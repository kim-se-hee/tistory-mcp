# Tistory MCP — 작업 큐

설계는 [`plan.md`](plan.md), endpoint 실측은 [`docs/api.md`](docs/api.md).
끝낸 항목은 체크박스만 닫고 본문은 남긴다 (히스토리 용).

`owns:` / `depends:` 메타는 병렬 작업 분배용. 없는 항목은 단독/직렬.

---

## Phase 1 — 사용자 통증 직격 자동화

### 인프라 (foundation — 선행)

- [x] **foundation** — deps + `src/index.ts` MCP stdio skeleton + tsconfig 확정
  - owns: `package.json`, `package-lock.json`, `src/index.ts`, `tsconfig.json`
  - 모든 후속 task 의 선행
- [x] **deps-bump** — 런타임 의존성 보강 (`playwright` + `keytar` + `cheerio`). browser.ts/scraper.ts 선행
  - owns: `package.json`, `package-lock.json`
  - depends: foundation
  - 사유: foundation 단계에서 빠져있던 핵심 deps. playwright (session_init headed 로그인), keytar (OS keychain storageState 저장), cheerio (scraper HTML 파싱). 설치 시 playwright 브라우저 바이너리는 `npx playwright install chromium` 별도 (README 보강은 별 todo).

### 코어 모듈 (foundation 후 병렬 가능)

- [x] **catalog.ts** — 치환자 catalog (`docs/catalog.md` TS 변환 + raw HTML 보강)
  - owns: `src/tistory/catalog.ts`
- [x] **api.ts** — 11 endpoint cookie-auth fetch 래퍼 (스킨 5 + 글 5 + 메타 1)
  - owns: `src/tistory/api.ts`
  - depends: foundation
- [x] **browser.ts** — Playwright session_init 전용. storageState → keytar 암호화 디스크 저장
  - owns: `src/tistory/browser.ts`
  - depends: foundation, deps-bump
- [x] **scraper.ts** — `window.Config.blog` + 공개 페이지 cheerio 파서
  - owns: `src/tistory/scraper.ts`
  - depends: foundation, deps-bump

### 도구 (코어 모듈 후)

- [x] **tool: tistory_session_init**
  - owns: `src/tools/session_init.ts`
  - depends: browser.ts
- [x] **tool: tistory_publish_post / update_post / delete_post**
  - owns: `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `src/tools/delete_post.ts`
  - depends: api.ts
- [x] **tool: tistory_upload_image**
  - owns: `src/tools/upload_image.ts`
  - depends: api.ts
- [x] **tool: tistory_apply_skin / apply_skin_settings**
  - owns: `src/tools/apply_skin.ts`, `src/tools/apply_skin_settings.ts`
  - depends: api.ts
- [x] **tool: tistory_fetch_meta**
  - owns: `src/tools/fetch_meta.ts`
  - depends: api.ts, scraper.ts

### 리소스 (코어 모듈과 병렬 가능)

- [x] **resources** — `tistory://substitutions` / `page-types` / `gotchas` / `template-default` 4종
  - owns: `src/resources/`
  - depends: foundation (substitutions 는 catalog.ts 의존)

### 보조

- [x] **templates/default 정제** — Odyssey 위젯/커버/전용 CSS 제거 + preview 이미지 4종 (`preview.gif`/`preview256.jpg`/`preview560.jpg`/`preview1600.jpg`) 추가
  - owns: `templates/default/`
- [x] **`npx` 배포 준비** — `package.json` bin + README
  - owns: `package.json`, `README.md`
  - depends: foundation

---

## Phase 2 — 미리보기 / 검증 보강

- [x] **tool: tistory_preview_skin** — `POST /preview/skin/{page}` 서버 렌더. body 5필드 중 `isDirty` 는 내부 처리, 라이브 html/css 사용 (body 에 못 보냄). 응답은 풀 HTML 문서
  - owns: `src/tools/preview_skin.ts`
  - depends: api.ts
- [x] **tool: tistory_screenshot** — Playwright 캡처 (MCP image response). `url` + `viewport?` 입력. browser.ts 의 storageState 재사용 (로그인 필요 페이지 대응)
  - owns: `src/tools/screenshot.ts`
  - depends: browser.ts
- [x] **tool: tistory_fetch_post** — 단일 글 본문 + 블로그 메타 동시 반환 (Notion `notion-fetch` 벤치마크). 공개 페이지 cheerio 파싱 — 쿠키 불필요
  - owns: `src/tools/fetch_post.ts`
  - depends: scraper.ts
- [x] **tool: skin_validate** — catalog 대조 + 블록 중첩 + preview 이미지 누락 + 함정 검사
  - owns: `src/tistory/validator.ts`, `src/tools/skin_validate.ts`
  - depends: catalog.ts
- [x] **prompts 정리** — `tistory/new_skin` / `diagnose_render` / `iterate_loop`
  - owns: `src/prompts/`

---

## Phase 3 — 폴리시

- [x] **tool: tistory_search_posts** — 글 검색
  - owns: `src/tools/search_posts.ts`
  - depends: api.ts
- [x] **npm publish 준비** — `package.json` `files` 화이트리스트 / `.npmignore` / `npm publish --dry-run` 으로 tarball 검증 / `version` 0.1.0 책정. `dist/` + `templates/` + `README.md` + `LICENSE` 만 포함되도록 좁히고 `src/` `docs/` `plan.md` `todo.md` `.claude/` 등 제외. publish 자체는 사용자 수동 (`npm publish --access public`) — 자동화하지 않음
  - owns: `package.json`, `.npmignore`
  - depends: foundation
- [x] **추가 template** — magazine, gallery
  - owns: `templates/magazine/`, `templates/gallery/`
  - depends: foundation
- [x] **src/index.ts wiring 수복 + 0.1.1 재발행** — 0.1.0 publish 직후 스모크에서 발견. 모든 도구·리소스·프롬프트 모듈은 만들었지만 `src/index.ts` 가 foundation 스켈레톤 (ping 1개) 그대로라 `npx -y tistory-mcp@0.1.0` 이 빈 서버를 띄움. `src/tools/index.ts` barrel 신규 + `registerTools`/`registerResources`/`registerPrompts` 호출 + 버전 0.1.1. publish 자체는 사용자 수동
  - owns: `src/index.ts`, `src/tools/index.ts`, `package.json`

---

## Phase 4 — 카테고리 CRUD

`docs/api.md §7.7` 에 메모만 있던 항목을 도구화. 인터페이스는 트리 batch 1개 (`tistory_categories_update`) — UI 가 batch 모드라 native 매칭. **실측 결과 cookie-only fetch 로 구현 가능** (`PUT /manage/category.json`, docs §3.6) — 함정 1 정책 유지.

- [x] **실측: `/manage/category` batch save XHR reverse-engineer** — Playwright 자동 시나리오 (추가 → 이름변경 → 삭제) + 네트워크 캡처로 PUT body 3종 확정. **결과 = `PUT /manage/category.json` body `{ rootLabel, delete[], append[], update[] }`** (delete=id 정수 배열, append=`id:-1` 객체, update=`label`에 이전 이름 보존, append 시 update 에 같은 객체 동시 등장). cookie-only fetch 로 재현 검증 완료. `docs/api.md §3.6` 신설. 한도 500/글 0개 삭제 가드는 UI 측 메모만 (fetch 직접 시도 미실측). visibility 토글/이동(드래그)/하위 카테고리는 별도 task 로 분리. 캡처 스크립트: `scripts/capture-category-xhr.ts`
  - owns: `docs/api.md`
- [x] **결정: 구현 경로** — fetch 가능 확정 → (a) 경로로 자동 결정. CLAUDE.md 함정 1 정책 유지 (Playwright 는 `session_init` / `screenshot` 두 곳만). api.ts 가 12 endpoint 로 늘어남
- [ ] **tool: tistory_categories_update** — 트리 batch. 입력 `tree: { id?, name, visibility?, children[] }[]` 받아 현재 트리 (`/manage/category.json` GET) 와 diff → `PUT /manage/category.json` 한 방. update 객체는 `label` 필드에 변경 전 이름 보존 (실측 그대로). append 객체는 `update` 배열에도 동시 포함 (UI 흐름 모방). 글 있는 카테고리 삭제 사전 검증 reject (entries > 0). 한도 500 검증. 응답 `{ categoryTree }` → 평탄화 반환
  - owns: `src/tools/categories_update.ts`, `src/tistory/api.ts`
  - depends: api.ts

### Phase 4 잔여 — 후속 실측 (낮은 우선순위)

- [ ] **실측: 카테고리 visibility 토글 / 하위 카테고리 / 드래그 이동** — `PUT /manage/category.json` body 가 어떻게 표현되는지. 위 핵심 실측의 같은 자동 모드 스크립트 (`scripts/capture-category-xhr.ts`) 확장으로 가능. 결과는 `docs/api.md §3.6` 보강
  - owns: `docs/api.md`
