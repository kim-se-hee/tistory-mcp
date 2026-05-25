/**
 * MCP prompts — 워크플로우 추천 3종 (plan.md §2 Prompts).
 *
 * Prompts 는 강제 워크플로우가 아니다. LLM 이 자유로이 도구를 조합하는 게
 * 기본이고, 이 prompt 들은 "이런 흐름으로 풀면 보통 깔끔하다" 는 시작점.
 *
 *  - tistory/new_skin         — 스킨 신규 작성 인터뷰
 *  - tistory/diagnose_render  — 시각 이상 진단 체크리스트
 *  - tistory/iterate_loop     — fetch_meta → validate → preview → screenshot → apply 사이클
 *
 * `src/index.ts` 에서 `registerPrompts(server)` 한 줄 호출하면 3개 다 붙는다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerNewSkin, NEW_SKIN_PROMPT_NAME } from "./new_skin.js";
import { registerDiagnoseRender, DIAGNOSE_RENDER_PROMPT_NAME } from "./diagnose_render.js";
import { registerIterateLoop, ITERATE_LOOP_PROMPT_NAME } from "./iterate_loop.js";

export {
  NEW_SKIN_PROMPT_NAME,
  DIAGNOSE_RENDER_PROMPT_NAME,
  ITERATE_LOOP_PROMPT_NAME,
};

export function registerPrompts(server: McpServer): void {
  registerNewSkin(server);
  registerDiagnoseRender(server);
  registerIterateLoop(server);
}
