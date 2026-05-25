/**
 * 공개 블로그 페이지 스크레이퍼.
 *
 * 책임 범위 — **cookie 불필요** 한 공개 endpoint 만:
 *   - 단일 글 본문 (`https://{host}/{postId}`) — docs/api.md §4.4 의 우회 1번
 *   - 공개 페이지 메타 (og:* / article:published_time / canonical / body#tt-body-*) — §8
 *   - 공개 페이지 `<script>window.T.config = {...}</script>` 안의 BLOG 컨텍스트 — §6.4 참고
 *
 * **api.ts 의 `fetchBlogConfig` 와 혼동 금지.** 그쪽은 admin (`/manage/category`)
 * HTML 의 `window.Config.blog` — cookie 필수. 여기는 cookie 없이 공개 페이지만.
 *
 * 마크다운 원본 복원은 어떤 경로로도 불가 — 서버가 HTML 정규화만 보관 (§4.4).
 * 본문 HTML 은 스킨이 적용된 형태로만 얻을 수 있다.
 */
/// <reference types="node" />
import { load, type CheerioAPI } from "cheerio";

// ─────────────────────────────────────────────────────────────────────────────
// 공통 fetch — 공개 페이지 (인증 헤더 없음)
// ─────────────────────────────────────────────────────────────────────────────

/** 공개 페이지 fetch 자체 실패. 4xx/5xx. */
export class PublicFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "PublicFetchError";
  }
}

/**
 * 공개 페이지를 그냥 fetch 해서 HTML 텍스트로 반환.
 *
 * 봇 탐지 대응 (docs/plan.md §3.2): 정상 user-agent 박음. 인증 헤더 없음.
 */
async function fetchPublicHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      // 실제 브라우저로 위장. 빈 UA 면 일부 CDN 이 차단할 수 있음
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new PublicFetchError(`GET ${url} → ${res.status}`, res.status, url);
  }
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// page type 매핑 — docs/api.md §8
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `body#tt-body-{type}` 의 type. 스킨 디자인 시 페이지 분기 셀렉터.
 *
 * 실측 7종 (§8) + 표준 추정 2종. 알 수 없는 값은 `string` 으로 통과.
 */
export type PageType =
  | "index"
  | "page"
  | "category"
  | "tag"
  | "search"
  | "guestbook"
  | "notice"
  | "archive"
  | "location";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 페이지 메타 추출
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 공개 페이지 (어떤 URL 이든) 의 표준 메타.
 *
 * 스킨 무관하게 티스토리가 자동 주입하는 부분만 다룬다. 스킨이 박은 임의
 * 콘텐츠는 `parsePostBody` 등 전용 파서로.
 */
export interface PublicPageMeta {
  /** `<title>` */
  title: string | null;
  /** `<link rel="canonical">` */
  canonical: string | null;
  /** `<meta property="og:title">` */
  ogTitle: string | null;
  /** `<meta property="og:image">` */
  ogImage: string | null;
  /** `<meta property="og:description">` */
  ogDescription: string | null;
  /** `<meta property="article:published_time">` — ISO. 단일 글에만 박힘. */
  publishedTime: string | null;
  /** `body[id]` → `tt-body-{type}` 에서 추출한 `{type}`. 매핑 안 되면 `null`. */
  pageType: PageType | string | null;
}

/** 셀렉터로 attr 꺼내는 helper — `noUncheckedIndexedAccess` 환경 대응. */
function metaContent($: CheerioAPI, selector: string): string | null {
  const v = $(selector).attr("content");
  return v == null || v === "" ? null : v;
}

/**
 * cheerio 로드된 페이지에서 표준 메타 추출.
 *
 * fetch 와 분리한 이유: 같은 HTML 에서 여러 파서 (`parsePostBody` 등) 를
 * 돌릴 때 cheerio 인스턴스 재사용하기 위함.
 */
export function parsePageMeta($: CheerioAPI): PublicPageMeta {
  const bodyId = $("body").attr("id") ?? "";
  // `tt-body-page` → `page`. 매핑 안 맞으면 원본 그대로 두지 말고 null 로.
  const m = bodyId.match(/^tt-body-(.+)$/);
  const pageType = m && m[1] ? m[1] : null;

  return {
    title: $("title").first().text() || null,
    canonical: $('link[rel="canonical"]').attr("href") ?? null,
    ogTitle: metaContent($, 'meta[property="og:title"]'),
    ogImage: metaContent($, 'meta[property="og:image"]'),
    ogDescription: metaContent($, 'meta[property="og:description"]'),
    publishedTime: metaContent($, 'meta[property="article:published_time"]'),
    pageType,
  };
}

/** URL 한 방 호출 — fetch + cheerio + 메타 추출. */
export async function fetchPageMeta(url: string): Promise<PublicPageMeta> {
  const html = await fetchPublicHtml(url);
  return parsePageMeta(load(html));
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 페이지 `window.T.config` — docs/api.md §6.4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 공개 페이지의 `window.T.config` 안 BLOG 컨텍스트 (관찰 가능한 필드만).
 *
 * admin 의 `window.Config.blog` 와는 별개 객체. cookie 없이 얻을 수 있는 게
 * 장점이지만 노출 필드는 훨씬 빈약. `blogId` 정도만 신뢰.
 */
export interface PublicBlogConfig {
  /** 블로그 numeric id. admin 의 `Config.blog.blogId` 와 동일 값. */
  blogId: number | null;
  /** 호스트 (서브도메인). */
  host: string | null;
  /** 모든 키 통과 — 스킨/플러그인이 임의로 박을 수 있음. */
  [key: string]: unknown;
}

/**
 * cheerio 인스턴스에서 `<script>` 들을 훑어 `window.T = ... config: {...}` 또는
 * `T.config = {...}` 패턴을 찾아 JSON 파싱.
 *
 * 티스토리가 inline 으로 박는 형식은 시기/스킨별로 다양함:
 *   - `T.config = { BLOG: { id: 1234, name: "..." } };`
 *   - `window.T = { config: { BLOG: {...} } };`
 *
 * 그래서 `BLOG\s*:\s*\{...\}` 의 가장 안쪽 블록만 추출 — 외곽 wrapper 변화에
 * 강하다.
 *
 * 못 찾으면 `null` (공개 페이지에 항상 박혀있다고 보장 못 함).
 */
export function parsePublicBlogConfig($: CheerioAPI): PublicBlogConfig | null {
  // <script> 내용 전부 합쳐서 한 번에 매칭. 양이 크지 않음 (공개 페이지 < 1MB).
  let scripts = "";
  $("script").each((_, el) => {
    scripts += $(el).html() ?? "";
    scripts += "\n";
  });
  // 가장 안쪽 BLOG 블록만 잡아낸다. nested object 가 거의 없는 게 실측.
  const m = scripts.match(/BLOG\s*:\s*(\{[^{}]*\})/);
  if (!m || !m[1]) return null;
  try {
    // 티스토리는 JS 객체 리터럴 — key 가 쌍따옴표 안 감겨있을 수 있음.
    // JSON.parse 하기 전에 unquoted key → quoted key 로 정규화.
    const normalized = m[1]
      .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
      // 작은따옴표 문자열 → 큰따옴표
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    const blog = JSON.parse(normalized) as Record<string, unknown>;
    const blogId = typeof blog["id"] === "number" ? (blog["id"] as number) : null;
    const host = typeof blog["host"] === "string" ? (blog["host"] as string) : null;
    return { ...blog, blogId, host };
  } catch {
    return null;
  }
}

/**
 * 공개 페이지 (보통 `https://{host}/`) 에서 `window.T.config.BLOG` 추출.
 *
 * ★ admin 의 풍부한 메타 (categories / activePlugins / skinInfo) 가 필요하면
 *   `api.ts` 의 `fetchBlogConfig` (cookie 필요) 를 써야 한다. 여기는
 *   "로그인 없이 얻을 수 있는 최소 BLOG 컨텍스트" 만.
 */
export async function fetchPublicBlogConfig(host: string): Promise<PublicBlogConfig | null> {
  const html = await fetchPublicHtml(`https://${host}/`);
  return parsePublicBlogConfig(load(html));
}

// ─────────────────────────────────────────────────────────────────────────────
// 단일 글 본문 — docs/api.md §4.4 의 우회 1번
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 단일 글 (`https://{host}/{postId}`) 의 추출 가능한 부분.
 *
 * ★ 본문 HTML 은 **스킨이 적용된 형태**. `.tt_article_useless_p_margin`,
 * `.article`, `.entry-content` 등 스킨별 컨테이너가 다름 — 안전한 fallback 다단계.
 *
 * 원본 마크다운은 어떤 경로로도 복원 불가 (§4.4).
 */
export interface ParsedPost {
  /** og:title 또는 `<title>`. */
  title: string | null;
  /** 본문 컨테이너 HTML. 못 찾으면 `null` (스킨이 표준 셀렉터 안 쓴 경우). */
  contentHtml: string | null;
  /** ISO. `article:published_time` 메타. */
  publishedTime: string | null;
  /** 대표 이미지. */
  ogImage: string | null;
  /** canonical URL. */
  canonical: string | null;
  /** 본문 안의 `<img src>` 추출. 이미지 만료 추적용. */
  imageUrls: string[];
}

/**
 * cheerio 인스턴스에서 본문 컨테이너를 찾아 ParsedPost 만든다.
 *
 * 스킨 무관 동작을 위해 셀렉터 fallback 다단계 — 가장 흔한 것부터:
 *   1. `.tt_article_useless_p_margin` — 티스토리 기본 본문 wrapper (가장 안정적)
 *   2. `.article` — Odyssey 등 다수 스킨
 *   3. `.entry-content` — WordPress 풍 스킨
 *   4. `[itemprop="articleBody"]` — schema.org
 */
export function parsePostBody($: CheerioAPI): ParsedPost {
  const meta = parsePageMeta($);

  const candidates = [
    ".tt_article_useless_p_margin",
    ".article",
    ".entry-content",
    '[itemprop="articleBody"]',
  ];
  let contentHtml: string | null = null;
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length > 0) {
      contentHtml = el.html();
      if (contentHtml != null && contentHtml.trim() !== "") break;
    }
  }

  const imageUrls: string[] = [];
  if (contentHtml != null) {
    // 본문 영역 안의 img 만 — 사이드바/위젯 이미지 제외
    $(candidates.join(", "))
      .first()
      .find("img")
      .each((_, el) => {
        const src = $(el).attr("src");
        if (src) imageUrls.push(src);
      });
  }

  return {
    title: meta.ogTitle ?? meta.title,
    contentHtml,
    publishedTime: meta.publishedTime,
    ogImage: meta.ogImage,
    canonical: meta.canonical,
    imageUrls,
  };
}

/** 글 URL 한 방 호출 — fetch + 본문/메타 파싱. */
export async function fetchPost(postUrl: string): Promise<ParsedPost> {
  const html = await fetchPublicHtml(postUrl);
  return parsePostBody(load(html));
}
