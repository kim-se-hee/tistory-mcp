# tistory-mcp

티스토리 블로그 관리자 동작을 MCP 도구로 노출하는 stdio TS/Node 서버.

블로그 주인이 LLM 에게 "글 올려" / "스킨 이거 적용해" 라고 말하면 끝나도록 만드는 것이 목표.

## 할 수 있는 일

LLM 에게 자연어로 말하면 끝:

- **"오늘 작성한 마크다운으로 비공개 글 올려줘"** → `tistory_publish_post`
- **"3번 글 공개로 바꾸고 카테고리를 '리뷰' 로"** → `tistory_update_post`
- **"이 스킨 코드 적용하고 미리보기 보여줘"** → `tistory_apply_skin` + `tistory_preview_skin` + `tistory_screenshot`
- **"내 글 중 '리액트' 들어간 거 다 찾아"** → `tistory_search_posts`
- **"카테고리 트리를 이렇게 재정렬해줘"** → `tistory_categories_update`

블로그 운영하면서 반복되던 6가지 마찰 — 치환자 추측, 편집 루프 1분+, 미리보기 부재, 함정 학습 비용, 글쓰기 동선, 메타 확인 — 을 도구 14개로 환원한 결과물.

설계 전체는 [`plan.md`](plan.md), endpoint 실측은 [`docs/api.md`](docs/api.md) 참조.

## 빠른 시작

```sh
# MCP 클라이언트가 알아서 실행 — 별도 설치 불필요
npx -y tistory-mcp
```

설치 시 `postinstall` 이 Chromium 바이너리를 OS 표준 위치 (`~/.cache/ms-playwright/` 등) 에 자동으로 받는다. 네트워크 차단 환경에서 실패하면 수동으로 `npx playwright install chromium` 한 번 돌리면 된다.

Chromium 은 `tistory_session_init` (카카오 OAuth + 2FA 로그인 1회) 과 `tistory_screenshot` (페이지 캡처) 둘만 사용한다. 나머지 12개 도구는 추출된 쿠키 + fetch 라 브라우저가 뜨지 않는다.

## MCP 클라이언트 설정

### Claude Code

```sh
claude mcp add tistory -- npx -y tistory-mcp
```

스코프는 기본이 user (모든 프로젝트에서 보임). 프로젝트에만 묶고 팀과 공유하려면 `--scope project` 를 붙여 `.mcp.json` 에 저장.

등록 확인:
```sh
claude mcp list
```

### Claude Desktop 등 기타 stdio 클라이언트

server 설정 JSON 에 추가:

```json
{
  "mcpServers": {
    "tistory": {
      "command": "npx",
      "args": ["-y", "tistory-mcp"]
    }
  }
}
```

### 첫 실행

세션이 없는 상태에서 도구를 호출하면 `tistory_session_init` 을 먼저 부르라는 에러가 뜬다. `session_init` 이 헤디드 Chromium 을 띄워 카카오 로그인 (2FA 푸시 승인 포함) 을 받고, `storageState` 를 OS keychain (keytar) 에 저장한다. 이후 모든 도구는 그 쿠키로 동작.

## 개발

```sh
npm install
npm run dev        # tsx src/index.ts
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/index.js
```

## 노출되는 것

**Tools 14개** — 카테고리별:

| 카테고리 | 도구 |
|---|---|
| 세션 | `tistory_session_init` |
| 글 | `tistory_publish_post` · `tistory_update_post` · `tistory_delete_post` · `tistory_fetch_post` · `tistory_search_posts` |
| 자산 | `tistory_upload_image` |
| 스킨 | `tistory_apply_skin` · `tistory_apply_skin_settings` · `tistory_preview_skin` · `skin_validate` |
| 메타 | `tistory_fetch_meta` · `tistory_categories_update` |
| 보조 | `tistory_screenshot` |

**Resources 4종** — `tistory://substitutions` (치환자 카탈로그) / `tistory://page-types` (`tt-body-*` 매핑) / `tistory://gotchas` (알려진 함정) / `tistory://template-default` (동작 스킨 골격)

**Prompts 3종** — `tistory/new_skin` / `tistory/diagnose_render` / `tistory/iterate_loop`

각 도구의 입력/동작/함정은 [`plan.md §2`](plan.md) 와 [`docs/api.md`](docs/api.md) 가 정답.

## 라이선스

MIT
