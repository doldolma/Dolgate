import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_CHARS,
  MAX_TEXT_FILE_BYTES,
  attachmentCapacityError,
  base64DecodedBytes,
  buildTextAttachment,
  bytesToBase64,
  isProbablyBinary,
  pickImageEncoding,
  processAttachmentFiles,
  type ImageEncoder,
} from "./ai-attachments";
import type { AiAttachment } from "@shared";

function textFile(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

describe("isProbablyBinary", () => {
  it("flags NUL bytes within the sniff window", () => {
    expect(isProbablyBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  it("passes UTF-8 text (Korean included)", () => {
    expect(isProbablyBinary(new TextEncoder().encode("안녕 world\nline2"))).toBe(false);
  });
});

describe("bytesToBase64 / base64DecodedBytes", () => {
  it("matches btoa on small buffers", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(bytesToBase64(bytes)).toBe(btoa("hello"));
  });

  it("handles buffers larger than the chunk size without overflow", () => {
    const bytes = new Uint8Array(100_000).fill(0x41);
    const base64 = bytesToBase64(bytes);
    expect(base64DecodedBytes(base64)).toBe(100_000);
  });

  it("accounts for padding in decoded-size estimates", () => {
    expect(base64DecodedBytes(btoa("a"))).toBe(1);
    expect(base64DecodedBytes(btoa("ab"))).toBe(2);
    expect(base64DecodedBytes(btoa("abc"))).toBe(3);
  });
});

describe("buildTextAttachment", () => {
  it("redacts secrets via redactAiContext", () => {
    const attachment = buildTextAttachment("env.sh", "token sk-ant-abcdef1234567890 end");
    expect(attachment.text).not.toContain("sk-ant-abcdef1234567890");
  });

  it("truncates long content with a marker", () => {
    const attachment = buildTextAttachment("big.log", "x".repeat(MAX_TEXT_ATTACHMENT_CHARS + 100));
    expect(attachment.text.length).toBeLessThanOrEqual(MAX_TEXT_ATTACHMENT_CHARS + 20);
    expect(attachment.text.endsWith("…(파일이 잘렸습니다)")).toBe(true);
  });

  it("accepts an empty file", () => {
    expect(buildTextAttachment("empty.txt", "")).toEqual({ kind: "text", name: "empty.txt", text: "" });
  });
});

describe("attachmentCapacityError", () => {
  const image: AiAttachment = { kind: "image", mediaType: "image/png", dataBase64: "aGk=" };
  const text: AiAttachment = { kind: "text", name: "a.log", text: "l" };

  it("allows below the caps and rejects at the caps per kind", () => {
    expect(attachmentCapacityError([], "image")).toBeNull();
    expect(attachmentCapacityError(Array(MAX_IMAGE_ATTACHMENTS).fill(image), "image")).toContain(
      "이미지",
    );
    // 이미지가 가득 차도 텍스트는 별도 상한.
    expect(attachmentCapacityError(Array(MAX_IMAGE_ATTACHMENTS).fill(image), "text")).toBeNull();
    expect(attachmentCapacityError(Array(MAX_TEXT_ATTACHMENTS).fill(text), "text")).toContain(
      "텍스트",
    );
  });
});

describe("pickImageEncoding", () => {
  it("keeps PNG for PNG sources and re-encodes the rest as JPEG", () => {
    expect(pickImageEncoding("image/png")).toEqual({ mediaType: "image/png" });
    expect(pickImageEncoding("image/webp").mediaType) .toBe("image/jpeg");
  });
});

describe("processAttachmentFiles", () => {
  const fakeEncoder: ImageEncoder = vi.fn(async (_file, sourceMime) => ({
    kind: "image" as const,
    mediaType: sourceMime === "image/png" ? ("image/png" as const) : ("image/jpeg" as const),
    dataBase64: "aGk=",
  }));

  it("routes images to the encoder and other files to the text pipeline", async () => {
    const result = await processAttachmentFiles(
      [new File([new Uint8Array(10)], "shot.png", { type: "image/png" }), textFile("app.log", "line1")],
      [],
      fakeEncoder,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      { kind: "image", mediaType: "image/png", dataBase64: "aGk=" },
      { kind: "text", name: "app.log", text: "line1" },
    ]);
  });

  it("rejects an image the encoder cannot fit under the size cap", async () => {
    const tooBig: ImageEncoder = async () => null;
    const result = await processAttachmentFiles(
      [new File([new Uint8Array(10)], "huge.png", { type: "image/png" })],
      [],
      tooBig,
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toContain("이미지가 너무 큽니다");
  });

  it("rejects binary files by extension and by NUL sniff", async () => {
    const byExtension = new File(["data"], "archive.zip", { type: "" });
    const bySniff = new File([new Uint8Array([0x68, 0x00, 0x69])], "fake.txt", { type: "" });
    const result = await processAttachmentFiles([byExtension, bySniff], [], fakeEncoder);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason.includes("바이너리"))).toBe(true);
  });

  it("rejects oversized text files before reading them", async () => {
    const oversized = textFile("big.log", "x");
    Object.defineProperty(oversized, "size", { value: MAX_TEXT_FILE_BYTES + 1 });
    const result = await processAttachmentFiles([oversized], [], fakeEncoder);
    expect(result.rejected[0].reason).toContain("최대 2MB");
  });

  it("enforces the image cap counting current attachments, accepting the rest", async () => {
    const current: AiAttachment[] = Array(MAX_IMAGE_ATTACHMENTS - 1).fill({
      kind: "image",
      mediaType: "image/png",
      dataBase64: "aGk=",
    });
    const files = [
      new File([new Uint8Array(4)], "a.png", { type: "image/png" }),
      new File([new Uint8Array(4)], "b.png", { type: "image/png" }),
      textFile("still-fine.log", "l"),
    ];
    const result = await processAttachmentFiles(files, current, fakeEncoder);
    // 남은 슬롯 1 → a.png 수용, b.png 거부, 텍스트는 별도 상한이라 수용.
    expect(result.accepted.filter((a) => a.kind === "image")).toHaveLength(1);
    expect(result.accepted.filter((a) => a.kind === "text")).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("b.png");
  });

  it("labels clipboard pastes without a filename", async () => {
    const nameless = new File([new Uint8Array(4)], "", { type: "image/png" });
    const failing: ImageEncoder = async () => {
      throw new Error("boom");
    };
    const result = await processAttachmentFiles([nameless], [], failing);
    expect(result.rejected[0].name).toBe("clipboard-image");
  });
});
