/**
 * `tistory_session_init` — 헤디드 Chromium 으로 카카오 OAuth + 2FA 1회 처리.
 *
 * 동작 자체는 `src/tistory/browser.ts` 의 `loginInteractive` 가 다 하고, 이 파일은:
 *   1. MCP 도구 스키마 정의 (zod v4)
 *   2. blogUrl 인자 → loginInteractive 호출 → 결과를 LLM 친화 텍스트로 직렬화
 *   3. 카카오 푸시 timeout / 사용자 취소 등 예외를 사용자 안내 메시지로 변환
 *
 * 등록 (`src/index.ts` 의 `server.registerTool` 호출) 은 별도 todo 항목 (도구 통합) 에서.
 * 이 파일은 모듈 단위로 자급 — `registerSessionInit(server)` 만 호출하면 붙는다.
 *
 * 핵심 함정 — CLAUDE.md 함정 1: Playwright 는 여기 한 번만. 다른 도구가 다시 띄우면 안 됨.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loginInteractive, type LoginResult } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP SDK 는 `inputSchema` 로 ZodRawShape (object 의 .shape) 를 받는다.
 * 객체 단위 `z.object({...})` 가 아니라 raw shape — SDK 내부에서 zod.object 로 감싼다.
 */
const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 URL 또는 host. 예: `saree98.tistory.com` 또는 `https://saree98.tistory.com`. " +
        "keytar account 키로도 사용 (멀티 블로그 분리 저장).",
    ),
  /**
   * 카카오톡 푸시 승인까지 사람이 직접 눌러야 해서 디폴트 5분.
   * 천천히 처리해야 하는 사용자를 위해 override 허용.
   */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000)
    .optional()
    .describe(
      "로그인 완료 대기 timeout (ms). 디폴트 5분 (300000). 카카오 2FA 푸시까지 시간 필요시 늘릴 것.",
    ),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 출력 직렬화
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM 이 읽을 결과 텍스트. cookieHeader 는 일부러 노출 안 함 — 로그/대화에 박히면
 * 그 자체가 자격증명. keytar 에 저장됐다는 사실만 알리고, 후속 도구는 `loadContext`
 * 로 알아서 꺼낸다.
 */
function formatResult(result: LoginResult): string {
  const lines = [
    `세션 저장 완료: host=${result.host}`,
    result.blogId != null
      ? `blogId=${result.blogId}`
      : `blogId=(미파싱) — window.Config 진입 전 리다이렉트되었거나 SPA 구조가 변경됐을 수 있음. 후속 fetch_meta 호출로 보강 가능.`,
  ];
  if (result.expiresAt) {
    lines.push(
      `가장 빠른 cookie 만료: ${result.expiresAt.toISOString()} (이후엔 재호출 필요)`,
    );
  } else {
    lines.push(`만료 정보 없음 — 모두 세션 쿠키. 브라우저/터미널 재시작 시점에 만료 가능.`);
  }
  lines.push(
    `keytar 저장 키: service="tistory-mcp", account="${result.host}" (+ "default" 별칭).`,
  );
  return lines.join("\n");
}

/** Playwright 에러 메시지를 사용자 친화로 변환. 원본은 message 끝에 (debug) 로 부착. */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    // waitForURL timeout 메시지 패턴 매칭 — Playwright 가 던지는 표준 문구.
    if (err.message.includes("Timeout") && err.message.includes("waitForURL")) {
      return (
        "로그인 완료 대기 timeout. 카카오톡 푸시 승인을 못 받았거나 사용자가 창을 닫음. " +
        `timeoutMs 인자로 시간을 늘리거나 다시 호출하세요. (debug: ${err.message})`
      );
    }
    if (err.message.includes("Target page, context or browser has been closed")) {
      return "사용자가 브라우저 창을 닫음. 로그인을 완료한 뒤 창을 두면 자동으로 캡처합니다.";
    }
    return `세션 초기화 실패: ${err.message}`;
  }
  return `세션 초기화 실패: ${String(err)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_INIT_TOOL_NAME = "tistory_session_init";

export function registerSessionInit(server: McpServer): void {
  server.registerTool(
    SESSION_INIT_TOOL_NAME,
    {
      title: "Tistory 세션 초기화 (1회 로그인)",
      description:
        "헤디드 Chromium 을 띄워 카카오 OAuth + 2FA 푸시를 사용자에게 위임합니다. " +
        "완료된 storageState 는 keytar (OS keychain) 에 host 별로 저장되며, " +
        "이후 모든 도구는 cookie-auth fetch 만 사용합니다 (브라우저 재기동 없음). " +
        "다른 도구가 `SessionExpiredError` 를 반환할 때만 다시 호출하면 됩니다.",
      inputSchema: inputShape,
    },
    async ({ blogUrl, timeoutMs }) => {
      try {
        const result = await loginInteractive({
          blogUrl,
          ...(timeoutMs != null ? { timeoutMs } : {}),
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: formatError(err) }],
        };
      }
    },
  );
}
