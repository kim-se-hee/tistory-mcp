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
- [x] **tool: tistory_categories_update** — 트리 batch. 입력 `tree: { id?, name, visibility?, children[] }[]` 받아 현재 트리 (`/manage/category.json` GET) 와 diff → `PUT /manage/category.json` 한 방. update 객체는 `label` 필드에 변경 전 이름 보존 (실측 그대로). append 객체는 `update` 배열에도 동시 포함 (UI 흐름 모방). 글 있는 카테고리 삭제 사전 검증 reject (entries > 0). 한도 500 검증. 응답 `{ categoryTree }` → 평탄화 반환
  - owns: `src/tools/categories_update.ts`, `src/tistory/api.ts`
  - depends: api.ts

### Phase 4 잔여 — 후속 실측 (낮은 우선순위)

- [x] **실측: 카테고리 visibility 토글 / 하위 카테고리 / 드래그 이동** — ✅ 2026-06-15 controlled PUT 실측 (TEMP 카테고리 생성→GET 확인→삭제, 기존 무영향). **하위**: append `parent:<부모id>` + update 부모 `children` 중첩 미러 + 부모 `leaf:false` 3개 동시 필요 (append.children 단독은 실패). **visibility**: update `visibility` 정수 토글로 적용. **순서**: 같은 레벨 `priority`. **이동**: 부모 children 재배치(=하위와 동일). ★ GET 노드엔 `parent`/`depth`/`opened` 없음(계층=nesting). `docs/api.md §3.6.1` 신설
  - owns: `docs/api.md`
- [x] **코드: categories_update 하위/이동/visibility 지원** — 현재 `children[]` reject (루트 전용). §3.6.1 실측대로 확장: 트리 diff 시 자식은 append `parent` + update 부모 `children` 중첩 미러 + `leaf:false` 동시 생성, visibility 토글, priority 재정렬. GET 노드에 `parent`/`depth`/`opened` 없는 점 반영(타입 정정). plan.md 도구표 categories_update 행의 "루트 레벨만 지원" 갱신
  - owns: `src/tools/categories_update.ts`, `src/tistory/api.ts`, `plan.md`
  - depends: 실측: 카테고리 visibility 토글 / 하위 카테고리 / 드래그 이동

---

## Phase 5 — 노션→블로그 본질 (감사 2026-06-15)

14개 에이전트 교차검증 감사 결과. 노션 본문이 블로그에서 깨지는 두 본질 블로커 + 렌더 품질 + 어포던스.
근본원인 2개: **(A) 도구가 마크다운→HTML 변환을 안 함** (서버는 MD 렌더 안 하므로 기호 생노출 — 마크다운 생노출/치환자 텍스트/목차 미표시가 전부 여기서 파생), **(B) 발행 시 업로드 이미지 영구화(attachments) 경로 없음** (`attachments:[]` 고정 → 무서명 `dn/{key}` 404).
A 고쳐도 B 없으면 "깨진 이미지"로 바뀔 뿐 → B 가 A 와 동시 또는 선행.
감사 정정 1건: `fetch_post` 는 **이미 구현·등록됨** (`src/tools/index.ts`, contentHtml/tags/categoryId 반환). 결함은 "도구 부재" 가 아니라 "있는 부품 미배선" + stale 주석.

### P0 — 본질 블로커

- [x] **실측: post.json `attachments` 모양 (블로커 B)** — ✅ 2026-06-15 실 발행 캡처 완료 (`scripts/capture-publish-attach-xhr.ts --mode=interactive`, saree98). **결과: `attachments` 원소 = 치환자 kage 값과 글자 단위로 동일한 문자열** `kage@{key}/{filename}?{credential...&amp;signature...}` (서명 통째 포함, `&`→`&amp;`). 별도 finalize XHR 없음 — attachments 등록이 곧 finalize. bare `kage@{key}` 는 무서명 404 (이전 §5.3 가정 오류 확정). 에디터는 originWidth/Height 실픽셀 자동 채움(300×366). 공개 렌더 img src = 발행시점 서명 URL 그대로(재서명 미관찰, expires +15일 — 장기 영구는 t+15일 재확인 여지). fixture `docs/samples/publish-with-image-body.json` + `docs/api.md §5.3/§5.3.1` 정정 + `CLAUDE.md 함정 5` 정정 완료
  - owns: `docs/samples/`, `docs/api.md`
- [x] **코드: attachments 배선** — 위 실측 확정 모양대로 배선. `upload_image` 가 attachmentRef(키/객체) 반환 → `publish_post`/`update_post` 에 `attachments` 인자 추가 → fields 머지로 `PostBody.attachments` 주입. plan.md 도구표(upload_image/publish/update 행) 보강
  - owns: `src/tistory/api.ts`, `src/tools/upload_image.ts`, `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `plan.md`
  - depends: 실측: post.json `attachments` 모양 (블로커 B)
- [x] **코드: update_post contentHtml 되박기 가드** — `fetch_post` 의 스킨 적용 `contentHtml` 을 그대로 PUT 하면 comment_group/관련글/만료 URL 이 본문에 박힘. update_post description·fetch_post hint 정정(되박기 권장 문구 제거) + 되박기 패턴(comment_group/관련글/만료URL 마커) 감지 시 중단
  - owns: `src/tools/update_post.ts`, `src/tools/fetch_post.ts`
- [x] **코드: update_post 태그 보존** — `tags` 미지정 시 `tag:""` fallback(현재 `update_post.ts:190`) 제거 → `fetch_post` 의 `entry.tags` 로 현재 태그 보존, 못 가져오면 clearTags 없이 기본 중단
  - owns: `src/tools/update_post.ts`
  - depends: 코드: update_post contentHtml 되박기 가드
- [x] **정정: fetch_post 부재 stale 주석 제거** — `fetch_post` 가 이미 존재하므로 `update_post.ts`(주석 line 10-11/62, description line 150)·`fetch_post.ts` 의 "fetch_post 가 아직 없음 / 준비 후" stale 문구 + plan.md 도구표 line 42 ("fetch_post 도구 준비 후") 정정
  - owns: `src/tools/update_post.ts`, `src/tools/fetch_post.ts`, `plan.md`

### P1 — 렌더 품질

- [x] **코드: MD→HTML 변환 내장 (블로커 A)** — `marked` + `sanitize-html` 추가, `src/tistory/markdown.ts` 신설. `contentFormat` 인자(publish=`markdown` 디폴트 / update=`html` 디폴트), `publish_post`/`update_post` 의 content 분기를 변환 통과로 교체. 이미지 치환자 `[##_Image|...]` 는 플레이스홀더로 보호 후 marked 통과·원복(치환자가 깨지지 않게). plan.md 도구표 + §3 결정 보강
  - owns: `src/tistory/markdown.ts`, `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `package.json`, `package-lock.json`, `plan.md`
- [x] **실측: 티스토리 허용 HTML 화이트리스트** — ✅ 2026-06-15 비공개 테스트글로 직접 측정(코드 의존 불필요였음). **서버는 마크다운 미렌더**(MD 기호 생노출 = 블로커 A 확정), **허용 HTML 매우 관대**(h1~h6+id / table / figure·img / pre>code[class] / blockquote / a[href,target,rel] / span[style] / div[class,data-*] / iframe 통과). 서버 보강: **헤딩 auto id**(목차 직결), code hljs+복사버튼, rel/iframe 속성. sanitize 정책 = 이 화이트리스트 관대하게 + script/onclick 만 제거. `docs/api.md §4.5` 신설 기록
  - owns: `docs/api.md`
- [x] **정정: publish/update description MD 문구** — 두 도구 description 의 "마크다운/HTML 모두 허용" → "마크다운 입력 시 도구가 HTML 변환" 으로 교체. plan.md 도구표 line 41 ("content (md or html)") 동기화
  - owns: `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `plan.md`
  - depends: 코드: MD→HTML 변환 내장 (블로커 A)
- [x] **코드: upload_image 픽셀 크기 자동 채움** — 로컬 파일에서 이미지 dimension 읽어 치환자 `originWidth`/`originHeight` 자동 채움(현재 미지정 시 0×0 → 레이아웃·목차 영향). 못 구하면 `widthOrigin` 폴백 + 경고
  - owns: `src/tools/upload_image.ts`, `src/tistory/api.ts`
- [x] **코드: update_post/delete_post postId 직행** — `postId` 직접 제공 시 목록 20p 순회(현재 `update_post.ts:169` 무조건 순회) 없이 PUT/DELETE path 로 바로. postUrl/slogan 만 순회
  - owns: `src/tools/update_post.ts`, `src/tools/delete_post.ts`
- [x] **코드: published/protected 가드** — (실측 ✅ 2026-06-15: `published:0` 은 임시저장 아님 — post.json 은 항상 실제 글 생성, 0/1 무관하게 동일. 진짜 초안은 autosave 슬롯. `docs/api.md §4.5` 기록.) 코드 남음: `published` description "임시저장(추정)" 문구 정정(초안 아님 명시) + `protected` + password 미지정 시 발행 거부 + 공개 발행 명시 확인
  - owns: `src/tools/publish_post.ts`

### P2 — 어포던스·견고성

- [x] **코드: 카테고리 상태 노출** — `publish_post` 응답에 카테고리 설정 상태 항상 노출(미지정 시 조용히 0 → 명시) + description 에 `fetch_meta` 선행 안내 + (선택) `allowNoCategory` 가드 + 카테고리 0개면 `categories_update` 유도
  - owns: `src/tools/publish_post.ts`
- [x] **코드: upload_image 응답 temporaryUrl 정리** — 응답 기본에서 `temporaryUrl` 제거(permanentReplacer/key 만 노출), 만료 URL 은 `verbose` 뒤로 숨김. plan.md 도구표 line 44 동기화
  - owns: `src/tools/upload_image.ts`, `plan.md`
- [x] **코드: 파괴적 도구 blogUrl 강제** — publish/update/delete 가 `blogUrl` 필수 강제 + default 폴백 차단 + 대상 host 응답 표기 (오발행 방지)
  - owns: `src/tools/publish_post.ts`, `src/tools/update_post.ts`, `src/tools/delete_post.ts`
- [x] **코드: 세션 만료 감지 강화** — `entryUrl` 형식 검증 + 200 응답에 로그인 HTML 마커 감지 시 `SessionExpiredError` 로 변환 (현재 200 로그인 페이지를 성공으로 오인 가능)
  - owns: `src/tistory/api.ts`
- [x] **코드: CDM 치환자 description 정정** — (실측 부분확정 ✅ 블로커 B 캡처에서 `CDM|1.3` + `originWidth:300/originHeight:366/style:alignCenter` 가 실제 렌더됨 확인. align 변형(Left/Right/widthOrigin) 시각 변별은 미검증.) 코드 남음: `upload_image` description 의 CDM/align 단정 문구를 실측 기반으로 교체. align 변형 시각 검증은 별도 후속(선택)
  - owns: `docs/api.md`, `src/tools/upload_image.ts`
- [x] **실측: category 0 글의 스킨 노출** — ✅ 2026-06-15: 공개 + category 0 글은 익명 접근 200 + 블로그 index 정상 노출(홈 피드 표시). 카테고리 0 = 숨김 아님, "그룹 미지정"일 뿐. → 어포던스 메시지는 "숨김 경고" 가 아니라 "카테고리 미지정(홈엔 보임)" 톤. `docs/api.md §4.5` 기록
  - owns: `docs/api.md`

### Phase 5 별도 세션 — 스킨 TOC 드리프트 (라이브는 1024 복원 완료)

- [x] **레포: skin-toc TOC 블록 라이브 동기화** — `scripts/skin-toc.ts` 의 `TOC_STYLE`/`TOC_SCRIPT` 를 라이브 백업 블록으로 통째 교체(CSS+JS 동시, 폭 1280→1024). 목차 미표시 부차요인(헤딩 폭 규칙) 해소
  - owns: `scripts/skin-toc.ts`
- [x] **레포: skin-toc 드리프트 가드** — 마커 해시 스탬프 + apply 직전 `patched.html` 블록 해시 비교 + `doApply` 에 `doBackup` 강제 + `sync-from-live` 서브커맨드
  - owns: `scripts/skin-toc.ts`
  - depends: 레포: skin-toc TOC 블록 라이브 동기화
