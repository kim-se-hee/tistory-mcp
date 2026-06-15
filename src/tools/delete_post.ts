/**
 * `tistory_delete_post` — 글 삭제. `DELETE /manage/post/{id}.json` 직격.
 *
 * 핵심:
 *   - 응답 `{ data: { id: number } }` (docs/api.md §4.1)
 *   - 숫자 `postId` 직접 제공 시 목록 순회 없이 DELETE path 로 직행 (path 의 `{id}` 가 진실 — docs/api.md §4.6).
 *     순회로 얻던 meta(title/permalink)는 응답 표기용 부가정보일 뿐 삭제엔 불필요.
 *   - `postUrl`/slogan 만 주어진 경우에만 listPosts 페이지 순회로 실제 id 매칭 (page 의 slogan 우회).
 *   - 삭제는 되돌릴 수 없음 — description 명시
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  deletePost,
  listPosts,
  SessionExpiredError,
  TistoryApiError,
  type PostListItem,
  type TistoryContext,
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
  postId: z
    .union([z.string().min(1), z.number().int().positive()])
    .optional()
    .describe("글 ID. `postUrl` 과 둘 중 하나 필수."),
  postUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "글 URL. 예: `https://saree98.tistory.com/18` 또는 `.../pages/foo`. " +
        "page 의 경우 slogan 만 나오므로 내부에서 listPosts 매칭으로 실제 id 를 찾습니다.",
    ),
} as const;

type Input = {
  blogUrl: string;
  postId?: string | number;
  postUrl?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// helper — postUrl → id 매칭 (page slogan 우회)
// ─────────────────────────────────────────────────────────────────────────────

function parseLastSegment(url: string): string {
  const u = new URL(url);
  return u.pathname.split("/").filter(Boolean).pop() ?? "";
}

/**
 * 숫자 `postId` 직접 제공이면 목록 순회 없이 그대로 DELETE path 로 (path 의 `{id}` 가 진실).
 * slogan/permalink 만 주어진 경우에만 페이지 순회로 실제 id 를 해소한다.
 */
async function resolvePostId(
  ctx: TistoryContext,
  rawId: string,
  postUrl: string | undefined,
  postIdDirect: boolean,
): Promise<{ id: string; meta: PostListItem } | null> {
  // 숫자 postId 직행: 순회로 얻던 meta 는 표기용일 뿐 — DELETE 에 불필요하므로 스캔 생략.
  // 실재 여부는 검증 안 함 (없으면 DELETE 가 404 → api.ts 가 throw).
  if (postIdDirect && /^\d+$/.test(rawId)) {
    return { id: rawId, meta: { id: rawId } as PostListItem };
  }

  // postUrl 의 마지막 segment 가 숫자라도 page 는 slogan 일 수 있으니 순회로 매칭.
  const target = postUrl ?? "";
  const meta = await findInListPosts(
    ctx,
    (it) =>
      it.id === rawId ||
      it.slogan === rawId ||
      (target !== "" && it.permalink === target),
  );
  if (!meta) return null;
  return { id: meta.id, meta };
}

async function findInListPosts(
  ctx: TistoryContext,
  match: (item: PostListItem) => boolean,
): Promise<PostListItem | null> {
  const maxPages = 20;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await listPosts(ctx, { page });
    if (!res.items || res.items.length === 0) return null;
    const hit = res.items.find(match);
    if (hit) return hit;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const DELETE_POST_TOOL_NAME = "tistory_delete_post";

export function registerDeletePost(server: McpServer): void {
  server.registerTool(
    DELETE_POST_TOOL_NAME,
    {
      title: "Tistory 글 삭제",
      description:
        "`DELETE /manage/post/{id}.json` 으로 글 또는 정적 페이지를 삭제합니다. " +
        "★ 되돌릴 수 없습니다. postUrl 로 호출 시 page 의 slogan 케이스를 위해 내부적으로 " +
        "`/manage/posts.json` 을 순회해 실제 id 를 매칭합니다 (최대 300건).",
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

        const postIdDirect = args.postId != null;
        const rawId = postIdDirect
          ? String(args.postId)
          : parseLastSegment(args.postUrl as string);

        const resolved = await resolvePostId(ctx, rawId, args.postUrl, postIdDirect);
        if (!resolved) {
          return errorText(
            `대상 글을 찾을 수 없습니다: "${rawId}". ` +
              `(최근 300건 내에 매칭 없음 — page slogan 이거나 너무 오래된 글일 수 있음)`,
          );
        }

        const res = await deletePost(ctx, resolved.id);
        const deletedId = res?.data?.id ?? resolved.id;

        return {
          content: [
            {
              type: "text",
              text: [
                `삭제 완료: postId=${deletedId}`,
                resolved.meta.title ? `title: ${resolved.meta.title}` : "",
                resolved.meta.permalink ? `permalink: ${resolved.meta.permalink}` : "",
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
      `삭제 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(`삭제 실패: ${err instanceof Error ? err.message : String(err)}`);
}
