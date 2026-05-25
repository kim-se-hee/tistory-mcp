/**
 * `tistory_preview_skin` — `POST /preview/skin/{page}` 서버 렌더. 풀 HTML 문서를 그대로 반환.
 *
 * 핵심 함정 (docs/api.md §6.3-§6.4, CLAUDE.md 함정 6):
 *   - body 가 **html/css 를 안 받음** — 항상 라이브(적용된) 스킨 코드 기반 렌더.
 *     변경된 코드 dry-run 하려면 `tistory_apply_skin({ isPreview:false })` 즉시 적용 →
 *     preview → 백업 복구 trade-off (1-2초 라이브 노출). 이 도구만으론 미적용 코드 미리보기 불가.
 *   - body 5필드 (`skinSettings`, `variableSettings`, `homeType`, `coverSettings`, `isDirty`)
 *     중 `isDirty` 는 내부 처리 (도구 인자로 노출 안 함). 4필드는 full snapshot 의미라
 *     인자 부분 지정 시 `current.json` 머지로 보강 (안 채우면 라이브와 다른 빈 설정으로 렌더됨).
 *   - 페이지 enum 5종: `index` / `entry` / `category` / `tag` / `guestbook`.
 *     `page`/`notice`/`search` 는 404 (docs/api.md §6.3).
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getSkinCurrent,
  previewSkin,
  SessionExpiredError,
  TistoryApiError,
  type PreviewBody,
  type PreviewPage,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_PAGES = ["index", "entry", "category", "tag", "guestbook"] as const;

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  page: z
    .enum(PREVIEW_PAGES)
    .describe(
      "미리보기 페이지 타입. 5종만 지원 (`page`/`notice`/`search` 는 서버 404):\n" +
        "- `index` → 홈 (`tt-body-index`)\n" +
        "- `entry` → 단일 글 (`tt-body-page`)\n" +
        "- `category` → 카테고리 목록 (`tt-body-category`)\n" +
        "- `tag` → 태그 목록 (`tt-body-tag`)\n" +
        "- `guestbook` → 방명록 (`tt-body-guestbook`)",
    ),
  variableSettings: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "미리보기에 적용할 변수 (key→value). 객체 머지 — 보낸 key 만 덮어쓰고 나머지는 라이브 값 유지. " +
        "★ 변수 효과는 스킨 코드 의존 — 코드가 그 변수를 참조 안 하면 미리보기에도 안 보임.",
    ),
  skinSettings: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "미리보기에 적용할 기본설정 (key→value). 객체 머지 — 보낸 key 만 덮어씀.",
    ),
  homeType: z
    .string()
    .optional()
    .describe(
      "미리보기 홈 타입. 예: `NONE`. 미지정 시 현재 라이브 값 유지.",
    ),
  coverSettings: z
    .array(z.unknown())
    .optional()
    .describe(
      "커버 설정 배열 (full replace). 미지정 시 현재 라이브 값 유지. " +
        "★ 배열은 머지가 아니라 통째 교체.",
    ),
} as const;

type Input = {
  blogUrl: string;
  page: PreviewPage;
  variableSettings?: Record<string, string>;
  skinSettings?: Record<string, string>;
  homeType?: string;
  coverSettings?: unknown[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const PREVIEW_SKIN_TOOL_NAME = "tistory_preview_skin";

export function registerPreviewSkin(server: McpServer): void {
  server.registerTool(
    PREVIEW_SKIN_TOOL_NAME,
    {
      title: "Tistory 스킨 미리보기 (서버 렌더 HTML)",
      description:
        "`POST /preview/skin/{page}` 로 서버가 렌더한 풀 HTML 문서를 반환합니다. " +
        "★ body 가 html/css 를 안 받아 **항상 라이브(적용된) 스킨 코드 기반** 렌더입니다. " +
        "변경된 코드를 미리보려면 `tistory_apply_skin({ isPreview:false })` 즉시 적용 → " +
        "preview → 백업 복구 trade-off 가 필요합니다 (이 도구만으론 미적용 코드 미리보기 불가). " +
        "`variableSettings`/`skinSettings`/`homeType`/`coverSettings` 4필드는 서버가 full snapshot 으로 받아, " +
        "부분 지정 시 `current.json` 으로 머지해 라이브 값을 보강합니다 (`isDirty` 는 내부 처리). " +
        "페이지 enum 은 `index`/`entry`/`category`/`tag`/`guestbook` 5종. " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        // settings 4필드는 full snapshot 의미라 라이브 값으로 머지 (안 채우면 빈 설정으로 렌더)
        const current = await getSkinCurrent(ctx);
        const currentHomeType = extractHomeType(current);
        const hasOverride =
          args.variableSettings !== undefined ||
          args.skinSettings !== undefined ||
          args.homeType !== undefined ||
          args.coverSettings !== undefined;

        const body: PreviewBody = {
          variableSettings: {
            ...current.variableSettings,
            ...(args.variableSettings ?? {}),
          },
          skinSettings: {
            ...current.skinSettings,
            ...(args.skinSettings ?? {}),
          },
          homeType: args.homeType ?? currentHomeType,
          coverSettings: args.coverSettings ?? extractCoverSettings(current),
          // 라이브에 미적용된 override 가 섞여있으면 true. 순수 라이브 그대로면 false.
          isDirty: hasOverride,
        };

        const html = await previewSkin(ctx, args.page, body);

        return {
          content: [
            {
              type: "text",
              text: html,
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
// current.json 필드 추출 헬퍼 (apply_skin_settings 와 동일 로직 — 응답 키 변동 대비)
// ─────────────────────────────────────────────────────────────────────────────

/** 최상위 `homeType` → `home.type` → `"NONE"` fallback. */
function extractHomeType(current: Record<string, unknown>): string {
  if (typeof current.homeType === "string") return current.homeType;
  const home = current.home;
  if (home && typeof home === "object") {
    const t = (home as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "NONE";
}

function extractCoverSettings(current: Record<string, unknown>): unknown[] {
  const cs = current.coverSettings;
  if (Array.isArray(cs)) return cs;
  return [];
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
      `스킨 미리보기 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `스킨 미리보기 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
