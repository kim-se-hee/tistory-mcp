/**
 * `tistory/iterate_loop` — fetch_meta → validate → preview → screenshot → apply 사이클.
 *
 * 스킨 점진 개선 (부분 패치) 작업의 한 사이클을 LLM 한테 박아 둔다. plan.md
 * §1 사용자 통증 #2 "편집 루프 1분+" 의 직격 자동화.
 *
 * 핵심 패턴 (부분 패치):
 *   - 큰 스킨을 한 번에 재작성하지 말 것. 변경 범위 (`changeScope`) 를 한 블록 /
 *     하나의 셀렉터 / 하나의 페이지로 좁힌다.
 *   - 현재 코드는 `tistory_apply_skin` 도구 호출 응답 또는 `tistory://template-default`
 *     기준점 으로 확보. 그 위에 diff 만 얹는다.
 *   - 사이클 한 바퀴가 1분 안에 돌아야 사용자가 견딘다. screenshot 까지 자동.
 *
 * arguments 는 모두 optional. 입력이 비어 있어도 사용자에게 되묻고 시작할 수 있게.
 *
 * 등록은 `src/prompts/index.ts` 의 `registerPrompts(server)` 에서 일괄.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const ITERATE_LOOP_PROMPT_NAME = "tistory/iterate_loop";

const argsShape = {
  targetPage: z
    .string()
    .optional()
    .describe(
      "이번 사이클의 대상 페이지 키. `tistory_preview_skin` enum 과 동일: " +
        "`index` / `entry` / `category` / `tag` / `guestbook`. " +
        "한 페이지로 좁혀야 preview/screenshot 비용이 작다.",
    ),
  changeScope: z
    .string()
    .optional()
    .describe(
      "이번 사이클에서 손댈 범위 한 줄. 예: '`<s_list>` 카드 thumbnail 비율만', " +
        "'header sticky 스타일만', '`body#tt-body-entry` 의 본문 max-width 만'. " +
        "범위를 좁힐수록 사이클이 빠르고 회귀 위험이 작다 (부분 패치 패턴).",
    ),
};

type Args = {
  targetPage?: string;
  changeScope?: string;
};

function buildLoopGuide(args: Args): string {
  const lines: string[] = [];
  lines.push("# 스킨 개선 사이클 — fetch_meta → validate → preview → screenshot → apply");
  lines.push("");
  lines.push("한 바퀴를 1분 안에 끝내는 게 목표다. 변경을 작게 끊어 여러 바퀴 도는 게 한 번에 다 하는 것보다 빠르다 (부분 패치 패턴).");
  lines.push("");
  lines.push("## 0. 이번 사이클의 좁은 범위");
  lines.push(`- targetPage: ${args.targetPage ?? "(미지정 — 사용자에게 어느 페이지를 고칠지 물어라)"}`);
  lines.push(`- changeScope: ${args.changeScope ?? "(미지정 — '뭘 어떻게 바꿀지' 한 줄로 좁히게 유도하라)"}`);
  lines.push("");
  lines.push("범위가 두루뭉술하면 사이클이 비대해진다. 한 셀렉터 / 한 블록 / 한 페이지로 좁힐 때까지 코드 작성을 보류하라.");
  lines.push("");
  lines.push("## 1. 컨텍스트 확보 (fetch_meta)");
  lines.push("- `tistory_fetch_meta { blogUrl }` — 카테고리 / 활성 플러그인 / 현재 스킨명 확인. 변경이 특정 카테고리 / 플러그인에 의존한다면 여기서 사실 검증.");
  lines.push("- 단순 CSS 손질이라면 생략 가능. 새 블록·페이지·플러그인 연동이 끼면 필수.");
  lines.push("");
  lines.push("## 2. 현재 코드 + 패치 계획");
  lines.push("- 라이브 코드 기준점: `tistory_apply_skin` GET 응답 (`docs/api.md §6.1`) 또는 직전 적용본.");
  lines.push("- `tistory://substitutions` / `tistory://page-types` 로 사용할 토큰 / `body#tt-body-*` 셀렉터 확정.");
  lines.push("- 패치는 **부분 교체** 형태로 작성 — 기존 블록의 외형은 유지하고, changeScope 내부만 손본다.");
  lines.push("");
  lines.push("## 3. 정적 검증 (skin_validate)");
  lines.push("- `skin_validate { html, css }` — errors 0 확인. warnings (catalog 누락, preview 이미지 fallback) 는 의도 검토.");
  lines.push("- error 가 나오면 여기서 멈추고 코드 수정. preview 까지 가기 전에 잡는 게 비용이 가장 싸다.");
  lines.push("");
  lines.push("## 4. 서버 미리보기 (preview_skin)");
  lines.push("- `tistory_preview_skin { page: <targetPage> }` — 풀 HTML 응답.");
  lines.push("- ★ preview 는 **라이브 코드 기반** (`docs/api.md §6.4`). 변경된 코드를 dry-run 하려면 한 번 apply 가 필요하다는 점 명심. 두 옵션:");
  lines.push("  - (a) `tistory_apply_skin { isPreview: true }` — 임시 적용 후 preview. 라이브 영향 없음. 권장.");
  lines.push("  - (b) `tistory_apply_skin { isPreview: false }` 즉시 적용 → preview → 백업 복구. 라이브가 잠깐 변함 — 사용자가 보고 있으면 피하라.");
  lines.push("");
  lines.push("## 5. 픽셀 검증 (screenshot)");
  lines.push("- `tistory_screenshot { url }` — 적용된 페이지를 캡처. preview HTML 만으론 폰트·이미지·JS 효과를 못 본다.");
  lines.push("- LLM 멀티모달이 직접 보고 changeScope 와 일치하는지 판단. 어긋나면 3번으로 복귀.");
  lines.push("");
  lines.push("## 6. 라이브 적용 (apply_skin)");
  lines.push("- `tistory_apply_skin { isPreview: false, html, css }` — 최종 박기.");
  lines.push("- 변수만 바뀌었다면 코드 재배포 없이 `tistory_apply_skin_settings { variableSettings }` 한 방으로 끝낼 수 있는지 먼저 확인.");
  lines.push("");
  lines.push("## 7. 회고 & 다음 사이클");
  lines.push("- 이번 사이클에서 발견한 함정 / 신규 치환자 / 깨지는 페이지가 있으면 사용자에게 보고하고 다음 changeScope 후보로 적어 둔다.");
  lines.push("- 이상이 깊으면 `tistory/diagnose_render` prompt 로 전환.");
  lines.push("");
  lines.push("한 바퀴가 끝났다면 사용자에게 '다음 changeScope' 를 물어 같은 prompt 를 다시 호출하라.");
  return lines.join("\n");
}

export function registerIterateLoop(server: McpServer): void {
  server.registerPrompt(
    ITERATE_LOOP_PROMPT_NAME,
    {
      title: "Tistory 스킨 점진 개선 사이클",
      description:
        "fetch_meta → skin_validate → preview_skin → screenshot → apply_skin 한 바퀴를 1분 안에 도는 흐름. " +
          "부분 패치 패턴 (작게 끊어 여러 바퀴) 권장. " +
          "targetPage / changeScope 인자로 사이클의 범위를 좁힌다. " +
          "preview 가 라이브 코드 기반인 점 (docs/api.md §6.4) 을 명시.",
      argsSchema: argsShape,
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildLoopGuide(args),
          },
        },
      ],
    }),
  );
}
