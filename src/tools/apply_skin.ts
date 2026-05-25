/**
 * `tistory_apply_skin` — 스킨 HTML/CSS 적용. `POST /manage/design/skin/html.json` 직격.
 *
 * 핵심 함정 (docs/api.md §6, CLAUDE.md 함정 6):
 *   - `isPreview: true` = 안전 dry-run, `false` = 즉시 라이브 발효
 *   - `preview/skin/{page}` 는 html/css 를 안 받음 (라이브 코드 기반) — dry-run 하려면
 *     `isPreview:false` 즉시 적용 후 preview fetch → 백업 복구 trade-off (별 도구 책임)
 *   - `GET /manage/design/skin/html.json` 응답의 `html`/`css` 는 JSON-string. 그걸 그대로
 *     디스크 dump 한 파일을 다시 PUT 하면 `"..."` 래핑·`\n` escape 가 박힌 채 전송되어
 *     스킨이 깨짐. 이 도구의 입력은 raw HTML/CSS 텍스트 — 디스크 read 시에도 JSON.parse
 *     하지 말 것 (raw text 로 직접 박는다).
 *   - skinDir 모드: `skin.html` / `style.css` 두 파일을 읽어 본문/CSS 로 사용. 둘 다 있어야 함.
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  applySkin,
  SessionExpiredError,
  TistoryApiError,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `html` + `css` 인라인 또는 `skinDir` 둘 중 하나. zod 의 superRefine 으로 강제.
 * raw shape 에선 refine 을 못 박으므로 핸들러 진입 후 검증.
 */
const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  html: z
    .string()
    .optional()
    .describe(
      "스킨 HTML 본문 (raw text). `skinDir` 과 둘 중 하나 필수. " +
        "★ JSON-string 으로 감싸지 말 것 — `GET html.json` 응답을 그대로 dump 한 파일은 `\"...\"`/`\\n` 박힌 채라 깨짐.",
    ),
  css: z
    .string()
    .optional()
    .describe(
      "스킨 CSS (raw text). `html` 과 짝. `skinDir` 사용 시 무시.",
    ),
  skinDir: z
    .string()
    .optional()
    .describe(
      "스킨 디렉터리 절대 경로. `skin.html` + `style.css` 를 읽어 적용. " +
        "`html`/`css` 인라인과 둘 중 하나 필수.",
    ),
  isPreview: z
    .boolean()
    .default(false)
    .describe(
      "`true` = dry-run (라이브 미반영, 안전). `false` = 즉시 라이브 적용 (디폴트). " +
        "★ preview endpoint (`tistory_preview_skin`) 는 라이브 코드만 렌더하므로, " +
        "변경된 코드 dry-run 은 `isPreview:false` 즉시 적용 → preview fetch → 백업 복구 흐름이 별도 필요.",
    ),
} as const;

type Input = {
  blogUrl: string;
  html?: string;
  css?: string;
  skinDir?: string;
  isPreview: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// skinDir 읽기 — skin.html + style.css
// ─────────────────────────────────────────────────────────────────────────────

async function readSkinDir(
  dir: string,
): Promise<{ html: string; css: string }> {
  const htmlPath = path.join(dir, "skin.html");
  const cssPath = path.join(dir, "style.css");
  // raw text 로 직접 read — JSON.parse 금지 (함정 메모 참조)
  const [html, css] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);
  return { html, css };
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const APPLY_SKIN_TOOL_NAME = "tistory_apply_skin";

export function registerApplySkin(server: McpServer): void {
  server.registerTool(
    APPLY_SKIN_TOOL_NAME,
    {
      title: "Tistory 스킨 적용 (HTML + CSS)",
      description:
        "`POST /manage/design/skin/html.json` 으로 스킨 HTML/CSS 를 적용합니다. " +
        "입력은 `html`+`css` 인라인 또는 `skinDir` (디렉터리에 `skin.html`/`style.css`) 중 하나. " +
        "`isPreview: true` 는 안전한 dry-run (라이브 미반영), `false` (디폴트) 는 즉시 라이브 발효입니다. " +
        "★ 입력은 raw HTML/CSS 문자열 — JSON-string 으로 감싸지 마세요 " +
        "(`GET html.json` 응답을 그대로 dump 한 파일은 escape 가 박힌 채라 깨집니다). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        // owns 밖이라 raw shape refine 못 박음 → 핸들러에서 검증
        const hasInline = args.html !== undefined || args.css !== undefined;
        const hasDir = args.skinDir !== undefined;
        if (!hasInline && !hasDir) {
          return errorText(
            "`html`+`css` 인라인 또는 `skinDir` 중 하나는 반드시 지정해야 합니다.",
          );
        }
        if (hasInline && hasDir) {
          return errorText(
            "`html`/`css` 인라인과 `skinDir` 은 동시에 쓸 수 없습니다. 하나만 선택하세요.",
          );
        }
        if (hasInline && (args.html === undefined || args.css === undefined)) {
          return errorText(
            "인라인 모드는 `html` 과 `css` 를 모두 지정해야 합니다 " +
              "(서버는 부분 적용이 아니라 full body 만 받음).",
          );
        }

        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        let html: string;
        let css: string;
        let source: string;
        if (hasDir) {
          try {
            const read = await readSkinDir(args.skinDir as string);
            html = read.html;
            css = read.css;
          } catch (err) {
            return errorText(
              `skinDir 읽기 실패: ${err instanceof Error ? err.message : String(err)} ` +
                `(skin.html / style.css 두 파일이 모두 존재해야 합니다)`,
            );
          }
          source = `skinDir=${args.skinDir}`;
        } else {
          html = args.html as string;
          css = args.css as string;
          source = "inline";
        }

        const responseUrl = await applySkin(ctx, {
          html,
          css,
          isPreview: args.isPreview,
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `스킨 적용 완료 (${args.isPreview ? "dry-run / isPreview=true" : "live / isPreview=false"})`,
                `source: ${source}`,
                `html: ${html.length} chars, css: ${css.length} chars`,
                `응답: ${responseUrl}`,
                args.isPreview
                  ? `※ dry-run 은 라이브 코드에 미반영. preview endpoint 는 라이브 코드 기반이라 변경분 미리보기엔 별도 흐름 필요.`
                  : `※ 라이브 즉시 발효. 공개 페이지를 새로고침해 확인하세요.`,
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
      `스킨 적용 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `스킨 적용 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
