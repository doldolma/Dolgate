import type { AiAttachment } from "@shared";
import { redactAiContext } from "./ai-context-redact";
import { hasBinaryExtension } from "./file-detection";

// AI 채팅 첨부 처리. 순수 로직(검증·base64·텍스트 파이프라인)은 canvas 없이 단위테스트
// 가능하게 분리하고, 이미지 재인코딩(canvas/createImageBitmap)만 주입 가능한 경계로 둔다.

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_TEXT_ATTACHMENTS = 4;
export const MAX_IMAGE_LONG_EDGE = 1568;
// Anthropic 이미지 하드 리밋 5MB — 재인코딩 결과가 이 아래로 들어오도록 여유를 둔다.
export const MAX_IMAGE_DECODED_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_CHARS = 32_000;

const BINARY_SNIFF_BYTES = 8 * 1024;
const JPEG_QUALITY = 0.85;
const FALLBACK_LONG_EDGE = 1024;

export type ImageAttachment = Extract<AiAttachment, { kind: "image" }>;
export type TextAttachment = Extract<AiAttachment, { kind: "text" }>;

export interface AttachmentRejection {
  name: string;
  reason: string;
}

export interface ProcessResult {
  accepted: AiAttachment[];
  rejected: AttachmentRejection[];
}

// 첫 8KB 안에 NUL 이 있으면 바이너리로 간주(에디터/SSH 쪽과 동일한 관례).
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

// MB급 버퍼를 String.fromCharCode(...spread) 하면 스택이 터지므로 청크로 나눠 인코딩.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8 * 1024;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64DecodedBytes(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Blob.arrayBuffer 는 jsdom(테스트 환경)에 없어 FileReader 로 폴백한다. 런타임(Chromium)은 전자를 쓴다.
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

// 텍스트 첨부 생성: redact → truncate. 빈 파일도 수용한다([첨부 파일: name] 마커가
// 병합 텍스트를 비지 않게 유지하므로 빈 블록 위험이 없다).
export function buildTextAttachment(name: string, raw: string): TextAttachment {
  let text = redactAiContext(raw);
  if (text.length > MAX_TEXT_ATTACHMENT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n…(파일이 잘렸습니다)`;
  }
  return { kind: "text", name, text };
}

// 현재 첨부 목록 기준으로 kind 를 하나 더 받을 수 있는지. 불가면 사용자에게 보여줄 사유를 돌려준다.
export function attachmentCapacityError(current: AiAttachment[], kind: AiAttachment["kind"]): string | null {
  const count = current.filter((attachment) => attachment.kind === kind).length;
  if (kind === "image" && count >= MAX_IMAGE_ATTACHMENTS) {
    return `이미지는 한 번에 최대 ${MAX_IMAGE_ATTACHMENTS}장까지 첨부할 수 있습니다.`;
  }
  if (kind === "text" && count >= MAX_TEXT_ATTACHMENTS) {
    return `텍스트 파일은 한 번에 최대 ${MAX_TEXT_ATTACHMENTS}개까지 첨부할 수 있습니다.`;
  }
  return null;
}

export interface ImageEncoding {
  mediaType: "image/png" | "image/jpeg";
  quality?: number;
}

// PNG(스크린샷 — 텍스트 선명도 유지)는 PNG 로, 그 외는 JPEG 로 재인코딩.
export function pickImageEncoding(sourceMime: string): ImageEncoding {
  if (sourceMime === "image/png") {
    return { mediaType: "image/png" };
  }
  return { mediaType: "image/jpeg", quality: JPEG_QUALITY };
}

export type ImageEncoder = (file: Blob, sourceMime: string) => Promise<ImageAttachment | null>;

// canvas 경계: 다운스케일 + 재인코딩. 크기 초과 시 JPEG → 1024px 순으로 폴백, 그래도 초과면 null.
export async function encodeImage(file: Blob, sourceMime: string): Promise<ImageAttachment | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const attempts: Array<{ longEdge: number; encoding: ImageEncoding }> = [
      { longEdge: MAX_IMAGE_LONG_EDGE, encoding: pickImageEncoding(sourceMime) },
      { longEdge: MAX_IMAGE_LONG_EDGE, encoding: { mediaType: "image/jpeg", quality: JPEG_QUALITY } },
      { longEdge: FALLBACK_LONG_EDGE, encoding: { mediaType: "image/jpeg", quality: JPEG_QUALITY } },
    ];
    for (const attempt of attempts) {
      const base64 = await renderToBase64(bitmap, attempt.longEdge, attempt.encoding);
      if (base64 && base64DecodedBytes(base64) <= MAX_IMAGE_DECODED_BYTES) {
        return { kind: "image", mediaType: attempt.encoding.mediaType, dataBase64: base64 };
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

async function renderToBase64(
  bitmap: ImageBitmap,
  maxLongEdge: number,
  encoding: ImageEncoding,
): Promise<string | null> {
  const scale = Math.min(1, maxLongEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, encoding.mediaType, encoding.quality);
  });
  if (!blob) {
    return null;
  }
  return bytesToBase64(await readBlobBytes(blob));
}

// 파일 목록을 첨부로 변환. 이미지 → 다운스케일 파이프라인, 그 외 → 텍스트 파이프라인(바이너리 거부).
// current + 이번에 수용된 것 기준으로 개수 상한을 순서대로 적용한다.
export async function processAttachmentFiles(
  files: File[],
  current: AiAttachment[],
  encode: ImageEncoder = encodeImage,
): Promise<ProcessResult> {
  const accepted: AiAttachment[] = [];
  const rejected: AttachmentRejection[] = [];
  const pool = () => [...current, ...accepted];

  for (const file of files) {
    const name = file.name || "clipboard-image";
    if (file.type.startsWith("image/")) {
      const capacityError = attachmentCapacityError(pool(), "image");
      if (capacityError) {
        rejected.push({ name, reason: capacityError });
        continue;
      }
      try {
        const image = await encode(file, file.type);
        if (!image) {
          rejected.push({ name, reason: "이미지가 너무 큽니다(다운스케일 후에도 4MB 초과)." });
          continue;
        }
        accepted.push(image);
      } catch {
        rejected.push({ name, reason: "이미지를 읽을 수 없습니다." });
      }
      continue;
    }

    const capacityError = attachmentCapacityError(pool(), "text");
    if (capacityError) {
      rejected.push({ name, reason: capacityError });
      continue;
    }
    if (file.size > MAX_TEXT_FILE_BYTES) {
      rejected.push({ name, reason: "파일이 너무 큽니다(최대 2MB)." });
      continue;
    }
    if (hasBinaryExtension(name)) {
      rejected.push({ name, reason: "바이너리 파일은 첨부할 수 없습니다." });
      continue;
    }
    try {
      const bytes = await readBlobBytes(file);
      if (isProbablyBinary(bytes)) {
        rejected.push({ name, reason: "바이너리 파일은 첨부할 수 없습니다." });
        continue;
      }
      accepted.push(buildTextAttachment(name, new TextDecoder().decode(bytes)));
    } catch {
      rejected.push({ name, reason: "파일을 읽을 수 없습니다." });
    }
  }

  return { accepted, rejected };
}
