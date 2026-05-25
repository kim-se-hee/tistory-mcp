/**
 * `tistory/new_skin` — 스킨 신규 작성 인터뷰.
 *
 * 빈 종이에서 스킨을 만들 때 LLM 이 따라야 할 흐름을 한 묶음으로 박아 둔다.
 * 강제 워크플로우는 아니다 (plan.md §2 Prompts) — 호출자가 이 prompt 를
 * 시작점으로 골라 LLM 한테 흘려보내면, LLM 은 안에 박힌 단계를 자율적으로
 * 도구 호출로 풀어낸다.
 *
 * 핵심 가정:
 *   - 기본 골격은 `tistory://template-default` 의 4파일 (skin.html / style.css /
 *     index.xml + preview 이미지 4종). plan.md §4 의 minimal vanilla baseline.
 *   - 스킨 변수 효과는 코드가 그 변수를 참조해야 보임 (CLAUDE.md 함정 §3).
 *     컬러팔레트는 `[##_var_xxx_##]` 로 노출하는 게 디자인 자유도가 높다.
 *   - 작성 직후 검증: `skin_validate` → 함정 (빈 url / `/tag` / `<s_t3>` 누락 등)
 *     걸러내고 `tistory_apply_skin {isPreview:true}` 로 dry-run.
 *   - 카테고리 (`tt-body-*`) 분기 CSS 는 `tistory://page-types` reference.
 *
 * arguments 는 전부 optional. 인터뷰 자체를 prompt 안에 포함해서, 인자가 없으면
 * LLM 이 사용자에게 되묻도록 유도한다 (제출 시점에 다 알 필요 없음).
 *
 * 등록 (`src/index.ts` 의 `server.registerPrompt`) 은 `src/prompts/index.ts` 의
 * `registerPrompts(server)` 한 번에 묶여서 처리된다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const NEW_SKIN_PROMPT_NAME = "tistory/new_skin";

// MCP prompt arguments 는 스펙상 string 전용 — zod v4 raw shape 로 정의.
const argsShape = {
  blogPurpose: z
    .string()
    .optional()
    .describe(
      "블로그의 주된 용도 한 줄. 예: '주간 기술 노트', '여행 사진 아카이브'. " +
        "레이아웃 결정 (리스트 vs 그리드 vs 매거진) 의 기준이 된다.",
    ),
  style: z
    .string()
    .optional()
    .describe(
      "디자인 톤. 예: 'minimal', 'editorial', 'brutalist', 'magazine'. " +
        "타이포·여백·이미지 비중 결정.",
    ),
  colorPalette: z
    .string()
    .optional()
    .describe(
      "색 팔레트 힌트. 예: 'monochrome', 'warm earth', '#0f172a + accent #f43f5e'. " +
        "스킨 변수 (`[##_var_*_##]`) 로 분리 노출할 색의 후보가 된다.",
    ),
};

type Args = {
  blogPurpose?: string;
  style?: string;
  colorPalette?: string;
};

function buildBriefing(args: Args): string {
  const lines: string[] = [];
  lines.push("# 새 스킨 인터뷰 — 작성 흐름");
  lines.push("");
  lines.push("아래 단계를 따라 사용자와 스킨을 함께 만들어라. 비어있는 인자는 사용자에게 한 번에 1~2개씩 되묻고, 충분히 모이면 코드 작성으로 넘어간다.");
  lines.push("");
  lines.push("## 0. 현재 입력");
  lines.push(`- blogPurpose: ${args.blogPurpose ?? "(미지정 — 사용자에게 묻기)"}`);
  lines.push(`- style: ${args.style ?? "(미지정 — 사용자에게 묻기)"}`);
  lines.push(`- colorPalette: ${args.colorPalette ?? "(미지정 — 사용자에게 묻기)"}`);
  lines.push("");
  lines.push("## 1. 기준 골격 확보");
  lines.push("- `tistory://template-default` 리소스를 읽어 `skin.html` / `style.css` / `index.xml` / preview 이미지 4종을 시작점으로 삼는다 (Odyssey 위젯·커버·전용 CSS 가 제거된 minimal vanilla baseline).");
  lines.push("- `tistory://substitutions` 리소스로 사용 가능한 치환자·블록을 먼저 훑는다. 빠뜨리면 `skin_validate` 에서 warning.");
  lines.push("- `tistory://page-types` 리소스로 `body#tt-body-*` 분기 셀렉터를 확인한다 (index / page / category / tag / guestbook).");
  lines.push("");
  lines.push("## 2. 디자인 결정");
  lines.push("- blogPurpose → 홈(`<s_list>` vs 매거진 vs 커버) 레이아웃 결정.");
  lines.push("- style → 타이포 스케일 / 여백 / 컴포넌트 톤.");
  lines.push("- colorPalette → 핵심 색을 `[##_var_xxx_##]` 변수로 분리. 변수로 빼야 추후 `tistory_apply_skin_settings { variableSettings }` 로 코드 손 안 대고 색만 바꿀 수 있다 (CLAUDE.md 함정 §3 — 변수 효과는 코드 참조 여부에 달림).");
  lines.push("");
  lines.push("## 3. 코드 작성 시 주의 (함정 — `tistory://gotchas` 참조)");
  lines.push("- 빈 `url('')` 금지 — 404 가 자체 진단 페이지를 깨뜨린다.");
  lines.push("- `/tag` 절대 직링크 금지 — 404. 태그 목록은 `<s_tag>` 블록이나 `[##_tag_label_*_##]` 사용.");
  lines.push("- `<s_t3>` 가 누락된 블록이 있으면 일부 페이지에서 렌더 실패. 스코프 단위로 짝 맞추기.");
  lines.push("- `<body>` 태그에 `[##_body_id_##]` 바인딩 필수 — 안 박으면 `tt-body-*` 분기 CSS 가 죽는다.");
  lines.push("");
  lines.push("## 4. 검증 & 미리보기");
  lines.push("1. `skin_validate` 로 정적 검증. errors 0 + warnings 검토.");
  lines.push("2. `tistory_apply_skin { isPreview: true }` 또는 `tistory_preview_skin { page: 'index' | 'entry' | 'category' | 'tag' | 'guestbook' }` 로 페이지별 렌더 확인.");
  lines.push("3. `tistory_screenshot` 로 픽셀 검증 (LLM 멀티모달이 직접 보고 다음 패치를 결정).");
  lines.push("4. 만족하면 `tistory_apply_skin { isPreview: false }` 로 라이브 적용. 변수만 만지는 후속 변경은 `tistory_apply_skin_settings` 한 방.");
  lines.push("");
  lines.push("## 5. 카테고리·메타 연동 (선택)");
  lines.push("- `tistory_fetch_meta` 로 카테고리 / 활성 플러그인 / 현재 스킨명 확인 후, 카테고리별 hero 카드 같은 페이지별 분기 CSS 를 마지막에 얹는다.");
  lines.push("");
  lines.push("이 흐름을 사용자에게 단계별로 안내하면서 진행하라. 한 번에 한 단계씩, 사용자 의사 결정이 필요한 곳에선 잠시 멈춰 물어라.");
  return lines.join("\n");
}

export function registerNewSkin(server: McpServer): void {
  server.registerPrompt(
    NEW_SKIN_PROMPT_NAME,
    {
      title: "Tistory 새 스킨 작성 인터뷰",
      description:
        "빈 종이에서 Tistory 스킨을 만들 때 따를 인터뷰·검증·미리보기·적용 흐름. " +
          "template-default 골격에서 시작해 변수 분리 → skin_validate → preview/screenshot → apply 순. " +
          "강제 워크플로우 아님 (plan.md §2 Prompts) — 도구 자유 조합 권장 시작점.",
      argsSchema: argsShape,
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildBriefing(args),
          },
        },
      ],
    }),
  );
}
