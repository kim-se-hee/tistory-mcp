/**
 * `tistory_delete_post` — 글 삭제. `DELETE /manage/post/{id}.json` 직격.
 *
 * 핵심:
 *   - 응답 `{ data: { id: number } }` (docs/api.md §4.1)
 *   - postId 또는 postUrl 둘 다 허용. postUrl 이면 path 마지막 segment 가 숫자가 아닐 수 있어 (page 의 slogan)
 *     listPosts 페이지 순회로 실제 id 매칭 → DELETE
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

/** 숫자 id 가 바로 들어오면 그대로, slogan 또는 permalink 매칭이면 페이지 순회. */
async function resolvePostId(
  ctx: TistoryContext,
  rawId: string,
  postUrl: string | undefined,
): Promise<{ id: string; meta: PostListItem } | null> {
  // 숫자만으로 구성되면 그대로 신뢰 (post 의 일반 케이스)
  if (/^\d+$/.test(rawId) && !postUrl?.includes("/pages/")) {
    // 실재 여부 확인까지는 안 함 — DELETE 가 404 면 어차피 api.ts 가 throw
    // meta 조회는 page slogan 매칭 케이스에서만 필요
    const meta = await findInListPosts(ctx, (it) => it.id === rawId);
    if (meta) return { id: meta.id, meta };
    // 못 찾았어도 id 자체는 신뢰 — listPosts 가 20페이지 (300건) 안에 없을 수 있음
    return { id: rawId, meta: { id: rawId } as PostListItem };
  }

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

        const rawId =
          args.postId != null
            ? String(args.postId)
            : parseLastSegment(args.postUrl as string);

        const resolved = await resolvePostId(ctx, rawId, args.postUrl);
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
