/**
 * Playwright session manager — `tistory_session_init` **전용**.
 *
 * 카카오 OAuth + 2FA 푸시는 헤들리스로 못 뚫음 (docs/api.md §1.1) → 헤디드 한 번.
 * 그 외 모든 도구는 여기서 캡처한 cookie 로 `src/tistory/api.ts` 의 fetch 만 사용.
 * 다른 모듈에서 절대 Playwright 다시 띄우지 말 것 (CLAUDE.md 함정 1).
 *
 * storageState 보관:
 *   - keytar (OS 자격증명 저장) 에 JSON 그대로 암호화 저장
 *   - service = "tistory-mcp", account = blog host (예: "saree98.tistory.com")
 *   - 블로그 host 별로 분리 → 멀티 블로그 동시 보관 가능
 */
/// <reference types="node" />
import { chromium, type BrowserContext } from "playwright";
import keytar from "keytar";

import type { TistoryContext } from "./api.js";

// ─────────────────────────────────────────────────────────────────────────────
// keytar 스토리지 키
// ─────────────────────────────────────────────────────────────────────────────

/** 모든 블로그 host 가 공유하는 service 이름. account 로 host 를 구분. */
const KEYTAR_SERVICE = "tistory-mcp";

/** 단일 블로그만 쓰는 사용자를 위한 기본 account. host 미지정 load 시 fallback. */
const DEFAULT_ACCOUNT = "default";

// ─────────────────────────────────────────────────────────────────────────────
// storageState 직렬화 타입
// ─────────────────────────────────────────────────────────────────────────────

/** Playwright `context.storageState()` 반환의 cookie 항목 (필요 필드만). */
interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix epoch seconds. `-1` 이면 세션 쿠키. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface StoredState {
  cookies: StoredCookie[];
  // origins (localStorage) 는 cookie-auth fetch 흐름에선 안 쓰지만 보관은 그대로
  origins: unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Playwright cookie 배열을 `Cookie:` 헤더 문자열로 직렬화.
 *
 * 도메인 매칭은 티스토리/카카오 도메인 전체를 포함하도록 felexible 하게:
 *   - 정확히 일치 (`host === cookie.domain`)
 *   - 점 prefix subdomain 매칭 (`cookie.domain` 이 `.tistory.com` 같은 경우)
 *
 * 실제 admin fetch 는 `{host}.tistory.com` 으로 가지만 카카오 cookie 도 같이
 * 보내야 일부 endpoint 가 통과 (실측). 그래서 host 매칭은 admin host 와
 * `tistory.com`/`kakao.com` 부모 도메인을 모두 통과시킨다.
 */
function serializeCookies(cookies: StoredCookie[], host: string): string {
  const now = Math.floor(Date.now() / 1000);
  const matched = cookies.filter((c) => {
    // 만료된 영구 쿠키는 제외. 세션 쿠키 (-1) 는 통과.
    if (c.expires !== -1 && c.expires > 0 && c.expires < now) return false;
    return cookieDomainMatches(c.domain, host);
  });

  // 같은 이름이 여러 도메인에서 오면 host 가장 가까운 것을 우선 — 정렬 후 dedup
  matched.sort((a, b) => b.domain.length - a.domain.length);
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of matched) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

function cookieDomainMatches(cookieDomain: string, host: string): boolean {
  // `.tistory.com` → `tistory.com` 로 정규화
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  if (host === d) return true;
  if (host.endsWith(`.${d}`)) return true;
  return false;
}

/**
 * `https://blog.tistory.com` 같은 입력에서 host 만 뽑아낸다.
 * 프로토콜·경로 없이 그대로 host 가 들어와도 통과.
 */
function normalizeHost(blogUrl: string): string {
  const trimmed = blogUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return new URL(trimmed).host;
  }
  // 경로 슬래시 떨굼
  return trimmed.replace(/\/.*$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginOptions {
  /**
   * 블로그 URL 또는 host. 카카오 OAuth 진입점 (`/manage`) 생성 + keytar account 키.
   * 예: `"saree98.tistory.com"` 또는 `"https://saree98.tistory.com"`.
   */
  blogUrl: string;
  /**
   * 로그인 완료 대기 timeout (ms). 카카오톡 푸시 승인까지 사람이 직접 눌러야
   * 하므로 디폴트 5분.
   */
  timeoutMs?: number;
}

export interface LoginResult {
  /** Tistory blogId — `window.Config.blog.blogId` 에서 추출. `null` 이면 메타 파싱 실패. */
  blogId: string | null;
  /** 블로그 host (keytar account 키). */
  host: string;
  /** 호출자가 `TistoryContext.cookie` 로 즉시 쓸 수 있는 직렬화된 헤더 값. */
  cookieHeader: string;
  /**
   * 가장 빠른 cookie 만료 시각. 세션 쿠키만 있으면 undefined.
   * UX 힌트용 (실제 만료 감지는 api.ts 의 redirect 분기).
   */
  expiresAt?: Date;
}

/**
 * 헤디드 Chromium 으로 `/manage` 진입 → 카카오 로그인 + 2FA 푸시 완료까지 대기.
 *
 * 완료 신호: URL 이 `{host}/manage` 또는 그 하위로 안착 + admin DOM 로드.
 *
 * 완료 후 `context.storageState()` 를 keytar 에 JSON 저장하고 즉시 쓸 수 있는
 * cookie 헤더를 반환한다 (도구가 한 번 더 load 안 하도록).
 */
export async function loginInteractive(opts: LoginOptions): Promise<LoginResult> {
  const host = normalizeHost(opts.blogUrl);
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const browser = await chromium.launch({ headless: false });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`https://${host}/manage`, { waitUntil: "domcontentloaded" });

    // 카카오/tistory 로그인 페이지를 거쳐 결국 `{host}/manage*` 로 돌아와야 함.
    // 카카오 푸시 승인까지 사람이 처리하므로 넉넉한 timeout.
    await page.waitForURL((url) => url.host === host && url.pathname.startsWith("/manage"), {
      timeout: timeoutMs,
    });
    // SPA 가 window.Config 박을 시간 — networkidle 까지는 무거우니 domcontentloaded 후 짧게.
    await page.waitForLoadState("domcontentloaded");

    // window.Config.blog.blogId — 메타 추출은 best-effort. 파싱 실패해도 로그인은 성공.
    const blogId = await page
      .evaluate(() => {
        // @ts-expect-error - window.Config 는 admin 페이지가 inline 으로 박는다 (docs/api.md §2.1)
        const cfg = window.Config as { blog?: { blogId?: number } } | undefined;
        return cfg?.blog?.blogId != null ? String(cfg.blog.blogId) : null;
      })
      .catch(() => null);

    const state = (await context.storageState()) as StoredState;
    await keytar.setPassword(KEYTAR_SERVICE, host, JSON.stringify(state));
    // 단일 블로그 사용자 편의를 위해 `default` 별칭도 같이 박는다 — 마지막 로그인 = default.
    await keytar.setPassword(KEYTAR_SERVICE, DEFAULT_ACCOUNT, JSON.stringify(state));

    const cookieHeader = serializeCookies(state.cookies, host);
    const expiresAt = earliestExpiry(state.cookies, host);

    return {
      blogId,
      host,
      cookieHeader,
      ...(expiresAt ? { expiresAt } : {}),
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * keytar 에서 storageState 꺼내 `TistoryContext.cookie` 로 그대로 쓸 헤더 직렬화.
 *
 * @param blogUrl host 또는 URL. 미지정 시 `default` (가장 최근 로그인) 사용.
 * @returns cookie 헤더 문자열. 저장된 것이 없거나 모든 쿠키가 만료/비매칭이면 `null`.
 */
export async function loadStoredCookies(blogUrl?: string): Promise<string | null> {
  const account = blogUrl ? normalizeHost(blogUrl) : DEFAULT_ACCOUNT;
  const json = await keytar.getPassword(KEYTAR_SERVICE, account);
  if (!json) return null;

  const state = parseState(json);
  if (!state) return null;

  // host 가 명시 안 됐으면 `default` 슬롯에 저장된 host 를 알 수 없음 → cookie 의 가장 흔한
  // tistory 도메인을 host 로 가정. 만료 감지는 api.ts 가 어차피 처리.
  const host = blogUrl ? normalizeHost(blogUrl) : inferHost(state.cookies);
  if (!host) return null;

  const header = serializeCookies(state.cookies, host);
  return header === "" ? null : header;
}

/**
 * keytar 에 저장된 세션 삭제. blogUrl 미지정 시 `default` 슬롯만.
 * 전체 와이프는 호출자가 host 별로 반복.
 */
export async function clearStoredCookies(blogUrl?: string): Promise<void> {
  const account = blogUrl ? normalizeHost(blogUrl) : DEFAULT_ACCOUNT;
  await keytar.deletePassword(KEYTAR_SERVICE, account).catch(() => undefined);
  if (!blogUrl) {
    // default 만 지울 땐 host 별 항목도 같이 비워야 stale 안 남음
    const all = await keytar.findCredentials(KEYTAR_SERVICE).catch(() => []);
    for (const cred of all) {
      await keytar.deletePassword(KEYTAR_SERVICE, cred.account).catch(() => undefined);
    }
  }
}

/**
 * 편의: keytar 에서 꺼내 `TistoryContext` 통째로 만들어주는 헬퍼.
 * api.ts 의 모든 함수 첫 인자가 `TistoryContext` 라서 도구 코드 한 줄 줄임.
 */
export async function loadContext(blogUrl: string): Promise<TistoryContext | null> {
  const cookie = await loadStoredCookies(blogUrl);
  if (!cookie) return null;
  return { host: normalizeHost(blogUrl), cookie };
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function parseState(json: string): StoredState | null {
  try {
    const v = JSON.parse(json) as StoredState;
    if (!Array.isArray(v.cookies)) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * cookies 목록에서 admin host 후보를 추론. `default` 슬롯에서만 쓰임.
 * `*.tistory.com` 형태의 가장 구체적인 도메인을 선택.
 */
function inferHost(cookies: StoredCookie[]): string | null {
  const tistoryCookies = cookies
    .map((c) => (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain))
    .filter((d) => d.endsWith(".tistory.com") && d !== "www.tistory.com");
  if (tistoryCookies.length === 0) return null;
  // 가장 자주 등장 = 사용자 블로그 host
  const counts = new Map<string, number>();
  for (const d of tistoryCookies) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = -1;
  for (const [d, n] of counts) {
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function earliestExpiry(cookies: StoredCookie[], host: string): Date | undefined {
  let min = Number.POSITIVE_INFINITY;
  for (const c of cookies) {
    if (!cookieDomainMatches(c.domain, host)) continue;
    if (c.expires === -1 || c.expires <= 0) continue;
    if (c.expires < min) min = c.expires;
  }
  return Number.isFinite(min) ? new Date(min * 1000) : undefined;
}
