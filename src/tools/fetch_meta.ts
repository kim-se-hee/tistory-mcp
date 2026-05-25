/**
 * `tistory_fetch_meta` — 블로그 풍부 메타 한 방 조회.
 *
 * 동선 (plan.md §2):
 *   - 기본: admin `/manage/category` GET → inline `window.Config.blog` 파싱
 *     (api.ts `fetchBlogConfig`) — categories / activePlugins / skinInfo /
 *     blogSettings / user / cclCommercial / useMobile 등 한 페이지에 다 박혀있음.
 *   - 폴백: 세션이 없거나 만료됐는데 `blogUrl` 만 들어왔을 때
 *     scraper `fetchPublicBlogConfig` 로 공개 페이지의 `window.T.config.BLOG`
 *     (blogId/host 정도만) 만 반환. 한정 메타이므로 응답에 폴백임을 명시.
 *
 * 책임 분담 (CLAUDE.md / plan.md §4):
 *   - cookie 필요 admin 메타 = api.ts (fetchBlogConfig)
 *   - cookie 불필요 공개 메타 = scraper.ts (fetchPublicBlogConfig)
 *   - 이 도구는 두 소스를 합치지 않고 "있는 쪽" 우선 (admin 이 풍부).
 *
 * ★ 추가 endpoint (`/manage/category.json`, `/manage/plugins.json`,
 * `/manage/setting/blog.json` 등 docs/api.md §3.1) 은 현 api.ts 미구현 →
 * 후속 todo. `Config.blog` 가 대부분의 LLM 의사결정 (categoryId / 태그 추론용
 * activePlugins / 현재 스킨명) 에 충분.
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  fetchBlogConfig,
  getBlogId,
  SessionExpiredError,
  TistoryApiError,
  type BlogConfig,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";
import {
  fetchPublicBlogConfig,
  PublicFetchError,
  type PublicBlogConfig,
} from "../tistory/scraper.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "미지정 시 keytar `default` 슬롯 (마지막 로그인 미러링) 을 사용. " +
        "세션이 없거나 만료됐고 host 가 명시되면 공개 페이지 폴백으로 최소 메타만 반환.",
    ),
} as const;

type Input = {
  blogUrl?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 응답 정형화 — LLM 이 다음 도구 호출 결정에 바로 쓸 수 있게 평탄화
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `BlogConfig` 의 풍부 메타를 LLM 이 한 번에 읽을 형태로 요약.
 *
 * - `categories` 는 트리이므로 평탄화 (`id`/`name`/`label`/`entries`/`visibility`) — id 만 알면 `publish_post` 의 `category` 인자에 바로 박힘.
 * - `skinInfo` 는 name/title/version 핵심만.
 * - `blogSettings` / `cclCommercial` / `cclDerive` / `useMobile` 은 통과.
 */
interface AdminMetaSummary {
  source: "admin";
  blogId: number | null;
  domain?: string;
  title?: string;
  created: string;
  categories: Array<{
    id: string | number;
    name: string;
    label?: string;
    entries?: number;
    visibility?: string;
    parentId?: string | number | null;
  }>;
  activePlugins: string[];
  skin: {
    name?: string;
    title?: string;
    version?: string;
    [key: string]: unknown;
  };
  blogSettings: Record<string, unknown>;
  cclCommercial?: number;
  cclDerive?: number;
  /** 실측: 응답이 string `"1"` 또는 boolean — 정규화 없이 통과 */
  useMobile?: string | boolean;
}

interface PublicMetaSummary {
  source: "public";
  blogId: number | null;
  host: string | null;
  /** 공개 페이지에서 얻은 원본 BLOG 객체 통째 — admin 폴백임을 명시. */
  raw: PublicBlogConfig;
  /** 카테고리/플러그인/스킨 등 풍부 메타는 admin 모드에서만. */
  hint: string;
}

/**
 * `Config.blog.categories` 트리 평탄화.
 *
 * tistory 카테고리 트리 노드는 `{ id, name, label, entries, visibility, children[] }`
 * 재귀 구조 (docs/api.md §3.3). 부모 id 를 같이 박아 LLM 이 계층 복원 가능.
 */
function flattenCategories(
  nodes: unknown[],
  parentId: string | number | null = null,
): AdminMetaSummary["categories"] {
  const out: AdminMetaSummary["categories"] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const id = (node["id"] ?? node["categoryId"]) as string | number | undefined;
    const name = node["name"];
    if (id === undefined || typeof name !== "string") continue;
    out.push({
      id,
      name,
      label: typeof node["label"] === "string" ? (node["label"] as string) : undefined,
      entries:
        typeof node["entries"] === "number" ? (node["entries"] as number) : undefined,
      visibility:
        typeof node["visibility"] === "string"
          ? (node["visibility"] as string)
          : undefined,
      parentId,
    });
    const children = node["children"];
    if (Array.isArray(children) && children.length > 0) {
      out.push(...flattenCategories(children, id));
    }
  }
  return out;
}

function summarizeAdmin(blog: BlogConfig): AdminMetaSummary {
  // skinInfo 는 자유 형식 — name/title/version 만 보장 안 함. 있는 것만 노출.
  const skinInfo = blog.skinInfo as Record<string, unknown>;
  const skin: AdminMetaSummary["skin"] = {
    ...skinInfo,
    name: typeof skinInfo["name"] === "string" ? (skinInfo["name"] as string) : undefined,
    title:
      typeof skinInfo["title"] === "string" ? (skinInfo["title"] as string) : undefined,
    version:
      typeof skinInfo["version"] === "string"
        ? (skinInfo["version"] as string)
        : undefined,
  };

  return {
    source: "admin",
    blogId: getBlogId(blog),
    ...(blog.domain !== undefined ? { domain: blog.domain } : {}),
    ...(blog.title !== undefined ? { title: blog.title } : {}),
    created: blog.created,
    categories: flattenCategories(blog.categories),
    activePlugins: blog.activePlugins,
    skin,
    blogSettings: blog.blogSettings,
    ...(blog.cclCommercial !== undefined ? { cclCommercial: blog.cclCommercial } : {}),
    ...(blog.cclDerive !== undefined ? { cclDerive: blog.cclDerive } : {}),
    ...(blog.useMobile !== undefined ? { useMobile: blog.useMobile } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// host 정규화 — blogUrl 입력은 `saree98.tistory.com` 또는 `https://...` 둘 다 허용
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHost(blogUrl: string): string {
  try {
    // 프로토콜이 박혀있으면 URL 파서 통과
    const u = new URL(blogUrl);
    return u.host;
  } catch {
    // 그냥 host — 슬래시/공백만 잘라낸다
    return blogUrl.replace(/^\/+|\/+$/g, "").trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const FETCH_META_TOOL_NAME = "tistory_fetch_meta";

export function registerFetchMeta(server: McpServer): void {
  server.registerTool(
    FETCH_META_TOOL_NAME,
    {
      title: "Tistory 블로그 메타 한 방 조회",
      description:
        "admin `/manage/category` 의 inline `window.Config.blog` 를 파싱해 " +
        "카테고리 트리(평탄화) / 활성 플러그인 / 현재 스킨 / 사용자 / 블로그 설정을 한 번에 반환합니다. " +
        "publish/update 도구의 `category` (categoryId) 와 LLM 의 태그/플러그인 분기 판단에 사용. " +
        "세션이 없거나 만료됐고 `blogUrl` 이 명시된 경우 공개 페이지의 `window.T.config.BLOG` 로 폴백 " +
        "(blogId/host 정도만, 카테고리/플러그인 미포함). " +
        "세션 만료 시 풍부 메타가 필요하면 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      // host 가 명시 안 되면 admin fetch 의 base URL 을 못 정함 (cookie 가 default 슬롯에
      // 있어도 어디로 보낼지 모름). 공개 폴백조차 host 필수. → 명확한 안내.
      const blogUrl = args.blogUrl;
      if (!blogUrl) {
        return errorText(
          "`blogUrl` 을 지정해야 합니다 (예: `saree98.tistory.com`). " +
            "admin 풍부 메타와 공개 페이지 폴백 둘 다 호스트가 필요합니다.",
        );
      }
      try {
        const ctx = await loadContext(blogUrl);
        if (ctx) {
          // admin 경로 — 풍부 메타
          const blog = await fetchBlogConfig(ctx);
          const summary = summarizeAdmin(blog);
          return jsonText(summary);
        }

        // 세션 없음 → 공개 페이지 폴백 (blogId/host 정도만)
        return await publicFallback(blogUrl);
      } catch (err) {
        // admin 호출 중 세션 만료 → 폴백 시도 (host 는 위에서 검증됨)
        if (err instanceof SessionExpiredError) {
          try {
            return await publicFallback(blogUrl);
          } catch (fallbackErr) {
            return errorResult(fallbackErr, blogUrl);
          }
        }
        return errorResult(err, blogUrl);
      }
    },
  );
}

async function publicFallback(blogUrl: string) {
  const host = normalizeHost(blogUrl);
  const publicConfig = await fetchPublicBlogConfig(host);
  if (!publicConfig) {
    return errorText(
      `공개 페이지(${host})에서 \`window.T.config.BLOG\` 를 찾지 못했습니다. ` +
        `풍부 메타가 필요하면 \`tistory_session_init\` 로 로그인하세요.`,
    );
  }
  const summary: PublicMetaSummary = {
    source: "public",
    blogId: publicConfig.blogId,
    host: publicConfig.host,
    raw: publicConfig,
    hint:
      "세션 없이 얻은 최소 메타입니다. 카테고리/플러그인/현재 스킨 등 풍부 메타는 " +
      "`tistory_session_init` 로 로그인 후 다시 호출하세요.",
  };
  return jsonText(summary);
}

// ─────────────────────────────────────────────────────────────────────────────
// 응답/에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function jsonText(payload: unknown) {
  // MCP text content 로 박되 JSON 포맷 — LLM 이 구조화된 메타를 한 번에 읽음
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function sessionRequired(blogUrl: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
          `(저장된 cookie 가 없거나 만료되었습니다.)`,
      },
    ],
  };
}

function errorText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) return sessionRequired(blogUrl);
  if (err instanceof TistoryApiError) {
    return errorText(
      `메타 조회 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  if (err instanceof PublicFetchError) {
    return errorText(
      `공개 페이지 폴백 실패 (HTTP ${err.status}): ${err.message} (${err.url})`,
    );
  }
  return errorText(
    `메타 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
