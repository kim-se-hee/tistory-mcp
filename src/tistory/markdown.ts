/**
 * 마크다운 → 티스토리 안전 HTML 변환.
 *
 * ★ 존재 이유 (docs/api.md §4.5 (1)): 티스토리 서버는 본문 마크다운을 **렌더하지 않는다**.
 * `# 제목`, `**굵게**` 를 그대로 발행하면 기호가 리터럴로 노출된다 (= "마크다운 생노출" 블로커).
 * 그래서 도구가 발행 전에 MD→HTML 변환을 직접 수행한다. body 에 "마크다운 모드" 필드는 없다.
 *
 * sanitize 정책은 docs/api.md §4.5 (2) 의 실측 허용 화이트리스트를 **관대하게** 따른다 —
 * 서버가 작성자 본문을 거의 그대로 보관하므로 (헤딩 auto id, table, figure/img, pre>code[class],
 * blockquote, a[target,rel], span[style], div[class,data-*], iframe 통과) 우리도 그만큼 허용하되
 * `<script>` / `on*` 이벤트 핸들러 등 위험 벡터만 제거한다. 헤딩 id 는 서버 목차 스크립트가
 * 채우므로 죽이지 않는다 (id 속성 허용).
 */

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// ─────────────────────────────────────────────────────────────────────────────
// 이미지 치환자 보호 — marked 가 `[##_Image|...|...]` 를 깨지 않도록 플레이스홀더 치환
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 티스토리 이미지 치환자 패턴 `[##_Image|{kageRef}|CDM|1.3|{json}_##]` (docs/api.md §5.3,
 * `api.ts:buildImageSubstitution`).
 *
 * marked 는 `[...]` 를 링크 문법으로, `|` 를 테이블 구분자로 오인할 수 있고, 치환자 안의
 * `&amp;`·`_` 등을 변형할 수 있다. 그래서 변환 **전에** 치환자를 통째로 placeholder 토큰으로
 * 빼두고, sanitize 까지 끝난 **후에** 원복한다.
 *
 * `_##]` 까지 non-greedy 로 잡아 한 치환자 단위로 매칭. 여러 개도 전역 매칭.
 */
const IMAGE_SUBSTITUTION_RE = /\[##_Image\|[\s\S]*?_##\]/g;

/** placeholder 토큰 — 마크다운/HTML 어느 문법으로도 변형되지 않는 형태여야 한다. */
function placeholderToken(index: number): string {
  // 영숫자만 — marked/sanitize 가 건드릴 이유가 없는 토큰. 본문에 우연히 등장할 확률 무시 가능.
  return `TISTORYIMAGEPLACEHOLDER${index}TISTORYIMAGEPLACEHOLDER`;
}

interface ProtectedContent {
  /** 치환자를 placeholder 로 바꾼 텍스트. */
  text: string;
  /** placeholder index → 원본 치환자 문자열. */
  substitutions: string[];
}

function protectImageSubstitutions(input: string): ProtectedContent {
  const substitutions: string[] = [];
  const text = input.replace(IMAGE_SUBSTITUTION_RE, (match) => {
    const token = placeholderToken(substitutions.length);
    substitutions.push(match);
    return token;
  });
  return { text, substitutions };
}

function restoreImageSubstitutions(html: string, substitutions: string[]): string {
  let out = html;
  substitutions.forEach((sub, i) => {
    // placeholder 가 marked 에 의해 <p> 로 감싸졌을 수 있으나 토큰 자체는 보존되므로 replace 로 충분.
    out = out.split(placeholderToken(i)).join(sub);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitize 정책 — docs/api.md §4.5 (2) 실측 화이트리스트 (관대)
// ─────────────────────────────────────────────────────────────────────────────

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // 실측 통과 태그를 관대하게 허용. sanitize-html 기본 + 헤딩/표/미디어/코드/임베드 보강.
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "div", "span", "br", "hr",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small",
    "blockquote", "q", "cite",
    "ul", "ol", "li", "dl", "dt", "dd",
    "pre", "code", "kbd", "samp", "var",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "a",
    "img", "figure", "figcaption", "picture", "source",
    "iframe",
    "abbr", "address", "time", "details", "summary",
  ],
  allowedAttributes: {
    // ★ 헤딩 id 는 서버 목차 스크립트가 쓰므로 허용 (docs/api.md §4.5 (2)).
    h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
    a: ["href", "name", "target", "rel", "title"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    source: ["src", "srcset", "type", "media"],
    // span[style] / div[class,data-*] 는 실측 통과 — figure/blockquote 등에도 class 허용.
    span: ["style", "class"],
    div: ["class", "style", "data-*"],
    p: ["class", "style", "data-ke-size", "data-*"],
    figure: ["class", "data-*"],
    figcaption: ["class"],
    blockquote: ["class", "cite", "data-*"],
    pre: ["class"],
    code: ["class"],
    table: ["class", "style"],
    th: ["colspan", "rowspan", "scope", "style"],
    td: ["colspan", "rowspan", "style"],
    col: ["span", "style"],
    iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen", "title"],
    time: ["datetime"],
    abbr: ["title"],
    ol: ["start", "type"],
  },
  // style 속성은 통과시키되 url()/expression 등 위험 패턴은 sanitize-html 이 기본 거른다.
  // 위험 스킴 차단: javascript: 등. http/https/mailto/data 이미지만 허용.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
  // iframe src 는 동영상 임베드 등 — 실측 통과 호스트 제한은 안 둠 (관대). 스킴만 https/http.
  allowedIframeHostnames: undefined,
  // `on*` 핸들러·script·style 태그는 allowedTags 에 없어 자동 제거. data 속성은 와일드카드 허용.
  // class/style/data-* 외 알 수 없는 속성은 제거되지만, 본문 렌더에 필요한 건 위에 다 열거함.
  disallowedTagsMode: "discard",
};

// ─────────────────────────────────────────────────────────────────────────────
// 변환 진입점
// ─────────────────────────────────────────────────────────────────────────────

/** marked 옵션 — GFM (표/취소선/자동링크) + breaks(줄바꿈 → <br>) 활성. */
const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * 마크다운 → 티스토리 안전 HTML.
 *
 * 흐름: 이미지 치환자 보호 → marked 변환 → sanitize → 치환자 원복.
 * 치환자는 변환·sanitize 전 과정에서 placeholder 로 빠져 있다가 마지막에 글자 단위로 원복되므로
 * `&amp;`·서명 query 가 손상되지 않는다 (docs/api.md §5.3.1 의 attachments 글자 일치 보장).
 */
export function markdownToHtml(markdown: string): string {
  const { text, substitutions } = protectImageSubstitutions(markdown);
  // marked.parse 는 async 옵션 미지정 시 동기 string 반환.
  const rendered = marked.parse(text, MARKED_OPTIONS) as string;
  const safe = sanitizeHtml(rendered, SANITIZE_OPTIONS);
  return restoreImageSubstitutions(safe, substitutions);
}

/**
 * 입력이 이미 HTML 인 경로 (`contentFormat: "html"`). 변환은 안 하되 위험 벡터만 제거한다.
 *
 * 치환자는 동일하게 보호/원복 — sanitize 가 `[##_Image|...]` 를 텍스트로 보고 건드릴 일은 없으나
 * 일관성·안전을 위해 같은 파이프라인을 탄다.
 */
export function sanitizeContentHtml(html: string): string {
  const { text, substitutions } = protectImageSubstitutions(html);
  const safe = sanitizeHtml(text, SANITIZE_OPTIONS);
  return restoreImageSubstitutions(safe, substitutions);
}

/** content 입력 포맷. `markdown` = MD→HTML 변환, `html` = sanitize 만. */
export type ContentFormat = "markdown" | "html";

/**
 * `contentFormat` 분기 단일 진입점. 도구가 이 함수 하나만 호출하면 된다.
 */
export function renderContent(content: string, format: ContentFormat): string {
  return format === "markdown" ? markdownToHtml(content) : sanitizeContentHtml(content);
}
