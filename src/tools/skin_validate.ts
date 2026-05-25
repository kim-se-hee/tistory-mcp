/**
 * `skin_validate` — 스킨 코드 정적 검증. cookie 불필요 (순수 로컬 검사).
 *
 * 입력: `{ html, css }` 인라인 또는 `path` (디렉토리). 둘 중 하나.
 * 동작: `validator.ts` 의 `validateSkin` 한 방. path 모드는 디렉토리에서
 *  - `skin.html` (필수) / `style.css` (필수)
 *  - basename 목록 (preview 이미지 4종 검사용)
 * 을 읽어 인라인으로 환원.
 *
 * 응답: `{ errors, warnings, passed, stats }` JSON. LLM 이 그대로 읽기 좋게 사람용 요약도 동봉.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { validateSkin, type ValidationResult } from "../tistory/validator.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  html: z
    .string()
    .optional()
    .describe(
      "스킨 HTML 본문 (raw text). `css` 와 짝. `path` 와 둘 중 하나 필수. " +
        "★ JSON-string 으로 감싸지 말 것 — `GET html.json` 응답을 그대로 dump 한 파일은 escape 가 박힌 채라 깨짐.",
    ),
  css: z
    .string()
    .optional()
    .describe("스킨 CSS (raw text). `html` 과 짝. `path` 사용 시 무시."),
  path: z
    .string()
    .optional()
    .describe(
      "스킨 디렉터리 절대 경로. `skin.html` + `style.css` + preview 이미지 4종 검사. " +
        "`html`/`css` 인라인과 둘 중 하나 필수.",
    ),
} as const;

type Input = {
  html?: string;
  css?: string;
  path?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// path 모드 — 디렉토리 읽기
// ─────────────────────────────────────────────────────────────────────────────

async function readSkinDir(
  dir: string,
): Promise<{ html: string; css: string; files: string[] }> {
  const htmlPath = path.join(dir, "skin.html");
  const cssPath = path.join(dir, "style.css");
  const [html, css, entries] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(cssPath, "utf8"),
    readdir(dir),
  ]);
  return { html, css, files: entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const SKIN_VALIDATE_TOOL_NAME = "skin_validate";

export function registerSkinValidate(server: McpServer): void {
  server.registerTool(
    SKIN_VALIDATE_TOOL_NAME,
    {
      title: "Tistory 스킨 정적 검증",
      description:
        "스킨 HTML/CSS 를 catalog 와 대조하고 함정을 잡습니다. cookie 불필요 (순수 로컬). " +
        "입력은 `html`+`css` 인라인 또는 `path` (디렉토리에 `skin.html`/`style.css`/preview 이미지) 중 하나. " +
        "검사 카테고리: (1) catalog 대조 — 미정의 치환자/블록은 warning. " +
        "(2) `<s_*>` 블록 짝/중첩 — error. " +
        "(3) preview 이미지 4종 (path 모드 한정) — 전부 누락 error / `preview.gif` 누락 warning. " +
        "(4) 함정 — 빈 `url()`, `/tag` 직링크, `<s_t3>` 누락/중복, `<body>` 에 `id` 미동적바인딩. " +
        "응답은 `{ errors, warnings, passed, stats }` — `passed = errors.length === 0`. " +
        "도구 자체는 isError 를 거의 안 던집니다 (입력 검증 실패 / 디렉토리 read 실패만).",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;

      const hasInline = args.html !== undefined || args.css !== undefined;
      const hasPath = args.path !== undefined;
      if (!hasInline && !hasPath) {
        return errorText(
          "`html`+`css` 인라인 또는 `path` 중 하나는 반드시 지정해야 합니다.",
        );
      }
      if (hasInline && hasPath) {
        return errorText(
          "`html`/`css` 인라인과 `path` 는 동시에 쓸 수 없습니다. 하나만 선택하세요.",
        );
      }
      if (hasInline && (args.html === undefined || args.css === undefined)) {
        return errorText(
          "인라인 모드는 `html` 과 `css` 를 모두 지정해야 합니다.",
        );
      }

      let html: string;
      let css: string;
      let files: string[] | undefined;
      let source: string;
      if (hasPath) {
        try {
          const read = await readSkinDir(args.path as string);
          html = read.html;
          css = read.css;
          files = read.files;
        } catch (err) {
          return errorText(
            `path 읽기 실패: ${err instanceof Error ? err.message : String(err)} ` +
              `(skin.html / style.css 두 파일이 모두 존재해야 합니다)`,
          );
        }
        source = `path=${args.path}`;
      } else {
        html = args.html as string;
        css = args.css as string;
        source = "inline";
      }

      const result = validateSkin({ html, css, ...(files ? { files } : {}) });

      return {
        content: [
          { type: "text", text: humanSummary(result, source) },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 사람용 요약 (LLM 이 읽기 쉬운 한 화면)
// ─────────────────────────────────────────────────────────────────────────────

function humanSummary(r: ValidationResult, source: string): string {
  const lines: string[] = [];
  lines.push(
    `스킨 검증 ${r.passed ? "통과" : "실패"} (source: ${source})`,
    `errors=${r.errors.length} / warnings=${r.warnings.length} / ` +
      `tokens=${r.stats.valueTokens} / blocks open=${r.stats.blockOpens} close=${r.stats.blockCloses}` +
      (r.stats.previewFilesPresent.length > 0
        ? ` / preview=[${r.stats.previewFilesPresent.join(", ")}]`
        : ""),
  );
  if (r.errors.length > 0) {
    lines.push("", "[errors]");
    for (const e of r.errors) lines.push(formatIssue(e));
  }
  if (r.warnings.length > 0) {
    lines.push("", "[warnings]");
    for (const w of r.warnings) lines.push(formatIssue(w));
  }
  return lines.join("\n");
}

function formatIssue(i: { code: string; source: string; line?: number; message: string }): string {
  const loc = i.line !== undefined ? `:${i.line}` : "";
  return `- [${i.code}] ${i.source}${loc} — ${i.message}`;
}

function errorText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
