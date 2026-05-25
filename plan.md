# Tistory MCP — 설계

블로그 주인이 LLM 한테 "글 올려" / "스킨 이거 적용해" 라고 말하면 끝나도록 만드는 MCP 서버. 지난 세션에서 직접 써보면서 반복됐던 6가지 마찰을 MCP 도구로 환원하는 게 목표.

작업 큐는 [`todo.md`](todo.md). 부속 문서:

- [`docs/api.md`](docs/api.md) — 관리자 페이지 endpoint / selector 실측
- [`docs/catalog.md`](docs/catalog.md) — 공식 docs 22 페이지 스크레이프 (1차 치환자 카탈로그, `src/tistory/catalog.ts` 로 흡수)
- [`docs/samples/`](docs/samples/) — 실측 req/resp 본문 (`apply-skin-put-body.json`, `publish-post-body.json` 등). 도구 구현 시 fixture

---

## 1. 왜 만드나

### 사용자 통증 (직전 세션 + 직접 써보기)

1. **치환자 추측** — `<s_t3>` / `<s_list_rep>` / `[##_list_rep_thumbnail_##]` 을 매번 docs 검색
2. **편집 루프 1분+** — 편집 → 관리자 업로드 → 적용 → 새로고침 → 스샷 → LLM 한테 다시
3. **미리보기 부재** — 적용 전엔 결과 모름
4. **함정 학습 비용** — 빈 `url('')` / `/tag` 404 / `<s_t3>` 스코프 / `body#tt-body-*` 스코프 등을 시행착오로
5. **글쓰기 동선** — 매번 마크다운 모드 토글 + 카테고리/태그 수동
6. **메타 확인** — 카테고리·태그·공개 상태를 일일이 클릭

### 범위

| 영역 | 포함               | 제외                            |
| ---- | ------------------ | ------------------------------- |
| 스킨 | 적용·검증·미리보기 | 시각 회귀 (LLM 멀티모달이 처리) |
| 글   | 발행/수정/삭제     | 댓글·답글 자동화                |
| 자산 | 이미지 업로드      | AI 이미지 생성 (다른 MCP)       |

---

## 2. 도구 목록

### Tools (13개)

| 이름                          | 입력                                                                                                                                                   | 동작                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tistory_session_init`        | `blogUrl`                                                                                                                                              | 헤디드 Chromium → 카카오 로그인 + 2FA. `storageState` 디스크 저장. 만료 시 다른 도구가 트리거                                                                                        |
| `tistory_publish_post`        | `content` (md or html), `title`, `category?`, `tags?`, `visibility?` (`public`/`private`/`protected`), `slogan?`, `password?`, `type?` (`post`/`page`) | `POST /manage/post.json` fetch 1방. 응답 `entryUrl` 에서 postId 추출 반환                                                                                                            |
| `tistory_update_post`         | `postId` (or `postUrl`), `content` (**필수 — 미지정 시 본문이 빈 문자열로 덮어쓰여 거부**), `title?`, `category?`, `tags?`, `visibility?`              | `PUT /manage/post/{id}.json` fetch. 현재 메타는 `/manage/posts.json` 페이지 순회 (최대 20p / 300건) 로 매칭 → 인자로 덮어쓰기 → full body PUT. **`posts.json` 응답에 `tag` 필드가 없어** 인자 미지정 시 태그가 빈 문자열로 덮어쓰임 — fetch_post 도구 준비 후 보존 우회 가능 |
| `tistory_delete_post`         | `postId` (or `postUrl`)                                                                                                                                | `DELETE /manage/post/{id}.json` fetch 1방                                                                                                                                            |
| `tistory_upload_image`        | `filePath`, `filename?`, `mime?`, `width?`, `height?`, `align?`                                                                                        | `POST /manage/post/attach.json` multipart (field `file`). 응답 `{ url, key, name, size }` + ready-to-paste `permanentReplacer` (영구 치환자 `[##_Image\|kage@{key}\|CDM\|1.3\|{json}_##]`) 동봉. `width`/`height`/`align` 은 치환자 json 메타 (`originWidth`/`originHeight`/`style`) — 미지정 시 0×0/`alignCenter`. `url` 은 ~5일 만료라 응답에서 `temporaryUrl` 로 명시 노출 |
| `tistory_apply_skin`          | `{html, css}` or `skinDir`, `isPreview?`                                                                                                               | `POST /manage/design/skin/html.json` fetch 1방                                                                                                                                       |
| `tistory_apply_skin_settings` | `{variableSettings?, skinSettings?, homeType?, coverSettings?}`                                                                                        | `GET current.json` → 머지 → `POST settings.json` (body 4필드 full snapshot, `isDirty` 없음). 변수·기본설정·홈타입·커버 부분 패치. 2026-05-25 실측 확정 (docs/api.md §6.1)            |
| `tistory_fetch_meta`          | `blogUrl` (필수 — 호스트 없으면 admin base URL · 공개 폴백 둘 다 불가)                                                                                  | admin GET → `window.Config.blog` 파싱. 카테고리(트리 평탄화)/플러그인/현재스킨/사용자/블로그설정 한 방. 세션 만료 시 공개 페이지 `window.T.config.BLOG` 폴백 (blogId/host 만). ★ 태그 카탈로그는 admin 에 없음 (docs/api.md §3.5) — 태그 조회는 별도 도구 (fetch_post / search_posts) 책임 |
| `tistory_preview_skin`        | `page` (`index`\|`entry`\|`category`\|`tag`\|`guestbook`), `variableSettings?`, `skinSettings?`, `homeType?`, `coverSettings?`                         | `POST /preview/skin/{page}` 서버 렌더. body 5필드 (`isDirty` 는 내부 처리) 중 settings 4필드는 full snapshot 의미라 `apply_skin_settings` 와 동일하게 `current.json` 머지로 보강 (안 채우면 빈 설정으로 렌더됨). `isDirty` 는 사용자 override 가 있으면 `true`, 순수 라이브면 `false`. 항상 라이브 html/css 사용 (body 에 못 보냄). 응답 = 풀 HTML 문서 |
| `tistory_screenshot`          | `url` (절대), `viewport?` (기본 1280×800)                                                                                                                                     | Playwright Chromium 헤들리스로 풀페이지 PNG 캡처 → MCP `image` content + 메타 텍스트. URL host 와 일치하는 keytar storageState 가 있으면 자동 주입 (로그인 페이지 대응), 없으면 anonymous. `waitUntil:"load"` (admin SPA polling 때문에 networkidle 영원히 안 옴). ★ Playwright 가 띄워지는 두 곳 중 하나 — session_init 외 유일한 예외 (CLAUDE.md 함정 1)                                                                                                                                                 |
| `tistory_fetch_post`          | `postUrl`                                                                                                                                              | 단일 글 본문 + 블로그 메타 동시 반환 (Notion `notion-fetch` 벤치마크). 공개 페이지 cheerio — cookie 불필요. **글 메타는 `window.T.entryInfo` 한 방** (entryId/categoryId/categoryLabel — 실측 saree98/15). **태그는 `a[rel="tag"]` 마이크로포맷** (스킨 무관). 게시/수정 시각은 `article:published_time`/`article:modified_time` og 메타. 본문은 HTML 정규화·스킨 적용된 형태 (docs/api.md §4.4) — 응답 `hint` 에 명시 |
| `skin_validate`               | `{html, css}` or `path`                                                                                                                                | 4 카테고리 정적 검증. (1) catalog 대조: 미정의 치환자/블록은 **warning** (error 아님 — catalog 가 1차 source 라 누락 가능, default 템플릿도 미정의 `[##_article_prev_link_##]` 등 사용). 변수 토큰 `[##_var_*_##]` / 이미지 치환자는 패턴 매칭으로 통과. (2) 블록 짝/중첩: `<s_*>` open/close stack + parent 룰 (catalog 정의 있을 때만) — error. (3) preview 이미지 4종 (path 모드 한정): 전부 누락 error / `preview.gif` fallback 누락 warning. (4) 함정: 빈 `url()` / `/tag` 직링크 / `<s_t3>` 누락·중복 / `<body>` 에 `[##_body_id_##]` 미바인딩. cookie 불필요. 응답: `{ errors, warnings, passed, stats: {valueTokens, blockOpens, blockCloses, previewFilesPresent} }` — `passed = errors.length === 0` |
| `tistory_search_posts`        | `blogUrl`, `query`, `searchType?` (`title`/`content`/`all`, 기본 `title`), `visibility?` (`all`/`public`/`private`/`protected`), `category?` (id 정수), `limit?` (1~300, 기본 20)                                                                                                                                                | `GET /manage/posts.json?searchKeyword=&searchType=&visibility=&category=&page=` 활용 server-side 검색. cookie 필수 (admin). 페이지 순회 최대 20p (300건). 응답 = `{ postId, title, url, visibility 소문자 enum, category, categoryId, publishedAt, modifiedAt, slogan }[]` + `{ count, truncated, pagesScanned }`. `update_post` / `delete_post` / `fetch_post` 입력으로 바로 호환되도록 평탄화. 카테고리 이름 필터 미지원 (id 정수만) — 사전에 `fetch_meta` 로 id 조회                                                                                                                                                                              |

### Resources (LLM 이 읽는 카탈로그)

| URI                          | 내용                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tistory://substitutions`    | 모든 `[##_*_##]` 와 `<s_*>` 블록 + variable system. 유효 위치 / 반환값. 1차 source = `docs/catalog.md`, 보강 = Odyssey 사용자 스킨 실측 65개 (docs/api.md §6.7) + 이미지 치환자 `[##_Image\|kage@{key}\|CDM\|1.3\|{json}_##]`                                                                                                   |
| `tistory://page-types`       | `tt-body-*` 매핑. 실측 7종 (`index`/`page`/`category`/`tag`/`search`/`guestbook`/`notice` — docs/api.md §8) + 표준 추정 2종 (`archive`/`location`)                                                                                                                                                                              |
| `tistory://gotchas`          | 알려진 함정. 4개 카테고리: 스킨 코드 / 스킨 편집 UI / 글쓰기 UI / 글쓰기 API. 아래 표 참조                                                                                                                                                                                                                                      |
| `tistory://template-default` | 동작 스킨 골격 (`skin.html` / `style.css` / `index.xml` / `preview.gif` / `preview256.jpg` / `preview560.jpg` / `preview1600.jpg`). minimal vanilla baseline — Odyssey 위젯/커버/전용 CSS 제거됨. preview 이미지 4종은 placeholder (catalog.md 권장 dims: 112×84 / 256×192 / 560×420 / 1600×1200). |

#### gotchas 상세

- **스킨 코드** — 빈 `url('')` / `/tag` 404 / `<s_t3>` 스코프 / `body#tt-body-*` 스코프 / `GET /manage/design/skin/html.json` 응답의 `html`·`css` 는 JSON-string 이라 그대로 디스크 dump 하면 `"..."` 래핑·`\n` escape 가 박힘 (`apply_skin` 으로 다시 PUT 하면 깨짐). seed 시 반드시 decode
- **스킨 편집 UI** — `스킨 등록` 버튼 z-index 차단, React 라우터 hashchange 무반응, Monaco 모델 swap (탭별 dispose), 스킨 파일 총 20MB 한도, beforeunload 다이얼로그
- **글쓰기 UI** — 자동저장 popup ("이어쓰기"), 모드 전환 confirm + 본문 lost, 카테고리 콤보 lazy fetch, 마크다운 원본 복원 불가 (HTML 정규화 저장)
- **글쓰기 API**
  - `mdCM.setValue()` 가 React state 미반영 → UI 자동화 우회. 도구는 fetch 직접 호출
  - 신규 vs 수정은 method/path 로만 분기 (POST `/manage/post.json` vs PUT `/manage/post/{id}.json`). body·query 의 id 무시 — 잘못 보내면 새 글 양산
  - `visibility` enum 표현 차이: request body = 정수 (0/15/20), posts.json response = 문자열 (PRIVATE/PROTECTED/PUBLIC)
  - 이미지 URL 은 서명/expires 박힘 (~5일). 영구는 `key` 보존 + `[##_Image|kage@{key}|...|_##]` 치환자
  - 자동저장 슬롯 명시적 DELETE 없음. 빈 body POST `/manage/autosave` 가 사실상 reset
- **스킨 변수** — variableSettings 효과는 스킨 코드 의존 (변수 안 쓰면 변경 안 보임)
- **미리보기** — `preview_skin` 는 라이브 코드만 렌더. 변경된 코드 dry-run 불가

### Prompts

| 이름 | arguments (전부 string, optional) | 권장 사용 시점 |
| --- | --- | --- |
| `tistory/new_skin` | `blogPurpose?` `style?` `colorPalette?` | 빈 종이에서 신규 스킨 작성 시작. template-default 골격 → 변수 분리 → skin_validate → preview/screenshot → apply 흐름 안내 |
| `tistory/diagnose_render` | `screenshotUrl?` `expectedBehavior?` | "왜 이상해 보이지?" 류 트러블슈팅. 페이지 식별 → skin-code 함정 → 본문/이미지 → 변수 → preview vs live → 검증 도구 순 |
| `tistory/iterate_loop` | `targetPage?` `changeScope?` | 한 사이클(1분 이내) 점진 개선. fetch_meta → skin_validate → preview_skin → screenshot → apply_skin. 부분 패치 패턴 (작게 끊어 여러 바퀴) 강조 |

구현 메모:
- MCP 스펙상 prompt argument 는 string 전용 — 모두 `z.string().optional()` raw shape.
- 핸들러는 인자를 받아 단일 `user` 텍스트 메시지를 조립. 인자가 비면 사용자에게 되묻도록 안내 라인 박음.
- `src/prompts/index.ts` 의 `registerPrompts(server)` 한 줄로 3종 일괄 등록 (resources 패턴과 동일).

> Prompts 는 워크플로우 *추천*만. 강제 아님. 도구는 LLM 이 자유 조합.

---

## 3. 핵심 결정

### 3.1. 언어: TypeScript / Node

|                      | TS/Node      | Java       | Python |
| -------------------- | ------------ | ---------- | ------ |
| Playwright 1st-party | O            | △ 커뮤니티 | O      |
| MCP SDK 성숙도       | O (레퍼런스) | △ 신생     | O      |
| 배포 (`npx -y`)      | O            | X JRE 필요 | △ venv |

**배포 마찰** 이 결정타. `npx -y @scope/tistory-mcp` 한 줄로 끝나야 함.

publish 패키징 정책: `package.json` `files` 화이트리스트 = `dist` + `templates` + `README.md` + `LICENSE` 4종만. `.npmignore` 는 안전망 (files 누락/실수 대비). `src/` `docs/` `plan.md` `todo.md` `.claude/` `.githooks/` `tsconfig.json` `package-lock.json` 은 tarball 진입 금지. `version` 은 도구 13개 + 리소스 4종 + 프롬프트 3종 완비된 첫 공개 버전을 `0.1.0` 으로 책정 (Phase 1+2 완료, Phase 3 폴리시 진행 중). publish 자체는 사용자 수동 (`npm publish --access public`) — `prepublishOnly: tsc` 훅만 자동.

함정: `npm publish --dry-run` 출력 `npm warn publish "bin[tistory-mcp]" script name was cleaned` 은 무해 (이름 정규화). LICENSE 파일은 아직 미생성 — 추가 todo 필요.

### 3.2. 인증: Notion-style JIT

티스토리는 admin OAuth scope 안 줌. 카카오 로그인 + 2FA 푸시 (카카오톡 확인 버튼) = 헤드리스 불가 (실측 확정).

★ **Playwright 가 필요한 곳은 `tistory_session_init` 과 `tistory_screenshot` 두 곳뿐**. session_init 은 카카오 OAuth + 2FA 때문에 (한 번), screenshot 은 픽셀 렌더가 본질 (호출마다). 한 번 로그인 → cookie 추출 → 이후 모든 *데이터* 도구는 `fetch + cookie` (스킨/글/이미지/메타). 브라우저 재기동 금지.

Chromium 바이너리는 `npx -y tistory-mcp` 가 자동으로 받아주지 않는다 (Playwright postinstall 은 `npm install` 시점만 동작, `npx` 실행에는 안 끼어듦). 사용자가 한 번 `npx playwright install chromium` 을 별도로 실행해야 한다 — README 첫 섹션에 박혀있다.

흐름:

```
모든 도구
  → 호출 전 세션 체크 (cookie expiry / 401·302 감지)
  → 만료/없음? "session required: call tistory_session_init" 에러
LLM 받아서
  → tistory_session_init 호출
  → 헤디드 Chromium 뜸 → 사용자 1회 로그인 (카톡 푸시 승인까지)
  → storageState → keytar (OS keychain) 에 JSON 직접 저장
    service=`tistory-mcp`, account=blog host. 별도 디스크 파일 없음.
    host 미지정 load 를 위해 `default` 별칭에도 마지막 로그인 미러링.
  → 원래 도구 재시도
```

세션 수명: 카카오/티스토리 쿠키 수일~수주 (로그인 유지 시). Notion OAuth refresh token 보다는 짧지만 충분히 실용적. 실측: 같은 세션에서 `browser_close` 후 재진입 시 만료 (Playwright context 리셋), 디스크 storageState 의 영속성은 구현 중 자연스럽게 검증.

봇 탐지 대응: 요청 간격 흔들기, 실제 user-agent, 정상 viewport.

### 3.3. JSON API 우회 (zip 빌드 폐기)

직전 설계의 zip 빌드/업로드 흐름은 _대부분 불필요_. 관리자 SPA 가 다음 endpoint 들을 cookie 만으로 노출 (2026-05-24~25 실측):

| 영역        | endpoints                                                                                                                                                                                                  | 상세               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 스킨        | `GET/POST /manage/design/skin/html.json`, `GET /manage/design/skin/current.json`, `POST /manage/design/skin/settings.json`, `POST /preview/skin/{page}`                                                    | docs/api.md §6     |
| 글 / 이미지 | `POST /manage/post.json`, `PUT/DELETE /manage/post/{id}.json`, `GET /manage/posts.json`, `POST /manage/post/attach.json`, `GET/POST /manage/autosave`                                                      | docs/api.md §4, §5 |
| 메타        | admin GET → `window.Config.blog`, `/manage/category.json`, `/manage/setting/blog.json`, `/manage/setting/contents.json`, `/manage/design/menu.json`, `/manage/design/sidebar.json`, `/manage/plugins.json` | docs/api.md §3     |

→ **Playwright 는 카카오 OAuth 세션 init 단 한 군데만 필요.** 스킨·글·이미지·메타 전부 cookie-authenticated fetch.

엔드포인트 상세 (request schema / response 예시 / 함정) 은 `docs/api.md` 참조.

---

## 4. 아키텍처

```
tistory-mcp/
  package.json            # bin: tistory-mcp
  src/
    index.ts              # MCP entry, stdio transport
    tools/                # 도구 13개 (publish_post.ts, apply_skin.ts, ...)
    resources/            # 카탈로그 md/json (substitutions, page-types, gotchas, template-default)
    prompts/
    tistory/
      catalog.ts          # 치환자 catalog (validator + resource source of truth)
                          # docs/catalog.md 의 TS 변환본 + raw HTML 재파싱 보강
      validator.ts        # catalog 대조 + 블록 중첩 + preview 이미지 누락 + 함정 검사
      browser.ts          # Playwright 세션 매니저 — session_init 전용 (카카오 OAuth 1회)
      api.ts              # cookie-auth fetch 래퍼. 11개 endpoint (스킨5 + 글5 + 메타1).
                          # 자동저장은 내부 보조 (외부에 도구로 안 노출)
      scraper.ts          # 공개 페이지 cheerio 파서 (cookie 불필요).
                          # 단일 글 본문 (§4.4 우회 1번) + og 메타 + window.T.config.BLOG.
                          # admin 의 window.Config.blog 는 api.ts 의 fetchBlogConfig 소관 (cookie 필수).
  templates/
    default/              # 동작 스킨 골격. resource source.
                          # minimal vanilla baseline (Odyssey 위젯/커버/전용 CSS 제거됨)
                          # skin.html / style.css / index.xml + preview.gif/256/560/1600
```

직전 설계 대비 변화:

- `preview/renderer.ts` (mini 치환 엔진) **삭제** — 서버 preview endpoint 가 100% 정확
- `mock.ts` 삭제
- `browser.ts` 가 **session_init 전용으로 축소** — 글쓰기/수정/이미지 다 fetch 라 브라우저 안 필요
- `api.ts` 가 가장 큰 파일 (11 endpoint)
