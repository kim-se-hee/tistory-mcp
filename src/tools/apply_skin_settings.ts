/**
 * `tistory_apply_skin_settings` — 변수/기본설정/홈타입/커버 부분 patch.
 * `GET /manage/design/skin/current.json` → 머지 → `POST /manage/design/skin/settings.json`.
 *
 * 핵심 함정 (docs/api.md §6.1, 2026-05-25 실측 확정):
 *   - body 4필드 (`skinSettings`, `variableSettings`, `homeType`, `coverSettings`) **full snapshot**.
 *     부분 patch 가 아니라 미지정 필드는 `current.json` 값으로 채워야 함 — 안 채우면 초기화.
 *   - `isDirty` 는 settings.json body 에 **포함 안 됨** (preview body 에만 들어감).
 *   - `variableSettings` / `skinSettings` 는 객체 머지 — 사용자가 일부 key 만 보내도 나머지는 현재값 유지.
 *   - variable 효과는 스킨 코드 의존 (하드코딩이면 무시) — docs/api.md §6.5
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  applySkinSettings,
  getSkinCurrent,
  SessionExpiredError,
  TistoryApiError,
  type SkinSettingsBody,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  variableSettings: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "변경할 변수 (key→value). 객체 머지 — 보낸 key 만 덮어쓰고 나머지는 현재값 유지. " +
        "★ 변수 효과는 스킨 코드 의존 — 코드가 그 변수를 참조 안 하면 적용해도 결과 변화 없음.",
    ),
  skinSettings: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "변경할 기본설정 (key→value). 객체 머지 — 보낸 key 만 덮어씀.",
    ),
  homeType: z
    .string()
    .optional()
    .describe(
      "홈 타입. 예: `NONE` (커버 없음) 등. 미지정 시 현재값 유지.",
    ),
  coverSettings: z
    .array(z.unknown())
    .optional()
    .describe(
      "커버 설정 배열 (full replace). 미지정 시 현재값 유지. " +
        "★ 배열은 머지가 아니라 통째 교체 — 일부 항목만 바꾸려면 현재값을 먼저 fetch_meta 로 받아서 수정 후 보낼 것.",
    ),
} as const;

type Input = {
  blogUrl: string;
  variableSettings?: Record<string, string>;
  skinSettings?: Record<string, string>;
  homeType?: string;
  coverSettings?: unknown[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const APPLY_SKIN_SETTINGS_TOOL_NAME = "tistory_apply_skin_settings";

export function registerApplySkinSettings(server: McpServer): void {
  server.registerTool(
    APPLY_SKIN_SETTINGS_TOOL_NAME,
    {
      title: "Tistory 스킨 설정 적용 (변수/기본/홈/커버)",
      description:
        "`POST /manage/design/skin/settings.json` 으로 스킨의 변수·기본설정·홈타입·커버를 적용합니다. " +
        "서버 body 가 4필드 full snapshot 이라, 부분 patch 흉내를 위해 `current.json` 을 먼저 fetch 해 " +
        "사용자 인자와 머지한 뒤 전체를 박습니다 (미지정 필드는 현재값 유지). " +
        "`variableSettings` / `skinSettings` 는 객체 머지 (key 단위), `coverSettings` 는 통째 교체. " +
        "★ 변수 효과는 스킨 코드가 그 변수를 참조해야만 보입니다 (하드코딩이면 무시). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        // 인자 전부 없으면 무의미 호출
        if (
          args.variableSettings === undefined &&
          args.skinSettings === undefined &&
          args.homeType === undefined &&
          args.coverSettings === undefined
        ) {
          return errorText(
            "변경할 항목이 없습니다. " +
              "`variableSettings` / `skinSettings` / `homeType` / `coverSettings` 중 최소 하나는 지정하세요.",
          );
        }

        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        // current.json 으로 full snapshot 확보 → 머지
        const current = await getSkinCurrent(ctx);

        // homeType 은 current.json 의 어느 필드에 있는지 실측 시점에 따라 다를 수 있어 fallback 체인.
        // docs/api.md §6.1 의 응답 키는 `home` 이지만, settings.json body 키는 `homeType`.
        // current 의 `home` 이 객체면 `type`/`value` 등을 직접 알 수 없으니, 명시적 입력 없으면
        // current 의 homeType 추출 결과 (또는 `"NONE"`) 를 사용.
        const currentHomeType = extractHomeType(current);

        const merged: SkinSettingsBody = {
          variableSettings: {
            ...current.variableSettings,
            ...(args.variableSettings ?? {}),
          },
          skinSettings: {
            ...current.skinSettings,
            ...(args.skinSettings ?? {}),
          },
          homeType: args.homeType ?? currentHomeType,
          // 배열은 머지 의미가 모호 → 인자 우선, 없으면 current 의 coverSettings (없으면 빈 배열)
          coverSettings:
            args.coverSettings ?? extractCoverSettings(current),
        };

        await applySkinSettings(ctx, merged);

        return {
          content: [
            {
              type: "text",
              text: [
                `스킨 설정 적용 완료`,
                `variableSettings: ${summarizeMerge(current.variableSettings, args.variableSettings)}`,
                `skinSettings: ${summarizeMerge(current.skinSettings, args.skinSettings)}`,
                `homeType: ${merged.homeType}` +
                  (args.homeType !== undefined && args.homeType !== currentHomeType
                    ? ` (← ${currentHomeType})`
                    : ""),
                `coverSettings: ${merged.coverSettings.length} item(s)` +
                  (args.coverSettings !== undefined ? ` (교체됨)` : ` (유지)`),
                `※ 변수 효과는 스킨 코드 의존 — 코드가 변수 미참조면 결과 변화 없음.`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return errorResult(err, args.blogUrl);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// current.json → settings.json body 필드 추출 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `current.json` 응답에서 homeType 을 추출. 실측 키는 환경에 따라 변동 가능성이 있어
 * 후보 순회: 최상위 `homeType` → `home.type` → `"NONE"` fallback.
 */
function extractHomeType(current: Record<string, unknown>): string {
  if (typeof current.homeType === "string") return current.homeType;
  const home = current.home;
  if (home && typeof home === "object") {
    const t = (home as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "NONE";
}

/** `current.json` 의 `coverSettings` 가 배열이면 그대로, 아니면 빈 배열. */
function extractCoverSettings(current: Record<string, unknown>): unknown[] {
  const cs = current.coverSettings;
  if (Array.isArray(cs)) return cs;
  return [];
}

function summarizeMerge(
  before: Record<string, string>,
  patch: Record<string, string> | undefined,
): string {
  if (!patch) return `${Object.keys(before).length} key(s) 유지`;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const prev = before[k];
    if (prev === v) continue;
    changed.push(`${k}=${v}${prev !== undefined ? ` (← ${prev})` : ""}`);
  }
  if (changed.length === 0) return `변경 없음`;
  return changed.join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// 에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function sessionRequired(blogUrl: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
          `(저장된 cookie 가 없거나 만료되었습니다.)`,
      },
    ],
  };
}

function errorText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) return sessionRequired(blogUrl);
  if (err instanceof TistoryApiError) {
    return errorText(
      `스킨 설정 적용 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `스킨 설정 적용 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
