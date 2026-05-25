# Tistory MCP — 작업 큐

설계는 [`plan.md`](plan.md), endpoint 실측은 [`docs/api.md`](docs/api.md).
끝낸 항목은 체크박스만 닫고 본문은 남긴다 (히스토리 용).

`owns:` / `depends:` 메타는 병렬 작업 분배용. 없는 항목은 단독/직렬.

---

## Phase 1 — 사용자 통증 직격 자동화

### 인프라 (foundation — 선행)

- [ ] **foundation** — deps + `src/index.ts` MCP stdio skeleton + tsconfig 확정
  - owns: `package.json`, `package-lock.json`, `src/index.ts`, `tsconfig.json`
  - 모든 후속 task 의 선행

### 코어 모듈 (foundation 후 병렬 가능)

- [x] **catalog.ts** — 치환자 catalog (`docs/catalog.md` TS 변환 + raw HTML 보강)
  - owns: `src/tistory/catalog.ts`
- [ ] **api.ts** — 11 endpoint cookie-auth fetch 래퍼 (스킨 5 + 글 5 + 메타 1)
  - owns: `src/tistory/api.ts`
  - depends: foundation
- [ ] **browser.ts** — Playwright session_init 전용. storageState → keytar 암호화 디스크 저장
  - owns: `src/tistory/browser.ts`
  - depends: foundation
- [ ] **scraper.ts** — `window.Config.blog` + 공개 페이지 cheerio 파서
  - owns: `src/tistory/scraper.ts`
  - depends: foundation

### 도구 (코어 모듈 후)

- [ ] **tool: tistory_session_init**
  - owns: `src/tools/session_init.ts`
  - depends: browser.ts
- [ ] **tool: tistory_publish_post / update_post / delete_post**
  - owns: `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `src/tools/delete_post.ts`
  - depends: api.ts
- [ ] **tool: tistory_upload_image**
  - owns: `src/tools/upload_image.ts`
  - depends: api.ts
- [ ] **tool: tistory_apply_skin / apply_skin_settings**
  - owns: `src/tools/apply_skin.ts`, `src/tools/apply_skin_settings.ts`
  - depends: api.ts
- [ ] **tool: tistory_fetch_meta**
  - owns: `src/tools/fetch_meta.ts`
  - depends: api.ts, scraper.ts

### 리소스 (코어 모듈과 병렬 가능)

- [ ] **resources** — `tistory://substitutions` / `page-types` / `gotchas` / `template-default` 4종
  - owns: `src/resources/`
  - depends: foundation (substitutions 는 catalog.ts 의존)

### 보조

- [ ] **templates/default 정제** — Odyssey 위젯/커버/전용 CSS 제거 + preview 이미지 4종 (`preview.gif`/`preview256.jpg`/`preview560.jpg`/`preview1600.jpg`) 추가
  - owns: `templates/default/`
- [ ] **`npx` 배포 준비** — `package.json` bin + README

---

## Phase 2 — 미리보기 / 검증 보강

- [ ] **tool: tistory_preview_skin** — `POST /preview/skin/{page}` 서버 렌더
- [ ] **tool: tistory_screenshot** — Playwright 캡처 (MCP image response)
- [ ] **tool: tistory_fetch_post** — 단일 글 본문 + 블로그 메타
- [ ] **tool: skin_validate** — catalog 대조 + 블록 중첩 + preview 이미지 누락 + 함정 검사
  - owns: `src/tistory/validator.ts`, `src/tools/skin_validate.ts`
  - depends: catalog.ts
- [ ] **prompts 정리** — `tistory/new_skin` / `diagnose_render` / `iterate_loop`
  - owns: `src/prompts/`

---

## Phase 3 — 폴리시

- [ ] **tool: tistory_search_posts** — 글 검색
- [ ] **추가 template** — magazine, gallery
