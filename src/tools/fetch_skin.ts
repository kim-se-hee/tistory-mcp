/**
 * `tistory_fetch_skin` — 현재 적용된 커스텀 스킨 HTML/CSS + 파일 리스트 조회.
 *
 * `tistory_apply_skin` (쓰기) 의 읽기 짝. `GET /manage/design/skin/html.json` 직격
 * (`api.ts` 의 `getSkin` 래퍼). 스킨을 고치기 전 라이브 소스를 한 방에 받아오는 진입점 —
 * 로컬에 stale 사본을 쌓아둘 필요 없이 서버를 source of truth 로 쓴다.
 *
 * 핵심 함정 (docs/api.md §6, CLAUDE.md 함정 6):
 *   - 반환 `html`/`css` 는 이미 JSON-decode 된 raw text (`requestJson` 이 parse 함).
 *     그대로 `apply_skin` 의 `html`/`css` 에 박으면 됨. 다시 `JSON.stringify` 로
 *     감싸지 말 것 — escape 이중으로 박혀 스킨이 깨진다.
 *   - `files.list[].url` 은 첨부 파일(이미지/JS) CDN URL — 본문 `html` 과는 별개.
 *
 * 등록 (`src/tools/index.ts` 의 `registerTools`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getSkin,
  SessionExpiredError,
  TistoryApiError,
  type SkinSource,
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
} as const;

type Input = { blogUrl: string };

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const FETCH_SKIN_TOOL_NAME = "tistory_fetch_skin";

export function registerFetchSkin(server: McpServer): void {
  server.registerTool(
    FETCH_SKIN_TOOL_NAME,
    {
      title: "Tistory 현재 스킨 HTML/CSS 조회",
      description:
        "`GET /manage/design/skin/html.json` 으로 현재 적용된 스킨의 HTML·CSS·파일 리스트를 반환합니다. " +
        "`tistory_apply_skin` 의 읽기 짝 — 스킨을 고치기 전 라이브 소스를 한 방에 받아옵니다. " +
        "★ 반환 `html`/`css` 는 이미 decode 된 raw 텍스트라 그대로 `apply_skin` 의 `html`/`css` 에 박으면 됩니다 " +
        "(다시 JSON-string 으로 감싸지 마세요 — escape 이 이중으로 박혀 스킨이 깨집니다). " +
        "cookie 인증 필요 — 세션 만료 시 `tistory_session_init` 재호출 안내를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        const skin: SkinSource = await getSkin(ctx);

        const result = {
          skinname: skin.skinname,
          html: skin.html,
          css: skin.css,
          files: skin.files,
          stats: {
            htmlChars: skin.html.length,
            cssChars: skin.css.length,
            fileCount: skin.files?.list?.length ?? 0,
          },
          hint:
            "html/css 는 이미 decode 된 raw 텍스트입니다. 편집 후 그대로 `tistory_apply_skin` 의 " +
            "html/css 에 전달하세요 (다시 JSON-string 으로 감싸면 escape 이 박혀 스킨이 깨집니다). " +
            "라이브 발효 전 `isPreview:true` 로 먼저 dry-run 하는 걸 권장합니다.",
        };

        return jsonText(result);
      } catch (err) {
        return errorResult(err, args.blogUrl);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답/에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function jsonText(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

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
      `스킨 조회 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `스킨 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
