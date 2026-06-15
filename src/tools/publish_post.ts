/**
 * `tistory_publish_post` — 신규 글/페이지 발행. `POST /manage/post.json` 직격 (fetch-first).
 *
 * 핵심 함정 (docs/api.md §4.6, CLAUDE.md 함정 2~4):
 *   - POST 는 **항상 신규**. body 의 `id` 도 query `?id=` 도 무시 → 수정은 `update_post` 별도
 *   - UI 의 CM5 `setValue` 가 React state 미반영 → 빈 글 양산. 그래서 fetch 직접 호출
 *   - 마크다운 원본은 서버가 HTML 정규화로만 보관 → 발행 후 마크다운 source 사라짐 (description 명시)
 *   - visibility 인자는 사용자 친화 enum (`public`/`private`/`protected`) — 내부에서 정수 변환
 *   - 본문 이미지는 `attachments` 인자(=upload_image 의 `attachmentRef`)를 같이 보내야 영구화 (docs/api.md §5.3.1)
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  publishPost,
  SessionExpiredError,
  TistoryApiError,
  visibilityToInt,
  type PostBody,
  type VisibilityName,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";
import { renderContent, type ContentFormat } from "../tistory/markdown.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  title: z.string().min(1).describe("글 제목."),
  content: z
    .string()
    .describe(
      "본문. 기본은 마크다운 (`contentFormat` 참고) — 도구가 HTML 로 변환해 발행합니다 " +
        "(★ 티스토리 서버는 마크다운을 렌더하지 않아 직접 넣으면 기호가 생노출됨, docs/api.md §4.5). " +
        "★ 서버는 HTML 로 정규화 저장 — 발행 후 마크다운 원본 복원 불가. " +
        "이미지 삽입은 `tistory_upload_image` 가 반환하는 `[##_Image|...|CDM|1.3|{json}_##]` 치환자 사용 " +
        "(치환자는 변환 중 보호되어 깨지지 않음, url 직박은 만료됨).",
    ),
  contentFormat: z
    .enum(["markdown", "html"])
    .default("markdown")
    .describe(
      "`content` 의 입력 포맷. `markdown` (기본) = 도구가 MD→HTML 변환 후 발행. " +
        "`html` = 이미 HTML 인 본문 (위험 태그/속성만 sanitize). 어느 쪽이든 이미지 치환자는 보존됩니다.",
    ),
  /** post 와 page 분기는 body 의 `type` 한 필드만 다름 (docs/api.md §4). */
  type: z
    .enum(["post", "page"])
    .default("post")
    .describe("`post` = 일반 글, `page` = 정적 페이지 (URL: `/pages/{slogan}`)."),
  category: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("categoryId 정수. 미지정 또는 `0` = 카테고리 없음. id 는 `tistory_fetch_meta` 로 조회."),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe("태그 배열. 내부에서 콤마 구분 문자열로 변환 (티스토리 body 스키마 `tag` 필드)."),
  visibility: z
    .enum(["public", "private", "protected"])
    .default("private")
    .describe(
      "공개 범위. 도구는 문자열 enum 만 받고 내부에서 정수 (0/15/20) 로 변환 (docs/api.md §4.3). " +
        "`protected` 는 비밀번호 필요 (`password` 인자).",
    ),
  password: z
    .string()
    .optional()
    .describe("`protected` 일 때 보호글 비밀번호. 그 외엔 무시 (서버 토큰이 들어감)."),
  slogan: z
    .string()
    .optional()
    .describe("URL slug. 미지정/빈 문자열이면 서버가 제목 기반 자동 생성."),
  published: z
    .boolean()
    .default(true)
    .describe("`true` = 즉시 발행, `false` = 임시저장 (추정)."),
  attachments: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "본문에 삽입한 이미지의 영구화 ref 배열. `tistory_upload_image` 응답의 `attachmentRef` 를 그대로 넣으세요. " +
        "★ 본문 치환자의 kage 값과 글자 단위로 동일해야 하며, 누락 시 이미지가 GC 되어 404 로 깨집니다 (docs/api.md §5.3.1). " +
        "이미지가 없으면 생략.",
    ),
} as const;

type Input = {
  blogUrl: string;
  title: string;
  content: string;
  contentFormat: ContentFormat;
  type: "post" | "page";
  category?: number;
  tags?: string[];
  visibility: VisibilityName;
  password?: string;
  slogan?: string;
  published: boolean;
  attachments?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const PUBLISH_POST_TOOL_NAME = "tistory_publish_post";

export function registerPublishPost(server: McpServer): void {
  server.registerTool(
    PUBLISH_POST_TOOL_NAME,
    {
      title: "Tistory 글 발행 (신규)",
      description:
        "`POST /manage/post.json` 으로 글 또는 정적 페이지를 신규 발행합니다. " +
        "본문은 마크다운/HTML 모두 허용하지만, 서버는 HTML 로 정규화 저장하므로 " +
        "발행 후 마크다운 원본은 복원 불가입니다 (수정 시 다시 마크다운 작성 권장). " +
        "이 도구는 항상 신규 글을 만듭니다 — 수정은 `tistory_update_post` 사용. " +
        "본문에 이미지를 삽입했다면 `tistory_upload_image` 가 준 `attachmentRef` 들을 `attachments` 인자에 함께 넘기세요 (누락 시 이미지 404). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) {
          return sessionRequired(args.blogUrl);
        }

        // ★ 서버는 마크다운 미렌더 → contentFormat 에 따라 변환/sanitize 후 발행 (docs/api.md §4.5).
        //   이미지 치환자는 변환 과정에서 보호됨 (markdown.ts).
        const content = renderContent(args.content, args.contentFormat);

        const fields: Partial<PostBody> = {
          title: args.title,
          content,
          type: args.type,
          visibility: visibilityToInt(args.visibility),
          category: args.category ?? 0,
          tag: (args.tags ?? []).join(","),
          published: args.published ? 1 : 0,
          // 이미지 영구화 — 미등록 시 orphan GC → 404 (docs/api.md §5.3.1)
          ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
          // slogan/password 는 미지정 시 디폴트 ("") — 서버 자동 생성/토큰
          ...(args.slogan !== undefined ? { slogan: args.slogan } : {}),
          ...(args.password !== undefined ? { password: args.password } : {}),
        };

        const { entryUrl, postId } = await publishPost(ctx, fields);

        return {
          content: [
            {
              type: "text",
              text: [
                `발행 완료: ${entryUrl}`,
                `postId: ${postId}`,
                `type: ${args.type}, visibility: ${args.visibility}`,
                args.type === "page"
                  ? `(page 는 postId 자리에 slogan 이 들어갑니다)`
                  : ``,
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
// 에러 직렬화 — 세션 만료는 LLM 이 곧바로 session_init 으로 분기할 수 있게 명시
// ─────────────────────────────────────────────────────────────────────────────

function sessionRequired(blogUrl: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
          `(저장된 cookie 가 없거나 keytar 슬롯이 비어있습니다.)`,
      },
    ],
  };
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) {
    return sessionRequired(blogUrl);
  }
  if (err instanceof TistoryApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `발행 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `발행 실패: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}
