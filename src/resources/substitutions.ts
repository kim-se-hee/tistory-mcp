/**
 * `tistory://substitutions` — 스킨 치환자 카탈로그.
 *
 * `src/tistory/catalog.ts` 의 `catalog` 객체를 그대로 JSON 으로 노출.
 * LLM 이 `skin_validate` 호출 전에 또는 스킨 코드 작성 시 토큰 reference 로 읽는 용도.
 */

import type { McpServer, ReadResourceCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalog } from "../tistory/catalog.js";

export const SUBSTITUTIONS_URI = "tistory://substitutions";

const read: ReadResourceCallback = async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(catalog, null, 2),
    },
  ],
});

export function registerSubstitutions(server: McpServer): void {
  server.registerResource(
    "substitutions",
    SUBSTITUTIONS_URI,
    {
      title: "Tistory 스킨 치환자 카탈로그",
      description:
        "모든 `<s_*>` 블록과 `[##_*_##]` 값 치환자, variable system, index.xml 스펙. " +
        "스킨 코드 작성/검증 reference. source: src/tistory/catalog.ts (docs/catalog.md 의 TS 변환본).",
      mimeType: "application/json",
    },
    read,
  );
}
