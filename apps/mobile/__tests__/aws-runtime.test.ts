import {
  assertAwsRuntimeReady,
  ensureAwsRuntimeGlobals,
  getMissingAwsRuntimeGlobals,
  installBlobArrayBufferPolyfill,
} from "../src/lib/aws-runtime";

describe("aws-runtime", () => {
  it("installs only the missing AWS runtime globals", () => {
    const existingReadableStream = function ExistingReadableStream() {};
    const target: {
      ReadableStream?: unknown;
      WritableStream?: unknown;
      TransformStream?: unknown;
      structuredClone?: unknown;
      URL?: unknown;
      URLSearchParams?: unknown;
      TextEncoder?: unknown;
      TextDecoder?: unknown;
    } = {
      ReadableStream: existingReadableStream,
    };

    expect(getMissingAwsRuntimeGlobals(target)).toEqual([
      "WritableStream",
      "TransformStream",
      "structuredClone",
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
    ]);

    const missingAfterInstall = ensureAwsRuntimeGlobals(target);

    expect(missingAfterInstall).toEqual([]);
    expect(target.ReadableStream).toBe(existingReadableStream);
    expect(typeof target.WritableStream).toBe("function");
    expect(typeof target.TransformStream).toBe("function");
    expect(typeof target.structuredClone).toBe("function");
    expect(typeof target.URL).toBe("function");
    expect(typeof target.URLSearchParams).toBe("function");
    expect(typeof target.TextEncoder).toBe("function");
    expect(typeof target.TextDecoder).toBe("function");
  });

  it("installed TextEncoder/TextDecoder shims round-trip utf-8, including offset views", () => {
    // Hermes 에 TextDecoder 가 없어 AWS SDK(Smithy CBOR)가 로드 시점에 죽는 회귀 방지.
    const target: { TextEncoder?: unknown; TextDecoder?: unknown } = {};
    ensureAwsRuntimeGlobals(target as never);

    const TextEncoderShim = target.TextEncoder as new () => {
      encode(input?: string): Uint8Array;
    };
    const TextDecoderShim = target.TextDecoder as new (label?: string) => {
      decode(input?: ArrayBuffer | ArrayBufferView): string;
    };

    const text = "dolgate — 한글 · emoji 🐧";
    const encoded = new TextEncoderShim().encode(text);
    expect(new TextDecoderShim("utf-8").decode(encoded)).toBe(text);

    // byteOffset 이 있는 서브뷰도 정확히 그 구간만 디코드해야 한다.
    const padded = new Uint8Array(encoded.length + 8).fill(0x21);
    padded.set(encoded, 4);
    const view = new Uint8Array(padded.buffer, 4, encoded.length);
    expect(new TextDecoderShim().decode(view)).toBe(text);

    expect(new TextDecoderShim().decode()).toBe("");
    expect(() => new TextDecoderShim("euc-kr")).toThrow(RangeError);
  });

  it("installs Blob.arrayBuffer via FileReader when missing (RN fetch + AWS SDK 회귀 방지)", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    class FakeBlob {}
    class FakeFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: unknown;
      readAsArrayBuffer(_blob: unknown): void {
        this.result = bytes;
        this.onload?.();
      }
    }
    const scope = { Blob: FakeBlob as never, FileReader: FakeFileReader as never };

    expect(installBlobArrayBufferPolyfill(scope)).toBe(true);
    const blob = new FakeBlob() as { arrayBuffer(): Promise<ArrayBuffer> };
    await expect(blob.arrayBuffer()).resolves.toBe(bytes);

    // 이미 있으면 덮어쓰지 않는다.
    expect(installBlobArrayBufferPolyfill(scope)).toBe(false);
  });

  it("throws a clear error when required globals are still unavailable", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => assertAwsRuntimeReady({})).toThrow(
        "모바일 AWS 런타임 초기화가 완료되지 않았습니다.",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
