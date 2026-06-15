/**
 * 티스토리 관리자 cookie-auth fetch 래퍼.
 *
 * 11 endpoint 한 파일: 스킨 5 + 글 5 + 메타 1.
 * 실측 스키마/함정은 `docs/api.md` (§3~§6), 핵심 함정 요약은 `CLAUDE.md`.
 *
 * 모든 호출은 Playwright 가 한 번 발급한 cookie 만 의존 (브라우저는 `session_init` 에서만).
 * 세션 만료 시 어떤 endpoint 든 `/auth/login` 으로 302 → 단일 분기에서 `SessionExpiredError` 로 변환.
 */
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 공통 타입
// ─────────────────────────────────────────────────────────────────────────────

/** API 호출 컨텍스트. 모든 endpoint 함수의 첫 인자. */
export interface TistoryContext {
  /** 블로그 호스트. 예: `"saree98.tistory.com"` (프로토콜 없이) */
  host: string;
  /** 직렬화된 cookie 헤더 값. 예: `"TSSESSION=...; LOGIN_KAKAO=..."` */
  cookie: string;
}

/** 세션 만료 — `/auth/login` 으로 리다이렉트되거나 401 떨어졌을 때. */
export class SessionExpiredError extends Error {
  constructor(message = "Tistory session expired. Call tistory_session_init.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** API 호출 자체 실패 (4xx/5xx, 단 401·302→login 은 SessionExpiredError 로 분기). */
export class TistoryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TistoryApiError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch 래퍼 — 공통 헤더 + 만료 감지
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 공통 fetch. cookie 헤더 부착, redirect 수동 처리 (login 으로의 302 = 세션 만료).
 *
 * @param ctx 호출 컨텍스트
 * @param pathname `/manage/...` 같은 호스트 상대 경로
 * @param init fetch RequestInit. headers 는 cookie 가 자동 머지됨
 */
async function request(
  ctx: TistoryContext,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `https://${ctx.host}${pathname}`;
  const headers = new Headers(init.headers);
  headers.set("cookie", ctx.cookie);
  // 일부 endpoint 가 Origin/Referer 없으면 CSRF 비슷한 거로 막음 — 안전한 디폴트
  if (!headers.has("origin")) headers.set("origin", `https://${ctx.host}`);
  if (!headers.has("referer")) headers.set("referer", `https://${ctx.host}/manage/`);

  const res = await fetch(url, {
    ...init,
    headers,
    // 자동 follow 시 login 으로 끌려가 본문 잃음 — 수동 감지
    redirect: "manual",
  });

  // 302 → /auth/login 또는 401 = 세션 만료
  if (res.status === 401) throw new SessionExpiredError();
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    if (loc.includes("/auth/login") || loc.includes("accounts.kakao.com")) {
      throw new SessionExpiredError();
    }
    // 그 외 리다이렉트는 사실상 안 옴 — 안전망
    throw new TistoryApiError(`Unexpected redirect to ${loc}`, res.status);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TistoryApiError(
      `${init.method ?? "GET"} ${pathname} → ${res.status}`,
      res.status,
      body,
    );
  }

  return res;
}

async function requestJson<T>(
  ctx: TistoryContext,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const res = await request(ctx, pathname, { ...init, headers });
  // 일부 endpoint (POST html.json) 가 평문 (`/preview/skin?...`) 으로 응답 → 호출자가 알아서
  const text = await res.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// visibility enum 이중성 — docs/api.md §4.3
// ─────────────────────────────────────────────────────────────────────────────

/** 외부 도구가 받는 문자열 enum. */
export type VisibilityName = "private" | "protected" | "public";
/** request body 에 박는 정수. */
export type VisibilityInt = 0 | 15 | 20;
/** `/manage/posts.json` response 의 문자열. */
export type VisibilityResponse = "PRIVATE" | "PROTECTED" | "PUBLIC";

const VIS_NAME_TO_INT: Record<VisibilityName, VisibilityInt> = {
  private: 0,
  protected: 15,
  public: 20,
};
const VIS_INT_TO_NAME: Record<VisibilityInt, VisibilityName> = {
  0: "private",
  15: "protected",
  20: "public",
};
const VIS_RESPONSE_TO_NAME: Record<VisibilityResponse, VisibilityName> = {
  PRIVATE: "private",
  PROTECTED: "protected",
  PUBLIC: "public",
};

export function visibilityToInt(v: VisibilityName): VisibilityInt {
  return VIS_NAME_TO_INT[v];
}
export function visibilityFromInt(v: VisibilityInt): VisibilityName {
  return VIS_INT_TO_NAME[v];
}
export function visibilityFromResponse(v: VisibilityResponse): VisibilityName {
  return VIS_RESPONSE_TO_NAME[v];
}

// ─────────────────────────────────────────────────────────────────────────────
// 메타 1: window.Config 추출 — docs/api.md §2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `window.Config = { ... };` 의 우변 객체 리터럴 문자열을 끝까지 추출.
 * 문자열·정규식·주석 안의 중괄호는 카운트에서 제외해야 함.
 * 못 찾으면 null.
 */
function extractWindowConfigObject(html: string): string | null {
  const startMatch = html.match(/window\.Config\s*=\s*\{/);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index + startMatch[0].length - 1; // '{' 위치
  let depth = 0;
  let i = start;
  // 모드: code | sq (single quote) | dq (double quote) | tpl (template) | re (regex) | lc (line comment) | bc (block comment)
  type Mode = "code" | "sq" | "dq" | "tpl" | "re" | "lc" | "bc";
  let mode: Mode = "code";
  for (; i < html.length; i++) {
    const c = html[i];
    const next = html[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "lc";
        i++;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "bc";
        i++;
        continue;
      }
      if (c === '"') {
        mode = "dq";
        continue;
      }
      if (c === "'") {
        mode = "sq";
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          return html.slice(start, i + 1);
        }
      }
    } else if (mode === "sq") {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "'") mode = "code";
    } else if (mode === "dq") {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') mode = "code";
    } else if (mode === "tpl") {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") mode = "code";
    } else if (mode === "lc") {
      if (c === "\n") mode = "code";
    } else if (mode === "bc") {
      if (c === "*" && next === "/") {
        mode = "code";
        i++;
      }
    } else if (mode === "re") {
      // 사용 안 함 — 객체 리터럴에 정규식 등장 가능하나 보수적으로 무시
    }
  }
  return null;
}


/**
 * `window.Config.blog` 의 일부 — 도구가 실제로 쓰는 필드만 타입화. 나머지는 unknown 으로 통과.
 *
 * 실측 (2026-05, saree98.tistory.com): top-level 에 `blogId`/`user` 는 더 이상 박히지 않음.
 * `blogId` 는 `blogSettings.blogId` (string) 에서 읽고, 유저 정보는 admin 페이지의 별도 키워드
 * (`top.tistoryUser` 등) 로 옮겨갔거나 제거됨. 호출부는 `getBlogId(blog)` 헬퍼를 사용할 것.
 */
export interface BlogConfig {
  /** 블로그 도메인 (예: `saree98.tistory.com`) */
  domain?: string;
  /** 커스텀 도메인 (없으면 빈 문자열) */
  customDomain?: string;
  /** 블로그 제목 */
  title?: string;
  /** admin 진입 URL (`/manage`) */
  manageUrl?: string;
  categories: unknown[];
  blogSettings: Record<string, unknown> & { blogId?: string | number };
  activePlugins: string[];
  /** 22개 전체 플러그인 메타 (`activePlugins` 는 active 만 추린 string[]) */
  plugins?: unknown[];
  skinInfo: Record<string, unknown>;
  created: string;
  visibility?: string;
  visibilityType?: string;
  useMobileSkin?: string | boolean;
  cclCommercial?: number;
  cclDerive?: number;
  useMobile?: string | boolean;
  /** 알려지지 않은 필드는 통과 */
  [key: string]: unknown;
}

/**
 * `Config.blog.blogSettings.blogId` 에서 숫자 blogId 추출. 없으면 null.
 * 응답에선 문자열로 박혀있어 호출부가 매번 parseInt 하지 않도록 헬퍼화.
 */
export function getBlogId(blog: BlogConfig): number | null {
  const raw = blog.blogSettings?.blogId;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 어떤 `/manage/*` HTML 페이지든 GET → inline `window.Config` 파싱.
 * `/manage/category` 가 가장 가벼우면서 안정적 (docs/api.md §2.1).
 *
 * SPA fallback HTML (~13140 bytes) 가 떨어져도 `window.Config.blog` 는 동일하게 박혀있음.
 */
export async function fetchBlogConfig(
  ctx: TistoryContext,
  pathname = "/manage/category",
): Promise<BlogConfig> {
  const res = await request(ctx, pathname, {
    headers: { accept: "text/html" },
  });
  const html = await res.text();
  // 실측: 응답은 순수 JSON 이 아니라 JS 객체 리터럴 (unquoted key) 이라 `JSON.parse` 가
  // line2 col7 에서 깨짐. 또한 객체 안에 `};` 가 박혀있으면 non-greedy 정규식이 중간에서
  // 잘리므로, `window.Config =` 시작 지점부터 중괄호 밸런스로 객체를 끝까지 추출한 뒤
  // `Function` 생성자로 평가한다 (응답은 이미 cookie 인증으로 가져온 신뢰 출처).
  const obj = extractWindowConfigObject(html);
  if (!obj) {
    throw new TistoryApiError(
      `window.Config not found in ${pathname}`,
      res.status,
      html.slice(0, 200),
    );
  }
  let config: { blog: BlogConfig };
  try {
    config = new Function(`return (${obj});`)() as { blog: BlogConfig };
  } catch (err) {
    throw new TistoryApiError(
      `window.Config parse failed: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      obj.slice(0, 200),
    );
  }
  if (!config.blog) {
    throw new TistoryApiError("window.Config.blog missing", res.status);
  }
  return config.blog;
}

// ─────────────────────────────────────────────────────────────────────────────
// 글 5: posts.json / post.json POST/PUT/DELETE / attach.json
// docs/api.md §4, §5
// ─────────────────────────────────────────────────────────────────────────────

/** `/manage/posts.json` 의 item 한 건. docs/api.md §3.2. */
export interface PostListItem {
  id: string;
  author: string;
  authorId: string;
  slogan: string;
  title: string;
  visibility: VisibilityResponse;
  category: string;
  categoryId: string;
  serviceCategory: string | null;
  serviceCategoryId: string | null;
  published: string;
  created: string;
  modified: string;
  reservedDate: string | null;
  statusLabel: string;
  postPassword: string;
  hasFile: boolean;
  permalink: string;
  isRestrict: boolean;
  restrictLabel: string | null;
  restrictType: string | null;
  restrictMessage: string | null;
  countOfComments: string;
  editable: boolean;
  isScheduled: boolean;
  categoryVisibility: "PUBLIC" | null;
}

export interface ListPostsParams {
  /** `-3` = 전체. categoryId 정수면 필터. 기본 `-3`. */
  category?: number | "-3";
  page?: number;
  searchKeyword?: string;
  /** `title` / `content` / `all`. 기본 `title`. */
  searchType?: "title" | "content" | "all";
  /** `all` / `public` / `private` / `protected`. 기본 `all`. */
  visibility?: "all" | VisibilityName;
}

/** `GET /manage/posts.json` — 글 목록 (풍부 메타). */
export async function listPosts(
  ctx: TistoryContext,
  params: ListPostsParams = {},
): Promise<{ items: PostListItem[]; [key: string]: unknown }> {
  const q = new URLSearchParams({
    category: String(params.category ?? -3),
    page: String(params.page ?? 1),
    searchKeyword: params.searchKeyword ?? "",
    searchType: params.searchType ?? "title",
    visibility: params.visibility ?? "all",
  });
  return requestJson(ctx, `/manage/posts.json?${q.toString()}`);
}

/**
 * POST/PUT 공통 body. `visibility` 는 정수 (docs/api.md §4.2/§4.3).
 *
 * 외부 도구는 보통 문자열 enum 을 받아 `visibilityToInt` 로 변환 후 박는다.
 */
export interface PostBody {
  /** 신규 = `"0"`, 수정 = `String(id)`. **사실상 무시됨** — 진실은 URL path. */
  id: string;
  title: string;
  /** 마크다운 또는 HTML. 서버는 HTML 정규화만 보관 (마크다운 원본 복원 불가). */
  content: string;
  /** 빈 문자열이면 서버 자동 생성. */
  slogan: string;
  visibility: VisibilityInt;
  /** categoryId 정수. `0` = 카테고리 없음. */
  category: number;
  /** 콤마 구분 태그. */
  tag: string;
  /** `1` = 발행, `0` = 임시저장 (추정). */
  published: 0 | 1;
  /** 보호글 비밀번호. 그 외엔 서버 토큰 채워서 보내야 함 — 빈 문자열도 동작. */
  password: string;
  uselessMarginForEntry: 0 | 1;
  cclCommercial: 0 | 1;
  cclDerive: 0 | 1;
  type: "post" | "page";
  /**
   * 영구화할 이미지 ref 배열 (`buildAttachmentRef` 결과). 본문 치환자의 kage 값과 글자 단위 동일.
   * 미등록 시 orphan → GC → 404 (docs/api.md §5.3.1). 이미지 없는 글은 `[]`.
   */
  attachments: string[];
  recaptchaValue: string;
  draftSequence: number | null;
  totalWritingTimeMs: number;
}

/** 발행/수정 응답 — `entryUrl` 에서 postId 추출. */
export interface PostResponse {
  /** post: `https://{host}/{id}`. page: `https://{host}/pages/{slogan}`. */
  entryUrl: string;
}

/** PostBody 의 디폴트. 도구가 일부 필드만 신경 쓰면 되도록. */
function defaultPostBody(): PostBody {
  return {
    id: "0",
    title: "",
    content: "",
    slogan: "",
    visibility: 0,
    category: 0,
    tag: "",
    published: 1,
    password: "",
    uselessMarginForEntry: 1,
    cclCommercial: 0,
    cclDerive: 0,
    type: "post",
    attachments: [],
    recaptchaValue: "",
    draftSequence: null,
    totalWritingTimeMs: 0,
  };
}

/**
 * `POST /manage/post.json` — 신규 발행. docs/api.md §4.1.
 *
 * ★ body 의 `id` 도 query `?id=` 도 무시됨. POST 는 항상 신규. 수정은 `updatePost`.
 *
 * @returns `{ entryUrl, postId }`. `postId` 는 post 일 때만 숫자, page 면 slogan.
 */
export async function publishPost(
  ctx: TistoryContext,
  fields: Partial<PostBody>,
): Promise<{ entryUrl: string; postId: string }> {
  const body: PostBody = { ...defaultPostBody(), ...fields, id: "0" };
  const { entryUrl } = await requestJson<PostResponse>(ctx, "/manage/post.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const postId = entryUrl.split("/").pop() ?? "";
  return { entryUrl, postId };
}

/**
 * `PUT /manage/post/{id}.json` — 수정. docs/api.md §4.1.
 *
 * path 의 `{id}` 가 진실. body 의 `id` 는 일관성 위해 같이 박지만 서버는 무시.
 */
export async function updatePost(
  ctx: TistoryContext,
  postId: string | number,
  fields: Partial<PostBody>,
): Promise<{ entryUrl: string }> {
  const idStr = String(postId);
  const body: PostBody = { ...defaultPostBody(), ...fields, id: idStr };
  return requestJson<PostResponse>(ctx, `/manage/post/${idStr}.json`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `DELETE /manage/post/{id}.json`. docs/api.md §4.1. */
export async function deletePost(
  ctx: TistoryContext,
  postId: string | number,
): Promise<{ data: { id: number } }> {
  return requestJson(ctx, `/manage/post/${String(postId)}.json`, {
    method: "DELETE",
  });
}

/** 이미지 업로드 응답 — docs/api.md §5.2. */
export interface ImageUploadResponse {
  name: string;
  /**
   * 서명 URL — `expires` 박힘 (실측 발행 +15일). 본문엔 직박 금지.
   * 영구화 치환자/attachments 는 이 url 의 서명 query 까지 통째로 박는다 (`buildAttachmentRef`).
   */
  url: string;
  /** kakao 자산 reference. 치환자엔 단독이 아니라 `key/{filename}?{서명query}` 형태로 박힘 (§5.3). */
  key: string;
  filename: string;
  size: number;
}

/**
 * `POST /manage/post/attach.json` — 이미지 업로드 (multipart, field 이름 `file` 만 동작).
 * docs/api.md §5.
 *
 * ★ 업로드만 하면 orphan → GC → 404. 영구화는 두 곳에 **서명 통째 포함 ref** 를 박아야 완성:
 *   1) 본문 치환자: `[##_Image|{attachmentRef}|CDM|1.3|{json}_##]`
 *   2) 발행 body `attachments`: `[attachmentRef]` (치환자 kage 값과 글자 단위 동일)
 *   `buildAttachmentRef` → `buildImageSubstitution` helper 참조 (docs/api.md §5.3-5.3.1).
 */
export async function uploadImage(
  ctx: TistoryContext,
  filePath: string,
  opts: { filename?: string; mime?: string } = {},
): Promise<ImageUploadResponse> {
  const data = await readFile(filePath);
  const filename = opts.filename ?? path.basename(filePath);
  const mime = opts.mime ?? guessMime(filename);

  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);

  return requestJson<ImageUploadResponse>(ctx, "/manage/post/attach.json", {
    method: "POST",
    // multipart boundary 는 fetch 가 FormData 보고 자동 설정 — content-type 지정 금지
    body: fd,
  });
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/** 이미지 픽셀 dimension. docs/api.md §5.3 (에디터는 실픽셀을 자동 채움). */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * 이미지 바이트의 헤더만 파싱해 픽셀 width/height 추출. PNG/JPEG/GIF/WebP/BMP 지원.
 * 못 알아내면 null (포맷 미지원·헤더 손상).
 *
 * ★ 새 의존성(sharp 등) 없이 magic bytes 만으로 해결 — package.json 은 이 모듈 소유 밖.
 * dimension 은 보통 파일 선두 수십~수백 바이트에 박혀 있어 전체 디코드가 불필요하다.
 */
export function parseImageDimensions(buf: Buffer): ImageDimensions | null {
  // PNG: \x89PNG\r\n\x1a\n + IHDR(13B) → offset 16 width / 20 height (BE)
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a" → offset 6 width / 8 height (LE, 16bit)
  if (
    buf.length >= 10 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP: "BM" → offset 18 width / 22 height (LE, 32bit; height 음수면 top-down)
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const w = buf.readInt32LE(18);
    const h = buf.readInt32LE(22);
    return { width: Math.abs(w), height: Math.abs(h) };
  }

  // WebP: "RIFF"...."WEBP" + chunk (VP8 / VP8L / VP8X) — 세 변형 헤더가 제각각
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return parseWebpDimensions(buf);
  }

  // JPEG: SOI 0xFFD8 → SOF 마커까지 세그먼트 스킵
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
    return parseJpegDimensions(buf);
  }

  return null;
}

function parseWebpDimensions(buf: Buffer): ImageDimensions | null {
  const fmt = buf.toString("ascii", 12, 16);
  if (fmt === "VP8 ") {
    // lossy: frame tag(3B) 뒤 0x9d012a sync → width/height 14bit LE
    if (buf.length < 30) return null;
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { width: w, height: h };
  }
  if (fmt === "VP8L") {
    // lossless: 0x2f signature 뒤 28bit 에 (w-1)14bit | (h-1)14bit 패킹
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21] ?? 0;
    const b1 = buf[22] ?? 0;
    const b2 = buf[23] ?? 0;
    const b3 = buf[24] ?? 0;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (fmt === "VP8X") {
    // extended: offset 24 부터 width-1 / height-1 각 24bit LE
    if (buf.length < 30) return null;
    const width = 1 + (buf.readUIntLE(24, 3));
    const height = 1 + (buf.readUIntLE(27, 3));
    return { width, height };
  }
  return null;
}

function parseJpegDimensions(buf: Buffer): ImageDimensions | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1] ?? 0;
    // SOF0..SOF15 (0xC0~0xCF) 중 DHT(C4)/DNL(C8)/DAC(CC) 제외 = 실제 frame 헤더
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // SOF: marker(2) + len(2) + precision(1) + height(2) + width(2)
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    // 그 외 세그먼트는 length 만큼 스킵 (length 는 marker 직후 2B BE, 자신 포함)
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return null;
    i += 2 + segLen;
  }
  return null;
}

/** 본문 삽입용 이미지 정렬/크기 메타. docs/api.md §5.3. */
export interface ImageSubstitutionMeta {
  originWidth: number;
  originHeight: number;
  style?: "alignCenter" | "alignLeft" | "alignRight" | "widthOrigin";
}

/**
 * 업로드 응답 → 영구화 ref `kage@{key}/{filename}?{서명query}`. docs/api.md §5.3-5.3.1.
 *
 * ★ 이 문자열이 영구화의 단위. 본문 치환자의 kage 값과 발행 body `attachments[]` 원소가
 * **글자 단위로 동일**해야 한다 (둘 다 이 함수 결과를 쓸 것). bare `kage@{key}` 는 무서명 404.
 *
 * 서명 query 는 attach.json 의 `url` 그대로 가져오되, post.json body 가 HTML 컨텍스트라
 * `&` 를 `&amp;` 로 인코딩한다 (실측 fixture `publish-with-image-body.json`).
 */
export function buildAttachmentRef(upload: ImageUploadResponse): string {
  // url 의 query (서명 포함) 만 추출 — host·`/dna/` path 는 버리고 kage@ prefix 로 치환
  const search = new URL(upload.url).search; // 선두 '?' 포함
  const encoded = search.replace(/&/g, "&amp;");
  return `kage@${upload.key}/${upload.filename}${encoded}`;
}

/**
 * 영구화 ref 를 본문에 박을 치환자로 감싼다. docs/api.md §5.3.
 *
 * @param attachmentRef `buildAttachmentRef` 결과. 발행 시 `attachments[]` 에도 동일 문자열 등록 필수.
 *
 * ★ 실 캡처 JSON 에는 `filename` 키 없음 — `originWidth/originHeight/style` 만 박는다.
 */
export function buildImageSubstitution(
  attachmentRef: string,
  meta: ImageSubstitutionMeta,
): string {
  const json = JSON.stringify({
    originWidth: meta.originWidth,
    originHeight: meta.originHeight,
    style: meta.style ?? "alignCenter",
  });
  return `[##_Image|${attachmentRef}|CDM|1.3|${json}_##]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 스킨 5: html.json GET/POST, current.json, settings.json, preview/skin/{page}
// docs/api.md §6
// ─────────────────────────────────────────────────────────────────────────────

export interface SkinFile {
  filename: string;
  url: string;
  label: string;
  size: number;
}

/** `GET /manage/design/skin/html.json` 응답. docs/api.md §6.1. */
export interface SkinSource {
  skinname: string;
  html: string;
  css: string;
  files: { list: SkinFile[]; totalSize: number };
}

/** `GET /manage/design/skin/html.json` — 현재 적용된 스킨 소스 + 파일 리스트. */
export async function getSkin(ctx: TistoryContext): Promise<SkinSource> {
  return requestJson(ctx, "/manage/design/skin/html.json");
}

/**
 * `POST /manage/design/skin/html.json` — 스킨 적용.
 *
 * ★ `isPreview: true` 는 안전한 dry-run (라이브 미반영).
 *   `isPreview: false` 는 즉시 라이브 발효 (docs/api.md §6.2).
 *
 * 응답은 평문 `/preview/skin?skin=customize/{blogId}` URL 1줄 — JSON 아님.
 */
export async function applySkin(
  ctx: TistoryContext,
  body: { html: string; css: string; isPreview?: boolean },
): Promise<string> {
  const res = await request(ctx, "/manage/design/skin/html.json", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/plain,application/json" },
    body: JSON.stringify({
      html: body.html,
      css: body.css,
      isPreview: body.isPreview ?? false,
    }),
  });
  return (await res.text()).trim();
}

/** 변수 그룹 정의 — `current.json` 응답의 일부. */
export interface VariableGroup {
  name: string;
  label?: string;
  variables: unknown[];
  [key: string]: unknown;
}

/** `GET /manage/design/skin/current.json` 응답. docs/api.md §6.1. */
export interface SkinCurrent {
  skin: {
    name: string;
    title: string;
    version: string;
    description?: string;
    variables?: unknown;
    [key: string]: unknown;
  };
  home: unknown;
  skinSettings: Record<string, string>;
  variableGroups: VariableGroup[];
  variableSettings: Record<string, string>;
  [key: string]: unknown;
}

/** `GET /manage/design/skin/current.json` — 메타 + 변수 정의 + 현재 설정 스냅샷. */
export async function getSkinCurrent(ctx: TistoryContext): Promise<SkinCurrent> {
  return requestJson(ctx, "/manage/design/skin/current.json");
}

/** `POST /manage/design/skin/settings.json` body. 4 필드 full snapshot — `isDirty` 없음. */
export interface SkinSettingsBody {
  skinSettings: Record<string, string>;
  variableSettings: Record<string, string>;
  /** `"NONE"` / 또는 커버 홈타입. */
  homeType: string;
  coverSettings: unknown[];
}

/**
 * `POST /manage/design/skin/settings.json` — 변수/기본설정/홈타입/커버 적용.
 * 부분 패치 흉내내려면 `getSkinCurrent` 로 받아서 머지 후 전체 박아라 (docs/api.md §6.1).
 */
export async function applySkinSettings(
  ctx: TistoryContext,
  body: SkinSettingsBody,
): Promise<void> {
  await request(ctx, "/manage/design/skin/settings.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** preview 페이지 enum. docs/api.md §6.3. */
export type PreviewPage = "index" | "entry" | "category" | "tag" | "guestbook";

/** preview body — `isDirty` 포함. html/css 안 받음 (라이브 코드 기반). */
export interface PreviewBody {
  skinSettings: Record<string, string>;
  variableSettings: Record<string, string>;
  homeType: string;
  coverSettings: unknown[];
  /** 변경된 settings 가 라이브에 미적용이면 `true`. */
  isDirty?: boolean;
}

/**
 * `POST /preview/skin/{page}` — 서버 렌더 풀 HTML. docs/api.md §6.3-§6.4.
 *
 * ★ body 가 html/css 를 안 받음 — 라이브 코드 기반. 변경된 코드 dry-run 하려면
 *   `applySkin({ isPreview:false })` 즉시 적용 → preview fetch → 백업 복구 trade-off.
 */
export async function previewSkin(
  ctx: TistoryContext,
  page: PreviewPage,
  body: PreviewBody,
): Promise<string> {
  const res = await request(ctx, `/preview/skin/${page}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/html" },
    body: JSON.stringify({
      skinSettings: body.skinSettings,
      variableSettings: body.variableSettings,
      homeType: body.homeType,
      coverSettings: body.coverSettings,
      isDirty: body.isDirty ?? false,
    }),
  });
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// 카테고리 1: GET/PUT /manage/category.json (batch CRUD)
// docs/api.md §3.3, §3.6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/manage/category.json` GET 응답의 트리 노드. 재귀 구조.
 * docs/api.md §3.3.
 *
 * - `id` — categoryId 정수. 신규는 `-1` (응답엔 안 박힘 — request 전용)
 * - `name` — 현재 이름
 * - `label` — 표시용 라벨. PUT update body 에선 **변경 전 이름** 보존 (§3.6)
 * - `priority` — 같은 부모 안에서의 순서 (0-based)
 * - `entries` — 카테고리에 속한 글 수. > 0 이면 UI 가 삭제 disable
 * - `visibility` — 정수 enum (0/15/20, §4.3 와 동일)
 * - `parent` — 0 = 루트, 아니면 부모 categoryId
 * - `viewChannel` — 홈주제 id (string) 또는 null
 * - `depth` — 1 = 루트, 2 = 하위
 * - `leaf` — children 비었으면 true
 * - `opened` — UI 펼침 상태 (PUT 시에도 그대로 박는다)
 * - `categoryInfo` — `{ liststyle, image, description }` (관리 화면용)
 */
export interface CategoryNode {
  id: number;
  name: string;
  label: string;
  priority: number;
  entries: number;
  visibility: VisibilityInt;
  parent: number;
  viewChannel: string | null;
  depth: number;
  leaf: boolean;
  opened: boolean;
  categoryInfo: { liststyle?: string; image?: string; description?: string };
  children: CategoryNode[];
  /** 알려지지 않은 필드는 통과 (서버가 추가 필드 박을 수 있음). */
  [key: string]: unknown;
}

/** `GET /manage/category.json` 응답. docs/api.md §3.3. */
export interface CategoryGetResponse {
  /** 루트 라벨 — PUT body 에 그대로 echo 함. */
  rootLabel: string;
  categories: CategoryNode[];
  /** 홈주제 enum (라이프/여행맛집/...). 글 발행 시 `serviceCategoryId` 후보. */
  viewChannels?: unknown[];
  settingSelected?: unknown;
  settingOptionList?: unknown;
  [key: string]: unknown;
}

/** `PUT /manage/category.json` 응답. docs/api.md §3.6 (GET 과 키 이름 다름 — `categoryTree`). */
export interface CategoryPutResponse {
  categoryTree: CategoryNode[];
  [key: string]: unknown;
}

/** `GET /manage/category.json` — 현재 카테고리 트리 + 메타. */
export async function getCategories(
  ctx: TistoryContext,
): Promise<CategoryGetResponse> {
  return requestJson(ctx, "/manage/category.json");
}

/**
 * `PUT /manage/category.json` body — 3-array diff. docs/api.md §3.6.
 *
 * **함정:**
 *   - `delete` 는 **id 정수 배열만**. 객체 보내면 500
 *   - `append` 는 `id: -1`, `isNew: true`, `updatedData: true` 필드 셋
 *   - `update` 는 `label` 필드에 **변경 전 이름** 보존, `updatedData: false`
 *   - UI 흐름 관찰: 신규 추가 시 `append` 와 `update` 두 배열에 같은 객체가 동시 등장 —
 *     도구 구현도 동일하게 미러링 (서버 검증 정확한 트리거 미실측, safer)
 */
export interface CategoryPutBody {
  rootLabel: string;
  /** 삭제할 카테고리 id 정수 배열. 객체 금지. */
  delete: number[];
  /** 신규 카테고리. `id:-1, isNew:true, updatedData:true` 필수. */
  append: CategoryAppendItem[];
  /** 수정할 카테고리. `label` 에 변경 전 이름, `updatedData:false`. append 와 동일 객체도 동시 포함. */
  update: CategoryUpdateItem[];
}

/** PUT `append[]` 각 객체. docs/api.md §3.6. */
export interface CategoryAppendItem {
  id: -1;
  name: string;
  children: CategoryAppendItem[];
  depth: number;
  opened: boolean;
  priority: number;
  visibility: VisibilityInt;
  parent: number;
  viewChannel: string | null;
  entries: 0;
  categoryInfo: Record<string, unknown>;
  isNew: true;
  updatedData: true;
}

/** PUT `update[]` 각 객체. docs/api.md §3.6. */
export interface CategoryUpdateItem {
  id: number;
  name: string;
  /** ★ 변경 전 이름 (이름 변경이 없으면 현재 이름 그대로). */
  label: string;
  priority: number;
  entries: number;
  visibility: VisibilityInt;
  viewChannel: string | null;
  children: CategoryUpdateItem[];
  leaf: boolean;
  categoryInfo: { liststyle?: string; image?: string; description?: string };
  depth: number;
  parent: number;
  opened: boolean;
  updatedData: false;
  /** append 와 동시 등장하는 신규 객체 한정. */
  isNew?: true;
}

/**
 * `PUT /manage/category.json` — 카테고리 batch CRUD. docs/api.md §3.6.
 *
 * 응답의 키 이름은 GET (`categories`) 과 달리 **`categoryTree`** — 둘 다 같은 노드 구조.
 * delete-only / append-only 도 빈 배열 채워서 보내야 함 (3 필드 전부 필수).
 */
export async function putCategories(
  ctx: TistoryContext,
  body: CategoryPutBody,
): Promise<CategoryPutResponse> {
  return requestJson<CategoryPutResponse>(ctx, "/manage/category.json", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
