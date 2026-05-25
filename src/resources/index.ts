/**
 * MCP resources — 4종 카탈로그.
 *
 * 도구가 호출 직전 또는 스킨 작성 직전에 LLM 이 읽어 reference 로 쓰는 정적/반정적 카탈로그.
 *
 *  - tistory://substitutions    — 스킨 치환자 catalog (src/tistory/catalog.ts JSON)
 *  - tistory://page-types       — `tt-body-*` 페이지 종류 (docs/api.md §8)
 *  - tistory://gotchas          — 도구·스킨 함정 (CLAUDE.md + docs/api.md §9)
 *  - tistory://template-default — 기본 스킨 골격 (templates/default/)
 *
 * `src/index.ts` 에서 `registerResources(server)` 한 줄 호출하면 4개 다 붙는다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSubstitutions, SUBSTITUTIONS_URI } from "./substitutions.js";
import { registerPageTypes, PAGE_TYPES_URI } from "./page-types.js";
import { registerGotchas, GOTCHAS_URI } from "./gotchas.js";
import { registerTemplateDefault, TEMPLATE_DEFAULT_URI } from "./template-default.js";

export {
  SUBSTITUTIONS_URI,
  PAGE_TYPES_URI,
  GOTCHAS_URI,
  TEMPLATE_DEFAULT_URI,
};

export function registerResources(server: McpServer): void {
  registerSubstitutions(server);
  registerPageTypes(server);
  registerGotchas(server);
  registerTemplateDefault(server);
}
