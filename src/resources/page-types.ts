/**
 * `tistory://page-types` — Tistory 스킨이 렌더하는 페이지 종류.
 *
 * `tt-body-*` body id 가 페이지 분기 셀렉터. LLM 이 CSS 작성 시 (`body#tt-body-index .hero { ... }`)
 * 또는 `tistory_preview_skin` 의 `page` 인자를 정할 때 참조.
 *
 * source: docs/api.md §8 실측 7종 + 표준 추정 2종.
 */

import type { McpServer, ReadResourceCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PAGE_TYPES_URI = "tistory://page-types";

export type PageTypeStatus = "measured" | "inferred";

export interface PageType {
  /** body 의 id 속성. CSS/JS 분기 셀렉터. */
  bodyId: string;
  /** URL 패턴 예시. */
  urlPattern: string;
  /** 한국어 페이지명. */
  label: string;
  /** 페이지가 주로 렌더하는 콘텐츠 한 줄. */
  mainContent: string;
  /** 실측 여부 — 추정은 라이브 트래픽 부족으로 미확정. */
  status: PageTypeStatus;
  /** `tistory_preview_skin` 도구의 `page` 인자로 쓸 수 있는 키. 미지원이면 null. */
  previewKey: "index" | "entry" | "category" | "tag" | "guestbook" | null;
  notes?: string;
}

const types: PageType[] = [
  {
    bodyId: "tt-body-index",
    urlPattern: "/",
    label: "홈 (인덱스)",
    mainContent: "최신글 카드 / `<s_list>` 또는 `<s_cover_*>`",
    status: "measured",
    previewKey: "index",
  },
  {
    bodyId: "tt-body-page",
    urlPattern: "/{postId}",
    label: "단일 글 (permalink)",
    mainContent: "글 단건. `<s_permalink_article_rep>` / `<s_article_rep>`",
    status: "measured",
    previewKey: "entry",
    notes:
      "도구 인자 키는 `entry` (preview endpoint 의 라우팅 명칭). post 와 page(type=page) 둘 다 같은 body id 를 씀.",
  },
  {
    bodyId: "tt-body-category",
    urlPattern: "/category 또는 /category/{name}",
    label: "카테고리 목록",
    mainContent: "글 리스트 (전체 또는 카테고리별 필터)",
    status: "measured",
    previewKey: "category",
  },
  {
    bodyId: "tt-body-tag",
    urlPattern: "/tag 또는 /tag/{name}",
    label: "태그 목록 / 클라우드",
    mainContent: "`/tag` 는 태그 클라우드, `/tag/{name}` 은 글 리스트",
    status: "measured",
    previewKey: "tag",
  },
  {
    bodyId: "tt-body-search",
    urlPattern: "/search/{keyword}",
    label: "검색 결과",
    mainContent: "검색 매칭 글 리스트",
    status: "measured",
    previewKey: null,
    notes: "preview endpoint 에선 미지원 (api.md §6.4: 404). 실제 페이지로 띄워야 확인 가능.",
  },
  {
    bodyId: "tt-body-guestbook",
    urlPattern: "/guestbook",
    label: "방명록",
    mainContent: "방명록 폼 + 목록 (`<s_guest>` 또는 `[##_guestbook_group_##]`)",
    status: "measured",
    previewKey: "guestbook",
  },
  {
    bodyId: "tt-body-notice",
    urlPattern: "/notice/{id} (추정)",
    label: "공지",
    mainContent: "공지 단건 / `<s_notice_rep>`",
    status: "measured",
    previewKey: null,
    notes: "body id 자체는 확인됐으나 라이브 공지 0건이라 페이지 본문 미실측. preview 미지원.",
  },
  {
    bodyId: "tt-body-archive",
    urlPattern: "/archive/... (표준 추정)",
    label: "아카이브 (연/월)",
    mainContent: "연/월 글 묶음",
    status: "inferred",
    previewKey: null,
    notes: "구 스킨 문서에 언급되는 표준이지만 실측 안 됨.",
  },
  {
    bodyId: "tt-body-location",
    urlPattern: "/location/... (표준 추정)",
    label: "위치별",
    mainContent: "위치 정보 첨부 글 묶음",
    status: "inferred",
    previewKey: null,
    notes: "구 스킨 문서에 언급되는 표준이지만 실측 안 됨.",
  },
];

const payload = {
  source: "docs/api.md §8",
  bodySelectorHint: "body id 가 페이지 분기 셀렉터: `body#tt-body-index .hero { ... }`",
  previewToolNote:
    "`tistory_preview_skin` 의 `page` enum 은 previewKey 가 null 이 아닌 5종만 (`index`/`entry`/`category`/`tag`/`guestbook`).",
  pageTypes: types,
};

const read: ReadResourceCallback = async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(payload, null, 2),
    },
  ],
});

export function registerPageTypes(server: McpServer): void {
  server.registerResource(
    "page-types",
    PAGE_TYPES_URI,
    {
      title: "Tistory 페이지 타입 (`tt-body-*`)",
      description:
        "스킨이 렌더하는 페이지 종류 9종 (실측 7 + 추정 2). " +
        "CSS 분기 셀렉터 및 `tistory_preview_skin` 의 `page` 인자 reference.",
      mimeType: "application/json",
    },
    read,
  );
}
