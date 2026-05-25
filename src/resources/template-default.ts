/**
 * `tistory://template-default` — 동작하는 기본 스킨 골격.
 *
 * source: `templates/default/` (현재 Odyssey 원본 통째 복사 — 정제 작업은 별 todo).
 * LLM 이 신규 스킨을 만들 때 시작 골격으로 읽거나, `tistory_apply_skin` 의 `skinDir` 인자 값 reference.
 *
 * payload 구조:
 *  - tree: 파일 경로 + 크기 메타 (전체 파일 1줄씩)
 *  - files: 텍스트 파일 (`skin.html`, `style.css`) 본문 동봉. binary preview 이미지는 path/size 만.
 *
 * binary 파일 (preview*.{gif,jpg}) 은 base64 로 박으면 무거우므로 메타만. 필요하면 디스크에서 직접 읽도록 안내.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer, ReadResourceCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TEMPLATE_DEFAULT_URI = "tistory://template-default";

// 패키지 루트의 `templates/default/` — 빌드 후엔 `dist/` 에서 두 단계 올라간다.
// `src/resources/template-default.ts` 와 `dist/resources/template-default.js` 둘 다 `../../templates/default` 로 해결됨.
const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, "..", "..", "templates", "default");

// 본문을 동봉할 텍스트 파일 — 나머지는 메타만.
const INLINE_TEXT_FILES = new Set(["skin.html", "style.css", "index.xml"]);

interface FileEntry {
  /** templates/default/ 기준 상대 경로. */
  path: string;
  size: number;
  /** 텍스트 동봉 여부 — true 면 `files[path]` 에 본문 있음. */
  inlined: boolean;
  /** 디렉터리이면 true. */
  directory: boolean;
}

function walk(dir: string, base: string, out: FileEntry[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    const rel = relative(base, abs).replace(/\\/g, "/");
    if (st.isDirectory()) {
      out.push({ path: rel + "/", size: 0, inlined: false, directory: true });
      walk(abs, base, out);
    } else {
      out.push({
        path: rel,
        size: st.size,
        inlined: INLINE_TEXT_FILES.has(name),
        directory: false,
      });
    }
  }
}

interface TemplatePayload {
  /** templates/default/ 의 실제 절대 경로 (도구가 디스크에서 직접 읽을 때 reference). */
  root: string;
  /** 현재 상태 한 줄. Odyssey 통째 vs 정제본 vs 미존재. */
  status: string;
  /** 도구·스킨 작성자에게 주는 사용 힌트. */
  hint: string;
  tree: FileEntry[];
  /** path → text 본문. INLINE_TEXT_FILES 만. */
  files: Record<string, string>;
  /** 읽기 실패 또는 디렉터리 부재 시 에러 메시지. */
  error?: string;
}

function buildPayload(): TemplatePayload {
  try {
    const rootStat = statSync(TEMPLATE_ROOT);
    if (!rootStat.isDirectory()) {
      return {
        root: TEMPLATE_ROOT,
        status: "missing",
        hint: "templates/default 가 디렉터리가 아님.",
        tree: [],
        files: {},
        error: `${TEMPLATE_ROOT} is not a directory`,
      };
    }
  } catch (e) {
    return {
      root: TEMPLATE_ROOT,
      status: "missing",
      hint: "templates/default 가 없음. 정제/시드 작업 필요 (todo.md 의 'templates/default 정제' 항목 참고).",
      tree: [],
      files: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const tree: FileEntry[] = [];
  walk(TEMPLATE_ROOT, TEMPLATE_ROOT, tree);

  const files: Record<string, string> = {};
  for (const entry of tree) {
    if (!entry.inlined) continue;
    try {
      files[entry.path] = readFileSync(join(TEMPLATE_ROOT, entry.path), "utf8");
    } catch (e) {
      // 읽기 실패는 무시 — tree 메타만 남기고 본문 생략.
      files[entry.path] = `// read failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    root: TEMPLATE_ROOT,
    status:
      "raw — Odyssey 스킨 원본 통째 복사본. preview 이미지 4종 누락 + Odyssey 전용 위젯/커버/CSS 미정제. " +
      "정제는 todo.md 'templates/default 정제' 항목 참고.",
    hint:
      "신규 스킨 시작점. `skin.html` / `style.css` / `index.xml` 본문은 `files` 에 동봉. " +
      "preview 이미지는 메타만 (binary). 디스크에서 직접 읽을 땐 `root` 경로 사용.",
    tree,
    files,
  };
}

const read: ReadResourceCallback = async (uri) => {
  // 매 read 마다 디스크 다시 — 정제 작업 중 변경 즉시 반영.
  const payload = buildPayload();
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
};

export function registerTemplateDefault(server: McpServer): void {
  server.registerResource(
    "template-default",
    TEMPLATE_DEFAULT_URI,
    {
      title: "기본 스킨 골격 (`templates/default/`)",
      description:
        "동작하는 Tistory 스킨 골격. tree + skin.html/style.css/index.xml 본문 동봉. " +
        "preview 이미지는 메타만. 신규 스킨 만들 때 시작점.",
      mimeType: "application/json",
    },
    read,
  );
}
