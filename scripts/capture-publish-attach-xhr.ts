/**
 * ad-hoc 실측 스크립트 — `POST /manage/post.json` 의 `attachments` 모양 reverse-engineer.
 *
 * 목적 (블로커 B, plan.md 미정 / docs/api.md §5.3 미검증):
 *   - 에디터로 이미지 1장 포함 글을 발행할 때 실제 `POST /manage/post.json` body 의
 *     `attachments` 원소가 어떻게 생겼는지 (key 문자열만 / 업로드 응답 객체 전체 / 치환자 토큰)
 *   - 업로드(`POST /manage/post/attach.json`) 와 발행 사이에 별도 finalize XHR 가 있는지
 *   - 본문에 박힌 `[##_Image|kage@{key}|...]` 치환자와 attachments 가 어떻게 연결되는지
 *   - (가능하면) 발행 직후 `dn/{key}` 무서명 URL 이 즉시 유효한지 — '치환자=영구' 가정 검증
 *
 * ★ CM5 setValue 가 React state 미반영 (CLAUDE.md 함정 2) → 본문 자동 입력은 신뢰 불가.
 *   그래서 자동 모드 없이 **interactive 만** 둔다. 사용자가 직접 글을 쓰고 발행한다.
 *
 * 두 모드:
 *   - `--mode=recon` (기본): 글쓰기 에디터 진입 + 초기 XHR + DOM 구조 + 스크린샷 dump. 클릭 X.
 *   - `--mode=interactive`: 헤디드 + 사용자가 직접 이미지 삽입 → 발행. 종료 시 dump.
 *
 * 사용:
 *   npx tsx scripts/capture-publish-attach-xhr.ts saree98.tistory.com --mode=interactive
 *
 * (keytar storageState 로더는 capture-category-xhr.ts 와 동일 — session_init 선행 필요)
 */
/// <reference types="node" />
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { chromium, type Page } from "playwright";
import keytar from "keytar";

const STOP_FILE = "scripts/.stop-capture";
const SERVICE = "tistory-mcp";

interface ChunkManifest {
  v: 1;
  chunks: number;
}

async function loadStorageState(account: string): Promise<object> {
  const head = await keytar.getPassword(SERVICE, account);
  if (!head) throw new Error(`no keytar entry for ${account}`);
  const manifest = JSON.parse(head) as ChunkManifest;
  if (manifest.v !== 1) throw new Error(`unknown manifest version ${manifest.v}`);
  const parts: string[] = [];
  for (let i = 0; i < manifest.chunks; i++) {
    const part = await keytar.getPassword(SERVICE, `${account}#${i}`);
    if (part == null) throw new Error(`missing chunk ${i}`);
    parts.push(part);
  }
  return JSON.parse(parts.join(""));
}

interface CapturedRequest {
  ts: string;
  method: string;
  url: string;
  resourceType: string;
  postData: string | null;
}

interface CapturedResponse {
  ts: string;
  url: string;
  status: number;
  contentType: string | null;
  bodyPreview: string;
  bodyLength: number;
}

interface Captured {
  requests: CapturedRequest[];
  responses: CapturedResponse[];
}

function attachCapture(page: Page, captured: Captured): void {
  // 글쓰기 관련 XHR/fetch 만: post.json / post/attach.json / autosave.
  // 좁히지 말고 /manage/ 전부 받아서 finalize 류 누락 방지.
  const isInteresting = (req: { url: () => string; resourceType: () => string }): boolean => {
    const type = req.resourceType();
    if (type !== "xhr" && type !== "fetch") return false;
    const u = req.url();
    return u.includes("/manage/") || u.includes("/api/") || u.includes("attach") || u.includes("kage");
  };

  page.on("request", (req) => {
    if (!isInteresting(req)) return;
    const url = req.url();
    const entry: CapturedRequest = {
      ts: new Date().toISOString(),
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      postData: req.postData(),
    };
    captured.requests.push(entry);
    process.stderr.write(`[req] ${req.method()} ${url}\n`);
    // post.json body 는 attachments 가 핵심 — 길게 찍는다.
    if (entry.postData) {
      const limit = url.includes("/post.json") || url.includes("/autosave") ? 4000 : 800;
      process.stderr.write(`      body: ${entry.postData.slice(0, limit)}\n`);
    }
  });

  page.on("response", async (res) => {
    const req = res.request();
    if (!isInteresting(req)) return;
    const url = res.url();
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "(failed to read body)";
    }
    captured.responses.push({
      ts: new Date().toISOString(),
      url,
      status: res.status(),
      contentType: res.headers()["content-type"] ?? null,
      bodyPreview: bodyText.slice(0, 2000),
      bodyLength: bodyText.length,
    });
    process.stderr.write(`[res] ${res.status()} ${url} (${bodyText.length}B)\n`);
  });
}

async function dumpEditorDom(page: Page): Promise<unknown> {
  // tsx esbuild 의 __name inject 우회 위해 함수를 문자열로 넘긴다 (capture-category 와 동일 패턴).
  const fnSrc = `(() => {
    var describe = function(el) {
      var rect = el.getBoundingClientRect();
      var cls = typeof el.className === 'string' ? el.className : '';
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: cls || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        title: el.getAttribute('title') || undefined,
        textPreview: (el.textContent || '').trim().slice(0, 60),
        visible: rect.width > 0 && rect.height > 0,
      };
    };
    var main = document.querySelector('#editor') || document.querySelector('main') || document.body;
    var toolbarBtns = Array.from(main.querySelectorAll('button, [role="button"]')).filter(function(b) {
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).slice(0, 60);
    var fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(describe);
    return {
      title: document.title,
      url: location.href,
      fileInputs: fileInputs,
      toolbarButtons: toolbarBtns.map(describe),
      hasCM5: !!document.querySelector('.CodeMirror'),
    };
  })()`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await page.evaluate(fnSrc as any);
}

async function modeRecon(page: Page, host: string, captured: Captured): Promise<void> {
  process.stderr.write(`[recon] navigating to /manage/post (글쓰기 에디터)\n`);
  await page.goto(`https://${host}/manage/post`, { waitUntil: "domcontentloaded" });
  // SPA + CM5 마운트 대기
  await page.waitForTimeout(4000);

  process.stderr.write(`[recon] dumping editor DOM\n`);
  const dom = await dumpEditorDom(page);

  const shotPath = `scripts/publish-recon-${Date.now()}.png`;
  await page.screenshot({ path: shotPath, fullPage: true });
  process.stderr.write(`[recon] screenshot saved: ${shotPath}\n`);

  const dumpPath = `scripts/publish-recon-${Date.now()}.json`;
  writeFileSync(dumpPath, JSON.stringify({ dom, captured, shotPath }, null, 2), "utf8");
  process.stderr.write(`[recon] dump saved: ${dumpPath}\n`);
}

async function modeInteractive(page: Page, host: string, captured: Captured): Promise<void> {
  await page.goto(`https://${host}/manage/post`, { waitUntil: "domcontentloaded" });
  process.stderr.write(`\n[ready] 브라우저에서 글쓰기 에디터가 열렸습니다.\n`);
  process.stderr.write(`[ready] 다음 시나리오를 직접 진행하세요 (각 단계의 XHR 가 캡처됩니다):\n`);
  process.stderr.write(`        1) 제목 입력 (예: "TEMP-실측-이미지")\n`);
  process.stderr.write(`        2) 본문에 이미지 1장 삽입 (툴바 이미지 버튼 → 로컬 파일 업로드)\n`);
  process.stderr.write(`           → 여기서 POST /manage/post/attach.json 응답 (url/key/...) 확인\n`);
  process.stderr.write(`        3) 본문에 텍스트 한 줄 추가 (자동저장 트리거용)\n`);
  process.stderr.write(`        4) "공개 발행" 클릭\n`);
  process.stderr.write(`           → ★ POST /manage/post.json body 의 attachments 가 핵심\n`);
  process.stderr.write(`        5) (선택) 발행된 글을 새 탭에서 열어 이미지가 dn/{key} 로 뜨는지 확인\n`);
  process.stderr.write(`\n[ready] 이 글은 비공개로 발행하거나 발행 후 삭제하세요 (실측용 임시 글).\n`);
  process.stderr.write(`[ready] 종료: 파일 '${STOP_FILE}' 생성 (또는 Ctrl+C)\n\n`);

  if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE);

  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = (): void => {
      if (resolved) return;
      resolved = true;
      try {
        if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE);
      } catch {
        /* ignore */
      }
      resolve();
    };
    const interval = setInterval(() => {
      if (existsSync(STOP_FILE)) {
        clearInterval(interval);
        done();
      }
    }, 1000);
    process.on("SIGINT", () => {
      clearInterval(interval);
      done();
    });
  });

  process.stderr.write(
    `\n[done] dumping ${captured.requests.length} requests / ${captured.responses.length} responses\n`,
  );
  const outPath = `scripts/publish-interactive-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(captured, null, 2), "utf8");
  process.stderr.write(`[done] saved: ${outPath}\n`);
  process.stderr.write(
    `[done] → post.json body 의 attachments 원소를 docs/samples/publish-with-image-body.json 으로 추려 저장하세요.\n`,
  );
}

async function main(): Promise<void> {
  const host = process.argv[2] ?? "saree98.tistory.com";
  const modeArg = process.argv.find((a) => a.startsWith("--mode="));
  const mode = (modeArg ? modeArg.slice("--mode=".length) : "recon") as "recon" | "interactive";

  process.stderr.write(`[init] mode=${mode} host=${host}\n`);
  const storageState = await loadStorageState(host);

  // interactive 는 사용자가 직접 클릭해야 하므로 헤디드, recon 은 헤들리스.
  const browser = await chromium.launch({ headless: mode === "recon" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context = await browser.newContext({ storageState: storageState as any });
  const page = await context.newPage();

  const captured: Captured = { requests: [], responses: [] };
  attachCapture(page, captured);

  try {
    if (mode === "recon") await modeRecon(page, host, captured);
    else if (mode === "interactive") await modeInteractive(page, host, captured);
    else throw new Error(`mode '${mode}' not implemented`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[err] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
