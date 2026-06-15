# tistory-mcp

티스토리 블로그 운영을 자연어로 끝내는 MCP 서버.

관리자 페이지를 열고, 마크다운 ↔ 에디터를 오가고, 스킨 코드를 복사 붙여넣기 하고 미리보기 확인을 위해 새 탭 띄우고 — 이 번거로운 작업 전체를 자연어로 처리하는 게 목표입니다.

## 예시

원하는 작업을 말하면 적절한 도구를 LLM 이 알아서 호출합니다.

### "내 블로그에 맞는 깔끔한 커스텀 스킨 만들어서 적용해줘"

기본 스킨이 마음에 들지 않을 때 한 마디로 통째로 갈아치울 수 있습니다.

| Before — 기본 스킨 | After — 커스텀 스킨 적용 |
|:---:|:---:|
| ![기본 티스토리 스킨](https://github.com/user-attachments/assets/761b2a5f-6b42-4f6e-9ff6-1ee022dd2cc8) | ![커스텀 스킨 적용 결과](https://github.com/user-attachments/assets/4fe4d17f-ce18-49b3-9e2a-c46c09e3996d) |

### "이 글에 목차 자동으로 달아줘"

본문 헤딩을 분석해서 우측 영역에 목차를 생성합니다.

| 평소 — 미니 sticky | 호버 — 펼친 목차 |
|:---:|:---:|
| ![접힌 목차 인디케이터](https://github.com/user-attachments/assets/c2862dbc-bd79-443d-975b-4305ff157862) | ![펼쳐진 풀 목차](https://github.com/user-attachments/assets/74c48398-4b73-421e-a05c-ff98b31ce239) |

### "이 글 헤더에 부제목 달아줘"

긴 제목이 답답할 때, 제목 아래에 부제목 영역을 추가할 수 있습니다.

![제목 + 부제목 헤더 예시](https://github.com/user-attachments/assets/3911089a-bdcd-4401-b7c7-c14b2275ee24)

## 시작하기

### 1. Claude Code 에 등록

```sh
claude mcp add tistory -- npx -y tistory-mcp
```

처음 실행될 때 필요한 브라우저 (Chromium) 도 함께 자동으로 받아 옵니다 — 별도 설치 명령이 필요 없습니다.

### 2. 첫 사용 — 블로그 연결

Claude 에게 한 번만 이렇게 말합니다:

> "내 티스토리 블로그 `xxx.tistory.com` 연결해줘"

- 헤디드 Chromium 창이 자동으로 뜨고, 카카오 로그인 화면으로 이동합니다
- 카톡 푸시 (또는 비밀번호 + 2FA) 로 직접 인증을 마치면
- 인증 쿠키가 OS 자격증명 저장소 (Windows Credential Manager / macOS Keychain / Linux Secret Service) 에 안전하게 보관되고, 창이 닫힙니다

### 3. 그 다음부터는

원하는 작업을 자연어로 던지면 됩니다.

## 도구 목록

LLM 이 자동으로 골라 쓰는 도구 14개. 명시적으로 이름을 부를 필요는 없지만, 어떤 일이 가능한지 한눈에 보고 싶다면 아래를 참고하세요.

| 카테고리 | 도구 |
|---|---|
| 세션 관리 | `tistory_session_init` |
| 글 | `tistory_publish_post` · `tistory_update_post` · `tistory_delete_post` · `tistory_fetch_post` · `tistory_search_posts` |
| 자산 | `tistory_upload_image` |
| 스킨 | `tistory_apply_skin` · `tistory_apply_skin_settings` · `tistory_preview_skin` · `skin_validate` |
| 메타 | `tistory_fetch_meta` · `tistory_categories_update` |
| 보조 | `tistory_screenshot` |

각 도구의 정확한 입력 / 동작 / 주의사항은 [`plan.md`](plan.md) 와 [`docs/api.md`](docs/api.md) 에 정밀하게 정리돼 있습니다.

## 변경 이력

버전별 추가/수정 내역은 [`CHANGELOG.md`](CHANGELOG.md) 참고. 커밋 메시지(Conventional Commits)에서 자동 생성됩니다.

## 라이선스

MIT
