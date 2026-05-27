/**
 * `tistory_categories_update` — 카테고리 트리 batch CRUD.
 *
 * 동선 (`docs/api.md §3.6`):
 *   1) `GET /manage/category.json` — 현재 트리 + `rootLabel` 확보
 *   2) 입력 트리와 diff → `delete[]` / `append[]` / `update[]` 3-array 산출
 *   3) `PUT /manage/category.json` 한 방. 응답 `{ categoryTree }` 평탄화 반환
 *
 * **시맨틱:**
 *   - 입력은 **전체 트리 desired state**. id 있는 노드 = 기존, 없으면 신규, 응답엔 있지만
 *     입력에 빠진 id = 삭제. (현재 단계는 루트 레벨만 — children 미지원, 미실측)
 *   - update 객체의 `label` 필드는 **변경 전 이름** 보존 (실측 — 서버 식별/충돌 검증 추정)
 *   - append 객체는 `update[]` 에도 동시 포함 — UI 흐름 모방 (실측 관찰, 안전 디폴트)
 *   - cookie-only fetch. CLAUDE.md 함정 1 유지 (Playwright 는 session_init / screenshot 만)
 *
 * **검증 (사전 reject):**
 *   - 글이 있는 카테고리 삭제: 응답의 `entries > 0` 노드 삭제 시도 → UI 가드 미러
 *     (fetch 직접 호출 시 서버 거부 동작은 미실측)
 *   - 한도 500: append 후 총 노드 수가 500 초과면 reject
 *   - children 미지원: 입력의 `children[]` 가 비지 않으면 reject — 하위 카테고리 body 표현 미실측
 *     (별도 후속 todo 의 실측 완료 후 확장)
 *
 * **미실측 / 보수적 처리:**
 *   - visibility 토글 body 표현 미실측. 입력에 `visibility` 와 응답의 그것이 다르면 정수만
 *     덮어쓴 채 PUT 시도 — 동작 보장 X (서버 무시 가능). 결과는 응답 트리에서 확인 필요
 *   - 카테고리 이동(부모 변경) / 순서 변경 미실측 — 루트 레벨 순서는 입력 배열 순서를 priority 로
 *     박지만 동작 보장 X
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

// children 은 미지원 (미실측). 입력 스키마에 자리는 두되 비어있어야 함.
// z.lazy 로 재귀 정의하지만 핸들러에서 비어있는지 강제로 검증한다.
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
          "★ visibility 변경 body 표현 미실측 — 동작 보장 X (별도 후속 todo).",
      ),
    children: z
      .array(desiredNodeSchema)
      .optional()
      .describe(
        "하위 카테고리. **현재 미지원** — 비어있지 않으면 reject. " +
          "하위 카테고리 body 표현이 미실측 (별도 후속 todo).",
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
      "전체 카테고리 트리 desired state. id 있는 노드 = 기존, 없으면 신규, " +
        "응답에 있지만 입력에 없는 id 는 삭제. " +
        "★ 현재 루트 레벨만 지원 (`children[]` 미지원, 미실측). " +
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
  parent: number;
  depth: number;
  priority: number;
  entries: number;
  visibility: VisibilityName;
  leaf: boolean;
}

function flattenTree(nodes: CategoryNode[]): FlatCategory[] {
  const out: FlatCategory[] = [];
  const walk = (ns: CategoryNode[]): void => {
    for (const n of ns) {
      out.push({
        id: n.id,
        name: n.name,
        parent: n.parent,
        depth: n.depth,
        priority: n.priority,
        entries: n.entries,
        visibility: visibilityFromInt(n.visibility),
        leaf: n.leaf,
      });
      if (n.children && n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// diff — 현재 트리 vs 입력 desired state
// ─────────────────────────────────────────────────────────────────────────────

interface DiffResult {
  delete: number[];
  append: CategoryAppendItem[];
  update: CategoryUpdateItem[];
  /** UI 흐름 모방 — append 시 update 에도 같은 객체 동시 등장. */
  newAsUpdateMirrors: CategoryUpdateItem[];
}

/**
 * 루트 레벨 desired vs current 비교.
 * children 미지원이라 깊이 1 (루트) 만 처리. 입력의 children 비어있음은 핸들러에서 사전 검증.
 */
function computeDiff(
  current: CategoryNode[],
  desired: DesiredNode[],
): DiffResult {
  const currentRoots = current; // 응답의 categories[] 가 곧 루트
  const currentById = new Map<number, CategoryNode>();
  for (const n of currentRoots) currentById.set(n.id, n);

  const keptIds = new Set<number>();
  const update: CategoryUpdateItem[] = [];
  const append: CategoryAppendItem[] = [];
  const newAsUpdateMirrors: CategoryUpdateItem[] = [];

  desired.forEach((d, idx) => {
    const priority = idx;
    if (d.id !== undefined) {
      const cur = currentById.get(d.id);
      if (!cur) {
        // 사용자가 모르는 id 보냄 — 핸들러에서 에러로 변환하기 위해 keptIds 에 박지 않음
        // (delete 대상으로 잡힐 일도 없음 — currentById 에 없으니까)
        throw new DiffError(`존재하지 않는 카테고리 id: ${d.id}`);
      }
      keptIds.add(d.id);
      const visInt: VisibilityInt =
        d.visibility !== undefined ? visibilityToInt(d.visibility) : cur.visibility;
      update.push({
        id: cur.id,
        name: d.name,
        // ★ label 에 변경 전 이름 보존 (실측 — 이름 변경 없으면 현재 이름 그대로)
        label: cur.name,
        priority,
        entries: cur.entries,
        visibility: visInt,
        viewChannel: cur.viewChannel,
        children: [],
        leaf: cur.leaf,
        categoryInfo: cur.categoryInfo ?? {},
        depth: cur.depth,
        parent: cur.parent,
        opened: cur.opened,
        updatedData: false,
      });
    } else {
      // 신규 — id: -1, isNew/updatedData true. 부모는 0 (루트), depth 1.
      const visInt: VisibilityInt =
        d.visibility !== undefined ? visibilityToInt(d.visibility) : 20; // 디폴트 public
      const newItem: CategoryAppendItem = {
        id: -1,
        name: d.name,
        children: [],
        depth: 1,
        opened: true,
        priority,
        visibility: visInt,
        parent: 0,
        viewChannel: null,
        entries: 0,
        categoryInfo: {},
        isNew: true,
        updatedData: true,
      };
      append.push(newItem);

      // UI 흐름 모방 — update[] 에도 같은 신규 객체를 update item 형태로 등장
      newAsUpdateMirrors.push({
        id: -1,
        name: d.name,
        label: d.name, // 신규는 변경 전 이름이 곧 새 이름
        priority,
        entries: 0,
        visibility: visInt,
        viewChannel: null,
        children: [],
        leaf: true,
        categoryInfo: {},
        depth: 1,
        parent: 0,
        opened: true,
        updatedData: false,
        isNew: true,
      });
    }
  });

  // 응답에 있는데 keptIds 에 없는 노드 = 삭제 대상
  const del: number[] = [];
  for (const n of currentRoots) {
    if (!keptIds.has(n.id)) del.push(n.id);
  }

  return { delete: del, append, update, newAsUpdateMirrors };
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
        "전체 카테고리 트리를 desired state 로 박아 추가/이름변경/삭제를 한 번에 처리합니다. " +
        "현재 트리 (`/manage/category.json` GET) 와 diff 해서 `PUT /manage/category.json` " +
        "(body `{ rootLabel, delete[], append[], update[] }`) 한 방으로 적용. " +
        "★ 입력은 desired state — id 있는 노드 = 기존, 없으면 신규, 입력에 빠진 id 는 삭제. " +
        "★ 현재는 **루트 레벨만 지원** (하위 카테고리 / `children[]` 미실측). " +
        "★ 글이 있는 카테고리 (`entries > 0`) 삭제 시도는 사전 reject (UI 가드 미러). " +
        "★ 한도 500개 초과 reject. " +
        "응답은 갱신된 트리 평탄화 (id/name/parent/depth/priority/entries/visibility/leaf). " +
        "세션 만료 시 `tistory_session_init` 재호출 안내.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        // 입력 사전 검증 — children 미지원
        for (const node of args.tree) {
          if (node.children !== undefined && node.children.length > 0) {
            return errorText(
              `children 미지원: "${node.name}" 에 하위 카테고리가 있습니다. ` +
                `하위 카테고리 body 표현은 미실측 — 별도 후속 todo 의 실측 완료 후 지원 예정. ` +
                `현재는 루트 레벨만 보내주세요.`,
            );
          }
        }

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

        // 글 있는 카테고리 삭제 reject
        const blockedDeletes: { id: number; name: string; entries: number }[] = [];
        for (const id of diff.delete) {
          const node = currentRoots.find((n) => n.id === id);
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

        // PUT body 조립 — UI 흐름 모방: update[] 에 신규 객체 미러 동시 포함
        const putBody: CategoryPutBody = {
          rootLabel: currentRes.rootLabel ?? "",
          delete: diff.delete,
          append: diff.append,
          update: [...diff.update, ...diff.newAsUpdateMirrors],
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

// 트리 전체 노드 수 — 한도 검증용. 현재 단계는 루트만이지만 응답엔 children 박힐 수 있어 재귀.
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
