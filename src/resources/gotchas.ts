/**
 * `tistory://gotchas` — Tistory 도구 호출 직전 LLM 이 참고하라는 함정 노트.
 *
 * 두 source 묶음:
 *  1. CLAUDE.md "핵심 함정" 7개 (도구 셋이 무너지는 원인)
 *  2. docs/api.md §9 함정 통합 (인증/CRUD/이미지/스킨/UI 자동화 5범주)
 *
 * 카테고리: skin-code / skin-edit-ui / write-ui / write-api / image / preview / auth / skin-vars.
 */

import type { McpServer, ReadResourceCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

export const GOTCHAS_URI = "tistory://gotchas";

export type GotchaCategory =
  | "auth"
  | "post-api"
  | "write-api"
  | "image"
  | "skin-api"
  | "skin-vars"
  | "preview"
  | "skin-code"
  | "skin-edit-ui"
  | "write-ui";

export type Severity = "critical" | "high" | "medium";

export interface Gotcha {
  id: string;
  category: GotchaCategory;
  severity: Severity;
  title: string;
  /** 한국어 본문. 함정의 내용 + 회피 방법. */
  body: string;
  /** docs/api.md 또는 docs/catalog.md 의 섹션 reference. */
  refs: string[];
}

const gotchas: Gotcha[] = [
  // ── CLAUDE.md 핵심 함정 7 ──────────────────────────────────────────────
  {
    id: "fetch-first",
    category: "auth",
    severity: "critical",
    title: "Playwright 는 session_init 단 한 곳만",
    body:
      "스킨/글/이미지/메타 전부 cookie + fetch 로 처리. " +
      "Playwright 는 카카오 OAuth + 2FA 푸시 때문에 `tistory_session_init` 한 도구에서만 띄우고, " +
      "다른 도구는 storageState 의 cookie 만 재사용한다. 도구마다 브라우저를 다시 띄우지 말 것.",
    refs: ["docs/api.md §1", "plan.md §3.2"],
  },
  {
    id: "cm5-setvalue-react-state",
    category: "write-api",
    severity: "critical",
    title: "CodeMirror 5 `setValue` 가 React state 미반영 → 빈 글 발행",
    body:
      "UI 자동화로 본문 textarea 에 박으면 React 가 인지 못 하고 빈 본문으로 발행된다. " +
      "그래서 `tistory_publish_post` 는 반드시 `POST /manage/post.json` fetch 직접 호출.",
    refs: ["docs/api.md §7.2"],
  },
  {
    id: "post-json-always-creates",
    category: "post-api",
    severity: "critical",
    title: "`POST /manage/post.json` 은 항상 신규 — body/query 의 id 무시",
    body:
      "POST 는 무조건 새 글을 만든다. body 의 `id` 도 query `?id=` 도 서버는 버린다. " +
      "수정은 반드시 `PUT /manage/post/{id}.json` 의 path `{id}` 로 분기. " +
      "실측: `POST .../post.json?id=18` → 새 글 20 생성됨. 잘못 보내면 글 양산.",
    refs: ["docs/api.md §4.1", "docs/api.md §4.6"],
  },
  {
    id: "visibility-enum-duality",
    category: "post-api",
    severity: "high",
    title: "visibility enum: request 는 정수, response 는 문자열",
    body:
      "request body 에는 `0` (비공개) / `15` (보호) / `20` (공개) 정수를 보낸다. " +
      "`posts.json` response 에는 `PRIVATE` / `PROTECTED` / `PUBLIC` 문자열로 온다. " +
      "도구 인자는 문자열 enum 으로 받고 내부에서 정수로 변환하는 게 LLM 친화적.",
    refs: ["docs/api.md §4.3"],
  },
  {
    id: "image-url-signed-expires",
    category: "image",
    severity: "critical",
    title: "upload 응답 `url` 은 ~5일 만료 — 영구는 `key` + 치환자",
    body:
      "`POST /manage/post/attach.json` 응답의 `url` 은 서명/expires 가 박힌 임시 URL. " +
      "본문에 그 URL 을 그대로 박으면 ~5일 후 깨진다. " +
      "영구 보관은 `key` 를 보존하고 본문에 치환자: " +
      "`[##_Image|kage@{key}|CDM|1.3|{json}_##]` (메타 JSON 포함).",
    refs: ["docs/api.md §5.2", "docs/api.md §5.3"],
  },
  {
    id: "preview-uses-live-code",
    category: "preview",
    severity: "high",
    title: "`preview/skin/{page}` 는 라이브 코드 기반 — body 에 html/css 못 보냄",
    body:
      "preview endpoint 는 변경 전 html/css 를 받지 않는다. 항상 라이브 (가장 최근 apply) 기준으로 렌더. " +
      "변경된 코드를 dry-run 하려면: `isPreview:false` 즉시 적용 → preview fetch → 백업 복구. " +
      "이 trade-off 가 싫으면 `isPreview:true` 만 써서 변경된 라이브 코드를 안전하게 띄우거나, " +
      "스킨 변수/설정만 바꾸는 preview 로 한정.",
    refs: ["docs/api.md §6.4"],
  },
  {
    id: "markdown-source-lost",
    category: "post-api",
    severity: "medium",
    title: "발행 후 마크다운 원본 복원 불가",
    body:
      "서버는 본문을 HTML 정규화만 해서 보관. 마크다운으로 보냈어도 read API 는 HTML 만 돌려준다. " +
      "도구 명세에 명시 — 사용자가 'md 그대로 다시 받고 싶다' 라고 하면 거부 또는 외부 저장 권유.",
    refs: ["docs/api.md §4.4"],
  },

  // ── docs/api.md §9 보강 (CLAUDE.md 7개와 겹치지 않는 것만) ───────────────
  {
    id: "session-expiry-redirect",
    category: "auth",
    severity: "high",
    title: "세션 만료 시 모든 endpoint 가 `/auth/login` 으로 302",
    body:
      "쿠키 만료/무효화 후 fetch 호출은 본 응답 대신 로그인 페이지 HTML 또는 302 가 온다. " +
      "도구는 응답 content-type / status / `Location` 헤더로 감지하고 " +
      '`session required: call tistory_session_init` 에러를 던져 LLM 이 재진입하게.',
    refs: ["docs/api.md §9", "plan.md §3.2"],
  },
  {
    id: "post-body-no-read-api",
    category: "post-api",
    severity: "medium",
    title: "본문 단건 read 용 JSON endpoint 가 없음",
    body:
      "`posts.json` 은 메타 + 요약만 준다. 본문 전체는 공개 페이지 스크레이프 (`scraper.ts`) " +
      "또는 관리자 `/manage/newpost/{id}` HTML 파싱으로 얻는다.",
    refs: ["docs/api.md §9", "docs/api.md §4.4"],
  },
  {
    id: "password-always-present",
    category: "post-api",
    severity: "medium",
    title: "`password` 필드는 보호글 외에도 항상 채워져 있음",
    body:
      "request body 의 `password` 는 visibility=15 (보호) 가 아니어도 빈 문자열 또는 더미가 들어가야 한다. " +
      "도구는 visibility 정수에 따라 빈 문자열을 자동 채울 것.",
    refs: ["docs/api.md §9"],
  },
  {
    id: "attach-field-name",
    category: "image",
    severity: "high",
    title: "`attach.json` multipart 필드명은 `file` 뿐",
    body:
      "`POST /manage/post/attach.json` 은 multipart 필드 이름이 정확히 `file` 이어야 한다. " +
      "`image` / `attachment` 등 변형은 거부됨.",
    refs: ["docs/api.md §5", "docs/api.md §9"],
  },
  {
    id: "keditor-native-picker",
    category: "image",
    severity: "medium",
    title: "마크다운 모드의 KEditor 첨부 UI 는 native picker 만",
    body:
      "Playwright 가 다이얼로그를 못 다룬다. 첨부는 항상 `attach.json` fetch 직접 — 그래서 " +
      "`tistory_upload_image` 도 fetch 기반.",
    refs: ["docs/api.md §5", "docs/api.md §9"],
  },
  {
    id: "skin-isPreview-flag",
    category: "skin-api",
    severity: "high",
    title: "`isPreview: true` 는 안전 dry-run, `false` 는 즉시 라이브",
    body:
      "`POST /manage/design/skin/html.json` 의 `isPreview` 플래그를 LLM 이 헷갈리기 쉽다. " +
      "`true` 면 미리보기 슬롯에만 박혀 라이브 영향 없음. `false` 는 즉시 모든 방문자에게 노출. " +
      "도구 default 는 안전한 쪽 (`true`) 으로 두고 LLM 이 의도적으로 `false` 를 요청하게.",
    refs: ["docs/api.md §6", "docs/api.md §9"],
  },
  {
    id: "skin-vars-no-effect-if-hardcoded",
    category: "skin-vars",
    severity: "medium",
    title: "variableSettings 효과는 스킨 코드 의존",
    body:
      "스킨 html/css 가 `[##_var_{NAME}_##]` 토큰을 안 쓰면 (하드코딩) UI 에서 변수 값을 바꿔도 " +
      "결과에 영향 없다. validator 가 variableSettings 키 ↔ 코드 토큰을 대조해서 경고할 것.",
    refs: ["docs/api.md §6.5", "docs/api.md §9"],
  },
  {
    id: "skin-total-20mb",
    category: "skin-api",
    severity: "medium",
    title: "스킨 파일 총 합 20MB 한도",
    body:
      "preview 이미지 4종 + images/ 자산 합쳐서 20MB 초과 시 업로드 거절. " +
      "preview1600.jpg 가 가장 큰 죄인 — 필요 없으면 빼라.",
    refs: ["docs/api.md §9"],
  },
  {
    id: "index-xml-reset",
    category: "skin-vars",
    severity: "high",
    title: "`index.xml` 의 `<variables>` 변경 시 사용자 설정 초기화",
    body:
      "변수 정의가 바뀌면 사용자가 UI 에서 설정한 variableSettings 가 전부 리셋된다. " +
      "변수 추가/삭제 전 현재 설정 백업 권장.",
    refs: ["docs/catalog.md File Structure", "docs/api.md §9"],
  },
  {
    id: "skin-empty-url",
    category: "skin-code",
    severity: "medium",
    title: "CSS 의 빈 `url('')` 은 현재 페이지를 다시 요청",
    body:
      "`background-image: url('')` 같이 빈 URL 을 쓰면 브라우저가 현재 페이지를 background 로 다시 받으려 한다. " +
      "404 가 아니라 의외의 본문이 background image 로 처리됨. variable 기본값 누락 시 자주 발생.",
    refs: ["plan.md §2 gotchas 상세"],
  },
  {
    id: "skin-tag-route-404",
    category: "skin-code",
    severity: "medium",
    title: "`/tag` 직링크는 404 가능 — 태그 클라우드 위젯 또는 `[##_taglog_link_##]` 사용",
    body:
      "스킨에서 `/tag` 로 직접 링크 박으면 일부 블로그/플러그인 설정에서 404. " +
      "`[##_taglog_link_##]` 치환자나 `<s_tag>` 클라우드를 거치는 게 안전.",
    refs: ["plan.md §2 gotchas 상세"],
  },
  {
    id: "skin-st3-scope",
    category: "skin-code",
    severity: "high",
    title: "`<s_t3>` 가 body 직속에 없으면 댓글/방명록 컴포넌트 미마운트",
    body:
      "티스토리 공통 JS 의 마운트 마커. body 안 1회 필수. " +
      "다른 블록 안에 넣거나 빼먹으면 `[##_comment_group_##]` / `[##_guestbook_group_##]` 가 빈 div 로 남음.",
    refs: ["docs/catalog.md", "src/tistory/catalog.ts blocks"],
  },
  {
    id: "skin-body-id-scope",
    category: "skin-code",
    severity: "medium",
    title: "`body#tt-body-*` 셀렉터로만 페이지별 분기 가능",
    body:
      "스킨 안에 `<html>`/`<body>` 자체를 박지 못 한다 (티스토리가 감싼다). " +
      "페이지별 스타일은 `body#tt-body-index .foo { ... }` 처럼 셀렉터로만 분기. " +
      "`tistory://page-types` resource 의 bodyId 목록 참고.",
    refs: ["docs/api.md §8", "src/resources/page-types.ts"],
  },
  {
    id: "edit-ui-register-button-zindex",
    category: "skin-edit-ui",
    severity: "medium",
    title: "`스킨 등록` 버튼 z-index 차단 → JS click 우회",
    body:
      "관리자 SPA 의 일부 오버레이가 등록 버튼을 가린다. Playwright `click()` 이 hit-test 실패. " +
      "다만 도구가 fetch-first 라 이 우회는 사실상 안 씀.",
    refs: ["docs/api.md §7.6", "plan.md §2 gotchas 상세"],
  },
  {
    id: "edit-ui-monaco-swap",
    category: "skin-edit-ui",
    severity: "medium",
    title: "Monaco 모델은 탭 전환 시 swap (dispose)",
    body:
      "스킨 편집 UI 에서 html/css 탭을 전환하면 Monaco model 이 dispose 되고 새로 만들어진다. " +
      "한 탭 끝낸 뒤 전환할 것. fetch-first 라 영향 없음.",
    refs: ["docs/api.md §7.6"],
  },
  {
    id: "edit-ui-react-router-hashchange",
    category: "skin-edit-ui",
    severity: "low" as Severity,
    title: "React 라우터가 `location.hash` 직접 변경에 무반응",
    body: "라우팅은 클릭 또는 dispatch 이벤트로. 직접 `location.hash =` 는 무시됨.",
    refs: ["docs/api.md §7.6"],
  },
  {
    id: "edit-ui-beforeunload",
    category: "skin-edit-ui",
    severity: "medium",
    title: "미저장 변경 시 `beforeunload` 다이얼로그",
    body:
      "Playwright 자동화로 페이지 닫기/네비게이션 시 confirm 이 뜬다. " +
      "`page.on('dialog')` 핸들러로 dismiss 또는 accept 자동 처리.",
    refs: ["docs/api.md §7.6"],
  },
  {
    id: "write-ui-autosave-popup",
    category: "write-ui",
    severity: "medium",
    title: "새 글 진입 시 자동저장 복구 confirm",
    body:
      '직전 세션에 자동저장된 본문이 있으면 "이어쓰기" popup. UI 자동화 시 자동 dismiss 또는 accept. ' +
      "fetch-first 라 publish 도구는 영향 없음. session_init 만 주의.",
    refs: ["docs/api.md §7.6"],
  },
  {
    id: "write-ui-mode-switch-loss",
    category: "write-ui",
    severity: "medium",
    title: "글쓰기 모드 전환 (기본/MD/HTML) 시 confirm + 본문 lost 가능",
    body:
      "마크다운 ↔ HTML ↔ 기본 모드 전환 시 본문 호환성 경고 confirm. 진행 시 일부 서식 손실. " +
      "fetch-first 발행에선 모드 자체가 무관.",
    refs: ["docs/api.md §7.6"],
  },
  {
    id: "write-ui-category-lazy",
    category: "write-ui",
    severity: "low" as Severity,
    title: "카테고리 콤보 lazy fetch",
    body: "카테고리 콤보 박스 처음 열 때 옵션 0개로 보이는 순간 있음. fetch-first 라 무관.",
    refs: ["docs/api.md §7.6"],
  },
];

const payload = {
  source: ["CLAUDE.md 핵심 함정 7", "docs/api.md §9 함정 통합"],
  hint:
    "도구 호출 직전 또는 스킨 코드 작성 직전에 LLM 이 읽는다. " +
    "category 로 필터하면 상황별 함정만 뽑기 쉬움. severity=critical 은 무시하면 도구가 깨진다.",
  gotchas,
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

export function registerGotchas(server: McpServer): void {
  server.registerResource(
    "gotchas",
    GOTCHAS_URI,
    {
      title: "Tistory 도구/스킨 함정 노트",
      description:
        "도구 호출·스킨 코드 작성 시 알아야 할 함정. " +
        "category: auth / post-api / write-api / image / skin-api / skin-vars / preview / skin-code / skin-edit-ui / write-ui. " +
        "severity: critical / high / medium.",
      mimeType: "application/json",
    },
    read,
  );
}
