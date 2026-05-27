#!/usr/bin/env node
// `tistory_session_init` / `tistory_screenshot` 가 쓰는 Chromium 을 자동 다운로드.
// 실패해도 패키지 설치 자체는 통과시킨다 (네트워크 차단 환경 대응).
// 사용자가 cookie-fetch 도구만 쓸 거면 첫 session_init 호출 시 다시 안내됨.

import { spawnSync } from "node:child_process";

if (process.env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] === "1") {
  process.exit(0);
}

const r = spawnSync("playwright", ["install", "chromium"], {
  stdio: "inherit",
  shell: true,
});

if (r.status !== 0) {
  console.error(
    "[tistory-mcp] Chromium 자동 다운로드 실패. session_init/screenshot 사용 전에 수동 실행: npx playwright install chromium",
  );
}
process.exit(0);
