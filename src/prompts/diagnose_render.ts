/**
 * `tistory/diagnose_render` — 시각 이상 진단 체크리스트.
 *
 * "왜 깨져 보이지?" 류 호출에 대해 LLM 이 머릿속에서 빠뜨릴 만한 후보를
 * 순서대로 짚도록 안내한다. 함정 카탈로그 (`tistory://gotchas`) 의 skin-code /
 * preview / skin-vars 카테고리를 흐름에 맞춰 한 줄씩 풀어 둔다.
 *
 * arguments 는 모두 optional. 스크린샷이나 기대 동작 묘사가 있으면 첫 단계에서
 * 바로 사용하고, 없으면 LLM 이 사용자에게 되묻도록 유도한다.
 *
 * 권장 사용 시점:
 *   - 사용자가 "이 부분이 이상해" / "이거 왜 안 나와?" 라고 말했을 때.
 *   - 스킨 적용 직후 결과가 예상과 다를 때 (preview / screenshot 사이클의 트러블슈팅).
 *
 * 등록은 `src/prompts/index.ts` 의 `registerPrompts(server)` 에서 일괄.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const DIAGNOSE_RENDER_PROMPT_NAME = "tistory/diagnose_render";

const argsShape = {
  screenshotUrl: z
    .string()
    .optional()
    .describe(
      "사용자가 공유한 스크린샷 URL 또는 식별자. 있으면 첫 단계에서 LLM 이 직접 보고 가설을 좁힌다. " +
        "없으면 `tistory_screenshot` 으로 직접 캡처해서 확보.",
    ),
  expectedBehavior: z
    .string()
    .optional()
    .describe(
      "사용자가 원하던 결과 한 줄. 예: '카테고리 페이지에 hero 가 떠야 함', '본문 이미지가 보여야 함'. " +
        "이게 있어야 '왜 안 나오나' 의 'X' 가 명확해진다.",
    ),
};

type Args = {
  screenshotUrl?: string;
  expectedBehavior?: string;
};

function buildChecklist(args: Args): string {
  const lines: string[] = [];
  lines.push("# 시각 이상 진단 — 체크리스트");
  lines.push("");
  lines.push("아래 후보를 1번부터 순서대로 짚어라. 가장 흔한 원인을 위에 둔다. 한 단계라도 'hit' 이면 거기서 멈추고 패치 → 재검증.");
  lines.push("");
  lines.push("## 0. 현재 입력");
  lines.push(`- screenshotUrl: ${args.screenshotUrl ?? "(미제공 — `tistory_screenshot` 으로 캡처 권장)"}`);
  lines.push(`- expectedBehavior: ${args.expectedBehavior ?? "(미제공 — 사용자에게 한 줄 요약 요청)"}`);
  lines.push("");
  lines.push("필요하면 먼저 `tistory://gotchas` 리소스를 읽어 카테고리별 함정 풀세트를 확보하라.");
  lines.push("");
  lines.push("## 1. 어디서 깨지는지 페이지 식별");
  lines.push("- 깨진 페이지의 `body#tt-body-*` 를 확인 (DevTools 또는 screenshot 의 URL → `tistory://page-types` 매핑).");
  lines.push("- 모든 페이지에서 깨지는지, 특정 `tt-body-*` 에서만인지 분리. 후자라면 페이지별 분기 CSS / 누락된 블록 의심.");
  lines.push("");
  lines.push("## 2. 스킨 코드 함정 (`tistory://gotchas` skin-code)");
  lines.push("- 빈 `url('')` — 자체 진단 페이지가 404 로 깨진다. CSS / inline style 전체에서 grep.");
  lines.push("- `/tag` 절대 직링크 — 404. 태그 위젯은 `<s_tag>` 블록 / `[##_tag_label_*_##]` 토큰으로.");
  lines.push("- `<s_t3>` 누락 또는 중복 — 일부 블록이 통째로 안 그려진다. 블록 짝 검증은 `skin_validate` 의 카테고리 (2).");
  lines.push("- `<body>` 에 `[##_body_id_##]` 미바인딩 — `body#tt-body-*` 분기 CSS 가 전부 죽는다. (스킨 시작점 함정 1순위)");
  lines.push("- `body#tt-body-*` 스코프 잘못 — 의도한 페이지에 스타일이 안 닿거나, 다른 페이지로 새어 나간다.");
  lines.push("");
  lines.push("## 3. 본문/이미지 함정");
  lines.push("- 본문 이미지가 안 보임 → `[##_Image|kage@{key}|...|_##]` 의 `url` 부분이 ~5일 만료된 임시 URL 인지 확인 (`docs/api.md §5.2-5.3`). 영구 치환자로 다시 박혀 있어야 함.");
  lines.push("- 발행 후 본문이 비어 있음 → 글쓰기 UI 자동화로 박은 의심. `mdCM.setValue` 가 React state 미반영 (CLAUDE.md 함정 §2). `tistory_publish_post` 직접 호출로 전환.");
  lines.push("- 마크다운 원본이 사라짐 → 정상. 서버는 HTML 정규화만 보관 (CLAUDE.md 함정 §7).");
  lines.push("");
  lines.push("## 4. 스킨 변수 함정");
  lines.push("- variableSettings 바꿨는데 안 보임 → 스킨 코드가 그 변수를 참조 안 함. 코드의 `[##_var_xxx_##]` 사용처 확인 (`tistory://gotchas` skin-vars).");
  lines.push("");
  lines.push("## 5. 미리보기 vs 라이브 차이");
  lines.push("- `tistory_preview_skin` 은 **라이브 코드** 기반 (body 에 html/css 안 받음 — `docs/api.md §6.4`). 변경된 코드를 dry-run 하려면 `tistory_apply_skin {isPreview:false}` 즉시 적용 → preview → 원본 복구. 사용자가 'preview 에선 됐는데 라이브에선 안 됨' 이라 말하면 사실 같은 코드를 보고 있었던 것.");
  lines.push("");
  lines.push("## 6. 검증 도구로 한 번 더");
  lines.push("- `skin_validate` 로 errors/warnings 확인. preview 이미지 4종 누락도 여기서 잡힌다.");
  lines.push("- `tistory_screenshot` 으로 픽셀 재확인. 패치 후 before/after 비교.");
  lines.push("");
  lines.push("진단이 끝나면 원인을 한 줄로 요약하고, 패치 → 재적용 → 재검증 한 사이클을 사용자에게 제안하라.");
  return lines.join("\n");
}

export function registerDiagnoseRender(server: McpServer): void {
  server.registerPrompt(
    DIAGNOSE_RENDER_PROMPT_NAME,
    {
      title: "Tistory 시각 이상 진단 체크리스트",
      description:
        "스킨/글이 예상과 다르게 보일 때 LLM 이 짚어야 할 함정 후보 순서. " +
          "skin-code → 본문/이미지 → 스킨 변수 → preview vs live → 검증 도구 순. " +
          "스크린샷·기대 동작을 인자로 받아 사용자 대화의 시작점으로 쓴다.",
      argsSchema: argsShape,
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildChecklist(args),
          },
        },
      ],
    }),
  );
}
