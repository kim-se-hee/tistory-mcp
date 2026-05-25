---
name: todo-run
description: todo.md 의 미체크 항목들을 dependency 순서대로 scoped-implementer 에게 직렬 dispatch. owns 경계 위반은 reject + 롤백. 완료 시 체크박스 닫음.
---

# /todo-run

todo.md 미체크 항목을 골라 `scoped-implementer` 서브에이전트에게 직렬로 dispatch. 끝나면 owns 경계 검증 후 체크박스 닫는다.

## 기본 모드: 직렬

병렬은 일단 안 한다. 작은 프로젝트, 디버깅 단순. 답답해지면 나중에 `--parallel` 로 worktree 격리 추가.

## 실행 순서

1. **파싱**
   - `Read` todo.md
   - 미체크 항목 (`- [ ]`) 만 추출
   - 각 항목의 `owns:` / `depends:` 라인 파싱
   - **하이브리드 검증**: 체크박스 + owns 라인은 필수. 빠진 항목은 사용자에게 보고하고 그 항목 스킵.

2. **순서 결정**
   - depends 가 적힌 항목은 해당 모듈이 done (체크됨) 인지 확인. 미완이면 뒤로 미룸.
   - dispatch 가능한 것부터 순서대로.

3. **사용자 확인**
   - dispatch 할 순서 목록을 사용자에게 한 번 보여주고 "ㄱㄱ?" 물어봐라.
   - 한 번에 한 항목씩이 기본. "전체 자동 진행" 은 사용자가 명시했을 때만.

4. **항목 하나 dispatch**
   - 현재 git HEAD sha 기록 (`git rev-parse HEAD`)
   - `Agent({ subagent_type: "claude" })` (또는 등록된 `scoped-implementer`) 호출. 프롬프트에 다음을 명시적으로 포함:
     - 항목 title
     - owns 파일 목록 (절대 경로 풀로)
     - depends 목록
     - 본문
     - "너는 scoped-implementer 다. `.claude/agents/scoped-implementer.md` 를 따라라" 한 줄

   주의: 현재 환경에 `scoped-implementer` 서브에이전트 타입이 등록 안 돼있을 수 있다. 그 경우 `claude` 타입으로 부르되 프롬프트에 .md 경로를 알려주면 같은 효과.

5. **owns 경계 검증 (워커 복귀 후)**
   - `git diff --name-only <기록한 sha>..HEAD` 로 변경 파일 목록 수집
   - 다음 외 파일이 있으면 **위반**:
     - 항목의 owns 에 명시된 파일
     - `plan.md` (보강 허용)
   - **위반 시**: 사용자에게 알리고 `git reset --hard <기록한 sha>` 제안. 자동 실행 X — 반드시 사용자 승인 받고 실행. 그리고 그 항목은 스킵 처리하고 todo.md 도 안 닫는다.

6. **체크박스 닫기**
   - 위반 없으면 todo.md 에서 해당 항목의 `- [ ]` → `- [x]` 로 교체 (`Edit`).
   - 본문은 그대로 둠 (CLAUDE.md 규칙: 히스토리 보존).

7. **다음 항목 또는 종료**
   - 남은 dispatch 가능 항목이 있고 사용자가 "계속" 이라 했으면 4번 반복.
   - 없으면 종료 보고: 완료 N개 / 위반 M개 / 스킵 K개.

## 출력

각 dispatch 사이 한 줄 상태 업데이트:
```
[1/4] api.ts ... 완료 (커밋 abc1234, plan.md 보강 1건)
[2/4] browser.ts ... 진행중
```

종료 시 요약:
```
완료 3 / 위반 1 (browser.ts: package.json 수정 발견 → 롤백 제안) / 미완 0
다음 dispatch 가능: scraper.ts (foundation 후)
```

## 안 하는 것

- plan.md 수정 (워커 전담)
- todo.md 의 본문 수정 (체크박스만)
- 새 todo 추가 (`/todo-plan` 전담)
- 코드 직접 작성 (워커 전담)

## 미래 확장 (지금은 무시)

- `--parallel` 플래그: 같은 layer 항목들을 `Agent({ isolation: "worktree" })` 로 동시 dispatch → 각자 ephemeral branch → `git rebase master <br>` + `git merge --ff-only` 로 선형 머지
