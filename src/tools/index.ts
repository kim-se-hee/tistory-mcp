/**
 * MCP tools — 13종 (plan.md §2 Tools).
 *
 * 카테고리:
 *  - 세션:   session_init
 *  - 글:     publish_post / update_post / delete_post / fetch_post / search_posts
 *  - 자산:   upload_image
 *  - 스킨:   apply_skin / apply_skin_settings / preview_skin / skin_validate
 *  - 메타:   fetch_meta
 *  - 보조:   screenshot
 *
 * `src/index.ts` 에서 `registerTools(server)` 한 줄 호출하면 13개 다 붙는다.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerSessionInit } from "./session_init.js";
import { registerPublishPost } from "./publish_post.js";
import { registerUpdatePost } from "./update_post.js";
import { registerDeletePost } from "./delete_post.js";
import { registerFetchPost } from "./fetch_post.js";
import { registerSearchPosts } from "./search_posts.js";
import { registerUploadImage } from "./upload_image.js";
import { registerApplySkin } from "./apply_skin.js";
import { registerApplySkinSettings } from "./apply_skin_settings.js";
import { registerPreviewSkin } from "./preview_skin.js";
import { registerSkinValidate } from "./skin_validate.js";
import { registerFetchMeta } from "./fetch_meta.js";
import { registerScreenshot } from "./screenshot.js";

export function registerTools(server: McpServer): void {
  registerSessionInit(server);
  registerPublishPost(server);
  registerUpdatePost(server);
  registerDeletePost(server);
  registerFetchPost(server);
  registerSearchPosts(server);
  registerUploadImage(server);
  registerApplySkin(server);
  registerApplySkinSettings(server);
  registerPreviewSkin(server);
  registerSkinValidate(server);
  registerFetchMeta(server);
  registerScreenshot(server);
}
