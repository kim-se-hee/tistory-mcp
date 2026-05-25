/**
 * `tistory_upload_image` — 이미지 업로드. `POST /manage/post/attach.json` multipart (fetch-first).
 *
 * 핵심 함정 (docs/api.md §5.2-5.3, CLAUDE.md 함정 5):
 *   - 응답 `url` 은 서명/`expires` 박힌 임시 URL (~5일 후 만료).
 *     본문에 직박으면 깨지므로 영구는 `key` 기반 치환자로 박는다:
 *     `[##_Image|kage@{key}|CDM|1.3|{json}_##]` (docs/catalog.md 의 Image 치환자).
 *   - 도구 응답은 ready-to-paste 치환자 (`permanentReplacer`) 를 같이 반환 — LLM 이 본문에
 *     그대로 박을 수 있게. width/height/style 미지정 시 catalog 디폴트 (`alignCenter`, 0×0).
 *   - field 이름은 `file` 만 동작 (api.ts 의 `uploadImage` 가 이미 강제).
 *   - mime 미지정 → filename 확장자로 추론. filename 미지정 → path basename.
 *
 * 등록 (`src/index.ts` 의 `server.registerTool`) 은 별도 도구 통합 todo 에서.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildImageSubstitution,
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
    .describe("치환자 `originWidth`. 본문 렌더 레이아웃 기준. 미지정 시 0 (티스토리가 추정)."),
  height: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("치환자 `originHeight`. 본문 렌더 레이아웃 기준. 미지정 시 0 (티스토리가 추정)."),
  align: z
    .enum(["alignCenter", "alignLeft", "alignRight", "widthOrigin"])
    .default("alignCenter")
    .describe("치환자 `style`. 본문 정렬 — `alignCenter` (디폴트) / `alignLeft` / `alignRight` / `widthOrigin`."),
} as const;

type Input = {
  blogUrl: string;
  filePath: string;
  filename?: string;
  mime?: string;
  width?: number;
  height?: number;
  align: "alignCenter" | "alignLeft" | "alignRight" | "widthOrigin";
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
        "응답 `url` 은 서명된 임시 URL 이며 약 5일 후 만료되므로 본문에 직박으면 깨집니다. " +
        "영구 보관·본문 삽입은 함께 반환하는 `permanentReplacer` (치환자 " +
        "`[##_Image|kage@{key}|CDM|1.3|{json}_##]`) 를 그대로 사용하세요. " +
        "`width`/`height`/`align` 옵션은 치환자 json 메타 (`originWidth`/`originHeight`/`style`) 에 박힙니다. " +
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

        const meta: ImageSubstitutionMeta = {
          originWidth: args.width ?? 0,
          originHeight: args.height ?? 0,
          style: args.align,
          // 치환자 json 의 filename 은 응답 filename 을 따라간다 (UI 자동저장과 동일)
          filename: res.filename,
        };
        const permanentReplacer = buildImageSubstitution(res.key, meta);

        const payload = {
          // 사용자/LLM 이 바로 본문에 박을 영구 치환자
          permanentReplacer,
          // 업로드 응답 원본 (url 은 ~5일 만료 — 본문엔 박지 말 것)
          name: res.name,
          filename: res.filename,
          key: res.key,
          size: res.size,
          temporaryUrl: res.url,
        };

        return {
          content: [
            {
              type: "text",
              text: [
                `업로드 완료: ${res.filename} (${res.size} bytes)`,
                ``,
                `본문 삽입용 치환자 (영구):`,
                permanentReplacer,
                ``,
                `※ \`temporaryUrl\` 은 서명된 URL 로 약 5일 후 만료. 본문에 직박 금지 — 위 치환자만 사용.`,
                ``,
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
