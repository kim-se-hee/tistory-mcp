/**
 * 스킨 코드 검증 — pure 함수 (MCP/zod 의존 없음).
 *
 * `skin_validate` 도구의 코어. 4 카테고리:
 *  1. catalog 대조 — html/css 안의 `[##_*_##]` 토큰과 `<s_*>` 블록을 catalog.ts 와 대조.
 *     미정의는 warning (error 아님) — catalog 는 1차 source 라 누락이 있을 수 있고,
 *     실제로 default 템플릿도 catalog 에 없는 토큰 (`[##_article_prev_link_##]` 등) 을 쓴다.
 *  2. 블록 중첩 — `<s_*>` 열림/닫힘 짝 + parent 룰 위반. 짝 안 맞으면 error.
 *  3. preview 이미지 4종 — path 모드 한정. `preview.gif` / `preview256.jpg` /
 *     `preview560.jpg` / `preview1600.jpg` 중 0개면 error (적어도 1개 필요),
 *     `preview.gif` (fallback) 없으면 warning.
 *  4. 함정 검사 — plan.md gotchas:
 *     - 빈 `url('')` / `url("")` / `url()` → warning (배경에 현재 페이지 박힘)
 *     - `/tag` 직링크 (href="/tag" 또는 href="/tag/...") → warning
 *     - `<s_t3>` 누락 또는 2회 이상 → error (댓글/방명록 컴포넌트 마운트 마커)
 *     - `<html>` / `<body>` 자체를 박은 경우 → warning (티스토리가 페이지별로 감싸므로
 *       `body#tt-body-*` 셀렉터로 분기해야 함)
 *
 * 응답 형식: `{ errors, warnings, passed }`. `passed = errors.length === 0`.
 * (다른 도구의 `isError` 와는 별개 — 검증은 항상 정상 응답, 결과로 errors 배열을 돌려준다.)
 */

import {
  extractBlockTags,
  extractValueTokens,
  findBlock,
  findValue,
} from "./catalog.js";

// ─────────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────────

export type IssueSeverity = "error" | "warning";

/** validator 가 발견한 한 건. severity 분리는 호출자가 errors/warnings 로 분기. */
export interface ValidationIssue {
  /** 카테고리 식별자 — LLM 이 필터링하기 좋게. */
  code:
    | "catalog-unknown-token"
    | "catalog-unknown-block"
    | "block-unclosed"
    | "block-unopened"
    | "block-parent-violation"
    | "preview-missing-all"
    | "preview-missing-fallback"
    | "gotcha-empty-url"
    | "gotcha-tag-route"
    | "gotcha-st3-missing"
    | "gotcha-st3-duplicate"
    | "gotcha-html-body-literal";
  severity: IssueSeverity;
  message: string;
  /** html / css / files / structure 중 어느 source 에서 나왔는지. */
  source: "html" | "css" | "files" | "structure";
  /** (있을 때) 1-based 줄 번호. */
  line?: number;
  /** (있을 때) 문제 토큰/태그/파일 경로 등 컨텍스트 스니펫. */
  hint?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** errors.length === 0 */
  passed: boolean;
  /** 디버그/UX 용 — 검사한 토큰/블록 수, preview 파일 매칭 등 통계. */
  stats: {
    valueTokens: number;
    blockOpens: number;
    blockCloses: number;
    previewFilesPresent: string[];
  };
}

export interface ValidatorInput {
  html: string;
  css: string;
  /** path 모드 한정 — 디렉터리 안 파일 목록 (basename 만). preview 이미지 검사에 사용. */
  files?: string[];
}

export interface ValidatorOptions {
  /** false 면 preview 이미지 검사 스킵 (인라인 모드 = path 정보 없음). 기본 true. */
  checkPreviewImages?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

export function validateSkin(
  input: ValidatorInput,
  opts: ValidatorOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. catalog 대조 (값치환자)
  const tokens = extractValueTokens(input.html);
  const cssTokens = extractValueTokens(input.css);
  issues.push(...checkValueTokens(tokens, "html", input.html));
  issues.push(...checkValueTokens(cssTokens, "css", input.css));

  // 2. 블록 짝 + 중첩
  const blockTags = extractBlockTags(input.html);
  const { blockIssues, parentIssues } = checkBlocks(blockTags, input.html);
  issues.push(...blockIssues, ...parentIssues);

  // 3. preview 이미지 4종
  const checkPreview = opts.checkPreviewImages !== false && input.files !== undefined;
  const previewPresent = checkPreview ? previewFilesPresent(input.files ?? []) : [];
  if (checkPreview) {
    issues.push(...checkPreviewFiles(input.files ?? []));
  }

  // 4. 함정 검사
  issues.push(...checkEmptyUrl(input.css));
  issues.push(...checkTagRouteLinks(input.html));
  issues.push(...checkSt3(input.html));
  issues.push(...checkHtmlBodyLiteral(input.html));

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    errors,
    warnings,
    passed: errors.length === 0,
    stats: {
      valueTokens: tokens.length + cssTokens.length,
      blockOpens: blockTags.open.length,
      blockCloses: blockTags.close.length,
      previewFilesPresent: previewPresent,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. catalog 대조
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 변수 토큰 패턴 — `[##_var_NAME_##]`. catalog 에 정적 등록되지 않으므로 별도 매칭.
 * `[##_var_..._##]` 형태면 catalog 대조에서 통과시킨다 (이름은 index.xml 에서 정의).
 */
const VAR_TOKEN_RE = /^\[##_var_[A-Za-z0-9_]+_##\]$/;

/**
 * 이미지 치환자 — `[##_Image|kage@KEY|CDM|1.3|JSON_##]`. catalog 에 1건 등록되어 있지만
 * `{KEY}`/`{JSON}` 자리 채워진 실제 토큰은 정확 매칭 안 됨. 패턴으로 통과.
 */
const IMAGE_TOKEN_RE = /^\[##_Image\|kage@[^|]+\|CDM\|[^|]+\|.*_##\]$/;

function checkValueTokens(
  tokens: string[],
  source: "html" | "css",
  body: string,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (VAR_TOKEN_RE.test(token)) continue; // 변수 토큰은 OK
    if (IMAGE_TOKEN_RE.test(token)) continue; // 이미지 치환자 OK
    if (findValue(token)) continue;
    out.push({
      code: "catalog-unknown-token",
      severity: "warning", // catalog 누락 가능 — error 가 아니라 경고
      message: `catalog 에 없는 값치환자: ${token}`,
      source,
      line: findLine(body, token),
      hint: token,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 블록 짝 + 중첩
// ─────────────────────────────────────────────────────────────────────────────

interface OpenFrame {
  name: string; // `<s_NAME>` 형태 그대로
  line: number;
}

/**
 * `<s_if_var_*>` / `<s_not_var_*>` 는 catalog 가 정의하지 않지만 정상 토큰 — 조건 블록.
 * 짝만 맞으면 통과.
 */
const VAR_BLOCK_RE = /^<\/?s_(if|not)_var_[A-Za-z0-9_]+>$/;

function isVarBlockTag(tag: string): boolean {
  return VAR_BLOCK_RE.test(tag);
}

function checkBlocks(
  tags: { open: string[]; close: string[] },
  html: string,
): { blockIssues: ValidationIssue[]; parentIssues: ValidationIssue[] } {
  // 등장 순서대로 다시 훑어 stack 검증 (extractBlockTags 는 순서 보존된 match 결과).
  const issues: ValidationIssue[] = [];
  const parentIssues: ValidationIssue[] = [];
  const stack: OpenFrame[] = [];

  // 한 번에 순회하려면 line 정보가 필요. html 을 직접 다시 스캔한다.
  const tagRe = /<\/?s_[a-zA-Z0-9_]+>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const line = lineOfIndex(html, match.index);
    const isClose = tag.startsWith("</");
    const name = isClose ? `<${tag.slice(2)}` : tag; // close → 대응 open 표기

    if (!isClose) {
      // 카탈로그 등록 여부 (변수 블록은 통과)
      if (!isVarBlockTag(tag) && !findBlock(tag)) {
        issues.push({
          code: "catalog-unknown-block",
          severity: "warning",
          message: `catalog 에 없는 블록: ${tag}`,
          source: "html",
          line,
          hint: tag,
        });
      }
      // parent 룰 검사 — catalog 정의가 있을 때만
      const def = findBlock(tag);
      if (def && def.parents && def.parents.length > 0) {
        const parentOpen = nearestAncestorOpen(stack);
        if (!parentOpen || !def.parents.includes(parentOpen)) {
          parentIssues.push({
            code: "block-parent-violation",
            severity: "error",
            message: `${tag} 는 ${def.parents.join(" / ")} 안에서만 의미가 있습니다 (현재 부모: ${parentOpen ?? "없음"}).`,
            source: "html",
            line,
            hint: tag,
          });
        }
      }
      stack.push({ name: tag, line });
    } else {
      const expected = `<${tag.slice(2)}`; // `</s_x>` → `<s_x>`
      const top = stack.at(-1);
      if (!top) {
        issues.push({
          code: "block-unopened",
          severity: "error",
          message: `여는 짝 없는 닫는 블록: ${tag}`,
          source: "html",
          line,
          hint: tag,
        });
        continue;
      }
      if (top.name !== expected) {
        // 잘못된 중첩 — top 이 안 닫혔거나 순서가 꼬임. top 을 미해결로 보고 닫는 쪽도 미매칭.
        issues.push({
          code: "block-unclosed",
          severity: "error",
          message: `블록 짝 불일치: ${top.name} (열림 @line ${top.line}) 가 닫히기 전에 ${tag} 닫힘 (@line ${line}).`,
          source: "html",
          line,
          hint: `expected ${`</${top.name.slice(1)}`}`,
        });
        // 복구: stack 비울 때까지 expected 와 매칭 시도
        const idx = [...stack].reverse().findIndex((f) => f.name === expected);
        if (idx >= 0) {
          const realIdx = stack.length - 1 - idx;
          stack.length = realIdx; // expected 위까지 잘라낸다
        } else {
          // 매칭 없음 — 그냥 unopened
          issues.push({
            code: "block-unopened",
            severity: "error",
            message: `여는 짝 없는 닫는 블록: ${tag}`,
            source: "html",
            line,
            hint: tag,
          });
        }
        continue;
      }
      stack.pop();
    }
  }

  // 닫히지 않고 남은 open 들
  for (const open of stack) {
    issues.push({
      code: "block-unclosed",
      severity: "error",
      message: `닫히지 않은 블록: ${open.name} (열림 @line ${open.line}).`,
      source: "html",
      line: open.line,
      hint: open.name,
    });
  }

  // open/close 짝/총수 mismatch 는 위 stack 로직이 이미 모두 잡는다.
  // tags 인자는 시그니처 호환 유지용 (extractBlockTags 의 결과를 외부에서 받음).
  void tags;

  return { blockIssues: issues, parentIssues };
}

function nearestAncestorOpen(stack: OpenFrame[]): string | undefined {
  // 변수 블록 (`<s_if_var_*>` 등) 은 부모 컨텍스트를 결정하지 않으므로 스킵.
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (!frame) continue;
    if (isVarBlockTag(frame.name)) continue;
    return frame.name;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. preview 이미지 4종
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_FILES = [
  "preview.gif",
  "preview256.jpg",
  "preview560.jpg",
  "preview1600.jpg",
] as const;

function previewFilesPresent(files: string[]): string[] {
  const lower = new Set(files.map((f) => f.toLowerCase()));
  return PREVIEW_FILES.filter((p) => lower.has(p));
}

function checkPreviewFiles(files: string[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const present = previewFilesPresent(files);
  if (present.length === 0) {
    out.push({
      code: "preview-missing-all",
      severity: "error",
      message:
        `preview 이미지가 하나도 없습니다. ` +
        `${PREVIEW_FILES.join(" / ")} 중 최소 1개 필요 (관리자 UI 가 썸네일을 못 그림).`,
      source: "files",
      hint: PREVIEW_FILES.join(", "),
    });
    return out;
  }
  if (!present.includes("preview.gif")) {
    out.push({
      code: "preview-missing-fallback",
      severity: "warning",
      message:
        `preview.gif (fallback) 가 없습니다. 다른 해상도 preview 가 없는 환경에서 빈 썸네일이 됩니다.`,
      source: "files",
      hint: present.join(", "),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 함정 검사
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_URL_RE = /url\(\s*(?:""|''|)\s*\)/g;

function checkEmptyUrl(css: string): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  let m: RegExpExecArray | null;
  while ((m = EMPTY_URL_RE.exec(css)) !== null) {
    out.push({
      code: "gotcha-empty-url",
      severity: "warning",
      message:
        `CSS 의 빈 url() — 브라우저가 현재 페이지를 background 로 다시 요청합니다. ` +
        `variable 기본값 누락이거나 조건부 토큰 미처리.`,
      source: "css",
      line: lineOfIndex(css, m.index),
      hint: m[0],
    });
  }
  return out;
}

// `/tag` 또는 `/tag/...` 직링크 — `[##_tag*_##]` 안의 동적 URL 은 제외.
// 토큰을 먼저 제거하고 검사.
const TOKEN_STRIP_RE = /\[##_[^\]]+?_##\]/g;
const TAG_HREF_RE = /href\s*=\s*["']\/tag(?:["'/?#])/g;

function checkTagRouteLinks(html: string): ValidationIssue[] {
  const stripped = html.replace(TOKEN_STRIP_RE, "");
  const out: ValidationIssue[] = [];
  let m: RegExpExecArray | null;
  while ((m = TAG_HREF_RE.exec(stripped)) !== null) {
    out.push({
      code: "gotcha-tag-route",
      severity: "warning",
      message:
        `\`/tag\` 직링크는 일부 블로그 설정에서 404 가 됩니다. ` +
        `\`[##_taglog_link_##]\` 또는 \`<s_tag>\` 클라우드를 거치세요.`,
      source: "html",
      // stripped 의 인덱스는 원문과 다르므로 line 은 생략
      hint: m[0],
    });
  }
  return out;
}

function checkSt3(html: string): ValidationIssue[] {
  const opens = (html.match(/<s_t3>/g) ?? []).length;
  const closes = (html.match(/<\/s_t3>/g) ?? []).length;
  const out: ValidationIssue[] = [];
  if (opens === 0) {
    out.push({
      code: "gotcha-st3-missing",
      severity: "error",
      message:
        `<s_t3> 가 body 안에 없습니다. ` +
        `티스토리 공통 JS 마운트 마커 — 누락 시 [##_comment_group_##] / [##_guestbook_group_##] 등 ` +
        `React 컴포넌트가 마운트되지 않습니다.`,
      source: "html",
      hint: "<s_t3>",
    });
  } else if (opens > 1) {
    out.push({
      code: "gotcha-st3-duplicate",
      severity: "warning",
      message: `<s_t3> 가 ${opens} 회 등장합니다. body 직속 1회만 사용하세요.`,
      source: "html",
      hint: "<s_t3>",
    });
  }
  if (opens !== closes) {
    // block 짝 검사가 이미 잡지만, st3 한정 명시.
    out.push({
      code: "gotcha-st3-missing",
      severity: "error",
      message: `<s_t3> 열림/닫힘 짝이 안 맞습니다 (열림 ${opens} / 닫힘 ${closes}).`,
      source: "html",
      hint: "<s_t3> ↔ </s_t3>",
    });
  }
  return out;
}

const HTML_LITERAL_RE = /<html\b/i;
const BODY_LITERAL_RE = /<body\b/i;

function checkHtmlBodyLiteral(html: string): ValidationIssue[] {
  // ★ 실측: default 템플릿이 <html>/<body> 를 박고 있다 — 티스토리가 그대로 렌더한다는 뜻.
  // 그래도 페이지별 분기를 위해 `body#tt-body-{type}` 셀렉터로 다뤄야 한다는 함정은 유효.
  // 검사는 정보성 warning 만 (default 도 통과해야 하므로 error 아님).
  const out: ValidationIssue[] = [];
  if (HTML_LITERAL_RE.test(html) || BODY_LITERAL_RE.test(html)) {
    // body 의 id 가 [##_body_id_##] 로 동적 바인딩되어 있는지 확인 — 안 되어 있으면 경고.
    const bodyTag = html.match(/<body[^>]*>/i)?.[0] ?? "";
    if (bodyTag && !bodyTag.includes("[##_body_id_##]")) {
      out.push({
        code: "gotcha-html-body-literal",
        severity: "warning",
        message:
          `<body> 태그에 id="[##_body_id_##]" 가 없습니다. ` +
          `페이지별 CSS 분기 (\`body#tt-body-index\` 등) 가 불가능해집니다.`,
        source: "html",
        hint: bodyTag,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 보조
// ─────────────────────────────────────────────────────────────────────────────

function lineOfIndex(text: string, index: number): number {
  // 1-based. index 가 음수/범위 밖이면 1.
  if (index <= 0) return 1;
  let line = 1;
  const upto = Math.min(index, text.length);
  for (let i = 0; i < upto; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findLine(text: string, needle: string): number | undefined {
  const idx = text.indexOf(needle);
  if (idx < 0) return undefined;
  return lineOfIndex(text, idx);
}
