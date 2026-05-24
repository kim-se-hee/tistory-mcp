/**
 * 티스토리 스킨 치환자 카탈로그 — `docs/catalog.md` 의 TS 변환본.
 *
 * 두 용도:
 *  1. `tistory://substitutions` MCP resource 의 source.
 *  2. `skin_validate` 도구가 코드 안 치환자/블록을 대조하는 reference.
 *
 * raw HTML 재파싱 보강 (Odyssey 실측 65개 등) 은 후속 작업 — `docs/api.md` §6.7.
 * 이미지 치환자 `[##_Image|kage@{KEY}|CDM|1.3|{JSON}_##]` 는 `docs/api.md` §5.3 에서 가져옴.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 페이지/블록 컨텍스트. 각 치환자가 어디서 의미를 갖는가.
 * 페이지 타입(`tt-body-*`) 과는 별개 — catalog.md 의 섹션 묶음과 1:1.
 */
export const SCOPES = [
  "common",
  "post",
  "page",
  "notice",
  "protected",
  "list",
  "paging",
  "cover",
  "comment",
  "guestbook",
  "tag-cloud",
  "sidebar",
  "image", // 이미지 치환자 (본문 어디서나) — api.md §5.3
] as const;
export type Scope = (typeof SCOPES)[number];

/** `<s_*>...</s_*>` 블록의 역할. validator 의 중첩 검사에 사용. */
export type BlockRole =
  /** 반복 렌더 (목록 1행, 댓글 1개 등) */
  | "repeat"
  /** 조건부 렌더 (있을 때만 / 첫 화면 등) */
  | "conditional"
  /** 그 안에 다른 블록을 담는 컨테이너 */
  | "container"
  /** 페이지 전역 스코프를 마킹 (예: `<s_t3>`) */
  | "scope";

export interface BlockSubstitution {
  /** 여는 태그명 — `<s_article_rep>` */
  open: string;
  /** 닫는 태그명 — `</s_article_rep>` */
  close: string;
  scope: Scope[];
  role: BlockRole;
  /** 부모 블록명들 (있을 때). 없으면 페이지 직속. */
  parents?: string[];
  description: string;
  /** 함정 / 제약 / 비고 */
  notes?: string;
}

export interface ValueSubstitution {
  /** `[##_*_##]` 토큰 그대로 */
  token: string;
  scope: Scope[];
  /** 부모 블록명 (있을 때) — 그 블록 안에서만 의미. */
  parents?: string[];
  /** 무엇을 반환/렌더하는지 한 줄 */
  returns: string;
  notes?: string;
}

export type SkinVarType = "STRING" | "SELECT" | "IMAGE" | "BOOL" | "COLOR";

export interface VariableSystem {
  types: { name: SkinVarType; description: string }[];
  /** `index.xml` `<variables>` 항목의 필드 */
  fields: { name: string; required: boolean; description: string }[];
  /** 치환자 패턴 ({NAME} 자리에 variable name) */
  tokens: { value: string; ifBlock: string; notBlock: string };
  caveat: string;
}

export interface SyntaxGuide {
  block: string;
  value: string;
  variable: { value: string; ifBlock: string; notBlock: string };
}

export interface FileSpec {
  path: string;
  /** true=필수, false=옵션, "one-of-previews"=preview 4종 중 1개 이상 */
  required: boolean | "one-of-previews";
  description: string;
  dimensions?: string;
}

export interface IndexXmlSpec {
  /** 변경 시 모든 스킨 설정 초기화 — gotcha */
  resetWarning: string;
  sections: { name: string; fields: string }[];
}

export interface SkinCatalog {
  syntax: SyntaxGuide;
  blocks: BlockSubstitution[];
  values: ValueSubstitution[];
  variables: VariableSystem;
  files: FileSpec[];
  indexXml: IndexXmlSpec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Syntax
// ─────────────────────────────────────────────────────────────────────────────

const syntax: SyntaxGuide = {
  block: "<s_NAME>...</s_NAME> — 그룹치환자 (반복 또는 조건)",
  value: "[##_NAME_##] — 값치환자",
  variable: {
    value: "[##_var_{NAME}_##]",
    ifBlock: "<s_if_var_{NAME}>...</s_if_var_{NAME}>",
    notBlock: "<s_not_var_{NAME}>...</s_not_var_{NAME}>",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Blocks (모든 `<s_*>` 그룹치환자)
// ─────────────────────────────────────────────────────────────────────────────

const blocks: BlockSubstitution[] = [
  // 공통
  {
    open: "<s_t3>",
    close: "</s_t3>",
    scope: ["common"],
    role: "scope",
    description: "티스토리 공통 JS 마운트 지점. body 안에 필수.",
    notes: "누락 시 댓글/방명록 등 React 컴포넌트가 마운트 안 됨. body 직속 1회만.",
  },

  // Post — 글 단건
  {
    open: "<s_article_rep>",
    close: "</s_article_rep>",
    scope: ["post"],
    role: "repeat",
    description: "글 본문 컨테이너 (목록·단건 어디서나 사용 가능한 통용 블록).",
  },
  {
    open: "<s_index_article_rep>",
    close: "</s_index_article_rep>",
    scope: ["post"],
    role: "repeat",
    description: "목록 페이지(index) 안에서 글 1건을 렌더하는 블록.",
  },
  {
    open: "<s_permalink_article_rep>",
    close: "</s_permalink_article_rep>",
    scope: ["post"],
    role: "container",
    description: "글 단건(permalink) 페이지의 본문 컨테이너.",
  },
  {
    open: "<s_article_rep_thumbnail>",
    close: "</s_article_rep_thumbnail>",
    scope: ["post"],
    role: "conditional",
    parents: ["<s_article_rep>", "<s_index_article_rep>", "<s_permalink_article_rep>"],
    description: "썸네일이 있을 때만 렌더되는 조건부 블록.",
  },
  {
    open: "<s_article_related>",
    close: "</s_article_related>",
    scope: ["post"],
    role: "container",
    description: "관련 글 묶음.",
  },
  {
    open: "<s_article_prev>",
    close: "</s_article_prev>",
    scope: ["post"],
    role: "conditional",
    description: "이전 글 링크 (있을 때).",
  },
  {
    open: "<s_article_next>",
    close: "</s_article_next>",
    scope: ["post"],
    role: "conditional",
    description: "다음 글 링크 (있을 때).",
  },
  {
    open: "<s_tag_label>",
    close: "</s_tag_label>",
    scope: ["post"],
    role: "container",
    description: "글의 태그 라벨 묶음 컨테이너.",
  },
  {
    open: "<s_tag_label_rep>",
    close: "</s_tag_label_rep>",
    scope: ["post"],
    role: "repeat",
    parents: ["<s_tag_label>"],
    description: "태그 라벨 1개 반복.",
  },
  {
    open: "<s_ad_div>",
    close: "</s_ad_div>",
    scope: ["post"],
    role: "conditional",
    description: "관리자 액션 (수정/삭제) — 로그인 시만 노출.",
  },
  {
    open: "<s_article_protected>",
    close: "</s_article_protected>",
    scope: ["post", "protected"],
    role: "conditional",
    description: "보호글 비번 입력 폼 (보호글일 때만 렌더).",
  },
  {
    open: "<s_rp_count>",
    close: "</s_rp_count>",
    scope: ["post"],
    role: "container",
    description: "댓글 수 표시 wrapper.",
  },

  // Notice
  {
    open: "<s_notice_rep>",
    close: "</s_notice_rep>",
    scope: ["notice"],
    role: "repeat",
    description: "공지글 1건 반복.",
  },

  // Page
  {
    open: "<s_page_rep>",
    close: "</s_page_rep>",
    scope: ["page"],
    role: "repeat",
    description: "정적 페이지(`type=page`) 1건 반복.",
  },

  // List
  {
    open: "<s_list>",
    close: "</s_list>",
    scope: ["list"],
    role: "container",
    description: "글 목록 컨테이너 (홈/카테고리/태그/검색).",
  },
  {
    open: "<s_list_rep>",
    close: "</s_list_rep>",
    scope: ["list"],
    role: "repeat",
    parents: ["<s_list>"],
    description: "목록 1행 반복.",
  },
  {
    open: "<s_list_empty>",
    close: "</s_list_empty>",
    scope: ["list"],
    role: "conditional",
    parents: ["<s_list>"],
    description: "목록이 비었을 때 표시할 블록.",
  },
  {
    open: "<s_list_rep_thumbnail>",
    close: "</s_list_rep_thumbnail>",
    scope: ["list"],
    role: "conditional",
    parents: ["<s_list_rep>"],
    description: "목록 행에 썸네일이 있을 때만 렌더.",
  },

  // Paging
  {
    open: "<s_paging>",
    close: "</s_paging>",
    scope: ["paging"],
    role: "container",
    description: "페이지네이션 컨테이너.",
  },
  {
    open: "<s_paging_rep>",
    close: "</s_paging_rep>",
    scope: ["paging"],
    role: "repeat",
    parents: ["<s_paging>"],
    description: "페이지 번호 1개 반복.",
  },

  // Cover
  {
    open: "<s_cover_group>",
    close: "</s_cover_group>",
    scope: ["cover"],
    role: "container",
    description: "홈 커버 그룹 (커버 1개).",
  },
  {
    open: "<s_cover_rep>",
    close: "</s_cover_rep>",
    scope: ["cover"],
    role: "repeat",
    parents: ["<s_cover_group>"],
    description: "커버 아이템 리스트 반복.",
  },
  {
    open: "<s_cover>",
    close: "</s_cover>",
    scope: ["cover"],
    role: "container",
    parents: ["<s_cover_rep>"],
    description: "커버 단건 wrapper.",
  },
  {
    open: "<s_cover_item>",
    close: "</s_cover_item>",
    scope: ["cover"],
    role: "repeat",
    parents: ["<s_cover_rep>"],
    description: "커버 아이템 1개 반복.",
  },
  {
    open: "<s_cover_item_thumbnail>",
    close: "</s_cover_item_thumbnail>",
    scope: ["cover"],
    role: "conditional",
    parents: ["<s_cover_item>"],
    description: "아이템에 썸네일이 있을 때만 렌더.",
  },
  {
    open: "<s_cover_item_article_info>",
    close: "</s_cover_item_article_info>",
    scope: ["cover"],
    role: "conditional",
    parents: ["<s_cover_item>"],
    description: "아이템이 글(RECENT)일 때 렌더.",
  },
  {
    open: "<s_cover_item_not_article_info>",
    close: "</s_cover_item_not_article_info>",
    scope: ["cover"],
    role: "conditional",
    parents: ["<s_cover_item>"],
    description: "아이템이 직접 입력(CUSTOM) 일 때 렌더.",
  },
  {
    open: "<s_cover_url>",
    close: "</s_cover_url>",
    scope: ["cover"],
    role: "conditional",
    parents: ["<s_cover_group>", "<s_cover>"],
    description: "커버에 URL 이 지정됐을 때만 렌더.",
  },

  // Comment
  {
    open: "<s_rp>",
    close: "</s_rp>",
    scope: ["comment"],
    role: "container",
    description: "댓글 전체 컨테이너.",
    notes:
      "★ 가장 쉬운 길은 `[##_comment_group_##]` 한 줄 사용. 수동 마크업은 본 블록 + 하위 블록 묶음.",
  },
  {
    open: "<s_rp_input_form>",
    close: "</s_rp_input_form>",
    scope: ["comment"],
    role: "container",
    parents: ["<s_rp>"],
    description: "댓글 입력 폼.",
  },
  {
    open: "<s_rp_member>",
    close: "</s_rp_member>",
    scope: ["comment"],
    role: "conditional",
    parents: ["<s_rp_input_form>"],
    description: "로그인 사용자용 영역.",
  },
  {
    open: "<s_rp_guest>",
    close: "</s_rp_guest>",
    scope: ["comment"],
    role: "conditional",
    parents: ["<s_rp_input_form>"],
    description: "비로그인 사용자용 영역 (이름/비밀번호).",
  },
  {
    open: "<s_rp_container>",
    close: "</s_rp_container>",
    scope: ["comment"],
    role: "container",
    parents: ["<s_rp>"],
    description: "댓글 목록 컨테이너.",
  },
  {
    open: "<s_rp_rep>",
    close: "</s_rp_rep>",
    scope: ["comment"],
    role: "repeat",
    parents: ["<s_rp_container>"],
    description: "댓글 1개 반복.",
  },
  {
    open: "<s_rp2_container>",
    close: "</s_rp2_container>",
    scope: ["comment"],
    role: "container",
    parents: ["<s_rp_rep>"],
    description: "대댓글 컨테이너.",
  },
  {
    open: "<s_rp2_rep>",
    close: "</s_rp2_rep>",
    scope: ["comment"],
    role: "repeat",
    parents: ["<s_rp2_container>"],
    description: "대댓글 1개 반복.",
  },

  // Guestbook
  {
    open: "<s_guest>",
    close: "</s_guest>",
    scope: ["guestbook"],
    role: "container",
    description: "방명록 전체 컨테이너.",
    notes: "★ 가장 쉬운 길은 `[##_guestbook_group_##]` 한 줄.",
  },
  {
    open: "<s_guest_input_form>",
    close: "</s_guest_input_form>",
    scope: ["guestbook"],
    role: "container",
    parents: ["<s_guest>"],
    description: "방명록 입력 폼.",
  },
  {
    open: "<s_guest_container>",
    close: "</s_guest_container>",
    scope: ["guestbook"],
    role: "container",
    parents: ["<s_guest>"],
    description: "방명록 목록 컨테이너.",
  },
  {
    open: "<s_guest_rep>",
    close: "</s_guest_rep>",
    scope: ["guestbook"],
    role: "repeat",
    parents: ["<s_guest_container>"],
    description: "방명록 1개 반복.",
  },

  // Tag Cloud
  {
    open: "<s_tag>",
    close: "</s_tag>",
    scope: ["tag-cloud"],
    role: "container",
    description: "태그 클라우드 컨테이너.",
  },
  {
    open: "<s_tag_rep>",
    close: "</s_tag_rep>",
    scope: ["tag-cloud"],
    role: "repeat",
    parents: ["<s_tag>"],
    description: "태그 1개 반복.",
  },

  // Sidebar
  {
    open: "<s_sidebar>",
    close: "</s_sidebar>",
    scope: ["sidebar"],
    role: "container",
    description: "사이드바 컨테이너.",
  },
  {
    open: "<s_sidebar_element>",
    close: "</s_sidebar_element>",
    scope: ["sidebar"],
    role: "container",
    parents: ["<s_sidebar>"],
    description: "사이드바 위젯 1개. 첫 줄 `<!-- TITLE -->` = 위젯 제목.",
  },

  // Sidebar 위젯들
  {
    open: "<s_rct_notice>",
    close: "</s_rct_notice>",
    scope: ["sidebar"],
    role: "container",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 최근 공지 컨테이너.",
  },
  {
    open: "<s_rct_notice_rep>",
    close: "</s_rct_notice_rep>",
    scope: ["sidebar"],
    role: "repeat",
    parents: ["<s_rct_notice>"],
    description: "[위젯] 최근 공지 1건 반복.",
  },
  {
    open: "<s_rctps_rep>",
    close: "</s_rctps_rep>",
    scope: ["sidebar"],
    role: "repeat",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 최근 글 1건 반복.",
  },
  {
    open: "<s_rctps_rep_thumbnail>",
    close: "</s_rctps_rep_thumbnail>",
    scope: ["sidebar"],
    role: "conditional",
    parents: ["<s_rctps_rep>"],
    description: "[위젯] 최근 글의 썸네일 (있을 때).",
  },
  {
    open: "<s_rctps_popular_rep>",
    close: "</s_rctps_popular_rep>",
    scope: ["sidebar"],
    role: "repeat",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 인기글 1건 반복. 변수 패턴은 Post 와 동일.",
  },
  {
    open: "<s_rctrp_rep>",
    close: "</s_rctrp_rep>",
    scope: ["sidebar"],
    role: "repeat",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 최근 댓글 1건 반복.",
  },
  {
    open: "<s_random_tags>",
    close: "</s_random_tags>",
    scope: ["sidebar"],
    role: "container",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 랜덤 태그 컨테이너 (tag-cloud 의 사이드바 형태).",
  },
  {
    open: "<s_search>",
    close: "</s_search>",
    scope: ["sidebar"],
    role: "container",
    parents: ["<s_sidebar_element>"],
    description: "[위젯] 검색 폼.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Values (모든 `[##_*_##]` 값치환자)
// ─────────────────────────────────────────────────────────────────────────────

const values: ValueSubstitution[] = [
  // 공통 — 모든 페이지
  { token: "[##_title_##]", scope: ["common"], returns: "블로그 제목" },
  { token: "[##_image_##]", scope: ["common"], returns: "블로그 대표 이미지 URL" },
  { token: "[##_blog_image_##]", scope: ["common"], returns: "<img> 포함된 대표 이미지" },
  { token: "[##_desc_##]", scope: ["common"], returns: "블로그 설명" },
  { token: "[##_blogger_##]", scope: ["common"], returns: "블로그 소유자 필명" },
  { token: "[##_blog_link_##]", scope: ["common"], returns: "블로그 홈 URL" },
  { token: "[##_rss_url_##]", scope: ["common"], returns: "RSS 피드 URL" },
  { token: "[##_taglog_link_##]", scope: ["common"], returns: "태그로그 URL" },
  { token: "[##_guestbook_link_##]", scope: ["common"], returns: "방명록 URL" },
  { token: "[##_page_title_##]", scope: ["common"], returns: "페이지 제목" },
  { token: "[##_blog_menu_##]", scope: ["common"], returns: "블로그 메뉴 리스트" },
  {
    token: "[##_body_id_##]",
    scope: ["common"],
    returns: "현재 페이지 타입 ID (`tt-body-*`)",
    notes:
      "body 의 id 로 사용. tt-body-index/page/category/tag/search/guestbook/notice 7종 실측 (api.md §8).",
  },
  {
    token: "[##_revenue_list_upper_##]",
    scope: ["common"],
    returns: "광고 슬롯 (홈/목록 상단)",
  },
  {
    token: "[##_revenue_list_lower_##]",
    scope: ["common"],
    returns: "광고 슬롯 (홈/목록 하단)",
  },

  // Post — 글 단건 (대부분 `<s_article_rep>` 등의 안에서 유효)
  ...((): ValueSubstitution[] => {
    const postParents = [
      "<s_article_rep>",
      "<s_index_article_rep>",
      "<s_permalink_article_rep>",
    ];
    return [
      { token: "[##_article_rep_link_##]", returns: "글 URL" },
      { token: "[##_article_rep_title_##]", returns: "제목" },
      { token: "[##_article_rep_category_##]", returns: "카테고리 명" },
      { token: "[##_article_rep_category_link_##]", returns: "카테고리 URL" },
      { token: "[##_article_rep_author_##]", returns: "작성자 (팀블로그)" },
      { token: "[##_article_rep_id_##]", returns: "글 ID" },
      {
        token: "[##_article_rep_date_##]",
        returns: "날짜/시간 (`yyyy. m. d. HH:MM`)",
      },
      { token: "[##_article_rep_simple_date_##]", returns: "날짜만 (`yyyy. m. d.`)" },
      { token: "[##_article_rep_date_year_##]", returns: "연도" },
      { token: "[##_article_rep_date_month_##]", returns: "월" },
      { token: "[##_article_rep_date_day_##]", returns: "일" },
      { token: "[##_article_rep_date_hour_##]", returns: "시" },
      { token: "[##_article_rep_date_minute_##]", returns: "분" },
      { token: "[##_article_rep_date_second_##]", returns: "초" },
      { token: "[##_article_rep_desc_##]", returns: "본문" },
      {
        token: "[##_article_rep_summary_##]",
        returns: "요약 (목록(index)에서만 의미)",
      },
      { token: "[##_article_rep_thumbnail_url_##]", returns: "썸네일 URL" },
      { token: "[##_article_rep_rp_cnt_##]", returns: "댓글 수" },
    ].map((v) => ({ ...v, scope: ["post"] as Scope[], parents: postParents }));
  })(),

  // Post 안의 태그 라벨
  {
    token: "[##_tag_label_rep_##]",
    scope: ["post"],
    parents: ["<s_tag_label_rep>"],
    returns: "태그 라벨 1개",
  },

  // Post — 보호글 관련 (Protected 섹션 변수 — Post 컨텍스트에서도 노출)
  {
    token: "[##_article_dissolve_##]",
    scope: ["post", "protected"],
    parents: ["<s_article_protected>"],
    returns: "보호글 비번 검증 JS (onsubmit/onclick)",
  },
  {
    token: "[##_article_password_##]",
    scope: ["post", "protected"],
    parents: ["<s_article_protected>"],
    returns: "보호글 비번 input id",
  },

  // Notice
  ...(
    [
      { token: "[##_notice_rep_link_##]", returns: "URL" },
      { token: "[##_notice_rep_title_##]", returns: "제목" },
      {
        token: "[##_notice_rep_date_##]",
        returns: "날짜 (`yyyy.mm.dd HH:MM`)",
      },
      { token: "[##_notice_rep_desc_##]", returns: "본문" },
      {
        token: "[##_notice_rep_summary_##]",
        returns: "요약 (목록에서만 의미)",
      },
    ] as const
  ).map<ValueSubstitution>((v) => ({
    ...v,
    scope: ["notice"],
    parents: ["<s_notice_rep>"],
    notes:
      "날짜 세부 (year/month/day/hour/minute/second) 토큰은 Post 와 동일하게 적용될 것으로 추정 (1차 source 에 명시 안 됨).",
  })),

  // Page — 변수는 사실상 Post 토큰 재사용
  ...(
    [
      "[##_article_rep_link_##]",
      "[##_article_rep_title_##]",
      "[##_article_rep_date_##]",
      "[##_article_rep_simple_date_##]",
      "[##_article_rep_date_year_##]",
      "[##_article_rep_date_month_##]",
      "[##_article_rep_date_day_##]",
      "[##_article_rep_date_hour_##]",
      "[##_article_rep_date_minute_##]",
      "[##_article_rep_date_second_##]",
      "[##_article_rep_desc_##]",
      "[##_article_rep_author_##]",
    ] as const
  ).map<ValueSubstitution>((token) => ({
    token,
    scope: ["page"],
    parents: ["<s_page_rep>"],
    returns: "Post 와 동일 — Page 컨텍스트에서 동일 의미.",
    notes: "Page 는 Post 토큰을 그대로 재사용 (날짜/링크/제목/본문/저자).",
  })),

  // List
  {
    token: "[##_list_conform_##]",
    scope: ["list"],
    parents: ["<s_list>"],
    returns: "카테고리명 / 검색어 / 태그명 (현재 목록 컨텍스트 명)",
  },
  {
    token: "[##_list_count_##]",
    scope: ["list"],
    parents: ["<s_list>"],
    returns: "전체 글 수",
  },
  {
    token: "[##_list_description_##]",
    scope: ["list"],
    parents: ["<s_list>"],
    returns: "설명",
  },
  {
    token: "[##_list_style_##]",
    scope: ["list"],
    parents: ["<s_list>"],
    returns: "리스트 스타일 (index.xml `listingType` 정의)",
  },
  {
    token: "[##_list_rep_link_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "글 URL",
  },
  {
    token: "[##_list_rep_title_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "제목 (New 뱃지 포함)",
  },
  {
    token: "[##_list_rep_summary_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "요약",
  },
  {
    token: "[##_list_rep_regdate_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "등록일 (`yyyy.mm.dd`)",
  },
  {
    token: "[##_list_rep_category_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "카테고리",
  },
  {
    token: "[##_list_rep_thumbnail_url_##]",
    scope: ["list"],
    parents: ["<s_list_rep>", "<s_list_rep_thumbnail>"],
    returns: "썸네일 URL",
  },
  {
    token: "[##_list_rep_rp_cnt_##]",
    scope: ["list"],
    parents: ["<s_list_rep>"],
    returns: "댓글 수",
  },

  // Paging
  { token: "[##_prev_page_##]", scope: ["paging"], parents: ["<s_paging>"], returns: "이전 페이지 URL" },
  { token: "[##_next_page_##]", scope: ["paging"], parents: ["<s_paging>"], returns: "다음 페이지 URL" },
  {
    token: "[##_paging_rep_link_##]",
    scope: ["paging"],
    parents: ["<s_paging_rep>"],
    returns: "페이지 N URL",
  },
  {
    token: "[##_paging_rep_link_num_##]",
    scope: ["paging"],
    parents: ["<s_paging_rep>"],
    returns: "페이지 번호",
  },
  {
    token: "[##_no_more_prev_##]",
    scope: ["paging"],
    parents: ["<s_paging>"],
    returns: "이전 페이지가 없을 때 추가될 클래스",
  },
  {
    token: "[##_no_more_next_##]",
    scope: ["paging"],
    parents: ["<s_paging>"],
    returns: "다음 페이지가 없을 때 추가될 클래스",
  },

  // Cover
  {
    token: "[##_cover_title_##]",
    scope: ["cover"],
    parents: ["<s_cover_group>", "<s_cover>"],
    returns: "커버 제목",
  },
  {
    token: "[##_cover_url_##]",
    scope: ["cover"],
    parents: ["<s_cover_url>"],
    returns: "커버 URL",
  },
  {
    token: "[##_cover_item_title_##]",
    scope: ["cover"],
    parents: ["<s_cover_item>"],
    returns: "아이템 제목",
  },
  {
    token: "[##_cover_item_url_##]",
    scope: ["cover"],
    parents: ["<s_cover_item>"],
    returns: "아이템 URL",
  },
  {
    token: "[##_cover_item_summary_##]",
    scope: ["cover"],
    parents: ["<s_cover_item>"],
    returns: "요약",
  },
  {
    token: "[##_cover_item_thumbnail_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_thumbnail>"],
    returns: "썸네일",
  },
  {
    token: "[##_cover_item_date_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_article_info>"],
    returns: "날짜",
  },
  {
    token: "[##_cover_item_simple_date_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_article_info>"],
    returns: "날짜 (간략)",
  },
  {
    token: "[##_cover_item_category_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_article_info>"],
    returns: "카테고리 명",
  },
  {
    token: "[##_cover_item_category_url_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_article_info>"],
    returns: "카테고리 URL",
  },
  {
    token: "[##_cover_item_comment_count_##]",
    scope: ["cover"],
    parents: ["<s_cover_item_article_info>"],
    returns: "댓글 수",
  },

  // Comment — 가장 쉬운 길
  {
    token: "[##_comment_group_##]",
    scope: ["post", "comment"],
    returns: "댓글 전체를 React 컴포넌트로 한 줄 마운트.",
    notes: "수동 마크업 대신 권장. `<s_t3>` 가 있어야 마운트 됨.",
  },

  // Comment — 수동 마크업 변수들
  {
    token: "[##_article_rep_id_##]",
    scope: ["comment"],
    parents: ["<s_rp_input_form>"],
    returns: "댓글 폼 ID 매핑용 글 ID",
  },
  {
    token: "[##_rp_input_comment_##]",
    scope: ["comment"],
    parents: ["<s_rp_input_form>"],
    returns: "textarea name 속성",
  },
  {
    token: "[##_rp_input_is_secret_##]",
    scope: ["comment"],
    parents: ["<s_rp_input_form>"],
    returns: "비밀댓글 checkbox name",
  },
  {
    token: "[##_rp_onclick_submit_##]",
    scope: ["comment"],
    parents: ["<s_rp_input_form>"],
    returns: "submit onclick",
  },
  {
    token: "[##_rp_rep_name_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "작성자",
  },
  {
    token: "[##_rp_rep_logo_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "프로필 이미지",
  },
  {
    token: "[##_rp_rep_date_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "날짜",
  },
  {
    token: "[##_rp_rep_desc_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "본문",
  },
  {
    token: "[##_rp_rep_link_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "permalink",
  },
  {
    token: "[##_rp_rep_onclick_delete_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "삭제 onclick",
  },
  {
    token: "[##_rp_rep_onclick_reply_##]",
    scope: ["comment"],
    parents: ["<s_rp_rep>", "<s_rp2_rep>"],
    returns: "답글 onclick",
  },

  // Guestbook — 가장 쉬운 길
  {
    token: "[##_guestbook_group_##]",
    scope: ["guestbook"],
    returns: "방명록 전체를 React 컴포넌트로 한 줄 마운트.",
    notes:
      "수동 마크업 대신 권장. 수동 시 `<s_guest>` 하위 블록 + Comment 와 유사한 변수 패턴.",
  },

  // Tag Cloud
  {
    token: "[##_tag_link_##]",
    scope: ["tag-cloud", "sidebar"],
    parents: ["<s_tag_rep>", "<s_random_tags>"],
    returns: "태그 URL",
  },
  {
    token: "[##_tag_name_##]",
    scope: ["tag-cloud", "sidebar"],
    parents: ["<s_tag_rep>", "<s_random_tags>"],
    returns: "태그명",
  },
  {
    token: "[##_tag_class_##]",
    scope: ["tag-cloud", "sidebar"],
    parents: ["<s_tag_rep>", "<s_random_tags>"],
    returns: "`cloud1`~`cloud5` (빈도 등급 클래스)",
  },

  // Sidebar — 최근 글 위젯
  ...(
    [
      { token: "[##_rctps_rep_link_##]", returns: "URL" },
      { token: "[##_rctps_rep_title_##]", returns: "제목" },
      { token: "[##_rctps_rep_date_##]", returns: "날짜" },
      { token: "[##_rctps_rep_rp_cnt_##]", returns: "댓글 수" },
      { token: "[##_rctps_rep_category_##]", returns: "카테고리 명" },
      { token: "[##_rctps_rep_category_link_##]", returns: "카테고리 URL" },
    ] as const
  ).map<ValueSubstitution>((v) => ({
    ...v,
    scope: ["sidebar"],
    parents: ["<s_rctps_rep>"],
  })),

  // Sidebar — 최근 댓글 위젯
  ...(
    [
      { token: "[##_rctrp_rep_link_##]", returns: "URL" },
      { token: "[##_rctrp_rep_desc_##]", returns: "본문" },
      { token: "[##_rctrp_rep_name_##]", returns: "작성자" },
      { token: "[##_rctrp_rep_time_##]", returns: "시간" },
    ] as const
  ).map<ValueSubstitution>((v) => ({
    ...v,
    scope: ["sidebar"],
    parents: ["<s_rctrp_rep>"],
  })),

  // Sidebar — 카테고리 위젯 (블록 없음)
  {
    token: "[##_category_##]",
    scope: ["sidebar"],
    parents: ["<s_sidebar_element>"],
    returns: "[위젯] 카테고리 — 폴더 형식 트리",
  },
  {
    token: "[##_category_list_##]",
    scope: ["sidebar"],
    parents: ["<s_sidebar_element>"],
    returns: "[위젯] 카테고리 — 리스트 형식",
  },

  // Sidebar — 방문자수 위젯 (블록 없음)
  {
    token: "[##_count_total_##]",
    scope: ["sidebar"],
    parents: ["<s_sidebar_element>"],
    returns: "[위젯] 방문자수 누적",
  },
  {
    token: "[##_count_today_##]",
    scope: ["sidebar"],
    parents: ["<s_sidebar_element>"],
    returns: "[위젯] 방문자수 오늘",
  },
  {
    token: "[##_count_yesterday_##]",
    scope: ["sidebar"],
    parents: ["<s_sidebar_element>"],
    returns: "[위젯] 방문자수 어제",
  },

  // Sidebar — 검색 위젯
  {
    token: "[##_search_name_##]",
    scope: ["sidebar"],
    parents: ["<s_search>"],
    returns: "검색 input name",
  },
  {
    token: "[##_search_text_##]",
    scope: ["sidebar"],
    parents: ["<s_search>"],
    returns: "검색 input 현재 값",
  },
  {
    token: "[##_search_onclick_submit_##]",
    scope: ["sidebar"],
    parents: ["<s_search>"],
    returns: "검색 submit onclick",
  },

  // 이미지 치환자 (api.md §5.3) — 본문 어디서나
  {
    token: "[##_Image|kage@{KEY}|CDM|1.3|{JSON}_##]",
    scope: ["image", "post", "page"],
    returns:
      "이미지 영구 삽입 형식. `{KEY}` = upload 응답의 `key`, `{JSON}` = `{originalFilename,filename,width,height,fileSize,bytesPerWebPixel,filterIds,croppedAreaPixels,deviceModel,...}` 메타.",
    notes:
      "★ upload 응답 `url` 은 ~5일 만료. 영구 보존은 반드시 이 치환자 형식으로. api.md §5.3 참조.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Variable System
// ─────────────────────────────────────────────────────────────────────────────

const variables: VariableSystem = {
  types: [
    { name: "STRING", description: "텍스트 입력" },
    {
      name: "SELECT",
      description: "드롭다운. `option` 필드 JSON 배열 `[{name,label,value}, ...]`",
    },
    { name: "IMAGE", description: "URL 기반 이미지 선택" },
    { name: "BOOL", description: "true / false 토글" },
    { name: "COLOR", description: "16진수 색" },
  ],
  fields: [
    { name: "name", required: true, description: "템플릿 치환 키" },
    { name: "label", required: true, description: "UI 표시명" },
    { name: "type", required: true, description: "STRING/SELECT/IMAGE/BOOL/COLOR 중 1" },
    { name: "default", required: true, description: "기본값" },
    { name: "description", required: false, description: "도움말" },
    { name: "option", required: false, description: "SELECT 필수. 나머지 type 에는 옵션" },
  ],
  tokens: {
    value: "[##_var_{NAME}_##]",
    ifBlock: "<s_if_var_{NAME}>...</s_if_var_{NAME}>",
    notBlock: "<s_not_var_{NAME}>...</s_not_var_{NAME}>",
  },
  caveat:
    "★ 스킨 코드가 변수를 참조하지 않으면 (예: 하드코딩) UI 에서 값을 바꿔도 효과 없음. api.md §6.5.",
};

// ─────────────────────────────────────────────────────────────────────────────
// File structure & index.xml
// ─────────────────────────────────────────────────────────────────────────────

const files: FileSpec[] = [
  {
    path: "index.xml",
    required: true,
    description: "스킨 메타. ★ 변경 시 모든 스킨 설정(variableSettings) 초기화됨.",
  },
  { path: "skin.html", required: true, description: "메인 템플릿" },
  { path: "style.css", required: true, description: "스타일" },
  {
    path: "preview.gif",
    required: "one-of-previews",
    dimensions: "112×84",
    description: "기본 — 다른 preview 가 없으면 fallback.",
  },
  {
    path: "preview256.jpg",
    required: "one-of-previews",
    dimensions: "256×192",
    description: "선택. 있으면 해당 해상도에서 우선 사용.",
  },
  {
    path: "preview560.jpg",
    required: "one-of-previews",
    dimensions: "560×420",
    description: "선택.",
  },
  {
    path: "preview1600.jpg",
    required: "one-of-previews",
    dimensions: "1600×1200",
    description: "선택.",
  },
  { path: "images/", required: false, description: "js, 추가 자산 (디렉터리)." },
];

const indexXml: IndexXmlSpec = {
  resetWarning:
    "index.xml 의 `<variables>` 정의가 바뀌면 사용자가 설정한 variableSettings 가 초기화됨.",
  sections: [
    { name: "기본", fields: "name, version, description, license" },
    { name: "작성자", fields: "name, homepage, email" },
    {
      name: "기본 설정",
      fields:
        "최근 글/댓글/트랙백 수, 태그 클라우드 옵션, 텍스트 길이 한도, 카테고리 스타일, 본문 폭",
    },
    { name: "<variables>", fields: "스킨 옵션 정의 (STRING/SELECT/IMAGE/BOOL/COLOR 중 1)" },
    {
      name: "<covers>",
      fields: "홈 커버 정의. type = RECENT (카테고리·수량 1~100) | CUSTOM (직접 입력)",
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const catalog: SkinCatalog = {
  syntax,
  blocks,
  values,
  variables,
  files,
  indexXml,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (validator / resource 가 사용)
// ─────────────────────────────────────────────────────────────────────────────

/** 토큰 이름으로 값치환자 찾기. 찾기 실패 시 undefined. */
export function findValue(token: string): ValueSubstitution | undefined {
  return values.find((v) => v.token === token);
}

/** 여는 태그명(`<s_*>`) 으로 블록 찾기. */
export function findBlock(openTag: string): BlockSubstitution | undefined {
  return blocks.find((b) => b.open === openTag);
}

/** 특정 블록을 부모로 갖는 값치환자 전체. */
export function valuesInBlock(openTag: string): ValueSubstitution[] {
  return values.filter((v) => v.parents?.includes(openTag) ?? false);
}

/** 특정 블록을 부모로 갖는 자식 블록 전체. */
export function childBlocks(openTag: string): BlockSubstitution[] {
  return blocks.filter((b) => b.parents?.includes(openTag) ?? false);
}

/** 스킨 코드에서 모든 `[##_*_##]` 토큰 추출 (validator 가 사용). */
export function extractValueTokens(code: string): string[] {
  const re = /\[##_[^\]]+?_##\]/g;
  return code.match(re) ?? [];
}

/** 스킨 코드에서 모든 `<s_*>` / `</s_*>` 태그 추출 (validator 가 사용). */
export function extractBlockTags(code: string): {
  open: string[];
  close: string[];
} {
  const openRe = /<s_[a-zA-Z0-9_]+>/g;
  const closeRe = /<\/s_[a-zA-Z0-9_]+>/g;
  return {
    open: code.match(openRe) ?? [],
    close: code.match(closeRe) ?? [],
  };
}
