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
};

const AWS_RUNTIME_REQUIRED_GLOBALS = [
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "structuredClone",
  "URL",
  "URLSearchParams",
] as const;

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

  return getMissingAwsRuntimeGlobals(target);
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
