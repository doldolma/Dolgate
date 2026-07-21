import { Buffer } from "buffer";
import structuredClonePolyfill from "@ungap/structured-clone";
import {
  ReadableStream as PolyfillReadableStream,
  TransformStream as PolyfillTransformStream,
  WritableStream as PolyfillWritableStream,
} from "web-streams-polyfill";

type AwsRuntimeGlobalTarget = {
  ReadableStream?: unknown;
  WritableStream?: unknown;
  TransformStream?: unknown;
  structuredClone?: unknown;
  URL?: unknown;
  URLSearchParams?: unknown;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
};

const AWS_RUNTIME_REQUIRED_GLOBALS = [
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
] as const;

// Hermes 에는 TextDecoder(일부 버전은 TextEncoder도)가 없어서 AWS SDK의 Smithy
// 프로토콜 모듈이 로드 시점(new TextDecoder())에 죽는다. Buffer 기반 utf-8 전용
// 셔임으로 채운다. (스펙과 달리 BOM 제거는 하지 않음 — AWS SDK 페이로드엔 무관.)
class BufferTextEncoder {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    const encoded = Buffer.from(input, "utf8");
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  }
}

class BufferTextDecoder {
  readonly encoding = "utf-8";

  constructor(label = "utf-8") {
    const normalized = String(label).toLowerCase();
    if (normalized !== "utf-8" && normalized !== "utf8" && normalized !== "unicode-1-1-utf-8") {
      throw new RangeError(`BufferTextDecoder 는 utf-8 만 지원합니다: ${label}`);
    }
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input == null) {
      return "";
    }
    const bytes = ArrayBuffer.isView(input)
      ? Buffer.from(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength)
      : Buffer.from(input);
    return bytes.toString("utf8");
  }
}

type AwsRuntimeRequiredGlobalName =
  (typeof AWS_RUNTIME_REQUIRED_GLOBALS)[number];

function isInstalledGlobal(value: unknown): boolean {
  return typeof value === "function";
}

export function getMissingAwsRuntimeGlobals(
  target: AwsRuntimeGlobalTarget = globalThis as AwsRuntimeGlobalTarget,
): AwsRuntimeRequiredGlobalName[] {
  return AWS_RUNTIME_REQUIRED_GLOBALS.filter((name) => {
    return !isInstalledGlobal(target[name]);
  });
}

export function ensureAwsRuntimeGlobals(
  target: AwsRuntimeGlobalTarget = globalThis as AwsRuntimeGlobalTarget,
): AwsRuntimeRequiredGlobalName[] {
  if (!isInstalledGlobal(target.ReadableStream)) {
    target.ReadableStream = PolyfillReadableStream;
  }
  if (!isInstalledGlobal(target.WritableStream)) {
    target.WritableStream = PolyfillWritableStream;
  }
  if (!isInstalledGlobal(target.TransformStream)) {
    target.TransformStream = PolyfillTransformStream;
  }
  if (!isInstalledGlobal(target.structuredClone)) {
    target.structuredClone = structuredClonePolyfill;
  }
  if (
    !isInstalledGlobal(target.URL) &&
    isInstalledGlobal((globalThis as AwsRuntimeGlobalTarget).URL)
  ) {
    target.URL = (globalThis as AwsRuntimeGlobalTarget).URL;
  }
  if (
    !isInstalledGlobal(target.URLSearchParams) &&
    isInstalledGlobal((globalThis as AwsRuntimeGlobalTarget).URLSearchParams)
  ) {
    target.URLSearchParams = (globalThis as AwsRuntimeGlobalTarget).URLSearchParams;
  }
  if (!isInstalledGlobal(target.TextEncoder)) {
    target.TextEncoder = BufferTextEncoder;
  }
  if (!isInstalledGlobal(target.TextDecoder)) {
    target.TextDecoder = BufferTextDecoder;
  }
  installBlobArrayBufferPolyfill();

  return getMissingAwsRuntimeGlobals(target);
}

type BlobLikeScope = {
  Blob?: { prototype: { arrayBuffer?: unknown } };
  FileReader?: new () => {
    onload: (() => void) | null;
    onerror: (() => void) | null;
    error?: unknown;
    result?: unknown;
    readAsArrayBuffer(blob: unknown): void;
  };
};

// React Native 의 Blob 에는 arrayBuffer() 가 없어서 최신 AWS SDK 의 응답 수집기
// (smithy streamCollector)가 "undefined is not a function / Deserialization error"
// 로 죽는다(aws-sdk-js-v3 #6636, #6733). FileReader 로 채워 넣는다.
export function installBlobArrayBufferPolyfill(
  scope: BlobLikeScope = globalThis as BlobLikeScope,
): boolean {
  const BlobCtor = scope.Blob;
  const FileReaderCtor = scope.FileReader;
  if (!BlobCtor || typeof BlobCtor.prototype.arrayBuffer === "function" || !FileReaderCtor) {
    return false;
  }

  BlobCtor.prototype.arrayBuffer = function arrayBuffer(this: unknown): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("Blob.arrayBuffer 폴리필 읽기 실패"));
      reader.readAsArrayBuffer(this);
    });
  };
  return true;
}

export function assertAwsRuntimeReady(
  target: AwsRuntimeGlobalTarget = globalThis as AwsRuntimeGlobalTarget,
): void {
  const missing = getMissingAwsRuntimeGlobals(target);
  if (missing.length === 0) {
    return;
  }

  if (__DEV__) {
    console.warn(
      `[aws-runtime] Missing required globals: ${missing.join(", ")}`,
    );
  }

  throw new Error(
    `모바일 AWS 런타임 초기화가 완료되지 않았습니다. 앱을 다시 실행해 주세요. (${missing.join(", ")})`,
  );
}
