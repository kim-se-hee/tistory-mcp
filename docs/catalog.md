# 티스토리 스킨 치환자 카탈로그

스킨 템플릿에서 쓰는 치환자/블록의 1차 카탈로그. `tistory://substitutions` 리소스의 source — 코드로 옮기면 `src/tistory/catalog.ts`.

**1차 source**
- 공식 가이드 https://tistory.github.io/document-tistory-skin/ (22개 페이지 fetch 완료, 2026-05-24)
- Odyssey 사용자 스킨 실측 (`api.md` §6.7)

WebFetch 는 AI 요약을 거치므로 `catalog.ts` 코딩 시 raw HTML 파싱 (cheerio + GitHub repo raw) 로 보강 권장.

## 목차

1. [Syntax 3종](#syntax-3종)
2. [공통 (모든 페이지)](#공통-모든-페이지)
3. [Post — 글 단건](#post--글-단건)
4. [Notice — 공지](#notice--공지)
5. [Page — 정적 페이지](#page--정적-페이지)
6. [Protected — 보호글](#protected--보호글)
7. [List — 글 목록 (홈/카테고리/태그/검색)](#list--글-목록-홈카테고리태그검색)
8. [Paging](#paging)
9. [Cover — 홈 커버](#cover--홈-커버)
10. [Comment — 댓글](#comment--댓글)
11. [Guestbook — 방명록](#guestbook--방명록)
12. [Tag Cloud](#tag-cloud)
13. [Sidebar — 사이드바](#sidebar--사이드바)
14. [스킨 옵션 (Variable System)](#스킨-옵션-variable-system)
15. [파일 구조 / index.xml](#파일-구조--indexxml)

---

## Syntax 3종

- **그룹치환자** `<s_NAME>...</s_NAME>` — 블록 (반복 또는 조건)
- **값치환자** `[##_NAME_##]` — 값 1개
- **변수치환자** (`index.xml` 의 `<variables>` 정의):
  - `[##_var_{NAME}_##]` — 값
  - `<s_if_var_{NAME}>...</s_if_var_{NAME}>` — 값이 있을 때
  - `<s_not_var_{NAME}>...</s_not_var_{NAME}>` — 값이 없을 때

---

## 공통 (모든 페이지)

| 변수 | 반환 |
|---|---|
| `[##_title_##]` | 블로그 제목 |
| `[##_image_##]` | 블로그 대표 이미지 URL |
| `[##_blog_image_##]` | `<img>` 포함 대표 이미지 |
| `[##_desc_##]` | 블로그 설명 |
| `[##_blogger_##]` | 블로그 소유자 필명 |
| `[##_blog_link_##]` | 블로그 URL |
| `[##_rss_url_##]` | RSS 피드 URL |
| `[##_taglog_link_##]` | 태그로그 URL |
| `[##_guestbook_link_##]` | 방명록 URL |
| `[##_page_title_##]` | 페이지 제목 |
| `[##_blog_menu_##]` | 블로그 메뉴 리스트 |
| `[##_body_id_##]` | 페이지 타입 ID (`tt-body-*`) |
| `[##_revenue_list_upper_##]` | 광고 (홈/목록 상단) |
| `[##_revenue_list_lower_##]` | 광고 (홈/목록 하단) |

블록:
- `<s_t3>` — 티스토리 공통 JS (body 안에 **필수**)

---

## Post — 글 단건

블록: `<s_article_rep>`, `<s_index_article_rep>` (목록 안), `<s_permalink_article_rep>` (단건)

| 변수 | 반환 |
|---|---|
| `[##_article_rep_link_##]` | 글 URL |
| `[##_article_rep_title_##]` | 제목 |
| `[##_article_rep_category_##]` | 카테고리 명 |
| `[##_article_rep_category_link_##]` | 카테고리 URL |
| `[##_article_rep_author_##]` | 작성자 (팀블로그) |
| `[##_article_rep_id_##]` | 글 ID |
| `[##_article_rep_date_##]` | 날짜/시간 `yyyy. m. d. HH:MM` |
| `[##_article_rep_simple_date_##]` | 날짜만 `yyyy. m. d.` |
| `[##_article_rep_date_year_##]` | 연도 |
| `[##_article_rep_date_month_##]` | 월 |
| `[##_article_rep_date_day_##]` | 일 |
| `[##_article_rep_date_hour_##]` | 시 |
| `[##_article_rep_date_minute_##]` | 분 |
| `[##_article_rep_date_second_##]` | 초 |
| `[##_article_rep_desc_##]` | 본문 |
| `[##_article_rep_summary_##]` | 요약 (index 만) |
| `[##_article_rep_thumbnail_url_##]` | 썸네일 URL |
| `[##_article_rep_rp_cnt_##]` | 댓글 수 |
| `[##_tag_label_rep_##]` | 태그 라벨 |
| `[##_article_dissolve_##]` | 보호글 해제 JS |
| `[##_article_password_##]` | 보호글 비번 input id |

추가 블록:
- `<s_article_rep_thumbnail>` — 조건부 썸네일
- `<s_article_related>` — 관련글
- `<s_article_prev>` / `<s_article_next>` — 이전/다음
- `<s_tag_label>` / `<s_tag_label_rep>` — 태그 라벨
- `<s_ad_div>` — 관리자 액션 (수정/삭제. 로그인 시만 노출)
- `<s_article_protected>` — 보호글 (비번 폼) — §Protected
- `<s_rp_count>` — 댓글 수 wrapper

---

## Notice — 공지

블록: `<s_notice_rep>`

| 변수 | 반환 |
|---|---|
| `[##_notice_rep_link_##]` | URL |
| `[##_notice_rep_title_##]` | 제목 |
| `[##_notice_rep_date_##]` | 날짜 (`yyyy.mm.dd HH:MM`) |
| `[##_notice_rep_desc_##]` | 본문 |
| `[##_notice_rep_summary_##]` | 요약 (index 만) |

날짜 세부 (year/month/day/hour/minute/second) 패턴은 Post 와 동일하게 적용될 것으로 추정.

---

## Page — 정적 페이지

블록: `<s_page_rep>`

| 변수 | 반환 |
|---|---|
| `[##_article_rep_link_##]` | URL |
| `[##_article_rep_title_##]` | 제목 |
| `[##_article_rep_date_##]` | 날짜/시간 |
| `[##_article_rep_simple_date_##]` | 날짜만 |
| `[##_article_rep_date_year/month/day/hour/minute/second_##]` | 세부 |
| `[##_article_rep_desc_##]` | 본문 |
| `[##_article_rep_author_##]` | 작성자 |

---

## Protected — 보호글

블록: `<s_article_protected>`

변수: Post 의 link / title / category / category_link / 날짜를 그대로 사용 + 보호 전용 2종:

| 변수 | 반환 |
|---|---|
| `[##_article_password_##]` | input id |
| `[##_article_dissolve_##]` | 비번 검증 JS (onsubmit/onclick) |

---

## List — 글 목록 (홈/카테고리/태그/검색)

블록: `<s_list>`, `<s_list_rep>`, `<s_list_empty>`, `<s_list_rep_thumbnail>` (조건부)

| 변수 | 반환 |
|---|---|
| `[##_list_conform_##]` | 카테고리명 / 검색어 / 태그명 |
| `[##_list_count_##]` | 전체 글 수 |
| `[##_list_description_##]` | 설명 |
| `[##_list_style_##]` | 리스트 스타일 (`index.xml` 정의) |
| `[##_list_rep_link_##]` | 글 URL |
| `[##_list_rep_title_##]` | 제목 (New 뱃지 포함) |
| `[##_list_rep_summary_##]` | 요약 |
| `[##_list_rep_regdate_##]` | 등록일 (`yyyy.mm.dd`) |
| `[##_list_rep_category_##]` | 카테고리 |
| `[##_list_rep_thumbnail_url_##]` | 썸네일 URL |
| `[##_list_rep_rp_cnt_##]` | 댓글 수 |

---

## Paging

블록: `<s_paging>`, `<s_paging_rep>`

| 변수 | 반환 |
|---|---|
| `[##_prev_page_##]` | 이전 페이지 URL |
| `[##_next_page_##]` | 다음 페이지 URL |
| `[##_paging_rep_link_##]` | 페이지 N URL |
| `[##_paging_rep_link_num_##]` | 페이지 번호 |
| `[##_no_more_prev_##]` | 이전 없음 클래스 |
| `[##_no_more_next_##]` | 다음 없음 클래스 |

---

## Cover — 홈 커버

블록: `<s_cover_group>` > `<s_cover_rep>` > `<s_cover>` / `<s_cover_item>`
조건부: `<s_cover_item_thumbnail>`, `<s_cover_item_article_info>` / `<s_cover_item_not_article_info>`, `<s_cover_url>`

| 변수 | 반환 |
|---|---|
| `[##_cover_title_##]` | 커버 제목 |
| `[##_cover_url_##]` | 커버 URL |
| `[##_cover_item_title_##]` | 아이템 제목 |
| `[##_cover_item_url_##]` | 아이템 URL |
| `[##_cover_item_summary_##]` | 요약 |
| `[##_cover_item_thumbnail_##]` | 썸네일 |
| `[##_cover_item_date_##]` | 날짜 |
| `[##_cover_item_simple_date_##]` | 날짜 (간략) |
| `[##_cover_item_category_##]` | 카테고리 명 |
| `[##_cover_item_category_url_##]` | 카테고리 URL |
| `[##_cover_item_comment_count_##]` | 댓글 수 |

데이터 타입 (`index.xml` 의 `<covers>` 정의):
- `RECENT` — 최신 글 (카테고리·수량 1~100 옵션)
- `CUSTOM` — 직접 입력 (title / summary / url / thumbnail)

---

## Comment — 댓글

★ **가장 쉬운 길**: `[##_comment_group_##]` 한 줄로 전체 렌더 (React 컴포넌트 마운트).

### 수동 구현 (직접 마크업)

| 변수 | 반환 |
|---|---|
| `[##_article_rep_id_##]` | 댓글 폼 ID 매핑 |
| `[##_rp_input_comment_##]` | textarea name |
| `[##_rp_input_is_secret_##]` | 비밀댓글 checkbox name |
| `[##_rp_onclick_submit_##]` | submit onclick |
| `[##_rp_rep_name_##]` | 작성자 |
| `[##_rp_rep_logo_##]` | 프로필 이미지 |
| `[##_rp_rep_date_##]` | 날짜 |
| `[##_rp_rep_desc_##]` | 본문 |
| `[##_rp_rep_link_##]` | permalink |
| `[##_rp_rep_onclick_delete_##]` | 삭제 onclick |
| `[##_rp_rep_onclick_reply_##]` | 답글 onclick |

블록:
- `<s_rp>` — 전체
- `<s_rp_input_form>`, `<s_rp_member>` (로그인 영역), `<s_rp_guest>` (비로그인 — name/password)
- `<s_rp_container>`, `<s_rp_rep>` — 댓글 1개
- `<s_rp2_container>`, `<s_rp2_rep>` — 대댓글

---

## Guestbook — 방명록

★ **가장 쉬운 길**: `[##_guestbook_group_##]` 한 줄로 전체.

수동 구현 시 사용 블록: `<s_guest>`, `<s_guest_input_form>`, `<s_guest_container>`, `<s_guest_rep>`. 변수 패턴은 Comment 와 유사.

---

## Tag Cloud

블록: `<s_tag>`, `<s_tag_rep>`

| 변수 | 반환 |
|---|---|
| `[##_tag_link_##]` | URL |
| `[##_tag_name_##]` | 태그명 |
| `[##_tag_class_##]` | `cloud1`~`cloud5` (빈도 등급) |

---

## Sidebar — 사이드바

구조: `<s_sidebar>` > `<s_sidebar_element>` (첫 줄 `<!-- TITLE -->` = 위젯 제목)

### 위젯 9종

| 위젯 | 블록 | 주요 변수 |
|---|---|---|
| 최근 공지 | `<s_rct_notice>` / `<s_rct_notice_rep>` | `[##_notice_rep_link_##]`, `[##_notice_rep_title_##]` |
| 최근 글 | `<s_rctps_rep>`, `<s_rctps_rep_thumbnail>` | `[##_rctps_rep_link/title/date/rp_cnt/category/category_link_##]` |
| 인기글 | `<s_rctps_popular_rep>` | Post 패턴과 동일 |
| 최근 댓글 | `<s_rctrp_rep>` | `[##_rctrp_rep_link/desc/name/time_##]` |
| 카테고리 | (블록 없음) | `[##_category_##]` (폴더), `[##_category_list_##]` (리스트) |
| 랜덤 태그 | `<s_random_tags>` | `[##_tag_link/name/class_##]` |
| 방문자수 | (블록 없음) | `[##_count_total/today/yesterday_##]` |
| 검색 | `<s_search>` | `[##_search_name/text/onclick_submit_##]` |

---

## 스킨 옵션 (Variable System)

`index.xml` 의 `<variables>` 안에 정의. 5 type:

| Type | 의미 |
|---|---|
| STRING | 텍스트 입력 |
| SELECT | 드롭다운 (option = JSON `[{name, label, value}, ...]`) |
| IMAGE | URL 기반 이미지 선택 |
| BOOL | true / false 토글 |
| COLOR | 16진수 색 |

각 variable 필드:
- `name` — 템플릿 치환 키
- `label` — UI 표시명
- `type` — 위 5종
- `default` — 기본값
- `description` — 도움말 (옵션)
- `option` — SELECT 필수, 나머지 옵션

★ **함정**: 스킨 코드가 변수를 참조하지 않으면 (예: 하드코딩) UI 에서 변수 값을 바꿔도 효과 없음. `api.md` §6.5 참고.

---

## 파일 구조 / index.xml

### 파일 구조

| 파일 | 필수 | 설명 |
|---|---|---|
| `index.xml` | ★ | 스킨 메타. **변경 시 모든 스킨 설정이 초기화됨** |
| `skin.html` | ★ | 메인 템플릿 |
| `style.css` | ★ | 스타일 |
| `preview.gif` | 1개 이상 | 112×84 — 기본 (다른 preview 없으면 fallback) |
| `preview256.jpg` | | 256×192 |
| `preview560.jpg` | | 560×420 |
| `preview1600.jpg` | | 1600×1200 |
| `images/` | 옵션 | js, 추가 자산 |

### index.xml 주요 필드 (요약)

- **기본**: name, version, description, license
- **작성자**: name, homepage, email
- **기본 설정**: 최근 글/댓글/트랙백 수, 태그 클라우드 옵션, 텍스트 길이 한도, 카테고리 스타일, 본문 폭
- `<variables>` — 스킨 옵션 (위 5 type)
- `<covers>` — 홈 커버 정의
