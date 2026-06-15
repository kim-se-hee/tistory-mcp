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
    .trim()
    .min(1)
    .describe(
      "★ 필수. 발행 대상 블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내. " +
        "파괴적 작업이므로 기본 블로그로의 조용한 폴백은 차단됩니다 — 반드시 명시하세요 (오발행 방지).",
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
    .describe(
      "categoryId 정수. 미지정 또는 `0` = 카테고리 그룹 미지정 (숨김 아님 — 홈 피드엔 정상 노출, docs/api.md §4.5). " +
        "★ 카테고리 ID 는 먼저 `tistory_fetch_meta` 로 조회해서 넘기세요 (이름이 아니라 정수 id). " +
        "블로그에 카테고리가 하나도 없다면 `tistory_categories_update` 로 먼저 만들 수 있습니다.",
    ),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe("태그 배열. 내부에서 콤마 구분 문자열로 변환 (티스토리 body 스키마 `tag` 필드)."),
  visibility: z
    .enum(["public", "private", "protected"])
    .default("private")
    .describe(
      "공개 범위. 도구는 문자열 enum 만 받고 내부에서 정수 (0/15/20) 로 변환 (docs/api.md §4.3). " +
        "`protected` 는 비밀번호 필수 (`password` 인자) — 없으면 발행 거부. " +
        "`public` 은 안전장치로 `confirmPublic:true` 가 있어야 발행됩니다.",
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
    .describe(
      "★ 초안/임시저장 토글이 아닙니다 — `false`(0) 든 `true`(1) 든 `post.json` 은 항상 실제 글을 생성합니다 (docs/api.md §4.5). " +
        "공개 여부는 `visibility` 가 결정합니다. 진짜 임시저장은 별도 autosave 슬롯이라 이 도구로는 만들 수 없습니다. " +
        "특별한 이유가 없으면 `true` 로 두세요.",
    ),
  confirmPublic: z
    .boolean()
    .default(false)
    .describe(
      "`visibility:public` 으로 발행할 때만 의미. 실수로 글이 전체 공개되는 것을 막는 안전장치입니다. " +
        "공개 발행하려면 명시적으로 `true` 로 설정하세요. `false`(기본)인 채 `public` 을 주면 발행이 거부됩니다 " +
        "(`private`/`protected` 에는 영향 없음).",
    ),
  attachments: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "본문에 삽입한 이미지의 영구화 ref 배열. `tistory_upload_image` 응답의 `attachmentRef` 를 그대로 넣으세요. " +
        "★ 본문 치환자의 kage 값과 글자 단위로 동일해야 하며, 누락 시 이미지가 GC 되어 404 로 깨집니다 (docs/api.md §5.3.1). " +
        "이미지가 없으면 생략.",
    ),
  allowNoCategory: z
    .boolean()
    .default(true)
    .describe(
      "카테고리를 지정하지 않은(또는 `0`) 발행을 허용할지. 기본 `true` — 카테고리 미지정 발행은 정상 동작입니다 " +
        "(category 0 = 숨김이 아니라 '그룹 미지정', 홈 피드엔 노출됨, docs/api.md §4.5). " +
        "특정 카테고리에 반드시 넣어야 하는 워크플로우에서 `false` 로 주면, category 미지정 시 발행을 거부하고 " +
        "`tistory_fetch_meta` 로 id 를 조회하도록 안내합니다 (실수로 미분류 발행되는 것을 막는 명시적 가드).",
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
  confirmPublic: boolean;
  attachments?: string[];
  allowNoCategory: boolean;
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
        "카테고리는 정수 id 로 지정합니다 — 이름이 아니라 id 이므로 먼저 `tistory_fetch_meta` 로 조회하세요. " +
        "category 를 생략하면 '카테고리 미지정(0)' 으로 발행되며, 이는 숨김이 아니라 그룹만 비어있는 상태입니다(홈 피드엔 노출). " +
        "본문에 이미지를 삽입했다면 `tistory_upload_image` 가 준 `attachmentRef` 들을 `attachments` 인자에 함께 넘기세요 (누락 시 이미지 404). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;

      // ★ 발행 전 가드 — 네트워크 호출 전에 막아 실수 발행/깨진 보호글/원치 않는 미분류를 차단한다.
      //   blogUrl 가드를 가장 먼저: 어느 블로그인지 모호한 채로 파괴적 작업을 시작하지 않는다.
      const guard =
        guardBlogUrl(args) ?? guardVisibility(args) ?? guardCategory(args);
      if (guard) {
        return guard;
      }

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

        // ★ 적용된 카테고리 상태를 항상 노출. 0 은 "숨김" 이 아니라 "그룹 미지정" 톤 (docs/api.md §4.5).
        const appliedCategory = args.category ?? 0;
        const categoryLine =
          appliedCategory === 0
            ? `category: 미지정 (0) — 카테고리 그룹 없이 발행됨 (숨김 아님, 홈 피드엔 노출). ` +
              `특정 카테고리에 넣으려면 tistory_fetch_meta 로 id 조회 후 재발행/수정하세요.`
            : `category: ${appliedCategory}`;

        return {
          content: [
            {
              type: "text",
              text: [
                args.visibility === "public"
                  ? `⚠ 전체 공개로 발행되었습니다: ${entryUrl}`
                  : `발행 완료: ${entryUrl}`,
                // ★ 어느 블로그에 발행했는지 항상 표기 — 오발행/잘못된 host 즉시 식별 (docs/api.md §4.6).
                `target host: ${ctx.host}`,
                `postId: ${postId}`,
                `type: ${args.type}, visibility: ${args.visibility}`,
                categoryLine,
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
// 발행 가드 — visibility 별 안전장치 (docs/api.md §4.3, §4.6)
//   protected: 비밀번호 없으면 서버 토큰이 들어가 사실상 잠기지 않은 보호글이 됨 → 거부
//   public:    confirmPublic 없으면 실수 전체공개 방지 위해 거부
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// blogUrl 가드 — 파괴적 도구는 대상 블로그를 반드시 명시해야 한다 (오발행 방지).
//   zod 가 빈/공백 문자열을 1차로 거른다(.trim().min(1))지만, 네트워크 직전에 한 번 더
//   막아 "어느 블로그인지 모호한 채로 기본 슬롯에 조용히 발행" 되는 경로를 차단한다.
//   (loadStoredCookies 는 blogUrl 미지정 시 `default` 슬롯으로 폴백 — 이 도구는 그 경로를 쓰지 않는다.)
// ─────────────────────────────────────────────────────────────────────────────

function guardBlogUrl(args: Input) {
  if (args.blogUrl.trim() === "") {
    return rejected(
      `blogUrl 이 비어 있습니다. 발행은 파괴적 작업이라 대상 블로그를 반드시 명시해야 합니다 ` +
        `(예: blogUrl="saree98.tistory.com"). 기본 블로그로의 조용한 폴백은 차단됩니다.`,
    );
  }
  return null;
}

function guardVisibility(args: Input) {
  if (args.visibility === "protected" && !args.password) {
    return rejected(
      `protected(보호글) 발행에는 비밀번호가 필요합니다. ` +
        `password 인자를 지정하거나 visibility 를 private/public 으로 바꾸세요. ` +
        `(비밀번호 없이 보내면 서버 토큰이 들어가 의도와 다른 보호글이 됩니다.)`,
    );
  }
  if (args.visibility === "public" && !args.confirmPublic) {
    return rejected(
      `public(전체 공개) 발행은 확인이 필요합니다. ` +
        `의도한 공개라면 confirmPublic:true 로 다시 호출하세요. ` +
        `초안/비공개로 두려면 visibility 를 private 으로 바꾸세요.`,
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 카테고리 가드 — opt-in. category 미지정(0) 발행은 정상이지만 (홈 피드엔 노출),
//   호출자가 allowNoCategory:false 로 명시하면 미분류 발행을 막고 id 조회로 유도한다.
//   ★ 톤 주의: "숨김 경고" 가 아니라 "그룹 미지정" — 거부 사유도 그 톤 유지 (docs/api.md §4.5).
// ─────────────────────────────────────────────────────────────────────────────

function guardCategory(args: Input) {
  const noCategory = (args.category ?? 0) === 0;
  if (noCategory && !args.allowNoCategory) {
    return rejected(
      `카테고리가 지정되지 않았습니다 (category 미지정 = 0, 그룹 없이 발행됨 — 숨김은 아니고 홈 피드엔 노출). ` +
        `allowNoCategory:false 로 호출했으므로 미분류 발행을 막았습니다. ` +
        `tistory_fetch_meta 로 categoryId 를 조회해 category 인자로 넘기거나, ` +
        `미지정 발행을 허용하려면 allowNoCategory:true 로 다시 호출하세요. ` +
        `(블로그에 카테고리가 하나도 없다면 tistory_categories_update 로 먼저 만드세요.)`,
    );
  }
  return null;
}

function rejected(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
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
