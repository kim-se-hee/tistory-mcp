/**
 * `tistory_upload_image` — 이미지 업로드. `POST /manage/post/attach.json` multipart (fetch-first).
 *
 * 핵심 함정 (docs/api.md §5.2-5.3.1, CLAUDE.md 함정 5):
 *   - 응답 `url` 은 서명/`expires`(+15일) 박힌 만료 URL. 본문 직박 금지.
 *     기본 응답에서 빼고 `verbose:true` 일 때만 `temporaryUrl` 로 노출 (디버그용).
 *   - 영구화는 **서명 통째 포함** ref `kage@{key}/{filename}?{서명query}` 를 두 곳에 박아야 완성:
 *     ① 본문 치환자 `[##_Image|{ref}|CDM|1.3|{json}_##]`  ② 발행 body `attachments[]`.
 *     bare `kage@{key}` 또는 attachments 미등록 = orphan → GC → 404 (docs/api.md §5.3.1).
 *   - 그래서 응답에 `permanentReplacer`(본문용) + `attachmentRef`(발행 attachments 용) 둘 다 반환.
 *     LLM 은 본문에 치환자를 박고, `publish_post`/`update_post` 의 `attachments` 인자에 ref 를 넘긴다.
 *   - width/height 미지정 시 **로컬 파일 헤더에서 실픽셀 자동 추출** (에디터가 하는 동작과 동일,
 *     docs/api.md §5.3.1 의 originWidth/Height 자동 채움). 못 구하면 0×0 + `widthOrigin` 폴백 + 경고
 *     (0×0 은 목차·레이아웃에 영향). style 미지정 시 `alignCenter`.
 *   - field 이름은 `file` 만 동작 (api.ts 의 `uploadImage` 가 이미 강제).
 *   - mime 미지정 → filename 확장자로 추론. filename 미지정 → path basename.
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import { readFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildAttachmentRef,
  buildImageSubstitution,
  parseImageDimensions,
  SessionExpiredError,
  TistoryApiError,
  uploadImage,
  type ImageSubstitutionMeta,
} from "../tistory/api.js";
import { loadContext } from "../tistory/browser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 입력 스키마 (zod v4 raw shape — MCP SDK 가 .object() 로 감싼다)
// ─────────────────────────────────────────────────────────────────────────────

const inputShape = {
  blogUrl: z
    .string()
    .min(1)
    .describe(
      "블로그 host 또는 URL. 예: `saree98.tistory.com`. " +
        "keytar 에서 cookie 를 꺼낼 account 키. 미저장 host 면 session_init 안내.",
    ),
  filePath: z
    .string()
    .min(1)
    .describe("업로드할 이미지 파일의 절대 경로. 서버가 직접 읽어 multipart 로 전송."),
  filename: z
    .string()
    .optional()
    .describe("multipart 에 박을 파일명. 미지정 시 `filePath` 의 basename."),
  mime: z
    .string()
    .optional()
    .describe(
      "MIME 타입. 미지정 시 filename 확장자로 추론 (`.png`/`.jpg`/`.gif`/`.webp`/`.svg`).",
    ),
  /**
   * 치환자 json 옵션 — catalog 의 Image 치환자 디폴트 (`docs/catalog.md`).
   * width/height 는 본문 레이아웃에 사용되므로 0 이면 티스토리 렌더가 부정확할 수 있음.
   * 사용자가 모르면 0 디폴트 두고, LLM 이 알면 정확한 값을 넣도록 description 으로 유도.
   */
  width: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "치환자 `originWidth`. 본문 렌더 레이아웃 기준. " +
        "미지정 시 로컬 파일 헤더에서 실픽셀 자동 추출 (PNG/JPEG/GIF/WebP/BMP). 못 구하면 0.",
    ),
  height: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "치환자 `originHeight`. 본문 렌더 레이아웃 기준. " +
        "미지정 시 로컬 파일 헤더에서 실픽셀 자동 추출. 못 구하면 0.",
    ),
  align: z
    .enum(["alignCenter", "alignLeft", "alignRight", "widthOrigin"])
    .default("alignCenter")
    .describe("치환자 `style`. 본문 정렬 — `alignCenter` (디폴트) / `alignLeft` / `alignRight` / `widthOrigin`."),
  /**
   * 만료 URL(temporaryUrl)을 기본 노출하면 LLM·사용자가 그걸 본문에 박아 +15일 후 404
   * (docs/api.md §5.3.1). 그래서 기본 응답에서 숨기고, 디버그 필요 시에만 verbose 로 노출.
   */
  verbose: z
    .boolean()
    .default(false)
    .describe(
      "true 면 디버그용 만료 URL(`temporaryUrl`)을 응답에 포함. " +
        "기본 false — temporaryUrl 은 서명·만료(+15일) URL 이라 본문 직박 시 404 나는 함정이므로 숨깁니다.",
    ),
} as const;

type Input = {
  blogUrl: string;
  filePath: string;
  filename?: string;
  mime?: string;
  width?: number;
  height?: number;
  align: "alignCenter" | "alignLeft" | "alignRight" | "widthOrigin";
  verbose: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// 본 동작
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_IMAGE_TOOL_NAME = "tistory_upload_image";

export function registerUploadImage(server: McpServer): void {
  server.registerTool(
    UPLOAD_IMAGE_TOOL_NAME,
    {
      title: "Tistory 이미지 업로드",
      description:
        "`POST /manage/post/attach.json` 으로 이미지를 업로드합니다 (multipart, field `file`). " +
        "응답 `url` 은 서명된 URL 이라 본문에 직박하면 깨집니다. " +
        "본문에는 함께 반환하는 `permanentReplacer` 치환자를 박고, " +
        "★ 발행 시에는 `publish_post`/`update_post` 의 `attachments` 인자에 함께 반환하는 `attachmentRef` 를 반드시 넘기세요 — " +
        "둘 중 하나라도 누락하면 이미지가 orphan 으로 GC 되어 404 로 깨집니다 (docs/api.md §5.3.1). " +
        "`width`/`height`/`align` 옵션은 치환자 json 메타 (`originWidth`/`originHeight`/`style`) 에 박힙니다. " +
        "응답은 기본으로 영구 식별자(`permanentReplacer`/`attachmentRef`/`key`)만 노출하며, " +
        "서명·만료(+15일) URL 인 `temporaryUrl` 은 본문 직박 시 404 함정이라 `verbose:true` 일 때만 포함합니다. " +
        "세션 만료 시 `tistory_session_init` 재호출 안내 메시지를 반환합니다.",
      inputSchema: inputShape,
    },
    async (input) => {
      const args = input as Input;
      try {
        const ctx = await loadContext(args.blogUrl);
        if (!ctx) {
          return sessionRequired(args.blogUrl);
        }

        const res = await uploadImage(ctx, args.filePath, {
          ...(args.filename !== undefined ? { filename: args.filename } : {}),
          ...(args.mime !== undefined ? { mime: args.mime } : {}),
        });

        // width/height 둘 중 하나라도 미지정이면 로컬 파일 헤더에서 실픽셀 자동 추출
        // (에디터가 하는 동작. 0×0 으로 나가면 목차·레이아웃이 부정확해짐 — docs/api.md §5.3.1).
        let dimWarning: string | null = null;
        let style = args.align;
        let width = args.width ?? 0;
        let height = args.height ?? 0;
        if (args.width === undefined || args.height === undefined) {
          const dims = await readImageDimensions(args.filePath);
          if (dims) {
            if (args.width === undefined) width = dims.width;
            if (args.height === undefined) height = dims.height;
          } else if (args.width === undefined && args.height === undefined) {
            // 실픽셀 못 구함 → 명시 크기 없는 0×0 대신 widthOrigin 으로 폴백
            // (티스토리가 원본 크기로 렌더하도록 위임).
            style = "widthOrigin";
            dimWarning =
              "이미지 dimension 을 파일 헤더에서 읽지 못해 0×0 + `widthOrigin` 으로 폴백했습니다. " +
              "정확한 레이아웃·목차가 필요하면 `width`/`height` 를 직접 지정하세요.";
          }
        }

        const meta: ImageSubstitutionMeta = {
          originWidth: width,
          originHeight: height,
          style,
        };
        // 서명 통째 포함 ref — 본문 치환자와 발행 attachments 가 같은 문자열을 공유 (§5.3.1)
        const attachmentRef = buildAttachmentRef(res);
        const permanentReplacer = buildImageSubstitution(attachmentRef, meta);

        const payload = {
          // 사용자/LLM 이 바로 본문에 박을 영구 치환자
          permanentReplacer,
          // ★ 발행 시 publish_post/update_post 의 `attachments` 인자에 그대로 넘길 것 (영구화 필수)
          attachmentRef,
          // 치환자에 실제 박힌 dimension/style (자동 추출 결과 포함)
          originWidth: width,
          originHeight: height,
          style,
          // 업로드 응답 원본 (영구 식별자만 — url 은 서명/만료라 verbose 뒤로 숨김)
          name: res.name,
          filename: res.filename,
          key: res.key,
          size: res.size,
          // temporaryUrl 은 서명·만료(+15일) URL. 본문 직박 시 404 함정이라 기본 비노출,
          // 디버그용으로 verbose 일 때만 포함 (docs/api.md §5.3.1).
          ...(args.verbose ? { temporaryUrl: res.url } : {}),
        };

        return {
          content: [
            {
              type: "text",
              text: [
                `업로드 완료: ${res.filename} (${res.size} bytes, ${width}×${height} ${style})`,
                ...(dimWarning ? [``, `⚠ ${dimWarning}`] : []),
                ``,
                `본문 삽입용 치환자 (영구):`,
                permanentReplacer,
                ``,
                `★ 발행 시 \`publish_post\`/\`update_post\` 의 \`attachments\` 인자에 아래 ref 를 반드시 함께 넘기세요 (미등록 시 이미지 깨짐):`,
                attachmentRef,
                ``,
                ...(args.verbose
                  ? [`※ \`temporaryUrl\` 은 서명·만료(+15일) URL. 본문에 직박 금지 — 위 치환자만 사용.`, ``]
                  : []),
                `세부:`,
                JSON.stringify(payload, null, 2),
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return errorResult(err, args.blogUrl);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// dimension 자동 추출 — 헤더만 읽어 실픽셀 (deps 미추가, api.ts 의 순수 파서 사용)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 로컬 이미지 파일의 픽셀 dimension 을 헤더 파싱으로 구한다. 못 구하면 null.
 *
 * 전체 디코드가 불필요해 선두 64KB 만 읽는다 (dimension 은 항상 파일 앞부분).
 * 읽기 실패(ENOENT 등)는 호출부의 uploadImage 가 먼저 같은 경로로 터지므로 여기선 null 폴백.
 */
async function readImageDimensions(
  filePath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const buf = await readFile(filePath);
    return parseImageDimensions(buf);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 에러 직렬화 — 세션 만료는 LLM 이 곧바로 session_init 으로 분기할 수 있게 명시
// ─────────────────────────────────────────────────────────────────────────────

function sessionRequired(blogUrl: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `session required: call tistory_session_init with blogUrl="${blogUrl}". ` +
          `(저장된 cookie 가 없거나 keytar 슬롯이 비어있습니다.)`,
      },
    ],
  };
}

function errorResult(err: unknown, blogUrl: string) {
  if (err instanceof SessionExpiredError) {
    return sessionRequired(blogUrl);
  }
  if (err instanceof TistoryApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `업로드 실패 (HTTP ${err.status}): ${err.message}${err.body ? `\n응답: ${err.body.slice(0, 500)}` : ""}`,
        },
      ],
    };
  }
  // ENOENT 등 파일 시스템 에러 — readFile 실패 메시지 그대로 노출
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `업로드 실패: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}
