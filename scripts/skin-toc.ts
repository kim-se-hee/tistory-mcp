/**
 * TOC 사이드바 주입 + 안전한 롤백을 위한 1회용 작업 스크립트.
 *
 * 단계별 CLI:
 *   tsx scripts/skin-toc.ts backup   <host>            → .skin-backup/{ts}/ 에 html/css/info 저장
 *   tsx scripts/skin-toc.ts analyze  <host>            → 최신 백업 분석 → 본문 selector 후보 출력
 *   tsx scripts/skin-toc.ts preview  <host>            → 백업 + TOC 패치 후 isPreview:true 로 dry-run, preview URL 출력
 *   tsx scripts/skin-toc.ts apply    <host>            → 최신 백업의 patched.html/css 를 isPreview:false 로 라이브 적용
 *   tsx scripts/skin-toc.ts restore  <host> <backupDir>→ 지정 백업의 원본 html/css 를 isPreview:false 로 복원
 *
 * 백업 디렉토리: `.skin-backup/<host>/<ISO ts>/` 안에 `original.html`, `original.css`,
 * `patched.html`, `info.json` 4개. apply 는 최신 디렉토리의 `patched.*` 를 박는다.
 *
 * 이 스크립트는 src/ 밖이라 tsc 빌드 대상이 아니다 — tsx 로만 실행.
 */
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { applySkin, getSkin, type SkinSource } from "../src/tistory/api.js";
import { loadContext } from "../src/tistory/browser.js";

const BACKUP_ROOT = ".skin-backup";

// ─────────────────────────────────────────────────────────────────────────────
// TOC 스니펫 — 본문 selector 는 analyze 결과 보고 결정. 일단 다중 후보로 자동 탐색.
// ─────────────────────────────────────────────────────────────────────────────

const TOC_STYLE = `
<style>
/* tistory-mcp: TOC mini-map → hover expand. 모노톤, 노션식 정렬 (H2 길게, H3 절반). */
#tm-toc {
  position: fixed;
  right: 24px;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  max-height: 80vh;
  padding: 8px 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: #333;
  z-index: 9999;
  overflow: hidden;
  transition: width 0.18s ease, padding 0.18s ease, background 0.18s ease, border-color 0.18s ease;
}
#tm-toc:hover,
#tm-toc:focus-within {
  width: 200px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 4px 8px;
  background: transparent;
  border-color: transparent;
  scrollbar-width: thin;
}
#tm-toc-title { display: none; }

#tm-toc ul { list-style: none; margin: 0; padding: 0; }
#tm-toc li { margin: 0; }
#tm-toc a {
  display: block;
  position: relative;
  padding: 5px 8px;
  color: #555;
  text-decoration: none;
  /* mini-map 기본: 텍스트 숨김, 막대만 */
  font-size: 0;
  line-height: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.12s, font-size 0.18s ease, line-height 0.18s ease, padding 0.18s ease;
}
/* mini-map 막대: 4단계 위계 — H1 가장 길고, H4 가장 짧음. */
#tm-toc a::before {
  content: '';
  display: block;
  height: 2px;
  width: 24px;
  background: #888;
  border-radius: 1px;
  transition: background 0.15s ease, width 0.15s ease;
}
#tm-toc a.tm-h2::before { width: 20px; background: #aaa; }
#tm-toc a.tm-h3::before { width: 12px; background: #c0c0c0; }
#tm-toc a.tm-h4::before { width: 8px;  background: #d0d0d0; }
#tm-toc a.tm-h2 { padding-left: 12px; }
#tm-toc a.tm-h3 { padding-left: 22px; }
#tm-toc a.tm-h4 { padding-left: 32px; }
#tm-toc a.tm-active::before { background: #111; }

#tm-toc:hover a,
#tm-toc:focus-within a {
  font-size: 13px;
  line-height: 1.5;
  padding: 4px 8px;
  color: #555;
}
#tm-toc:hover a.tm-h1,
#tm-toc:focus-within a.tm-h1 { padding-left: 8px; font-size: 13px; font-weight: 500; color: #333; }
#tm-toc:hover a.tm-h2,
#tm-toc:focus-within a.tm-h2 { padding-left: 18px; font-size: 12.5px; color: #555; }
#tm-toc:hover a.tm-h3,
#tm-toc:focus-within a.tm-h3 { padding-left: 30px; font-size: 12px; color: #777; }
#tm-toc:hover a.tm-h4,
#tm-toc:focus-within a.tm-h4 { padding-left: 42px; font-size: 11.5px; color: #888; }
#tm-toc:hover a::before,
#tm-toc:focus-within a::before { display: none; }
#tm-toc:hover a:hover,
#tm-toc:focus-within a:hover { color: #111; }
#tm-toc a.tm-active { color: #111; }
#tm-toc:hover a.tm-active,
#tm-toc:focus-within a.tm-active { color: #111; font-weight: 600; }

@media (max-width: 1024px) {
  #tm-toc { display: none; }
}
@media (prefers-color-scheme: dark) {
  #tm-toc { color: #ccc; }
  #tm-toc:hover,
  #tm-toc:focus-within {
    background: transparent;
    border-color: transparent;
  }
  #tm-toc a { color: #aaa; }
  #tm-toc a::before { background: #6a6a6a; }
  #tm-toc a.tm-h2::before { background: #555; }
  #tm-toc a.tm-h3::before { background: #3f3f3f; }
  #tm-toc a.tm-h4::before { background: #333; }
  #tm-toc a.tm-active::before { background: #fff; }
  #tm-toc:hover a:hover,
  #tm-toc:focus-within a:hover { color: #fff; }
  #tm-toc a.tm-active { color: #fff; }
}
</style>
`.trim();

const TOC_SCRIPT = `
<script>
(function () {
  // tistory-mcp: build TOC after DOM ready. Pick the first matching body selector.
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  ready(function () {
    var candidates = [
      '#article-view',
      '.post-body',
      '.tt_article_useless_p_margin',
      '.article-view .contents_style',
      '.entry-content',
      '.article_view',
      'article .contents_style',
      '#content article',
      'article'
    ];
    var body = null;
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el && el.querySelector('h1, h2, h3, h4')) { body = el; break; }
    }
    if (!body) return;

    // 본문 안의 h1~h4 전부. 글 제목(post-h1)은 본문 컨테이너 밖이라 자동 제외.
    var headings = body.querySelectorAll('h1, h2, h3, h4');
    if (headings.length < 2) return;

    var nav = document.createElement('nav');
    nav.id = 'tm-toc';
    nav.setAttribute('aria-label', '목차');
    var title = document.createElement('div');
    title.id = 'tm-toc-title';
    title.textContent = '목차';
    nav.appendChild(title);

    var ul = document.createElement('ul');
    var items = [];
    headings.forEach(function (h, idx) {
      if (!h.id) h.id = 'tm-h-' + idx;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent.trim();
      a.className = 'tm-' + h.tagName.toLowerCase(); // tm-h1 / tm-h2 / tm-h3 / tm-h4
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var t = document.getElementById(h.id);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + h.id);
      });
      li.appendChild(a);
      ul.appendChild(li);
      items.push({ h: h, a: a });
    });
    nav.appendChild(ul);
    document.body.appendChild(nav);

    // scroll-spy
    if ('IntersectionObserver' in window) {
      var current = null;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            var found = items.find(function (it) { return it.h === e.target; });
            if (!found) return;
            if (current) current.a.classList.remove('tm-active');
            found.a.classList.add('tm-active');
            current = found;
          }
        });
      }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
      items.forEach(function (it) { io.observe(it.h); });
    }
  });
})();
</script>
`.trim();

const TOC_MARKER_BEGIN = "<!-- tistory-mcp:toc-begin -->";
const TOC_MARKER_END = "<!-- tistory-mcp:toc-end -->";
const TOC_BLOCK = `${TOC_MARKER_BEGIN}\n${TOC_STYLE}\n${TOC_SCRIPT}\n${TOC_MARKER_END}`;

// ─────────────────────────────────────────────────────────────────────────────
// 패치 / 백업 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function injectToc(html: string): string {
  // 이미 박혀있으면 교체 (멱등)
  const re = new RegExp(`${escapeRe(TOC_MARKER_BEGIN)}[\\s\\S]*?${escapeRe(TOC_MARKER_END)}`);
  if (re.test(html)) return html.replace(re, TOC_BLOCK);
  // </body> 직전 삽입. 없으면 끝에 추가.
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) return html + "\n" + TOC_BLOCK + "\n";
  return html.slice(0, idx) + TOC_BLOCK + "\n" + html.slice(idx);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupDir(host: string, ts: string): Promise<string> {
  const dir = path.join(BACKUP_ROOT, host, ts);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function latestBackup(host: string): Promise<string | null> {
  const root = path.join(BACKUP_ROOT, host);
  try {
    const entries = await readdir(root);
    const dirs: { name: string; mtime: number }[] = [];
    for (const e of entries) {
      const p = path.join(root, e);
      const st = await stat(p).catch(() => null);
      if (st?.isDirectory()) dirs.push({ name: p, mtime: st.mtimeMs });
    }
    if (!dirs.length) return null;
    dirs.sort((a, b) => b.mtime - a.mtime);
    return dirs[0]!.name;
  } catch {
    return null;
  }
}

async function ctxOrDie(host: string) {
  const ctx = await loadContext(host);
  if (!ctx) throw new Error(`No stored session for ${host}. Run tistory_session_init first.`);
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// 단계
// ─────────────────────────────────────────────────────────────────────────────

async function doBackup(host: string): Promise<{ dir: string; skin: SkinSource }> {
  const ctx = await ctxOrDie(host);
  const skin = await getSkin(ctx);
  const ts = nowStamp();
  const dir = await backupDir(host, ts);
  await writeFile(path.join(dir, "original.html"), skin.html, "utf8");
  await writeFile(path.join(dir, "original.css"), skin.css, "utf8");
  await writeFile(
    path.join(dir, "info.json"),
    JSON.stringify(
      {
        host,
        ts,
        skinname: skin.skinname,
        files: skin.files,
        htmlBytes: Buffer.byteLength(skin.html, "utf8"),
        cssBytes: Buffer.byteLength(skin.css, "utf8"),
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, skin };
}

async function doAnalyze(host: string): Promise<void> {
  const dir = await latestBackup(host);
  if (!dir) throw new Error(`No backup for ${host}. Run \`backup\` first.`);
  const html = await readFile(path.join(dir, "original.html"), "utf8");
  console.log(`# Analyze: ${dir}`);
  console.log(`html bytes: ${Buffer.byteLength(html, "utf8")}`);
  // 본문 영역 후보 — 티스토리 치환자 주변 클래스 추출
  const repIdx = html.search(/\[##_article_rep_desc_##\]|\[##_article_rep_##\]/);
  console.log(`article 치환자 위치: ${repIdx}`);
  if (repIdx > 0) {
    const ctx = html.slice(Math.max(0, repIdx - 400), repIdx + 80);
    console.log("--- 주변 컨텍스트 (앞 400자) ---");
    console.log(ctx);
    console.log("--- 끝 ---");
  }
  // class= 빈도 top 20 — selector 후보
  const counts = new Map<string, number>();
  const re = /class\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log("--- 상위 클래스 ---");
  for (const [c, n] of top) console.log(`${n.toString().padStart(4)}  .${c}`);
}

async function doPreview(host: string): Promise<void> {
  const { dir, skin } = await doBackup(host);
  const patched = injectToc(skin.html);
  await writeFile(path.join(dir, "patched.html"), patched, "utf8");
  await writeFile(path.join(dir, "patched.css"), skin.css, "utf8");
  console.log(`백업 + 패치 저장: ${dir}`);
  const ctx = await ctxOrDie(host);
  const previewUrl = await applySkin(ctx, { html: patched, css: skin.css, isPreview: true });
  console.log(`PREVIEW: ${previewUrl}`);
}

async function doApply(host: string): Promise<void> {
  const dir = await latestBackup(host);
  if (!dir) throw new Error(`No backup for ${host}. Run \`preview\` first.`);
  const html = await readFile(path.join(dir, "patched.html"), "utf8").catch(() => null);
  const css = await readFile(path.join(dir, "patched.css"), "utf8").catch(() => null);
  if (!html || !css) throw new Error(`patched.* not found in ${dir}. Run \`preview\` first.`);
  const ctx = await ctxOrDie(host);
  const out = await applySkin(ctx, { html, css, isPreview: false });
  console.log(`LIVE applied. server returned: ${out}`);
  console.log(`복원하려면: tsx scripts/skin-toc.ts restore ${host} "${dir}"`);
}

async function doRestore(host: string, backupDir: string): Promise<void> {
  const html = await readFile(path.join(backupDir, "original.html"), "utf8");
  const css = await readFile(path.join(backupDir, "original.css"), "utf8");
  const ctx = await ctxOrDie(host);
  const out = await applySkin(ctx, { html, css, isPreview: false });
  console.log(`RESTORED from ${backupDir}. server returned: ${out}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, host, arg2] = process.argv.slice(2);
  if (!cmd || !host) {
    console.error(
      "usage: tsx scripts/skin-toc.ts <backup|analyze|preview|apply|restore> <host> [backupDir]",
    );
    process.exit(2);
  }
  switch (cmd) {
    case "backup": {
      const { dir } = await doBackup(host);
      console.log(`백업 완료: ${dir}`);
      return;
    }
    case "analyze":
      return doAnalyze(host);
    case "preview":
      return doPreview(host);
    case "apply":
      return doApply(host);
    case "restore": {
      if (!arg2) throw new Error("restore requires <backupDir>");
      return doRestore(host, arg2);
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
