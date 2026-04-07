import type { TerminalConnectionProgress } from "@shared";

export function normalizeRemoteInvokeErrorMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^Error:\s*/u, "")
    .trim();
}

export function normalizeErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error
    ? normalizeRemoteInvokeErrorMessage(error.message)
    : fallback;
}

export function createConnectionProgress(
  stage: TerminalConnectionProgress["stage"],
  message: string,
  options: Partial<
    Pick<TerminalConnectionProgress, "blockingKind" | "retryable">
  > = {},
): TerminalConnectionProgress {
  return {
    stage,
    message,
    blockingKind: options.blockingKind ?? "none",
    retryable: options.retryable ?? false,
  };
}
