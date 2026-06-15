/**
 * `tistory_update_post` — 기존 글/페이지 부분 patch. `PUT /manage/post/{id}.json` 직격.
 *
 * 핵심 함정 (docs/api.md §4):
 *   - 신규 vs 수정은 **URL path 의 `{id}` 로만 분기** — POST/`?id=`/body.id 셋 다 무시됨
 *     → 새 글 양산 방지하려면 반드시 PUT path 에 id 박을 것
 *   - 부분 patch 흉내: `/manage/posts.json` 으로 현재 메타 fetch → 인자로 덮어쓰기 → PUT
 *     (서버 PUT 은 full body 만 받음. 인자 빠진 필드를 default 로 보내면 title/content 가 지워짐)
 *   - 본문 (content) 은 현재 메타 fetch 에 포함 안 됨 — 본문 미지정 patch 는 본문 보존을
 *     위해 별도 우회 (공개 페이지 스크레이프) 가 필요하지만 fetch_post 가 아직 없음 →
 *     **본문을 바꾸지 않을 거면 `content` 인자를 비워두지 말고 명시적으로 같이 보낼 것**
 *     (이 도구는 본문 미지정 시 빈 문자열로 PUT 하지 않고 사용자에게 경고 후 abort).
 *   - visibility 응답은 문자열 enum (PRIVATE/PROTECTED/PUBLIC) — `visibilityFromResponse` 변환
 *   - 본문 이미지는 `attachments` 인자(=upload_image 의 `attachmentRef`)를 같이 보내야 영구화 (docs/api.md §5.3.1)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listPosts,
  updatePost,
  SessionExpiredError,
  TistoryApiError,
  visibilityToInt,
  visibilityFromResponse,
  type PostBody,
  type PostListItem,
  type VisibilityName,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe("블로그 host 또는 URL. 예: `saree98.tistory.com`."),
  /** postId 또는 postUrl 중 하나 — superRefine 으로 둘 중 하나 강제. */
  postId: z
    .union([z.string().min(1), z.number().int().positive()])
    .optional()
    .describe("글 ID. `postUrl` 과 둘 중 하나 필수."),
  postUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "글 URL. 예: `https://saree98.tistory.com/18`. path 끝의 숫자를 id 로 파싱. " +
        "`postId` 와 둘 중 하나 필수.",
    ),
  title: z.string().min(1).optional().describe("새 제목. 미지정 시 현재 값 유지."),
  content: z
    .string()
    .optional()
    .describe(
      "새 본문. ★ 현재 본문을 보존하려면 명시적으로 같이 보내야 합니다 " +
        "(이 도구는 본문 미지정 patch 를 거부 — 서버 PUT 이 full body 라 빈 본문이 박혀 글이 비워집니다). " +
        "본문은 그대로 두고 메타만 바꾸려면 `keepContent: true` + 현재 본문 텍스트를 별도로 가져와 다시 보내거나, " +
        "fetch_post 도구가 준비된 뒤 사용하세요.",
    ),
  category: z.number().int().nonnegative().optional().describe("새 categoryId."),
  tags: z.array(z.string().min(1)).optional().describe("새 태그 배열 (전체 교체)."),
  visibility: z
    .enum(["public", "private", "protected"])
    .optional()
    .describe("새 공개 범위. 미지정 시 현재 값 유지."),
  password: z.string().optional().describe("`protected` 일 때 비밀번호."),
  slogan: z.string().optional().describe("새 URL slug."),
  attachments: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "수정 본문에 삽입한 이미지의 영구화 ref 배열. `tistory_upload_image` 응답의 `attachmentRef` 를 그대로 넣으세요. " +
        "★ 본문 치환자의 kage 값과 글자 단위로 동일해야 하며, 누락 시 이미지가 GC 되어 404 로 깨집니다 (docs/api.md §5.3.1). " +
        "본문 이미지를 그대로 유지/추가하려면 해당 ref 들을 모두 포함하세요.",
    ),
} as const;

type Input = {
  blogUrl: string;
  postId?: string | number;
  postUrl?: string;
  title?: string;
  content?: string;
  category?: number;
  tags?: string[];
  visibility?: VisibilityName;
  password?: string;
  slogan?: string;
  attachments?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 되박기 오염 가드 — fetch_post 의 스킨 렌더 contentHtml 을 그대로 PUT 하는 사고 차단
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `fetch_post` 가 반환하는 `contentHtml` 은 **공개 페이지에서 스크레이프한 스킨 렌더 산물**이다.
 * 본문 원본이 아니라 댓글 위젯·관련글·만료 서명 이미지 URL 까지 섞인 결과물이라,
 * 이걸 그대로 `update_post` 의 `content` 로 다시 PUT 하면 (= 되박기) 글이 오염된다:
 *   - `#comment_group` (티스토리 댓글 위젯) 이 본문 안에 박힘
 *   - 관련글 위젯 컨테이너가 본문 일부로 저장됨
 *   - 발행 시점 서명이 박힌 kage 이미지 URL 이 본문에 굳어져 expires 후 404
 *
 * 사용자가 의도적으로 넣는 정상 raw HTML 과 구분하기 위해, 마커는 티스토리 스킨/CDN
 * 이 자동 생성하는 산물 특유의 것만으로 한정한다. 일반적인 본문 작성으로는 나올 수 없는
 * 시그니처들이다.
 */
const REBACK_MARKERS: ReadonlyArray<{ name: string; test: RegExp }> = [
  // 티스토리 stock 댓글 위젯. `[##_comment_group_##]` → `<div id="comment_group">`.
  { name: "댓글 위젯 (#comment_group)", test: /id\s*=\s*["']comment_group["']/i },
  // 관련글 위젯 컨테이너 — 티스토리가 본문 하단에 자동 주입.
  {
    name: "관련글 위젯",
    test: /class\s*=\s*["'][^"']*\b(?:another_category|related_post|tt_relate[a-z_]*)\b/i,
  },
  // 만료 서명이 박힌 kage 이미지 URL — 발행 시점 서명이 본문에 굳으면 expires 후 404.
  {
    name: "만료 서명 이미지 URL (kakaocdn signature)",
    test: /kakaocdn\.net\/dna\/[^"'\s]*[?&]signature=/i,
  },
];

/** 되박기 오염 마커 탐지. 하나라도 걸리면 이름 목록 반환. 깨끗하면 빈 배열. */
function detectRebackPollution(content: string): string[] {
  return REBACK_MARKERS.filter((m) => m.test.test(content)).map((m) => m.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// postUrl → postId 파싱
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `https://{host}/18` 또는 `https://{host}/pages/foo-bar` 에서 마지막 segment 추출.
 * page 인 경우 slogan 이 들어오지만 `PUT /manage/post/{id}.json` 은 ID 가 필요 →
 * 현재 메타 fetch 시 permalink 매칭으로 진짜 id 를 다시 찾는다.
 */
function parsePostIdFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// 현재 메타 fetch — listPosts 페이지네이션 순회로 일치 항목 찾기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/manage/posts.json` 에 단일 글 조회 endpoint 가 없어서 페이지 순회로 매칭.
 * 보통 최근 글이 1페이지 (15건)에 있어서 1회 fetch 로 끝나지만, 오래된 글은
 * 여러 페이지 순회 필요. 최대 20페이지 (300건) — 그 이상이면 abort.
 *
 * page 타입은 permalink 가 `/pages/{slogan}` 이라 마지막 segment 매칭이 안 됨 → permalink 비교.
 */
async function findPostMeta(
  ctx: import("../tistory/api.js").TistoryContext,
  blogHost: string,
  idOrSlogan: string,
  postUrl?: string,
): Promise<PostListItem | null> {
  const targetPermalink = postUrl ?? `https://${blogHost}/${idOrSlogan}`;
  const maxPages = 20;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await listPosts(ctx, { page });
    if (!res.items || res.items.length === 0) return null;
    for (const item of res.items) {
      if (item.id === idOrSlogan) return item;
      if (item.permalink === targetPermalink) return item;
      // page 타입은 slogan 이 들어옴
      if (item.slogan === idOrSlogan) return item;
    }
    // 다음 페이지로
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const UPDATE_POST_TOOL_NAME = "tistory_update_post";

export function registerUpdatePost(server: McpServer): void {
  server.registerTool(
    UPDATE_POST_TOOL_NAME,
    {
      title: "Tistory 글 수정 (부분 patch)",
      description:
        "`PUT /manage/post/{id}.json` 으로 기존 글의 메타·본문을 수정합니다. " +
        "현재 메타를 `/manage/posts.json` 에서 fetch → 인자로 덮어쓴 뒤 full body PUT 합니다. " +
        "★ 본문(`content`)을 인자로 안 주면 서버가 빈 본문으로 덮어쓰므로 이 도구는 거부합니다. " +
        "★ `fetch_post` 의 `contentHtml` 을 그대로 되박지 마세요 — 그건 스킨 렌더 산물이라 댓글 위젯·관련글·만료 서명 이미지 URL 이 " +
        "섞여 있어 본문이 오염되고 이미지가 만료 후 404 가 됩니다 (이 도구가 해당 마커를 감지하면 거부합니다). " +
        "본문은 원본 (마크다운 또는 깨끗한 HTML) 을 직접 작성해 보내세요. " +
        "본문에 이미지를 삽입했다면 `tistory_upload_image` 가 준 `attachmentRef` 들을 `attachments` 인자에 함께 넘기세요 (누락 시 이미지 404). " +
        "마크다운 원본은 서버가 HTML 정규화로만 보관 — 수정 시 마크다운으로 재작성 권장.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        if (args.postId == null && !args.postUrl) {
          return errorText("postId 또는 postUrl 중 하나는 필수입니다.");
        }

        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        const rawId =
          args.postId != null
            ? String(args.postId)
            : parsePostIdFromUrl(args.postUrl as string);

        const meta = await findPostMeta(ctx, ctx.host, rawId, args.postUrl);
        if (!meta) {
          return errorText(
            `대상 글을 찾을 수 없습니다: id/slogan="${rawId}". ` +
              `최근 20페이지 (300건) 내에 없거나 권한 밖. ` +
              `(listPosts 페이지네이션 한계 — 너무 오래된 글이면 별도 도구 필요)`,
          );
        }
        const realId = meta.id;

        if (args.content === undefined) {
          return errorText(
            `content 인자가 비어있습니다. 본문 미지정 patch 는 서버가 빈 본문으로 덮어쓰므로 거부합니다. ` +
              `현재 본문을 보존하려면 직접 본문 텍스트를 가져와 content 인자로 함께 보내세요.`,
          );
        }

        // 되박기 오염 가드: fetch_post 의 스킨 렌더 contentHtml 을 그대로 PUT 하려는 사고 차단.
        const polluted = detectRebackPollution(args.content);
        if (polluted.length > 0) {
          return errorText(
            `content 에 스킨 렌더 산물이 섞여 있어 거부합니다: ${polluted.join(", ")}. ` +
              `\`fetch_post\` 의 \`contentHtml\` 은 공개 페이지에서 스크레이프한 결과라 댓글 위젯·관련글·만료 서명 이미지 URL 이 ` +
              `본문에 박혀 있습니다. 이걸 그대로 update_post 에 되박으면 글이 오염되고 이미지는 만료 후 404 가 됩니다. ` +
              `원본 본문 (마크다운 또는 깨끗한 HTML) 을 직접 작성해 보내세요. 의도적으로 raw HTML 을 넣는 경우라도 ` +
              `위 산물 마커는 본문에서 제거한 뒤 넣어야 합니다.`,
          );
        }

        // 현재 메타 + 인자 머지. 빠진 필드는 메타에서 가져옴.
        const currentVisibility = visibilityFromResponse(meta.visibility);
        const visibility: VisibilityName = args.visibility ?? currentVisibility;
        const tag =
          args.tags != null ? args.tags.join(",") : ""; /* posts.json 응답에 tag 없음 — 빈 문자열 fallback */

        const fields: Partial<PostBody> = {
          title: args.title ?? meta.title,
          content: args.content,
          slogan: args.slogan ?? meta.slogan,
          visibility: visibilityToInt(visibility),
          category: args.category ?? (Number(meta.categoryId) || 0),
          tag,
          // password: 보호글이면 사용자 인자 우선, 아니면 서버 토큰 유지
          ...(args.password !== undefined
            ? { password: args.password }
            : { password: meta.postPassword }),
          // type 은 응답에 없음 — page 면 permalink 에 `/pages/` 가 있다 (docs/api.md §4)
          type: meta.permalink.includes("/pages/") ? "page" : "post",
          // 본문 이미지 영구화 — 미등록 시 orphan GC → 404 (docs/api.md §5.3.1)
          ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
        };

        const { entryUrl } = await updatePost(ctx, realId, fields);

        return {
          content: [
            {
              type: "text",
              text: [
                `수정 완료: ${entryUrl}`,
                `postId: ${realId}`,
                `visibility: ${visibility}` +
                  (visibility !== currentVisibility ? ` (← ${currentVisibility})` : ""),
                args.tags != null ? `tags: ${args.tags.join(", ") || "(없음)"}` : "",
                `※ 태그는 응답 메타에 없어 인자 미지정 시 빈 문자열로 덮어쓰입니다. ` +
                  `현재 태그를 유지하려면 같이 보내세요.`,
              ]
                .filter(Boolean)
                .join("\n"),
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
      `수정 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(`수정 실패: ${err instanceof Error ? err.message : String(err)}`);
}
