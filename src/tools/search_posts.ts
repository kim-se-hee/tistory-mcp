/**
 * `tistory_search_posts` — 글 제목/본문 검색.
 *
 * 동선:
 *   - `GET /manage/posts.json?searchKeyword=&searchType=&visibility=&category=&page=` 활용
 *     (docs/api.md §3.2). admin endpoint 자체가 server-side 검색 지원 → 페이지 fetch
 *     1~N 회 + 클라이언트 필터 없이 끝남.
 *   - 인증된 admin 만 검색 가능 (cookie 필수). 공개 페이지 `/search/{kw}` 는 스킨이 렌더링하는
 *     글 리스트라 메타 (categoryId / visibility 문자열 등) 가 admin 응답만큼 풍부하지 않다 →
 *     `update_post` / `fetch_post` 의 입력에 바로 쓸 수 있는 형태로 정규화하려면 admin 우선.
 *   - 최대 20 페이지 (300건) 안전망. `limit` (기본 20, 상한 300) 만큼 채우면 조기 종료.
 *
 * 핵심 함정 (docs/api.md §3.2, §4.3):
 *   - `searchType` enum 3종 — `title` / `content` / `all`. 기본 `title` (가장 흔한 의도).
 *   - visibility 응답은 문자열 enum (`PUBLIC` / `PRIVATE` / `PROTECTED`) — 도구 응답은
 *     사용자 친화 소문자 enum 으로 변환 (다른 도구 입력과 일관).
 *   - 카테고리 필터는 categoryId 정수만 받음 (이름 매칭 안 됨). 이름으로 검색하려면
 *     사전에 `tistory_fetch_meta` 로 id 조회 필요.
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listPosts,
  SessionExpiredError,
  TistoryApiError,
  visibilityFromResponse,
  type PostListItem,
  type VisibilityName,
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
        "keytar 에서 cookie 를 꺼낼 account 키 — admin posts.json 호출에 필요.",
    ),
  query: z
    .string()
    .min(1)
    .describe(
      "검색어. 빈 문자열은 거부 (검색이 아니라 목록 조회면 별도 도구 사용).",
    ),
  searchType: z
    .enum(["title", "content", "all"])
    .default("title")
    .describe(
      "검색 대상: `title` (제목만) / `content` (본문만) / `all` (제목+본문). " +
        "기본 `title` (admin UI 기본값과 일치).",
    ),
  visibility: z
    .enum(["all", "public", "private", "protected"])
    .default("all")
    .describe("공개 범위 필터. 기본 `all` (전체)."),
  category: z
    .number()
    .int()
    .optional()
    .describe(
      "categoryId 정수 필터. 미지정 = 전체 (`-3`). " +
        "이름으로 필터하려면 사전에 `tistory_fetch_meta` 로 id 조회 필요.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(20)
    .describe(
      "반환할 최대 건수. 기본 20, 상한 300 (admin 페이지 순회 한도 20p × 15건).",
    ),
} as const;

type Input = {
  blogUrl: string;
  query: string;
  searchType: "title" | "content" | "all";
  visibility: "all" | VisibilityName;
  category?: number;
  limit: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// 응답 정형화 — `update_post` / `fetch_post` 의 입력으로 바로 쓰일 수 있는 형태
// ─────────────────────────────────────────────────────────────────────────────

interface SearchHit {
  /** numeric postId (문자열 — `update_post` / `delete_post` 의 `postId` 인자에 그대로 박힘). */
  postId: string;
  title: string;
  /** `https://{host}/{id}` (post) 또는 `.../pages/{slogan}` (page). */
  url: string;
  /** 소문자 enum — 다른 도구 입력과 일관. */
  visibility: VisibilityName;
  /** 카테고리 이름 (응답의 `category` 필드 — `"카테고리 없음"` 가능). */
  category: string;
  /** 카테고리 id (`"0"` = 카테고리 없음). */
  categoryId: string;
  /** 게시 시각. `YYYY-MM-DD HH:MM` 형식 (admin 응답 그대로). */
  publishedAt: string;
  /** 최종 수정 시각. */
  modifiedAt: string;
  /** URL slug. */
  slogan: string;
}

interface SearchPostsResult {
  query: string;
  searchType: "title" | "content" | "all";
  /** 반환한 hits 의 개수. `limit` 또는 페이지 순회 한도에서 잘림. */
  count: number;
  /** 페이지 순회 한도 (20p) 에 닿아 더 있을 수 있음. */
  truncated: boolean;
  /** 순회한 페이지 수. */
  pagesScanned: number;
  hits: SearchHit[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const SEARCH_POSTS_TOOL_NAME = "tistory_search_posts";

/** admin posts.json 페이지 순회 한도 — update_post 의 findPostMeta 와 동일 (300건). */
const MAX_PAGES = 20;

export function registerSearchPosts(server: McpServer): void {
  server.registerTool(
    SEARCH_POSTS_TOOL_NAME,
    {
      title: "Tistory 글 검색",
      description:
        "`GET /manage/posts.json` 의 server-side 검색 (searchKeyword + searchType) 으로 글을 찾습니다. " +
        "응답은 `update_post` / `delete_post` / `fetch_post` 의 입력으로 바로 쓸 수 있는 형태 " +
        "(`postId`, `url`, `visibility` 소문자 enum, `categoryId`, `publishedAt`) 로 정규화. " +
        "★ admin endpoint 라 cookie 필수 — 세션 만료 시 `tistory_session_init` 안내. " +
        "공개 페이지 `/search/{kw}` 는 스킨 의존이라 admin 응답이 메타 풍부도에서 우위. " +
        "카테고리 이름 필터는 미지원 (id 정수만) — 사전에 `tistory_fetch_meta` 로 id 조회.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        const hits: SearchHit[] = [];
        let pagesScanned = 0;
        let truncated = false;

        for (let page = 1; page <= MAX_PAGES; page += 1) {
          pagesScanned = page;
          const res = await listPosts(ctx, {
            page,
            searchKeyword: args.query,
            searchType: args.searchType,
            visibility: args.visibility,
            // category 미지정이면 `-3` (전체) — listPosts 의 디폴트
            ...(args.category !== undefined ? { category: args.category } : {}),
          });

          // 응답이 비었거나 items 없으면 끝
          const items = res.items;
          if (!Array.isArray(items) || items.length === 0) break;

          for (const item of items) {
            hits.push(toSearchHit(item));
            if (hits.length >= args.limit) break;
          }
          if (hits.length >= args.limit) {
            // limit 채웠는데 페이지 끝이 아니면 더 있을 수 있음
            if (page < MAX_PAGES) {
              // posts.json 은 페이지당 15건 — 한 페이지 다 안 채웠다면 사실상 검색 결과의 끝
              if (items.length >= 15) truncated = true;
            }
            break;
          }

          // 페이지가 15건 미만이면 마지막 페이지
          if (items.length < 15) break;

          // 20p 까지 다 봐도 limit 안 차면 그게 진짜 끝 (truncated false)
        }

        // 페이지 한도 (20p) 에서 잘렸는지
        if (pagesScanned >= MAX_PAGES && hits.length < args.limit) {
          // 한도 끝까지 갔는데 limit 못 채움 — 진짜 결과 끝일 수도 있어 truncated 단정 불가
          // 마지막 fetch 가 15건 가득이었으면 truncated 추정 가능하지만 단순화: 한도 도달만 표시
          truncated = true;
        }

        const result: SearchPostsResult = {
          query: args.query,
          searchType: args.searchType,
          count: hits.length,
          truncated,
          pagesScanned,
          hits,
        };

        return jsonText(result);
      } catch (err) {
        return errorResult(err, args.blogUrl);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PostListItem → SearchHit 정규화
// ─────────────────────────────────────────────────────────────────────────────

function toSearchHit(item: PostListItem): SearchHit {
  return {
    postId: item.id,
    title: item.title,
    url: item.permalink,
    visibility: visibilityFromResponse(item.visibility),
    category: item.category,
    categoryId: item.categoryId,
    publishedAt: item.published,
    modifiedAt: item.modified,
    slogan: item.slogan,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답/에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function jsonText(payload: unknown) {
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

function sessionRequired(blogUrl: string) {
  return errorText(
    `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
      `(저장된 cookie 가 없거나 keytar 슬롯이 비어있습니다.)`,
  );
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) {
    return sessionRequired(blogUrl);
  }
  if (err instanceof TistoryApiError) {
    return errorText(
      `검색 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `검색 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
