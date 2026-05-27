# 티스토리 관리자 API 실측

대상 블로그: `saree98.tistory.com` (호스트 `https://saree98.tistory.com`)
실측 기간: 2026-05-24 ~ 2026-05-25 (Playwright MCP 헤디드 진입)

이 문서는 MCP 도구 구현을 위한 티스토리 관리자/공개 페이지의 endpoint·스키마·UI 구조 기록입니다. 스킨 치환자 카탈로그는 `catalog.md` 참고.

**핵심 결론**
- 로그인 1회 (헤디드) → cookie 발급 → 이후 모든 도구는 fetch 만으로 동작
- `/manage/*` 페이지 대부분이 `.json` 변종으로 데이터 API 제공
- 글 CRUD / 이미지 업로드 / 스킨 편집 모두 JSON endpoint 존재 → Playwright UI 자동화 불필요
- UI 자동화는 카카오 OAuth 진입 1회에만 필요

## 목차

1. [인증](#1-인증)
2. [전역 블로그 메타 (`window.Config`)](#2-전역-블로그-메타-windowconfig)
3. [JSON 데이터 API](#3-json-데이터-api)
4. [글 (Post / Page) CRUD](#4-글-post--page-crud)
5. [이미지 업로드](#5-이미지-업로드)
6. [스킨 편집](#6-스킨-편집)
7. [UI 자동화 (Playwright fallback)](#7-ui-자동화-playwright-fallback)
8. [공개 페이지 — 스킨이 렌더하는 곳](#8-공개-페이지--스킨이-렌더하는-곳)
9. [함정 (gotchas) 통합](#9-함정-gotchas-통합)
- [부록 A. 좌측 메뉴 카탈로그](#부록-a-좌측-메뉴-카탈로그)
- [부록 B. 정적 리소스](#부록-b-정적-리소스)
- [부록 C. 비범위 admin 영역](#부록-c-비범위-admin-영역)

---

## 1. 인증

### 1.1 로그인 동선

`/manage` 접근 시 미로그인이면 `https://www.tistory.com/auth/login?redirectUrl=...` → 카카오 OAuth (`accounts.kakao.com/login`) → **카카오톡 푸시 2차 인증** (전화번호 표시, 모바일에서 직접 승인) → `https://www.tistory.com/auth/kakao/redirect?code=...` → `/manage` 복귀.

푸시 승인은 headless 자동화 불가. `tistory_session_init` 은 반드시 헤디드.

### 1.2 cookie 추출 후 모든 API fetch

로그인 cookie 만 보존하면 §3~§6 의 모든 endpoint 를 fetch 로 호출 가능. Playwright 컨텍스트의 `context.cookies()` 결과를 다음 요청의 `Cookie` 헤더에 그대로 박는다.

### 1.3 세션 만료 신호

어느 endpoint 든 응답이 `/auth/login` 으로 리다이렉트되면 만료. 어댑터 한 곳에서 분기 → "재로그인 필요" 에러로 변환.

---

## 2. 전역 블로그 메타 (`window.Config`)

### 2.1 추출

어느 `/manage/*` HTML 페이지든 GET 하면 응답 `<script>` 안에 `window.Config = {...}` 가 inline. 단일 fetch 로 풀 메타 확보.

```js
const html = await (await fetch('https://saree98.tistory.com/manage/category', {
  headers: { cookie }
})).text();
const config = JSON.parse(html.match(/window\.Config\s*=\s*({.+?});/s)[1]);
```

스킨 편집 등 일부 경로에서 SPA fallback HTML (~13140 bytes) 이 떨어질 때도 `window.Config.blog` 는 동일하게 inline 박혀있음 → 메타 추출에는 무관.

### 2.2 노출 필드 (`Config.blog`)

실측 (2026-05, saree98.tistory.com) 기준 top-level 키:

| 필드 | 예시 / 비고 |
|---|---|
| `domain` | `"saree98.tistory.com"` |
| `customDomain` | 커스텀 도메인 (없으면 `""`) |
| `title` | 블로그 제목 |
| `manageUrl` | admin 진입 URL |
| `image` | 대표 이미지 |
| `categories` | 전체 트리 + categoryId |
| `blogSettings` | `blogId` (string), `entriesOnPage`, `language`, `timezone`, `allowWriteOnGuestbook`, `useCommentRecognition`, ... |
| `activePlugins` | active 플러그인 name 배열 (예: `["DaumShow", "SyntaxHighlight", ...]`) |
| `plugins` | 22개 전체 플러그인 메타 (name/title/active 등) |
| `skinInfo` | name, title, version, license, variables, default, cover, liststyle |
| `created` | `"2024-08-29"` |
| `visibility`, `visibilityType` | 노출 enum |
| `useMobileSkin`, `useMobile` | 모바일 스킨 토글 |
| `cclCommercial`, `cclDerive`, `targetNotification`, `uselessMargin` | 메타 토글 |

**주의 — blogId 는 top-level 이 아니라 `blogSettings.blogId` (string)** 에 박힘. `api.ts:getBlogId(blog)` 헬퍼로 number 변환.
이전(2024 초기) 응답에는 top-level `blogId: number` 와 `user: { userId, role, name, loginId }` 가 있었으나 현재는 제거됨. 유저 정보는 `/manage/setting/blog.json` 등 별도 endpoint 로 이동.

---

## 3. JSON 데이터 API

대다수 admin 페이지가 `.json` 변종으로 데이터 API 제공. cookie 만으로 모두 GET 가능.

### 3.1 endpoint 목록

| URL | 내용 |
|---|---|
| `/manage/category.json` | GET = 카테고리 트리 (§3.3), **viewChannels (홈주제 enum)**, settingSelected, settingOptionList. **PUT = batch CRUD (§3.6)** |
| `/manage/posts.json` | 글 목록 (풍부 메타 — §3.2) |
| `/manage/pages.json` | 정적 페이지 목록 |
| `/manage/notices.json` | 공지 |
| `/manage/comments.json` | 댓글 |
| `/manage/templates.json` | 서식 |
| `/manage/design/menu.json` | 블로그 공개 메뉴 (`menus`, `types` 카탈로그) |
| `/manage/design/sidebar.json` | 사이드바 모듈 (basicModules/userModules/activeModules) |
| `/manage/plugins.json` | 22개 플러그인 (name/title/description/category/active) |
| `/manage/setting/blog.json` | 블로그 메타 (blogId, name, title, address, secondaryDomain) |
| `/manage/setting/contents.json` | 글쓰기 옵션 enum (visibilityType, useCCL, CCL_commercial, contentsModify) |

JSON **미제공** (HTML 만):
- `/manage/post.json` — 글쓰기 페이지 자체 (단, 글 CRUD endpoint 는 §4 에 따로)
- `/manage/guestbook.json`
- `/manage/design/skin.json` — 스킨 라이브러리
- `/manage/statistics/blog.json`

### 3.2 `/manage/posts.json`

쿼리: `?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`
- `category=-3` = 전체. 특정 categoryId → 필터
- `searchType` = `title` / `content` / `all`
- `visibility` = `all` / `public` / `private` / `protected`

응답 items[] 스키마:

```ts
{
  id: string,                       // "18"
  author: string,                   // "ksh98"
  authorId: string,                 // "6837615"
  slogan: string,                   // URL slug
  title: string,
  visibility: "PUBLIC" | "PRIVATE" | "PROTECTED",
  category: string,                 // "카테고리 없음" / 카테고리명
  categoryId: string,               // "0" / "1363062"
  serviceCategory: null | string,   // 홈주제명
  serviceCategoryId: null | string,
  published: string,                // "2026-05-24 21:40"
  created: string,
  modified: string,
  reservedDate: null | string,      // 예약 발행 시각
  statusLabel: string,              // "비공개글" / "공개글"
  postPassword: string,             // 항상 채워짐 (보호글 외엔 서버 토큰)
  hasFile: boolean,
  permalink: string,                // "https://saree98.tistory.com/18"
  isRestrict: boolean,
  restrictLabel: null | string,
  restrictType: null | string,
  restrictMessage: null | string,
  countOfComments: string,          // "0"
  editable: boolean,
  isScheduled: boolean,
  categoryVisibility: null | "PUBLIC"
}
```

### 3.3 `/manage/category.json`

응답:
- 카테고리 트리: `{ id, name, label, priority, entries, visibility, children[], leaf }` 재귀
- `rootLabel`
- **`viewChannels`** — 티스토리 홈주제 enum (라이프 / 여행맛집 / 문화연예 / IT / 스포츠 / 시사 / 이벤트 + 하위). 글 발행 시 `serviceCategoryId` 로 매칭
- `settingSelected`, `settingOptionList` — 카테고리 표시 옵션 (이름 길이 한도, "새 글" 뱃지 기간, 글 수 노출)

### 3.4 `/manage/setting/contents.json` (글쓰기 enum)

publish 인자 검증의 source of truth:
- `visibilityType` — 3종 (정수, §4.3)
- `useCCL`, `CCL_commercial`, `CCL_derive`
- `contentsModify` 등

### 3.5 태그는 별도 API 없음

태그 관리 페이지 자체가 없음. 태그는 글에 인라인 부착 (§4.2 의 `tag` 필드) 만 source. 공개 페이지에서는 `/tag` (태그 클라우드) 와 `/tag/{name}` 으로 조회.

### 3.6 카테고리 CRUD — `PUT /manage/category.json` (batch)

★ **`/manage/category` 페이지의 `변경사항 저장` 버튼이 트리거하는 batch save endpoint.** 추가/이름변경/삭제/이동 모두 같은 PUT 한 번에 처리. cookie-only fetch 로 도구 구현 가능 (Playwright 불필요 — 함정 1 유지).

| Method/URL | Body | Response |
|---|---|---|
| `PUT /manage/category.json` | `{ rootLabel, delete[], append[], update[] }` (Content-Type: application/json) | `{ categoryTree: [...] }` — 갱신된 전체 트리 |

**Body 3개 배열의 시맨틱 (2026-05-27 실측):**

- **`delete: number[]`** — 삭제할 카테고리 ID **정수 배열만**. 객체 형태로 보내면 500.
- **`append: object[]`** — 신규 카테고리. `id: -1`, `isNew: true`, `updatedData: true`. 필드 셋:
  ```json
  {
    "id": -1,
    "name": "새 카테고리",
    "children": [],
    "depth": 1,
    "opened": true,
    "priority": 2,          // 현재 카테고리 개수 (0-based 끝 + 1)
    "visibility": 20,       // §4.3 visibility enum 과 동일 (0=비공개/15=보호/20=공개)
    "parent": 0,            // 0 = 루트. 하위 카테고리는 부모 id
    "viewChannel": null,    // 홈주제 id (string) 또는 null
    "entries": 0,
    "categoryInfo": {},
    "isNew": true,
    "updatedData": true
  }
  ```
- **`update: object[]`** — 수정할 카테고리. id 는 실제 값. **`label` 필드에 변경 전 이전 이름을 보존해 보냄** (서버 식별/충돌 검증 용으로 추정). `updatedData: false`. 필드 셋:
  ```json
  {
    "id": 1363523,
    "name": "새 이름",
    "label": "이전 이름",   // ★ 변경 전 이름. update 시에만 다름
    "priority": 2,
    "entries": 0,
    "visibility": 20,
    "viewChannel": null,
    "children": [],
    "leaf": true,
    "categoryInfo": { "liststyle": "", "image": "", "description": "" },
    "depth": 1,
    "parent": 0,
    "opened": true,
    "updatedData": false
  }
  ```

**관찰 — append 시 update 에 같은 객체 동시 등장:** UI 가 신규 카테고리 추가 시 `append` 와 `update` 두 배열에 똑같은 객체를 박는다. 이유 불명이지만 도구 구현 시 동일하게 보내는 것이 안전 (UI 흐름 모방).

**함정:**
- `delete` 에 객체 보내면 500 (`{"data":null,"message":"일시적인 문제로 처리할 수 없습니다..."}`). 반드시 ID 정수 배열.
- DELETE method 자체는 405 (`/manage/category/{id}.json`, `/manage/category.json?id=` 등 다 막힘). PUT 만 받음.
- 응답 키가 GET 과 다름: GET 은 `categories`, PUT 응답은 `categoryTree` — 둘 다 같은 트리 구조지만 키 이름 주의.
- 글이 있는 카테고리 삭제는 UI 에서 disabled (실측 — entries > 0 카테고리 row 의 `a.btn_post.삭제` 에 `.disabled` 클래스). fetch 로는 검증 없이 보낼 수 있지만 동작 미실측 — 도구에서 사전 검증 권장.
- 카테고리 한도 500 개 (`.count_total` 의 `/ 500`).

**UI 자동화 함정 (도구는 fetch-only 라 무관, 참고용):**
- 카테고리 row 의 `추가/수정/관리/이동/삭제` 액션은 `hover` 시에만 visible (`a.btn_post`). text content 매칭.
- 새 카테고리 input 박스 (`form.edit_item`) 의 commit 은 Enter/blur 가 아닌 `button.btn_default` (`확인`) 클릭이 트리거. 빈 입력에선 disabled.
- `변경사항 저장` 클래스: 비활성 = `btn_save btn_off` (`disabled` attr), 활성 = `btn_save`, 클릭 직후 = `btn_save btn_doing`. **delete 클릭 후 enable window 가 매우 짧음** (수십 ms) — 자동화 시 polling + 즉시 click 필요.
- `set_order` div 가 pointer events 가로챔 (§7.6 의 `스킨 등록` 버튼과 동일 패턴) — Playwright `click({force:true})` 또는 JS `.click()` 필요.

---

## 4. 글 (Post / Page) CRUD

★ **post/page 분기는 body 의 `type` 필드 하나만 다름.** endpoint·path·method·스키마 전부 동일. ID 시퀀스 공유. URL 패턴만 응답에서 갈림 (`/{id}` vs `/pages/{slogan}`).

### 4.1 endpoint 4종

| 동작 | Method/URL | Body | Response |
|---|---|---|---|
| 신규 발행 | `POST /manage/post.json` | §4.2 스키마, `type:"post"` 또는 `"page"` | `{ entryUrl: "https://{host}/{id}" }` (post) / `{ entryUrl: ".../pages/{slogan}" }` (page) |
| 수정 | `PUT /manage/post/{id}.json` | 동일 스키마. **body 의 `id` 와 query `?id=` 는 무시됨, path 의 `{id}` 가 진실** | 동일 패턴 |
| 삭제 | `DELETE /manage/post/{id}.json` | (none) | `{ data: { id: number } }` |
| 자동저장 | `POST /manage/autosave` | `{ title, content, tags, categoryId, draftSequence, totalWritingTimeMs }` | 200 |

`Content-Type: application/json`, `Accept: application/json`.

검증: 글 18 PUT → modified 시각 갱신 + title 변경 반영, 글 19/20 DELETE → posts.json 에서 사라짐.

### 4.2 body 스키마 (POST/PUT 공통)

```json
{
  "id": "0",                       // POST 신규="0", PUT 수정="{id}" (둘 다 사실상 무시 — 진실은 URL path)
  "title": "글 제목",
  "content": "본문 (마크다운 또는 HTML)",
  "slogan": "URL-slug",            // 빈문자열 → 서버 자동생성 (한글/em-dash 그대로, 띄어쓰기 -)
  "visibility": 0,                 // 0=비공개, 15=공개(보호), 20=공개
  "category": 0,                   // categoryId 정수, 0=카테고리없음
  "tag": "",                       // 콤마 구분 (추정)
  "published": 1,                  // 1=발행, 0=임시저장 (추정)
  "password": "45NTk5OT",          // 보호글 비밀번호. 그 외엔 무관 토큰
  "uselessMarginForEntry": 1,
  "cclCommercial": 0,
  "cclDerive": 0,
  "type": "post",                  // "post" or "page"
  "attachments": [],
  "recaptchaValue": "",
  "draftSequence": null,
  "totalWritingTimeMs": 0          // UX 트래킹용, 0 OK
}
```

응답:
```ts
{ entryUrl: string }
// post:  "https://saree98.tistory.com/{id}"
// page:  "https://saree98.tistory.com/pages/{slogan}"
// postId 추출: entryUrl.split('/').pop()
```

도구 stub:

```ts
async function publishPost(cookie, host, fields) {
  const r = await fetch(`https://${host}/manage/post.json`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      id: '0', published: 1, password: '', uselessMarginForEntry: 1,
      cclCommercial: 0, cclDerive: 0, type: 'post', attachments: [],
      recaptchaValue: '', draftSequence: null, totalWritingTimeMs: 0,
      ...fields,
    }),
  });
  const { entryUrl } = await r.json();
  return { entryUrl, postId: Number(entryUrl.split('/').pop()) };
}

async function updatePost(cookie, host, postId, fields) {
  const r = await fetch(`https://${host}/manage/post/${postId}.json`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...fields, id: String(postId) }),
  });
  return r.json();
}

async function deletePost(cookie, host, postId) {
  const r = await fetch(`https://${host}/manage/post/${postId}.json`, {
    method: 'DELETE',
    headers: { cookie, accept: 'application/json' },
  });
  return r.json();
}
```

### 4.3 visibility enum 이중성 ★

같은 개념인데 표현이 다름. 도구 인자 표준화 시 매핑 필수:

| 의미 | request body (정수) | posts.json response (문자열) |
|---|---|---|
| 비공개 | `0` | `"PRIVATE"` |
| 공개(보호) | `15` | `"PROTECTED"` |
| 공개 | `20` | `"PUBLIC"` |

### 4.4 본문 조회 — 마크다운 복원 불가

서버는 **본문을 HTML 로 정규화 저장**. 글 한 건 본문 조회 endpoint 가 없어 두 우회로:

1. 공개 페이지 (`https://{host}/{postId}`) 스크레이프 — 본문 HTML (스킨 적용된)
2. `/manage/newpost/{id}` HTML fetch → script 안 inline 데이터 파싱 — 원본 본문 (HTML 정규화 후)

마크다운으로 작성한 글도 서버 저장은 HTML. 원본 마크다운은 어떤 동선으로도 복원 불가 — 도구 명세에 명시 필요.

시도했으나 모두 SPA fallback 또는 400 (참고용):
- `/manage/post/{id}.json` → 400 "잘못된 요청입니다."
- `/manage/post.json?id={id}` → 200 SPA fallback HTML
- `/manage/post/get/{id}.json`, `/manage/api/post/{id}` → SPA fallback

수정 페이지 (`/manage/newpost/{id}`) 진입 시 글은 **기본모드 (Tiny iframe)** 로 열림 — 마크다운 CM 인스턴스는 빈 상태. 티스토리는 글의 작성 모드 메타를 저장하지 않거나 항상 HTML 로 정규화 보관.

### 4.5 자동저장

- `GET /manage/autosave` → `{ autosavedEntry: { content, title, tags, categoryId, draftSequence, thumbnail, totalWritingTimeMs, createdAt } }`
- `POST /manage/autosave` → 슬롯 덮어쓰기. **빈 본문 보내면 슬롯 초기화** (다음 글쓰기 시 "이어쓰기" confirm 안 뜸)
- 명시적 DELETE 없음 (`DELETE /manage/autosave` → 405, `POST /manage/autosave/clear` → 405)

도구가 fetch 만 쓰면 자동저장 슬롯 자체가 안 만들어짐. UI 자동화 했을 때만 사후 정리 필요 — internal helper 로 충분.

### 4.6 함정

- ★ **POST `/manage/post.json` 은 항상 신규.** body 의 `id` 도, query `?id=` 도 무시됨. 잘못 보내면 새 글 양산 (실측: `POST ...post.json?id=18` 호출 → 새 글 20 생성). 신규 vs 수정은 **URL path 의 `{id}` 존재 여부** 만으로 분기
- visibility 가 request(정수) / response(문자열) 다름 — §4.3
- `password` 필드는 보호글 외에도 항상 채워져있음 (서버 토큰)
- 본문 별도 JSON endpoint 없음 — §4.4 우회

---

## 5. 이미지 업로드

### 5.1 endpoint

| Method/URL | Body | Response |
|---|---|---|
| `POST /manage/post/attach.json` | `multipart/form-data`, field 이름 `file` | `{ name, url, key, filename, size }` |

field 이름은 `file` 만 동작 (5종 시도: `file` / `Filedata` / `image` / `upload` / `attach`).

```ts
async function uploadImage(cookie, host, filePath, { filename, mime = 'image/png' } = {}) {
  const data = await readFile(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([data], { type: mime }), filename || path.basename(filePath));
  const r = await fetch(`https://${host}/manage/post/attach.json`, {
    method: 'POST',
    headers: { cookie, accept: 'application/json' },  // multipart content-type 은 fetch 가 자동 설정
    body: fd,
  });
  return r.json();
}
```

### 5.2 응답 — 서명된 임시 URL + 영구 key

```json
{
  "name": "tmp-1x1.png",
  "url": "https://blog.kakaocdn.net/dna/{prefix}/{shortId}/{longHash}/img.png?credential={cred}&expires={epoch}&allow_ip=&allow_referer=&signature={sig}",
  "key": "{prefix}/{shortId}/{longHash}",
  "filename": "img.png",
  "size": 68
}
```

- `url` — 서명 URL. `expires` 약 5일 (실측 `expires=1780239599` = 2026-05-30). 그대로 본문에 박으면 만료 후 깨질 가능성
- `key` — **영구 reference**. 티스토리 자체 치환자 (§5.3) 가 이걸 사용. 도구는 **`key` 를 보존**할 것
- `allow_ip` / `allow_referer` 빈 문자열 — 누구나 인증 없이 fetch 가능

### 5.3 본문 삽입 형식 — 티스토리 치환자 ★

UI 는 `<figure>...<img src={서명 url}>...</figure>` 를 박지만, **자동저장 슬롯의 `content` 를 보면 서버는 치환자로 저장**:

```
[##_Image|kage@{key}|CDM|1.3|{"originWidth":1,"originHeight":1,"style":"alignCenter","filename":"tmp-1x1.png"}_##]
```

구조:
- `kage@` — kakao image storage prefix
- `{key}` — 응답의 `key` 그대로
- `CDM|1.3` — placeholder 메타 (의미 미확정)
- JSON — `originWidth`, `originHeight`, `style` (`alignCenter` / `alignLeft` / `alignRight` / `widthOrigin`), `filename`

★ **도구는 본문에 이 치환자 형식을 박을 것**:
- 영구 (key 기반, expires 무관)
- 티스토리 렌더 파이프라인이 알아서 처리 (CDN, lazy load, 정렬 등)

자동저장 `thumbnail` 필드도 동일 패턴 (`kage@{key}?...`).

### 5.4 워크플로우

```
1) uploadImage(path) → { key, url }
2) content 의 placeholder (예: ![](_img1)) 를 [##_Image|kage@{key}|CDM|1.3|{...}_##] 로 치환
3) publishPost({ content, ... })
```

---

## 6. 스킨 편집

★ **HTTP API 만으로 완결.** Monaco UI 자동화 불필요.

### 6.1 endpoint

| 동작 | Method/URL | 요청 | 응답 |
|---|---|---|---|
| 메타 + 변수 정의 조회 | `GET /manage/design/skin/current.json` | (none) | `{ skin: {name, title, version, description, variables}, home, skinSettings, variableGroups, variableSettings }` |
| **소스 + 파일 조회** | `GET /manage/design/skin/html.json` | (none) | `{ skinname, html, css, files: { list: [{filename, url, label, size}], totalSize } }` |
| **스킨 적용 (저장)** | `POST /manage/design/skin/html.json` | `{ html, css, isPreview: boolean }` (application/json) | 평문 `/preview/skin?skin=customize/{blogId}` |
| **스킨 설정 적용** (변수/기본설정/홈타입/커버) | `POST /manage/design/skin/settings.json` | `{ skinSettings, variableSettings, homeType, coverSettings }` (4필드 full snapshot) | 200, body `[]` |
| 미리보기 렌더 | `POST /preview/skin/{page}` | `{ skinSettings, variableSettings, homeType, coverSettings, isDirty }` | `text/html;charset=UTF-8` 풀 페이지 |
| 현재 스킨 zip 백업 | `GET /manage/design/skin/download.zip?originalname=customize/{skinId}` | (none) | 전체 스킨 zip |

`POST html.json` 성공 시 alert:
> 스킨 편집이 완료되었습니다. 스킨 편집으로 인한 오류 발생 시, 직접 수정하시거나 티스토리 공식 스킨으로 재적용 해주세요.

도구 stub:

```ts
async function getSkin(cookie, host) {
  const r = await fetch(`https://${host}/manage/design/skin/html.json`, { headers: { cookie } });
  return r.json(); // { skinname, html, css, files }
}

async function applySkin(cookie, host, { html, css, isPreview = false }) {
  await fetch(`https://${host}/manage/design/skin/html.json`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ html, css, isPreview }),
  });
}
```

### 6.2 `isPreview` 동작 (실측 2026-05-24)

- `isPreview: true` — 임시 적용. html.json / 공개 페이지 둘 다 변경 안 박힘. **안전한 dry-run**
- `isPreview: false` — 라이브 즉시 발효

### 6.3 미리보기 페이지 enum

`POST /preview/skin/{page}` 의 `{page}` 5종:

| page | body id |
|---|---|
| `index` | `tt-body-index` (홈) |
| `entry` | `tt-body-page` (단일 글) |
| `category` | `tt-body-category` |
| `tag` | `tt-body-tag` |
| `guestbook` | `tt-body-guestbook` |

`page` / `notice` / `search` → 404. 즉 도구 인자 enum 은 5개.

### 6.4 미리보기는 라이브 코드 기준

`POST /preview/skin/{page}` body 는 **html/css 를 안 받음**. `skinSettings`, `variableSettings`, `homeType`, `coverSettings`, `isDirty` 5필드만. 즉 항상 현재 적용된 (라이브) 스킨 코드 기반 렌더.

**변경된 코드를 dry-run preview 하려면** → `isPreview: false` 로 즉시 적용 → preview endpoint fetch → 백업으로 복구. 1-2초간 라이브 노출 trade-off.

(`isPreview: true` 응답의 `/preview/skin?skin=customize/{blogId}` URL 을 직접 GET 시 500 — 별도 인증/iframe 컨텍스트 필요. Phase 3 nice-to-have)

미리보기 iframe 내부 `window.T.config` 에 `PREVIEW: true`, `ROLE: "owner"`, `BLOG.id` 등 컨텍스트 주입됨.

### 6.5 변수 적용은 스킨 코드 의존

`variableSettings` 의 효과는 **스킨 코드가 그 변수를 참조하는지에 달림**. 예: Odyssey 사용자 버전은 푸터를 하드코딩 ("© ksh") 해서 `footerCopyright` 변수 값 무시. 도구가 변수를 보내도 결과 안 바뀜.

### 6.6 SPA fallback 의 함정

`/manage/design/skin/css.json`, `/manage/design/skin/files`, `/manage/design/skin/info` 같은 추측 endpoint 는 진짜 endpoint 아니라 **SPA fallback HTML** (~13140 bytes) 떨어짐. §2.1 의 `window.Config` 추출은 여기서도 가능.

### 6.7 Odyssey 실측 결과

- HTML 18253 chars, CSS 27878 chars
- 사용된 substitutions / blocks 65개 → `catalog.md` 1차 source
- 로컬 백업: `.playwright-mcp/odyssey-skin.html`, `odyssey-style.css`, `odyssey-html.json`

---

## 7. UI 자동화 (Playwright fallback)

§3~§6 의 API 가 동작 안 할 때 또는 로그인 진입 시에만 필요. 일반 워크플로우는 API 우선.

### 7.1 글쓰기 페이지 구조

- URL: `/manage/post` → `/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F`
- 진입 시 자동저장 글 있으면 `confirm("YYYY. MM. DD. HH:MM에 저장된 글이 있습니다. 이어서 작성하시겠습니까?")` — 자동 dismiss 안 하면 무한 대기
- 에디터: KEditor 0.7.21 + TinyMCE + CodeMirror 5 (3 모드)

| 모드 | 본문 컨테이너 | 자동화 |
|---|---|---|
| 기본 | iframe 안 `[role=textbox]` (Tiny) | 어려움 (iframe contenteditable) |
| 마크다운 | `.cm-s-tistory-markdown` (CM5) | 쉬움 (`el.CodeMirror.setValue`) |
| HTML | `.cm-s-tistory-html` (CM5) | 쉬움 (동일) |

마크다운/HTML CM 인스턴스는 둘 다 미리 마운트 (display 토글). 모드 전환 confirm:
> 작성 모드를 변경하시겠습니까? 현재 서식이 유지되지 않을 수 있습니다.

accept 시 본문 lost 가능. 숨겨진 `<textarea id="editor-tistory">` 도 있지만 CodeMirror 가 source of truth.

자동저장: 우하단 `자동 저장 완료 HH:MM:SS` 표시. 임시저장 (수동, `임시저장` 버튼 + `임시저장 개수 N개`) 과는 별개 슬롯.

### 7.2 ★ CM5 `setValue` 가 React state 미반영

```js
document.querySelector('.cm-s-tistory-markdown').CodeMirror.setValue(text);
```

CM 내부 값은 바뀌지만 React state 까지 propagate 안 됨. → 자동저장 body 의 `content` 가 `""` 로 나감 → 발행 시 빈 글 (실측: 글 18 본문 0 byte).

해법: **UI 자동화 우회. §4 의 fetch 직접 호출**. 본 도구 셋이 fetch-first 인 핵심 이유.

### 7.3 핵심 셀렉터 (참고용)

```js
const titleEl = document.getElementById('post-title-inp');        // textarea.textarea_tit
const cmMarkdown = document.querySelector('.cm-s-tistory-markdown').CodeMirror;
const cmHtml = document.querySelector('.cm-s-tistory-html').CodeMirror;
// 태그 input: label=태그, placeholder=태그입력
// 카테고리: role=combobox name=카테고리 선택 (textContent 매치로 선택)
// 첨부: input#attach-image (image/*), input#attach-file (*) — multiple
```

React onChange 감지하려면 native setter (예: `Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set`) 로 값 박고 input/change 이벤트 dispatch.

### 7.4 발행 모달

`완료` 버튼 → `dialog > group[name=발행정보 입력폼]`:
- 공개범위 라디오 3종 — `공개` / `공개(보호)` / `비공개` (기본 비공개)
- CCL 토글, 댓글 허용 더보기, 홈주제 (공개 시만 enable, `viewChannels` enum), 발행일 (현재 / 예약)
- URL 미리보기: `https://saree98.tistory.com/entry/{slug}` + slug textbox (보통 disabled)
- 대표이미지 file input (`Choose File`)
- 하단: `취소` / 발행 버튼 라벨 dynamic — 비공개 = `비공개 저장`, 공개 = `공개 발행`

### 7.5 스킨 편집 페이지 (Monaco)

§6 API 로 충분하지만 fallback 참고용:

- URL: `/manage/design/skin/edit#/source/{html|css|file}`
- 편집기: **Monaco** (글쓰기는 CM5 — 다른 베이스)
- `html 편집` 버튼 클릭 시 confirm: "html 및 CSS 편집으로 인해 발생하는 문제는 직접 수정하셔야 합니다. 계속 진행하시겠습니까?"
- 탭별 모델 swap (이전 dispose). `window.monaco.editor.getModels()` 로 활성 모델 1개만 보임

| Tab | hash | model.uri | model.language | Odyssey 길이 |
|---|---|---|---|---|
| HTML | `#/source/html` | `inmemory://model/1` | `tistory-skin-html` | 18253 chars |
| CSS | `#/source/css` | `inmemory://model/2` | `css` | 27878 chars |
| 파일업로드 | `#/source/file` | (모델 없음) | — | 파일 리스트 + `input[name=Filedata]` multiple |

```js
const m = window.monaco.editor.getModels().find(m => m.getLanguageId() === 'tistory-skin-html');
m.setValue(newHtml);
// 변경 후 `적용` 버튼 enable → 클릭 = 서버 PUT (= §6 의 POST html.json 과 동일 효과)
```

Monaco 언어 `tistory-skin-html` 토큰:
- `metatag` — `<!DOCTYPE ...>`
- `delimiter` — `<`, `>`, `=`, `"`
- `tag` — HTML 태그명 (`html`, `head`, `s_t3`, `s_list` 등 동일 처리)
- `attribute.name` / `attribute.value`
- **`valueReplacer.tistory-skin-html`** — `[##_*_##]` 패턴 (모든 변수 치환자 매칭)
- `comment`

→ Monaco 가 `[##_*_##]` 를 syntax highlight 만 하지 변수 validity 검증은 안 함. 카탈로그는 외부 source (`catalog.md`) 가 정답.

파일업로드: 현재 스킨 (Odyssey) 등록 파일 — `preview_large.jpg`, `showcase_bg.jpg`, `showcase_list_01.jpg`~`_03.jpg`, `showcase_preview.jpg` (총 2.2 MB / **20 MB 한도**).

### 7.6 함정 (UI 자동화)

- 스킨 편집 React 라우터가 `location.hash` 직접 변경에 반응 안 함 → `<a>` 클릭 또는 `hashchange` dispatch
- `/manage/design/skin` 의 `스킨 등록` 버튼 위에 `div.blog_skin` 이 pointer-events 가로챔 → JS `el.click()` 강제 호출
- 페이지 떠날 때 미저장 변경 = `beforeunload` 다이얼로그
- 새 글 진입 시 자동저장 복구 confirm 자동 dismiss 안 하면 무한 대기
- 카테고리 콤보 lazy fetch (옵션 0개 보일 수 있음 — wait 필요)

### 7.7 카테고리 / 메뉴 인라인 UI

★ **카테고리 CRUD 는 `PUT /manage/category.json` batch endpoint 로 fetch 가능** (§3.6 — 2026-05-27 실측 확정, UI XHR reverse-engineer). 아래 인라인 UI 메모는 도구 구현엔 무관 — 참고용. 메뉴 순서 변경은 미실측.

카테고리 row (`/manage/category`) 액션 5종 (hover 시만 visible):

| 액션 | 동작 |
|---|---|
| 추가 | 그 카테고리 **하위로** 새 카테고리 (인라인 input) |
| 수정 | 이름 인라인 textbox |
| 관리 | 카테고리 상세 (description / list style / image) — 미확정 |
| 이동 | 글 일괄 이동 또는 부모 변경 — 미확정 |
| 삭제 | 글 0개일 때만 enable |

모든 액션 **batch 모드** — `변경사항 저장` 클릭해야 서버 반영. 카테고리 한도 500개. 카테고리 ID 는 글 목록 필터 URL 에서만 노출 (`?category=1363062`) → DOM 식별자 없으므로 textContent 매치 필요.

블로그 메뉴 (`/manage/design/menu`): 드래그앤드롭 순서 변경 + 메뉴 추가 + 미리보기 새창 + 변경사항 저장. 스킨의 `s_t3` 헤더 nav 와 연동.

### 7.8 미리보기 모달 (글쓰기 페이지)

`미리보기` 버튼 → `dialog`. PC / Mobile 버튼 + 직접입력 (가로/세로 spinbutton, 기본 916x788). iframe 안에 실 적용 스킨으로 렌더링. 닫기 `button[name=닫기]`.

---

## 8. 공개 페이지 — 스킨이 렌더하는 곳

스킨 가이드 (`tistory.github.io/document-tistory-skin`) 의 page type 매핑 실측:

| URL | body id | title 예 | 주 콘텐츠 |
|---|---|---|---|
| `/` | `tt-body-index` | `{블로그명}` | 최신글 카드 |
| `/category` | `tt-body-category` | `'분류 전체보기' 카테고리의 글 목록` | 글 리스트 |
| `/category/{name}` | `tt-body-category` | `'{카테고리}' 카테고리의 글 목록` | 글 리스트 (필터) |
| `/tag` | `tt-body-tag` | `태그 목록` | 태그 클라우드 |
| `/tag/{name}` | `tt-body-tag` (추정) | `'{태그}' 태그의 글` | 글 리스트 |
| `/{postId}` | `tt-body-page` | `{글 제목}` | 단일 글. `og:title/image`, `meta[property=article:published_time]` |
| `/search/{kw}` | `tt-body-search` | `'{kw}'의 검색결과` | 글 리스트 |
| `/guestbook` | `tt-body-guestbook` | `방명록` | 방명록 폼 |
| `/notice/{id}` (추정) | `tt-body-notice` | — | 공지 (공지 0개라 미실측) |
| `/archive/...` (표준 추정) | `tt-body-archive` | — | 연/월 아카이브 — 미실측 |
| `/location/...` (표준 추정) | `tt-body-location` | — | 위치별 — 미실측 |
| `/rss` | — | XML | RSS 2.0 (자동 생성) |

스킨 디자인 시 **body id 가 페이지 분기 셀렉터** (`body#tt-body-index .hero { ... }`).

공개 페이지 메타 활용:
- `og:title`, `og:image`, `article:published_time` (ISO)
- `<link rel=canonical>` 모든 페이지
- `/rss` 가 가장 안정적인 최신글 source

---

## 9. 함정 (gotchas) 통합

### 인증
- 카카오 2차 인증 = 카카오톡 푸시 → headless 불가, 헤디드 1회 필수
- 세션 만료 = 모든 endpoint 가 `/auth/login` 으로 리다이렉트

### 글 CRUD (§4)
- ★ **POST `/manage/post.json` 은 항상 신규.** body/query 의 id 무시 → 잘못 보내면 글 양산. 신규 vs 수정은 URL path 의 `{id}` 로만 분기
- visibility enum: request (정수 0/15/20) ↔ response (문자열 PRIVATE/PROTECTED/PUBLIC)
- 본문 별도 JSON endpoint 없음 → 공개 페이지 스크레이프 또는 `/manage/newpost/{id}` HTML 파싱
- 마크다운 원본 복원 불가 — 서버는 HTML 정규화만 보관
- `password` 필드는 항상 채워져있음 (보호글 외엔 무관 토큰)

### 이미지 (§5)
- 응답 `url` 은 서명 URL (~5일 만료). 영구 보관하려면 `key` 로 `[##_Image|kage@{key}|...|_##]` 치환자 사용
- attach.json field 이름은 `file` 만 동작
- 마크다운 모드에서 KEditor 첨부 UI 는 native picker 만 — 자동화 시 fetch 직접

### 스킨 (§6)
- `isPreview: true` 는 안전한 dry-run. `false` 는 즉시 라이브
- preview endpoint 는 html/css 안 받음 — 라이브 코드 기반 렌더
- 변경된 코드 dry-run 은 라이브 적용 후 복구 trade-off
- variable 효과는 스킨 코드 의존 (하드코딩 시 무시됨)
- 스킨 파일 총 20MB 한도
- `index.xml` 변경 시 모든 스킨 설정이 초기화됨 (catalog.md File Structure 참고)

### UI 자동화 (§7)
- ★ **CM5 `setValue` 가 React state 미반영** → fetch 직접 호출 (가장 중요)
- Monaco 모델은 탭 전환 시 swap. 한 탭 끝낸 뒤 전환
- React 라우터가 `location.hash` 직접 변경에 반응 안 함 → 클릭 또는 dispatch
- `스킨 등록` 버튼 z-index 차단 → JS click 우회
- 글쓰기 모드 전환 (기본/MD/HTML) 시 confirm → 본문 lost 가능
- 새 글 진입 시 자동저장 복구 confirm → 자동 dismiss
- 발행 시 비공개 기본 선택 — 의도 안 한 공개 발행은 막힘 (안전)
- `beforeunload` 다이얼로그 (미저장 변경 시)
- 카테고리 콤보 lazy fetch (옵션 0개 보일 수 있음)

---

## 부록 A. 좌측 메뉴 카탈로그

`/manage` 진입 후 사이드바 (`navigation[aria-level=block]`):

| 그룹 | 라벨 | URL |
|---|---|---|
| (루트) | 블로그관리 홈 | `/manage/` |
| 콘텐츠 | 글 관리 | `/manage/posts` |
| 콘텐츠 | 페이지 관리 | `/manage/pages` |
| 콘텐츠 | 카테고리 관리 | `/manage/category` |
| 콘텐츠 | 공지 관리 | `/manage/notices` |
| 콘텐츠 | 서식 관리 | `/manage/templates` |
| 콘텐츠 | 설정 | `/manage/setting/contents` |
| 댓글·방명록 | 댓글 관리 | `/manage/comments` |
| 댓글·방명록 | 방명록 관리 | `/manage/guestbook` |
| 댓글·방명록 | 설정 | `/manage/setting/comments` |
| 통계 | 방문 통계 | `/manage/statistics/blog` |
| 통계 | 유입 경로 | `/manage/statistics/referrer` |
| (루트) | 수익 | `/manage/revenue` |
| 꾸미기 | 스킨 변경 | `/manage/design/skin` |
| 꾸미기 | 스킨 편집 | `/manage/design/skin/edit` |
| 꾸미기 | 사이드바 | `/manage/design/sidebar` |
| 꾸미기 | 메뉴 | `/manage/design/menu` |
| 꾸미기 | 모바일 | `/manage/design/mobile` |
| 꾸미기 | 메뉴바/구독 설정 | `/manage/design/setting` |
| (루트) | 플러그인 | `/manage/plugins` |
| 링크 | 나의 링크 | `/manage/link/my` |
| 관리 | 블로그 | `/manage/setting/blog` |
| 관리 | 팀블로그 | `/manage/teamblog` |

대시보드 (`/manage/`) 본문 위젯:
- 최근 7일 통계 (조회 / 방문 일별)
- 인기글 top
- 유입 채널 / 키워드
- 최근 글 2개 본문 미리보기

→ fetch_meta 도구의 일부 데이터를 한 페이지에 묶어주지만 본문 일부가 함께 노출되는 메타+본문 mix.

---

## 부록 B. 정적 리소스

- 글 에디터: https://t1.daumcdn.net/keditor/opensource/KEDITOR-0.7.21.zip (OSS)
- TinyMCE OSS notice: https://t1.daumcdn.net/osa/hermes/notice/1397.html
- 스킨 공식 가이드: https://tistory.github.io/document-tistory-skin/ — `catalog.md` 의 1차 source

---

## 부록 C. 비범위 admin 영역

MCP 도구 surface 외. URL / 존재만 기록.

| 영역 | URL | 비고 |
|---|---|---|
| 방문 통계 | `/manage/statistics/blog` | 일/주/월 차트 |
| 유입 경로 | `/manage/statistics/referrer` | refer 도메인 별 |
| 댓글 관리 | `/manage/comments` | 일괄 처리 |
| 방명록 | `/manage/guestbook` | |
| 댓글/방명록 설정 | `/manage/setting/comments` | 비밀글, 차단 |
| 콘텐츠 설정 | `/manage/setting/contents` | 글 발행 기본값 |
| 플러그인 | `/manage/plugins` | 22개 사전 정의 (Daum 검색창, 드래그 검색, 코드 문법 강조, GA, Naver Analytics 등). 토글만 |
| 나의 링크 | `/manage/link/my` | 외부 링크 |
| 수익 | `/manage/revenue` | 광고 수익 (애드센스 등) |
| 블로그 설정 | `/manage/setting/blog` | 이름, 닉네임, 주소, 본인인증, 카카오 연결, 폐쇄 |
| 팀블로그 | `/manage/teamblog` | 멀티 작성자 |

플러그인 중 **코드 문법 강조** 가 스킨의 `<pre><code>` 영역과 직접 관련. 사용중이면 본문 코드블럭이 자동 highlight.
