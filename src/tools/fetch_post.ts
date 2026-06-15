/**
 * `tistory_fetch_post` — 단일 글 본문 + 메타 + 블로그 컨텍스트 한 방 조회.
 *
 * Notion `notion-fetch` 벤치마크: LLM 이 "이 글 가져와줘" 한 마디로 본문 + 글 메타 +
 * 블로그 컨텍스트를 한 번에 받아 다음 도구 (update_post / publish_post / preview_skin)
 * 결정에 바로 쓸 수 있게 평탄화.
 *
 * 핵심 동선:
 *   - 공개 페이지 GET (cookie 불필요) → cheerio 파싱
 *   - 본문 HTML / og 메타 / `body#tt-body-{type}` = scraper.ts 의 `parsePostBody`
 *     + `parsePageMeta` 재사용
 *   - 글 메타 (postId / categoryId / categoryLabel / tags / modifiedTime / txid) 는
 *     scraper.ts 에 없으므로 도구 안에서 직접 cheerio 추출 — scraper.ts owns 위반 회피
 *   - 블로그 메타 = scraper.ts 의 `parsePublicBlogConfig` (BLOG.id/name/title 등)
 *
 * 핵심 함정 (docs/api.md §4.4, CLAUDE.md 함정 7):
 *   - 본문은 **HTML 정규화된** 형태로만 보관. 마크다운 원본은 어떤 경로로도 복원 불가.
 *     응답 description 에 명시 — LLM 이 "수정하려면 본문 통째 다시 작성" 임을 알게.
 *   - 본문 HTML 은 스킨이 적용된 상태. 이미지 url 도 스킨 처리된 형태 (`img src=...`).
 *   - visibility 는 공개 페이지에선 추론 불가 — 어차피 비공개 글은 fetch 자체가 401/302.
 *     "공개 페이지로 가져왔다" = "공개 상태" 라고 LLM 이 추론할 수 있게 응답에 명시.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { load, type CheerioAPI } from "cheerio";
import { z } from "zod";

import {
  parsePageMeta,
  parsePostBody,
  parsePublicBlogConfig,
  PublicFetchError,
  type ParsedPost,
  type PublicBlogConfig,
  type PublicPageMeta,
} from "../tistory/scraper.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  postUrl: z
    .string()
    .url()
    .describe(
      "공개 글 URL. 예: `https://saree98.tistory.com/15`. " +
        "비공개/보호글은 공개 페이지로 접근 불가 → 4xx 에러. " +
        "cookie 인증이 필요 없으므로 `tistory_session_init` 선행 불필요.",
    ),
} as const;

type Input = {
  postUrl: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 응답 정형화 — LLM 이 다음 도구 호출 결정에 바로 쓸 수 있게 평탄화
// ─────────────────────────────────────────────────────────────────────────────

interface PostEntryMeta {
  /** numeric postId. `update_post` / `delete_post` 의 `postId` 인자에 바로 박힘. */
  postId: number | null;
  /** 카테고리 numeric id (`window.T.entryInfo.categoryId`). */
  categoryId: number | null;
  /** 카테고리 사람용 이름 (`window.T.entryInfo.categoryLabel`). */
  categoryLabel: string | null;
  /** 태그 배열 — `a[rel="tag"]` 마이크로포맷. 없으면 빈 배열. */
  tags: string[];
  /** ISO. `article:published_time`. */
  publishedTime: string | null;
  /** ISO. `article:modified_time`. */
  modifiedTime: string | null;
  /** `article:txid` (`{blogId}_{postId}`). 디버깅용. */
  txid: string | null;
}

interface FetchPostResult {
  /** 입력 URL (정규화 후). */
  url: string;
  /** og:title 또는 `<title>`. */
  title: string | null;
  /**
   * 본문 컨테이너 HTML. ★ 마크다운 원본은 복원 불가 (서버가 HTML 정규화 저장).
   * 스킨이 적용된 컨테이너 셀렉터로 추출됨 — 셀렉터 fallback 은 scraper.ts 참고.
   */
  contentHtml: string | null;
  /** 글 메타 — postId / 카테고리 / 태그 / 게시·수정 시각. */
  entry: PostEntryMeta;
  /** og:* / canonical / pageType — 표준 메타. */
  page: PublicPageMeta;
  /** `window.T.config.BLOG` — blogId/name/title 등 블로그 컨텍스트. */
  blog: PublicBlogConfig | null;
  /** 본문 안의 `<img src>` 목록. 이미지 만료 추적용. */
  imageUrls: string[];
  /** LLM 에게 한 줄 힌트 — 마크다운 복원 불가 등. */
  hint: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 글 메타 추출 — scraper.ts 가 커버 안 하는 부분만 (owns 위반 회피)
// ─────────────────────────────────────────────────────────────────────────────

/** `<meta property="...">` content 추출 — `noUncheckedIndexedAccess` 대응. */
function metaContent($: CheerioAPI, selector: string): string | null {
  const v = $(selector).attr("content");
  return v == null || v === "" ? null : v;
}

/**
 * `<script>` 들에서 `window.T.entryInfo = {...}` 객체 추출.
 *
 * 실측 형태 (saree98.tistory.com/15):
 *   `window.T.entryInfo = {"entryId":15,"isAuthor":false,"categoryId":1363062,"categoryLabel":"Spring"};`
 *
 * 단순 JSON 으로 들어있어 `JSON.parse` 가능. `null` (글이 아닌 페이지) 인 경우도 통과.
 */
function parseEntryInfo($: CheerioAPI): Record<string, unknown> | null {
  let scripts = "";
  $("script").each((_, el) => {
    scripts += $(el).html() ?? "";
    scripts += "\n";
  });
  // `window.T.entryInfo = null;` 또는 `... = {...};`
  const m = scripts.match(/T\.entryInfo\s*=\s*(\{[^;]*\}|null)\s*;/);
  if (!m || !m[1]) return null;
  if (m[1].trim() === "null") return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** URL path 의 마지막 numeric 세그먼트 = postId. `/15` / `/m/15` / `/123/` 다 처리. */
function extractPostIdFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(\d+)\/?$/);
    if (m && m[1]) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
  } catch {
    // URL 파싱 실패 → null
  }
  return null;
}

function parseEntryMeta($: CheerioAPI, postUrl: string): PostEntryMeta {
  const entryInfo = parseEntryInfo($);

  // postId: entryInfo.entryId 가 가장 신뢰. URL 폴백.
  let postId: number | null = null;
  if (entryInfo && typeof entryInfo["entryId"] === "number") {
    postId = entryInfo["entryId"] as number;
  } else {
    postId = extractPostIdFromUrl(postUrl);
  }

  const categoryId =
    entryInfo && typeof entryInfo["categoryId"] === "number"
      ? (entryInfo["categoryId"] as number)
      : null;
  const categoryLabel =
    entryInfo && typeof entryInfo["categoryLabel"] === "string"
      ? (entryInfo["categoryLabel"] as string)
      : null;

  // 태그: HTML5 표준 마이크로포맷 (`a[rel="tag"]`). 티스토리 스킨이 표준 따름.
  // 실측: <div class="post-tags"><a href="/tag/Must" rel="tag">Must</a></div>
  const tags: string[] = [];
  $('a[rel="tag"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text && !tags.includes(text)) tags.push(text);
  });

  return {
    postId,
    categoryId,
    categoryLabel,
    tags,
    publishedTime: metaContent($, 'meta[property="article:published_time"]'),
    modifiedTime: metaContent($, 'meta[property="article:modified_time"]'),
    txid: metaContent($, 'meta[property="article:txid"]'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 페이지 fetch — scraper.ts 가 internal helper 라 도구 안에서 다시 박는다
// ─────────────────────────────────────────────────────────────────────────────

/** scraper.ts 의 `fetchPublicHtml` 과 동일 동선. 한 글에서 cheerio 인스턴스 재사용. */
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
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
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const FETCH_POST_TOOL_NAME = "tistory_fetch_post";

export function registerFetchPost(server: McpServer): void {
  server.registerTool(
    FETCH_POST_TOOL_NAME,
    {
      title: "Tistory 단일 글 본문 + 메타 한 방 조회",
      description:
        "공개 글 URL 을 받아 본문 HTML + 글 메타 (postId / 카테고리 / 태그 / 게시·수정 시각) + " +
        "블로그 컨텍스트 (`window.T.config.BLOG`) 를 한 번에 반환합니다. " +
        "쿠키 인증이 필요 없어 `tistory_session_init` 선행 불필요. " +
        "비공개/보호글은 공개 페이지로 접근 불가 (4xx). " +
        "★ 본문은 서버가 HTML 정규화 저장 — 마크다운 원본은 어떤 경로로도 복원 불가 (docs/api.md §4.4). " +
        "또한 본문 HTML 은 스킨이 적용된 형태 (`.tt_article_useless_p_margin` 등 컨테이너 셀렉터로 추출)라 " +
        "댓글 위젯(#comment_group)·관련글·만료 서명 이미지 URL 이 섞여 있을 수 있습니다. " +
        "★ 반환된 `contentHtml` 을 그대로 `update_post` 에 되박으면 본문이 오염되므로, 메타 확인·현황 파악 용도로 쓰고 " +
        "수정 시 본문은 원본을 직접 작성하세요.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const html = await fetchHtml(args.postUrl);
        const $ = load(html);

        // scraper.ts 헬퍼 재사용 — 본문/표준메타/블로그 컨텍스트
        const post: ParsedPost = parsePostBody($);
        const page: PublicPageMeta = parsePageMeta($);
        const blog: PublicBlogConfig | null = parsePublicBlogConfig($);

        // scraper.ts 가 커버 안 하는 글 전용 메타
        const entry = parseEntryMeta($, args.postUrl);

        const result: FetchPostResult = {
          url: args.postUrl,
          title: post.title,
          contentHtml: post.contentHtml,
          entry,
          page,
          blog,
          imageUrls: post.imageUrls,
          hint:
            "본문은 HTML 정규화된 형태입니다 (마크다운 원본 복원 불가). " +
            "스킨이 적용된 컨테이너에서 추출됐습니다 — 댓글 위젯(#comment_group)·관련글·만료 서명 이미지 URL 이 " +
            "섞여 있을 수 있습니다. ★ 이 `contentHtml` 을 그대로 `update_post` 에 되박지 마세요: 그 산물이 본문에 굳어 " +
            "글이 오염되고 이미지는 만료 후 404 가 됩니다 (update_post 가 해당 마커를 감지하면 거부). " +
            "수정 시에는 본문을 원본 (마크다운 또는 깨끗한 HTML) 으로 다시 작성하세요.",
        };

        return jsonText(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답/에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function jsonText(payload: unknown) {
  // MCP text content 로 박되 JSON 포맷 — LLM 이 구조화된 메타를 한 번에 읽음
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
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

function errorResult(err: unknown) {
  if (err instanceof PublicFetchError) {
    // 401/403/404 는 비공개/보호글 또는 잘못된 URL — LLM 이 분기할 수 있게 status 노출
    return errorText(
      `공개 페이지 조회 실패 (HTTP ${err.status}): ${err.message} (${err.url}). ` +
        `비공개/보호글이거나 URL 이 잘못됐을 수 있습니다.`,
    );
  }
  return errorText(
    `글 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
