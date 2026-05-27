/**
 * ad-hoc 실측 스크립트 — `/manage/category` reverse-engineer.
 *
 * 두 모드:
 *   - `--mode=recon` (기본): 진입 + 초기 XHR + DOM 구조 + 스크린샷 dump. 자동 클릭 X.
 *   - `--mode=interactive`: 헤디드 + 사용자가 직접 클릭. Ctrl+C 종료 시 dump.
 *   - `--mode=auto`: 셀렉터 추측해서 자동 클릭 시도 (recon 후 셀렉터 확정되면 사용).
 *
 * 사용:
 *   npx tsx scripts/capture-category-xhr.ts saree98.tistory.com --mode=recon
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
  // 필터: XHR/fetch 만 (document/script/image/font/stylesheet 제외).
  // /manage/category 만으로 좁히면 batch save 가 다른 path 로 가는 경우 놓침.
  const isInteresting = (req: { url: () => string; resourceType: () => string }): boolean => {
    const type = req.resourceType();
    if (type !== "xhr" && type !== "fetch") return false;
    const u = req.url();
    // 같은 호스트 admin 만
    return u.includes("/manage/") || u.includes("/api/");
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
    if (entry.postData) process.stderr.write(`      body: ${entry.postData.slice(0, 800)}\n`);
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

async function dumpDomStructure(page: Page): Promise<unknown> {
  // tsx esbuild 가 page.evaluate 안의 어떤 함수 정의에도 `__name` helper 를 inject 함
  // (브라우저 컨텍스트엔 helper 없어 ReferenceError). 함수를 문자열로 넘기면 우회 가능.
  const fnSrc = `(() => {
    var describe = function(el) {
      var rect = el.getBoundingClientRect();
      var cls = typeof el.className === 'string' ? el.className : '';
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: cls || undefined,
        role: el.getAttribute('role') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        textPreview: (el.textContent || '').trim().slice(0, 80),
        visible: rect.width > 0 && rect.height > 0,
      };
    };
    var main = document.querySelector('main') || document.body;
    var categoryEls = Array.from(main.querySelectorAll('[class*="category"], [class*="Category"]'));
    var liEls = Array.from(main.querySelectorAll('li')).slice(0, 30);
    var buttons = Array.from(main.querySelectorAll('button, [role="button"]'));
    var save = buttons.filter(function(b) { return (b.textContent || '').includes('저장'); });
    var add = buttons.filter(function(b) { return (b.textContent || '').includes('추가'); });
    return {
      title: document.title,
      url: location.href,
      bodyTextPreview: (document.body.textContent || '').trim().slice(0, 500),
      categoryElCount: categoryEls.length,
      categoryElsSample: categoryEls.slice(0, 20).map(describe),
      liSample: liEls.map(describe),
      saveButtons: save.map(describe),
      addButtons: add.map(describe),
      windowConfigBlogId: (window.Config && window.Config.blog && window.Config.blog.blogSettings && window.Config.blog.blogSettings.blogId) || null,
    };
  })()`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await page.evaluate(fnSrc as any);
}

async function modeRecon(page: Page, host: string, captured: Captured): Promise<void> {
  process.stderr.write(`[recon] navigating to /manage/category\n`);
  await page.goto(`https://${host}/manage/category`, { waitUntil: "domcontentloaded" });
  // SPA 마운트 대기
  await page.waitForTimeout(3000);

  process.stderr.write(`[recon] dumping DOM\n`);
  const dom = await dumpDomStructure(page);

  // div.blog_category 내부 outerHTML + 모든 button/input/select 의 상세
  const deep = await page.evaluate(`(() => {
    var root = document.querySelector('.blog_category');
    if (!root) return { err: 'no .blog_category' };
    var html = root.outerHTML.slice(0, 8000);
    var allButtons = Array.from(root.querySelectorAll('button, [role="button"]')).map(function(b) {
      var rect = b.getBoundingClientRect();
      return {
        tag: b.tagName.toLowerCase(),
        classes: typeof b.className === 'string' ? b.className : '',
        text: (b.textContent || '').trim().slice(0, 50),
        ariaLabel: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || '',
        visible: rect.width > 0 && rect.height > 0,
        disabled: b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true',
      };
    });
    var allInputs = Array.from(root.querySelectorAll('input, textarea, select')).map(function(i) {
      var rect = i.getBoundingClientRect();
      return {
        tag: i.tagName.toLowerCase(),
        type: i.getAttribute('type') || '',
        classes: typeof i.className === 'string' ? i.className : '',
        placeholder: i.getAttribute('placeholder') || '',
        ariaLabel: i.getAttribute('aria-label') || '',
        value: ('value' in i ? i.value : '').slice(0, 50),
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    var allLinks = Array.from(root.querySelectorAll('a, [class*="add"], [class*="edit"], [class*="del"]')).map(function(a) {
      return {
        tag: a.tagName.toLowerCase(),
        classes: typeof a.className === 'string' ? a.className : '',
        text: (a.textContent || '').trim().slice(0, 30),
      };
    }).slice(0, 50);
    return { html: html, buttons: allButtons, inputs: allInputs, actionish: allLinks };
  })()`);

  process.stderr.write(`[recon] taking screenshot\n`);
  const shotPath = `scripts/category-recon-${Date.now()}.png`;
  await page.screenshot({ path: shotPath, fullPage: true });
  process.stderr.write(`[recon] screenshot saved: ${shotPath}\n`);

  const dumpPath = `scripts/category-recon-${Date.now()}.json`;
  writeFileSync(
    dumpPath,
    JSON.stringify({ dom, deep, captured, shotPath }, null, 2),
    "utf8",
  );
  process.stderr.write(`[recon] dump saved: ${dumpPath}\n`);
}

async function modeAuto(page: Page, host: string, captured: Captured): Promise<void> {
  // dialog 자동 accept (confirm 류 대응)
  page.on("dialog", (d) => {
    process.stderr.write(`[auto] dialog '${d.type()}': ${d.message().slice(0, 100)}\n`);
    d.accept().catch(() => undefined);
  });

  await page.goto(`https://${host}/manage/category`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const tag = `TEMP실측${Date.now().toString().slice(-6)}`;
  process.stderr.write(`[auto] using tag: ${tag}\n`);

  // Phase 1: 루트 레벨 카테고리 추가
  // 함정 §7.6: div.set_order 가 pointer events 가로챔 → JS click 강제 (스킨등록 버튼과 동일 패턴)
  process.stderr.write(`[auto] phase 1: add root category (force JS click)\n`);
  const phase1Click = await page.evaluate(`(() => {
    var btn = document.querySelector('input.btn_g[value="카테고리 추가"]');
    if (!btn) return { ok: false, reason: 'no add button' };
    btn.click();
    return { ok: true };
  })()`);
  process.stderr.write(`[auto] add-button click: ${JSON.stringify(phase1Click)}\n`);
  await page.waitForTimeout(1500);

  // 추가 후 등장한 input 들 + 새 bundle_item 의 html
  const phase1Dom = await page.evaluate(`(() => {
    var root = document.querySelector('.blog_category');
    if (!root) return null;
    var inputs = Array.from(root.querySelectorAll('input[type="text"], input:not([type])')).map(function(i) {
      var rect = i.getBoundingClientRect();
      return { classes: typeof i.className === 'string' ? i.className : '', value: i.value || '', visible: rect.width > 0 && rect.height > 0, placeholder: i.getAttribute('placeholder') || '' };
    });
    // 가장 최근 추가된 bundle_item (마지막) 의 outerHTML — commit UI 확인
    var items = Array.from(root.querySelectorAll('.bundle_item'));
    var lastHtml = items.length > 0 ? items[items.length - 1].outerHTML.slice(0, 2000) : '';
    var allButtons = Array.from(root.querySelectorAll('button, a, input[type="button"]')).map(function(b) {
      var rect = b.getBoundingClientRect();
      return { tag: b.tagName.toLowerCase(), cls: typeof b.className === 'string' ? b.className : '', text: (b.textContent || '').trim().slice(0,30), value: b.value || '', visible: rect.width > 0 && rect.height > 0 };
    }).filter(function(b) { return b.visible; });
    return { inputs: inputs, lastBundle: lastHtml, buttons: allButtons };
  })()`);
  const phase1Path = `scripts/category-auto-phase1-${Date.now()}.json`;
  writeFileSync(phase1Path, JSON.stringify(phase1Dom, null, 2));
  process.stderr.write(`[auto] phase 1 dump saved: ${phase1Path}\n`);

  // 가시 text input 에 이름 입력
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visibleTextInput = (await page.evaluateHandle(`(() => {
    var root = document.querySelector('.blog_category');
    if (!root) return null;
    var inputs = Array.from(root.querySelectorAll('input[type="text"], input:not([type])'));
    for (var i = 0; i < inputs.length; i++) {
      var rect = inputs[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && !inputs[i].readOnly && inputs[i].value === '') return inputs[i];
    }
    return null;
  })()`)) as any;

  if (await visibleTextInput.evaluate((el: HTMLInputElement | null) => el !== null)) {
    await visibleTextInput.fill(tag);
    await page.waitForTimeout(500);
    // commit 트리거: form.edit_item 안의 '확인' 버튼 클릭 (button.btn_default).
    // 빈 입력일 땐 btn_off (disabled), 텍스트 있으면 enable.
    const confirmResult = await page.evaluate(`(() => {
      var btns = Array.from(document.querySelectorAll('form.edit_item button.btn_default'));
      if (btns.length === 0) return { ok: false, reason: 'no confirm button' };
      var enabled = btns.filter(function(b) { return !b.disabled; });
      if (enabled.length === 0) return { ok: false, reason: 'all disabled', classes: btns.map(function(b) { return b.className; }) };
      enabled[0].click();
      return { ok: true, clicked: enabled[0].className };
    })()`);
    process.stderr.write(`[auto] commit confirm: ${JSON.stringify(confirmResult)}\n`);
    await page.waitForTimeout(1000);
  } else {
    process.stderr.write(`[auto] no visible empty text input found — abort\n`);
    return;
  }
  await page.waitForTimeout(1500);

  // 입력 후 상태 dump (저장 버튼이 enable 됐는지 확인)
  const inputState = await page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button.btn_save')).map(function(b) { return { cls: b.className, disabled: b.disabled }; });
    var inputs = Array.from(document.querySelectorAll('.blog_category input.tf_blog')).map(function(i) { return { cls: i.className, value: i.value }; });
    return { btns: btns, inputs: inputs };
  })()`);
  process.stderr.write(`[auto] state after type: ${JSON.stringify(inputState)}\n`);

  // 변경사항 저장 — btn_on 클래스로 enable 된 상태 확인
  process.stderr.write(`[auto] click save (phase 1)\n`);
  const saveResult1 = await page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button.btn_save'));
    var on = btns.filter(function(b) { return !b.disabled; });
    if (on.length === 0) return { ok: false, reason: 'no enabled save button', allClasses: btns.map(function(b) { return b.className; }) };
    on[0].click();
    return { ok: true, clicked: on[0].className };
  })()`);
  process.stderr.write(`[auto] save result: ${JSON.stringify(saveResult1)}\n`);
  await page.waitForTimeout(2500);

  // Phase 1.5: 이름 변경 (update body 캡처)
  // 페이지 reload 로 새 카테고리 fresh state 확보
  process.stderr.write(`[auto] phase 1.5: reload + rename category\n`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const renamedTag = tag + "_R";
  const tempIdx15 = await page.evaluate(`((tagName) => {
    var items = Array.from(document.querySelectorAll('.bundle_item'));
    for (var i = 0; i < items.length; i++) {
      var name = items[i].querySelector('.txt_name');
      if (name && name.textContent && name.textContent.indexOf(tagName) !== -1) return i;
    }
    return -1;
  })('${tag}')`);
  process.stderr.write(`[auto] phase 1.5 temp row index: ${tempIdx15}\n`);

  if (typeof tempIdx15 === "number" && tempIdx15 >= 0) {
    const rowLoc15 = page.locator(".bundle_item").nth(tempIdx15);
    await rowLoc15.hover({ force: true });
    await page.waitForTimeout(400);
    const editLoc = rowLoc15.locator('a.btn_post', { hasText: "수정" });
    if ((await editLoc.count()) > 0) {
      await editLoc.first().click({ force: true });
      await page.waitForTimeout(800);
      // edit 모드 input 에 새 이름 입력 + confirm
      const renameResult = await page.evaluate(`((newName) => {
        var inputs = Array.from(document.querySelectorAll('form.edit_item input.tf_blog'));
        var visible = inputs.find(function(i) { var r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (!visible) return { ok: false, reason: 'no edit input' };
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(visible, newName);
        visible.dispatchEvent(new Event('input', { bubbles: true }));
        visible.dispatchEvent(new Event('change', { bubbles: true }));
        var confirmBtns = Array.from(document.querySelectorAll('form.edit_item button.btn_default')).filter(function(b) { return !b.disabled; });
        if (confirmBtns.length === 0) return { ok: false, reason: 'no enabled confirm' };
        confirmBtns[0].click();
        return { ok: true, value: visible.value };
      })('${renamedTag}')`);
      process.stderr.write(`[auto] rename: ${JSON.stringify(renameResult)}\n`);
      await page.waitForTimeout(1500);

      // inline poll+click 으로 save
      const renameSave = await page.evaluate(`(async () => {
        var deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          var btns = Array.from(document.querySelectorAll('button.btn_save'));
          var on = btns.find(function(b) { return !b.disabled; });
          if (on) { on.click(); return { ok: true, cls: on.className }; }
          await new Promise(function(r) { setTimeout(r, 50); });
        }
        return { ok: false };
      })()`);
      process.stderr.write(`[auto] rename save: ${JSON.stringify(renameSave)}\n`);
      await page.waitForTimeout(2500);
    }
  }

  // Phase 2: 카테고리 삭제 (delete body 캡처 — 위에서 한 번 했지만 cleanup 차원에서 한 번 더)
  process.stderr.write(`[auto] phase 2: reload + delete\n`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 카테고리 row 의 nth index 찾기 (TEMP 매칭)
  const tempIdx = await page.evaluate(`((tagName) => {
    var items = Array.from(document.querySelectorAll('.bundle_item'));
    for (var i = 0; i < items.length; i++) {
      var name = items[i].querySelector('.txt_name');
      if (name && name.textContent && name.textContent.indexOf(tagName) !== -1) return i;
    }
    return -1;
  })('${tag}')`);
  process.stderr.write(`[auto] temp row index: ${tempIdx}\n`);

  if (typeof tempIdx === "number" && tempIdx >= 0) {
    // Playwright 정식 hover (mousemove + onMouseEnter 트리거)
    const rowLoc = page.locator(".bundle_item").nth(tempIdx);
    await rowLoc.hover({ force: true });
    await page.waitForTimeout(500);
    const delLoc = rowLoc.locator('a.btn_post', { hasText: "삭제" });
    const delCount = await delLoc.count();
    process.stderr.write(`[auto] delete link count: ${delCount}\n`);
    if (delCount > 0) {
      const delCls = await delLoc.first().getAttribute("class");
      process.stderr.write(`[auto] delete link class: ${delCls}\n`);
      await delLoc.first().click({ force: true });
      await page.waitForTimeout(1500);

      // delete 클릭 후 등장한 모달/팝업 찾기 + 확인 버튼 dump
      const modalDump = await page.evaluate(`(() => {
        // 페이지 전체에서 새로 등장한 모달 후보 — body 직속 또는 .layer_* / .modal_* / [role=dialog]
        var candidates = Array.from(document.querySelectorAll('[class*="layer"], [class*="modal"], [class*="popup"], [role="dialog"], [role="alertdialog"]'));
        var visible = candidates.filter(function(el) {
          var rect = el.getBoundingClientRect();
          var st = window.getComputedStyle(el);
          return rect.width > 100 && rect.height > 50 && st.display !== 'none' && st.visibility !== 'hidden';
        });
        return visible.map(function(el) {
          var btns = Array.from(el.querySelectorAll('button, a, input[type="button"]')).map(function(b) {
            return { tag: b.tagName.toLowerCase(), cls: typeof b.className === 'string' ? b.className : '', text: (b.textContent || '').trim().slice(0, 30), value: b.value || '' };
          });
          return { cls: typeof el.className === 'string' ? el.className : '', textPreview: (el.textContent || '').trim().slice(0, 200), buttons: btns };
        });
      })()`);
      writeFileSync(`scripts/category-auto-modal-${Date.now()}.json`, JSON.stringify(modalDump, null, 2));
      process.stderr.write(`[auto] modal dump: ${JSON.stringify(modalDump).slice(0, 600)}\n`);

      // 모달 안의 '확인' 버튼 자동 클릭 시도
      const modalConfirm = await page.evaluate(`(() => {
        var modals = Array.from(document.querySelectorAll('[class*="layer"], [class*="modal"], [class*="popup"], [role="dialog"], [role="alertdialog"]'));
        for (var i = 0; i < modals.length; i++) {
          var rect = modals[i].getBoundingClientRect();
          if (rect.width < 100) continue;
          var btns = Array.from(modals[i].querySelectorAll('button, a, input[type="button"]'));
          // '확인' / '삭제' 텍스트 + disabled 아님
          var ok = btns.filter(function(b) {
            if (b.disabled) return false;
            var t = (b.textContent || b.value || '').trim();
            return t === '확인' || t === '삭제' || t === '예';
          });
          if (ok.length > 0) {
            ok[0].click();
            return { ok: true, clicked: (ok[0].textContent || ok[0].value || '').trim(), cls: ok[0].className };
          }
        }
        return { ok: false, reason: 'no confirm button in modal' };
      })()`);
      process.stderr.write(`[auto] modal confirm: ${JSON.stringify(modalConfirm)}\n`);
      await page.waitForTimeout(1500);
    }
  }

  // delete 후 저장 enable window 가 짧음 — 같은 evaluate 안에서 polling + 즉시 click
  const pollAndClick = await page.evaluate(`(async () => {
    var deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      var btns = Array.from(document.querySelectorAll('button.btn_save'));
      var on = btns.find(function(b) { return !b.disabled; });
      if (on) {
        on.click();
        return { ok: true, clicked: on.className, waited: Date.now() - (deadline - 5000) };
      }
      await new Promise(function(r) { setTimeout(r, 50); });
    }
    return { ok: false, reason: 'timeout' };
  })()`);
  process.stderr.write(`[auto] poll+click result: ${JSON.stringify(pollAndClick)}\n`);
  await page.waitForTimeout(2500);

  const stateAfterDel = await page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button.btn_save')).map(function(b) { return { cls: b.className, disabled: b.disabled }; });
    var items = Array.from(document.querySelectorAll('.bundle_item .txt_name')).map(function(n) { return (n.textContent || '').trim(); });
    return { btns: btns, items: items };
  })()`);
  process.stderr.write(`[auto] state after delete+save: ${JSON.stringify(stateAfterDel)}\n`);

  // 변경사항 저장 (cleanup)
  process.stderr.write(`[auto] click save (phase 2 cleanup)\n`);
  const saveResult2 = await page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button.btn_save'));
    var on = btns.filter(function(b) { return b.className.indexOf('btn_on') !== -1 && !b.disabled; });
    if (on.length === 0) return { ok: false, reason: 'no enabled save button', allClasses: btns.map(function(b) { return b.className; }) };
    on[0].click();
    return { ok: true };
  })()`);
  process.stderr.write(`[auto] save2 result: ${JSON.stringify(saveResult2)}\n`);
  await page.waitForTimeout(2500);

  // 캡처 dump
  const outPath = `scripts/category-auto-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(captured, null, 2), "utf8");
  process.stderr.write(`\n[done] captured ${captured.requests.length} reqs / ${captured.responses.length} ress\n`);
  process.stderr.write(`[done] saved: ${outPath}\n`);
}

async function modeInteractive(page: Page, host: string, captured: Captured): Promise<void> {
  await page.goto(`https://${host}/manage/category`, { waitUntil: "domcontentloaded" });
  process.stderr.write(`\n[ready] 브라우저에서 카테고리 페이지가 열렸습니다.\n`);
  process.stderr.write(`[ready] 직접 클릭으로 다음 시나리오 진행 (각 단계 후 '변경사항 저장' 눌러서 XHR 트리거):\n`);
  process.stderr.write(`        1) 새 카테고리 추가 → "TEMP-실측-A" → 변경사항 저장\n`);
  process.stderr.write(`        2) 이름 변경 → "TEMP-실측-A-renamed" → 변경사항 저장\n`);
  process.stderr.write(`        3) visibility 토글 (있으면) → 변경사항 저장\n`);
  process.stderr.write(`        4) 하위 카테고리 추가 → 변경사항 저장\n`);
  process.stderr.write(`        5) 부모 변경/이동 → 변경사항 저장\n`);
  process.stderr.write(`        6) 전부 삭제 → 변경사항 저장 (cleanup)\n`);
  process.stderr.write(`\n[ready] 종료 방법: 파일 '${STOP_FILE}' 생성 (또는 Ctrl+C)\n\n`);

  // 기존 stop 파일 잔재 제거
  if (existsSync(STOP_FILE)) unlinkSync(STOP_FILE);

  // background 실행 시 stdin EOF 즉시 발생 → 파일 시그널 + SIGINT 만 사용
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

  process.stderr.write(`\n[done] dumping ${captured.requests.length} requests / ${captured.responses.length} responses\n`);
  const outPath = `scripts/category-interactive-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(captured, null, 2), "utf8");
  process.stderr.write(`[done] saved: ${outPath}\n`);
}

async function main(): Promise<void> {
  const host = process.argv[2] ?? "saree98.tistory.com";
  const modeArg = process.argv.find((a) => a.startsWith("--mode="));
  const mode = (modeArg ? modeArg.slice("--mode=".length) : "recon") as
    | "recon"
    | "interactive"
    | "auto";

  process.stderr.write(`[init] mode=${mode} host=${host}\n`);
  const storageState = await loadStorageState(host);

  const browser = await chromium.launch({ headless: mode === "recon" || mode === "auto" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context = await browser.newContext({ storageState: storageState as any });
  const page = await context.newPage();

  const captured: Captured = { requests: [], responses: [] };
  attachCapture(page, captured);

  try {
    if (mode === "recon") await modeRecon(page, host, captured);
    else if (mode === "interactive") await modeInteractive(page, host, captured);
    else if (mode === "auto") await modeAuto(page, host, captured);
    else throw new Error(`mode '${mode}' not implemented yet`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[err] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
