/**
 * `tistory_screenshot` — Playwright 헤들리스로 임의 URL 풀페이지 캡처.
 *
 * 용도 (plan.md §2): `preview_skin` 의 풀 HTML 결과를 사람/LLM 이 시각으로 확인하거나,
 * 로그인 필요 admin 페이지를 그대로 찍어 디자인 검증/디버깅에 쓴다.
 *
 * 핵심 함정 — CLAUDE.md 함정 1 ("Playwright 는 session_init 한 군데만") 의 **유일한 예외**:
 *   화면 캡처는 본질적으로 렌더 엔진이 필요해 cookie-fetch 로 대체 불가. 단, 그 외에는
 *   session_init 외에 Playwright 를 절대 띄우지 말 것. 이 도구는 캡처만 하고 종료.
 *
 * storageState 재사용:
 *   - browser.ts 는 `loadStoredCookies()` / `loadContext()` 만 export (cookie 헤더 직렬화 전용).
 *     Playwright `browser.newContext({ storageState })` 에 넣을 raw JSON 은 노출 안 함.
 *   - browser.ts 보강은 owns 위반 → 도구가 동일 keytar 키 (`tistory-mcp` / account=host) 로
 *     직접 raw state 를 꺼내 newContext 에 주입.
 *   - keytar 에 없거나 파싱 실패 시 anonymous 컨텍스트로 진행 (공개 페이지면 OK).
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chromium, type BrowserContextOptions } from "playwright";
import keytar from "keytar";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// keytar 키 (browser.ts 와 동기 — 그쪽 상수 export 안 됨)
// ─────────────────────────────────────────────────────────────────────────────

/** browser.ts `KEYTAR_SERVICE` 와 동일 값이어야 함. 변경 시 양쪽 동시 갱신. */
const KEYTAR_SERVICE = "tistory-mcp";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

/** Playwright 데스크탑 표준에 가까운 기본값. preview 결과 캡처에 충분. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

const inputShape = {
  url: z
    .string()
    .url()
    .describe(
      "캡처할 페이지의 절대 URL (예: `https://saree98.tistory.com/`, " +
        "`https://saree98.tistory.com/manage/posts`). 로그인 필요 페이지면 " +
        "해당 host 의 session_init 가 선행돼야 storageState 가 주입됩니다.",
    ),
  viewport: z
    .object({
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(240).max(2160),
    })
    .optional()
    .describe(
      "캡처 뷰포트 (px). 미지정 시 1280×800. 풀페이지 캡처라 height 는 첫 fold 크기일 뿐 " +
        "최종 이미지 높이는 문서 전체.",
    ),
} as const;

type Input = {
  url: string;
  viewport?: { width: number; height: number };
};

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const SCREENSHOT_TOOL_NAME = "tistory_screenshot";

export function registerScreenshot(server: McpServer): void {
  server.registerTool(
    SCREENSHOT_TOOL_NAME,
    {
      title: "Tistory 페이지 스크린샷 (Playwright)",
      description:
        "Playwright Chromium 헤들리스로 임의 URL 을 열어 풀페이지 PNG 를 캡처하고 " +
        "MCP image content 로 반환합니다. URL 의 host 에 대한 session_init storageState 가 " +
        "keytar 에 있으면 자동 주입돼 로그인 필요 페이지도 캡처 가능 (없으면 anonymous). " +
        "★ Playwright 가 띄워지는 두 곳 중 하나 (다른 하나는 `tistory_session_init`). " +
        "그 외 도구에서 절대 브라우저를 재기동하지 말 것 (CLAUDE.md 함정 1).",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      const viewport = args.viewport ?? DEFAULT_VIEWPORT;

      let host: string;
      try {
        host = new URL(args.url).host;
      } catch {
        return errorText(`URL 파싱 실패: ${args.url}`);
      }

      const storageState = await loadStorageState(host);

      const browser = await chromium.launch({ headless: true });
      try {
        const contextOpts: BrowserContextOptions = {
          viewport,
          ...(storageState ? { storageState } : {}),
        };
        const context = await browser.newContext(contextOpts);
        try {
          const page = await context.newPage();
          // networkidle 까진 가지 않고 load 만 — admin SPA 가 polling 도구를 박는 경우 networkidle 영원히 안 옴.
          await page.goto(args.url, { waitUntil: "load", timeout: 30_000 });
          const buffer = await page.screenshot({ fullPage: true, type: "png" });
          const data = buffer.toString("base64");
          return {
            content: [
              {
                type: "image" as const,
                data,
                mimeType: "image/png",
              },
              {
                type: "text" as const,
                text:
                  `captured: ${args.url} (viewport ${viewport.width}×${viewport.height}, ` +
                  `storageState=${storageState ? `keytar(${host})` : "anonymous"}, ` +
                  `png ${buffer.length} bytes)`,
              },
            ],
          };
        } finally {
          await context.close().catch(() => undefined);
        }
      } catch (err) {
        return errorText(
          `스크린샷 실패: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * keytar 에서 storageState raw JSON 을 꺼내 Playwright 가 받는 객체로 파싱.
 *
 * browser.ts 의 `loginInteractive` 가 저장한 그대로 — `{ cookies, origins }`.
 * Playwright `newContext({ storageState })` 는 그 모양을 직접 받는다.
 *
 * 못 찾거나 JSON 파싱 실패 시 `null` → anonymous 컨텍스트로 떨어진다.
 */
async function loadStorageState(
  host: string,
): Promise<BrowserContextOptions["storageState"] | null> {
  const json = await keytar.getPassword(KEYTAR_SERVICE, host).catch(() => null);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { cookies?: unknown; origins?: unknown };
    if (!Array.isArray(parsed.cookies)) return null;
    // Playwright 타입은 cookies/origins 가 필수. origins 가 비어있으면 빈 배열로 보강.
    return parsed as BrowserContextOptions["storageState"];
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function errorText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
