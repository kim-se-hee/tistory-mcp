---
name: todo-plan
description: plan.md 를 읽고 다음 작업 묶음을 todo.md 에 append. 체크박스 + owns/depends 메타 포맷 자동 부착. plan.md 는 read-only.
---

# /todo-plan

plan.md (+ 현재 코드 상태 + 최근 커밋) 를 보고 "다음에 뭐 할지" 를 todo.md 에 append 한다. 이미 있는 항목은 절대 건드리지 않는다.

## 실행 순서

1. **상태 파악**
   - `Read` plan.md, todo.md
   - `Bash` `git log --oneline -20` 으로 최근 흐름 확인
   - 필요하면 `Glob`/`Grep` 으로 구현 진척도 확인 (예: `src/tistory/api.ts` 있나)

2. **다음 묶음 후보 추출**
   - todo.md 의 미체크 항목 중 **depends 가 모두 done** 인 것들이 곧 dispatch 가능한 묶음.
   - 만약 todo.md 가 비어있거나 다음 Phase 로 넘어갈 시점이면 plan.md 의 도구 표·아키텍처·결정을 보고 새 항목 후보를 뽑는다.
   - 사용자에게 "이 묶음으로 갈까?" 한 번 물어봐라. 자의적으로 큰 묶음 만들지 말 것.

3. **todo.md 에 append**
   - 해당 Phase 섹션 끝에 다음 형식으로 추가:
     ```markdown
     - [ ] **<짧은 이름>** — <한 줄 설명>
       - owns: `<path>`, `<path>`
       - depends: <이름> (없으면 줄 생략)
     ```
   - **owns 와 depends 라인은 필수 형식**. 본문은 자유.
   - 이미 있는 체크 항목은 닫혔든 열렸든 **건드리지 말 것**.

4. **plan.md 는 read-only**
   - 이 스킬은 plan.md 를 절대 수정하지 않는다. 보강은 `scoped-implementer` (워커) 의 책임.

## 출력

todo.md 에 추가한 항목 목록을 사용자에게 보여주고, 다음으로 `/todo-run` 을 호출하면 된다고 안내.

## 안 하는 것

- plan.md 갱신 (워커 전담)
- 이미 있는 todo 수정/삭제 (사용자 수동 영역)
- 코드 작성 (워커 전담)
