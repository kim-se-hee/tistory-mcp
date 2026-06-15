/**
 * `tistory_categories_update` — 카테고리 트리 batch CRUD (하위/이동/visibility 포함).
 *
 * 동선 (`docs/api.md §3.6`, §3.6.1):
 *   1) `GET /manage/category.json` — 현재 트리 + `rootLabel` 확보
 *   2) 입력 트리(desired state)와 diff → `delete[]` / `append[]` / `update[]` 3-array 산출
 *   3) `PUT /manage/category.json` 한 방. 응답 `{ categoryTree }` 평탄화 반환
 *
 * **시맨틱:**
 *   - 입력은 **전체 트리 desired state** (중첩 children 포함). id 있는 노드 = 기존,
 *     없으면 신규, 응답엔 있지만 입력에 빠진 id = 삭제.
 *   - 트리 내 위치가 곧 계층/순서: 배열 index = `priority`, nesting 깊이 = `depth`,
 *     부모 노드 id = 자식의 `parent`. ★ GET 노드엔 `parent`/`depth`/`opened` 가 없으므로
 *     (§3.6.1) 계층은 desired 트리의 nesting 으로만 재구성한다.
 *   - update 객체의 `label` 필드는 **변경 전 이름** 보존 (실측 — 서버 식별/충돌 검증 추정)
 *   - cookie-only fetch. CLAUDE.md 함정 1 유지 (Playwright 는 session_init / screenshot 만)
 *
 * **하위 카테고리 (§3.6.1 실측) — 세 가지 동시:**
 *   1. `append[]` 에 자식 객체 `{ id:-1, parent:<부모id>, ... }`
 *   2. `update[]` 의 부모 노드 `children` 에 같은 신규 객체(`id:-1`) 중첩 미러
 *   3. 부모 노드 `leaf:false`
 *   (append.children 단독은 자식 무시 — 실측). 이동(부모 변경)도 같은 메커니즘.
 *
 * **visibility:** update 객체의 `visibility` 정수(0/15/20) 변경으로 적용 (§3.6.1 실측 확정).
 *
 * **검증 (사전 reject):**
 *   - 글이 있는 카테고리 삭제: 응답의 `entries > 0` 노드 삭제 시도 → UI 가드 미러
 *     (fetch 직접 호출 시 서버 거부 동작은 미실측)
 *   - 한도 500: append 후 총 노드 수가 500 초과면 reject
 *   - 모르는 id: desired 에 현재 트리에 없는 id 가 있으면 reject
 *
 * 등록 (`src/tools/index.ts` barrel) 은 별도 통합 todo 에서 (이 도구 파일 owns 밖).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getCategories,
  putCategories,
  SessionExpiredError,
  TistoryApiError,
  visibilityFromInt,
  visibilityToInt,
  type CategoryAppendItem,
  type CategoryNode,
  type CategoryPutBody,
  type CategoryUpdateItem,
  type VisibilityInt,
  type VisibilityName,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape)
// ─────────────────────────────────────────────────────────────────────────────

type DesiredNode = {
  id?: number;
  name: string;
  visibility?: VisibilityName;
  children?: DesiredNode[];
};

const desiredNodeSchema: z.ZodType<DesiredNode> = z.lazy(() =>
  z.object({
    id: z
      .number()
      .int()
      .optional()
      .describe(
        "기존 카테고리 id (정수). 미지정 = 신규로 추가. " +
          "응답 트리에 있지만 입력에 없는 id 는 삭제 대상.",
      ),
    name: z.string().min(1).describe("카테고리 이름. 빈 문자열 불가."),
    visibility: z
      .enum(["public", "private", "protected"])
      .optional()
      .describe(
        "공개 범위. 미지정 시 기존 노드는 현재 visibility 보존, 신규는 `public` 디폴트. " +
          "update 객체의 visibility 정수 토글로 적용 (docs/api.md §3.6.1).",
      ),
    children: z
      .array(desiredNodeSchema)
      .optional()
      .describe(
        "하위 카테고리 (중첩 트리). 신규 자식은 부모와 동시에 생성됨 — " +
          "append `parent` + 부모 update `children` 중첩 미러 + 부모 `leaf:false` " +
          "(docs/api.md §3.6.1). 이동(부모 변경)도 새 위치에 nesting 으로 표현.",
      ),
  }),
);

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  tree: z
    .array(desiredNodeSchema)
    .describe(
      "전체 카테고리 트리 desired state (중첩 children 포함). id 있는 노드 = 기존, " +
        "없으면 신규, 응답에 있지만 입력에 없는 id 는 삭제. " +
        "배열 순서 = priority, nesting = 계층 (docs/api.md §3.6.1). " +
        "★ 글이 있는 카테고리 (`entries > 0`) 삭제는 사전 reject. " +
        "★ 한도 500개. 초과 append 는 reject.",
    ),
} as const;

type Input = {
  blogUrl: string;
  tree: DesiredNode[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 트리 평탄화 (응답 변환용)
// ─────────────────────────────────────────────────────────────────────────────

interface FlatCategory {
  id: number;
  name: string;
  /** 부모 id (0 = 루트). GET/PUT 응답엔 없어 트리 위치에서 재구성 (§3.6.1). */
  parent: number;
  /** 1 = 루트, 2 = 하위. 트리 위치에서 재구성. */
  depth: number;
  priority: number;
  entries: number;
  visibility: VisibilityName;
  leaf: boolean;
}

/** 응답 트리를 평탄화. 계층(parent/depth)은 nesting 위치에서 재구성한다 (§3.6.1). */
function flattenTree(nodes: CategoryNode[]): FlatCategory[] {
  const out: FlatCategory[] = [];
  const walk = (ns: CategoryNode[], parent: number, depth: number): void => {
    ns.forEach((n, idx) => {
      out.push({
        id: n.id,
        name: n.name,
        parent,
        depth,
        priority: typeof n.priority === "number" ? n.priority : idx,
        entries: n.entries,
        visibility: visibilityFromInt(n.visibility),
        leaf: n.leaf,
      });
      if (n.children && n.children.length > 0) walk(n.children, n.id, depth + 1);
    });
  };
  walk(nodes, 0, 1);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// diff — 현재 트리 vs 입력 desired state
// ─────────────────────────────────────────────────────────────────────────────

interface DiffResult {
  delete: number[];
  append: CategoryAppendItem[];
  update: CategoryUpdateItem[];
}

/** 현재 트리를 id → 노드로 평탄 인덱싱 (하위 포함). 모르는 id 검증·기존 메타 보존용. */
function indexById(nodes: CategoryNode[]): Map<number, CategoryNode> {
  const m = new Map<number, CategoryNode>();
  const walk = (ns: CategoryNode[]): void => {
    for (const n of ns) {
      m.set(n.id, n);
      if (n.children && n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return m;
}

/**
 * desired 트리를 재귀 순회하며 append/update/delete 3-array 산출.
 *
 * - 기존 노드(id 있음): update 객체 생성. 새 위치의 parent/depth/priority/visibility 반영.
 *   자식이 있으면 update.children 에 자식 객체들을 중첩 미러하고 `leaf:false` (§3.6.1).
 * - 신규 노드(id 없음): append 객체(id:-1) 생성. 부모의 update.children 에 동일 객체를
 *   중첩 미러해야 부모 밑에 생성됨 (루트 신규는 미러 불필요).
 * - 부모가 신규(id:-1)면 자식 append 의 parent 도 -1 — 실제 연결은 nesting 미러가 담당.
 */
function computeDiff(current: CategoryNode[], desired: DesiredNode[]): DiffResult {
  const currentById = indexById(current);
  const keptIds = new Set<number>();
  const append: CategoryAppendItem[] = [];
  const update: CategoryUpdateItem[] = [];

  /**
   * 한 노드를 변환해 append/update 에 push 하고, 그 노드를 부모의 children 미러로 쓸
   * 객체(append item 또는 update item)를 반환한다. 반환 객체 자신의 children 도 채워진다.
   *
   * @param parentId 부모 카테고리 id (0 = 루트, -1 = 신규 부모)
   * @param depth 1 = 루트
   */
  const visit = (
    node: DesiredNode,
    parentId: number,
    depth: number,
    priority: number,
  ): CategoryAppendItem | CategoryUpdateItem => {
    const hasChildren = node.children !== undefined && node.children.length > 0;

    if (node.id !== undefined) {
      const cur = currentById.get(node.id);
      if (!cur) throw new DiffError(`존재하지 않는 카테고리 id: ${node.id}`);
      keptIds.add(node.id);

      const visInt: VisibilityInt =
        node.visibility !== undefined
          ? visibilityToInt(node.visibility)
          : cur.visibility;

      // 자식 미러를 먼저 만든다 (자식들도 append/update 에 push 됨).
      // 신규 자식이면 append 객체, 기존 자식이면 update 객체가 그대로 미러됨 (§3.6.1).
      const childMirrors: (CategoryAppendItem | CategoryUpdateItem)[] = [];
      if (hasChildren) {
        node.children!.forEach((c, i) => {
          childMirrors.push(visit(c, cur.id, depth + 1, i));
        });
      }

      const item: CategoryUpdateItem = {
        id: cur.id,
        name: node.name,
        // ★ label 에 변경 전 이름 보존 (실측 — 이름 변경 없으면 현재 이름 그대로)
        label: cur.name,
        priority,
        entries: cur.entries,
        visibility: visInt,
        viewChannel: cur.viewChannel,
        children: childMirrors,
        // 자식이 생기면 leaf:false (§3.6.1). 자식 없으면 현재 leaf 보존.
        leaf: hasChildren ? false : cur.leaf,
        categoryInfo: cur.categoryInfo ?? {},
        depth,
        parent: parentId,
        opened: cur.opened ?? true,
        updatedData: false,
      };
      update.push(item);
      return item;
    }

    // 신규 — id:-1, isNew/updatedData true.
    const visInt: VisibilityInt =
      node.visibility !== undefined ? visibilityToInt(node.visibility) : 20; // 디폴트 public

    // 자식 미러를 먼저 만든다 (자식 append 객체들이 부모 children 에 중첩됨, §3.6.1).
    const childMirrors: CategoryAppendItem[] = [];
    if (hasChildren) {
      node.children!.forEach((c, i) => {
        const m = visit(c, -1, depth + 1, i);
        // 신규 부모 밑의 노드는 신규여야 한다 (기존 노드를 신규 부모로 이동 = id 있는 자식인데
        // 부모가 -1 → 서버가 부모 못 찾음). 보수적으로 거부.
        if (!("isNew" in m) || m.isNew !== true) {
          throw new DiffError(
            `신규 카테고리 "${node.name}" 하위에 기존 카테고리(id=${(m as CategoryUpdateItem).id})를 ` +
              `둘 수 없습니다. 기존 카테고리 이동은 기존(id 있는) 부모 밑으로만 가능합니다.`,
          );
        }
        childMirrors.push(m as CategoryAppendItem);
      });
    }

    const item: CategoryAppendItem = {
      id: -1,
      name: node.name,
      children: childMirrors,
      depth,
      opened: true,
      priority,
      visibility: visInt,
      parent: parentId,
      viewChannel: null,
      entries: 0,
      categoryInfo: {},
      isNew: true,
      updatedData: true,
    };
    append.push(item);
    return item;
  };

  desired.forEach((d, idx) => {
    visit(d, 0, 1, idx);
  });

  // 응답에 있는데 keptIds 에 없는 노드 = 삭제 대상 (하위 포함).
  const del: number[] = [];
  for (const id of currentById.keys()) {
    if (!keptIds.has(id)) del.push(id);
  }

  return { delete: del, append, update };
}

class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 도구 등록
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIES_UPDATE_TOOL_NAME = "tistory_categories_update";

/** 한도 500 — UI `count_total` 의 `/ 500` 실측 (docs/api.md §3.6). */
const CATEGORY_LIMIT = 500;

export function registerCategoriesUpdate(server: McpServer): void {
  server.registerTool(
    CATEGORIES_UPDATE_TOOL_NAME,
    {
      title: "Tistory 카테고리 트리 batch 업데이트",
      description:
        "전체 카테고리 트리를 desired state 로 박아 추가/이름변경/삭제/이동/공개범위 변경을 " +
        "한 번에 처리합니다. 현재 트리 (`/manage/category.json` GET) 와 diff 해서 " +
        "`PUT /manage/category.json` (body `{ rootLabel, delete[], append[], update[] }`) 한 방으로 적용. " +
        "★ 입력은 desired state — id 있는 노드 = 기존, 없으면 신규, 입력에 빠진 id 는 삭제. " +
        "★ 중첩 `children[]` 으로 하위 카테고리 지원 (배열 순서 = 표시 순서, nesting = 계층). " +
        "신규 하위는 append `parent` + 부모 update `children` 중첩 미러 + 부모 `leaf:false` " +
        "3개를 동시에 보냄 (docs/api.md §3.6.1). visibility 는 update 정수 토글로 적용. " +
        "★ 글이 있는 카테고리 (`entries > 0`) 삭제 시도는 사전 reject (UI 가드 미러). " +
        "★ 한도 500개 초과 reject. " +
        "응답은 갱신된 트리 평탄화 (id/name/parent/depth/priority/entries/visibility/leaf). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) return sessionRequired(args.blogUrl);

        const currentRes = await getCategories(ctx);
        const currentRoots = currentRes.categories ?? [];

        // diff
        let diff: DiffResult;
        try {
          diff = computeDiff(currentRoots, args.tree);
        } catch (err) {
          if (err instanceof DiffError) return errorText(err.message);
          throw err;
        }

        // 글 있는 카테고리 삭제 reject (하위 포함 인덱스에서 조회).
        const currentById = indexById(currentRoots);
        const blockedDeletes: { id: number; name: string; entries: number }[] = [];
        for (const id of diff.delete) {
          const node = currentById.get(id);
          if (node && node.entries > 0) {
            blockedDeletes.push({ id: node.id, name: node.name, entries: node.entries });
          }
        }
        if (blockedDeletes.length > 0) {
          const lines = blockedDeletes.map(
            (b) => `  - id=${b.id} "${b.name}" (글 ${b.entries}개)`,
          );
          return errorText(
            `글이 있는 카테고리는 삭제할 수 없습니다 (UI 가드, fetch 직접 호출 동작 미실측):\n${lines.join("\n")}\n` +
              `해당 카테고리의 글을 먼저 다른 카테고리로 이동하거나 삭제하세요.`,
          );
        }

        // 한도 500 검증
        const currentCount = countAll(currentRoots);
        const afterCount = currentCount - diff.delete.length + diff.append.length;
        if (afterCount > CATEGORY_LIMIT) {
          return errorText(
            `카테고리 한도(${CATEGORY_LIMIT}개) 초과: 현재 ${currentCount}, ` +
              `삭제 ${diff.delete.length}, 신규 ${diff.append.length} → 최종 ${afterCount}개.`,
          );
        }

        const putBody: CategoryPutBody = {
          rootLabel: currentRes.rootLabel ?? "",
          delete: diff.delete,
          append: diff.append,
          update: diff.update,
        };

        const putRes = await putCategories(ctx, putBody);
        const flat = flattenTree(putRes.categoryTree ?? []);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  applied: {
                    deleted: diff.delete.length,
                    appended: diff.append.length,
                    updated: diff.update.length,
                  },
                  total: flat.length,
                  categories: flat,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err, args.blogUrl);
      }
    },
  );
}

// 트리 전체 노드 수 — 한도 검증용 (하위 포함 재귀).
function countAll(nodes: CategoryNode[]): number {
  let n = 0;
  const walk = (ns: CategoryNode[]): void => {
    for (const x of ns) {
      n += 1;
      if (x.children && x.children.length > 0) walk(x.children);
    }
  };
  walk(nodes);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 에러 직렬화
// ─────────────────────────────────────────────────────────────────────────────

function errorText(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function sessionRequired(blogUrl: string) {
  return errorText(
    `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
      `(저장된 cookie 가 없거나 만료되었습니다.)`,
  );
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) return sessionRequired(blogUrl);
  if (err instanceof TistoryApiError) {
    return errorText(
      `카테고리 업데이트 실패 (HTTP ${err.status}): ${err.message}` +
        `${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
    );
  }
  return errorText(
    `카테고리 업데이트 실패: ${err instanceof Error ? err.message : String(err)}`,
  );
}
