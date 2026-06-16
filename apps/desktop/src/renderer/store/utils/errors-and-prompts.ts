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

export interface ConnectionFailurePresentation {
  title: string;
  message: string;
}

function extractDialTarget(message: string): string {
  const match = /\bdial tcp (?:\[[^\]]+\]|[^:\s]+):\d+/iu.exec(message);
  if (!match) {
    return "대상 호스트";
  }
  return match[0].replace(/^dial tcp\s+/iu, "");
}

export function resolveConnectionFailurePresentation(
  message: string,
): ConnectionFailurePresentation {
  const normalized = normalizeRemoteInvokeErrorMessage(message);
  const target = extractDialTarget(normalized);
  const awsSsmExitCodeMatch =
    /^AWS SSM session exited with code\s+(-?\d+)/i.exec(normalized);
  if (awsSsmExitCodeMatch) {
    return {
      title: "Connection Failed",
      message: `AWS SSM 세션이 종료되었습니다. (code ${awsSsmExitCodeMatch[1]})`,
    };
  }
  if (/host key is not trusted yet/i.test(normalized)) {
    return {
      title: "Host Key Not Trusted",
      message:
        "이 호스트의 SSH 호스트 키를 먼저 신뢰해야 컨테이너를 조회할 수 있습니다.",
    };
  }
  if (
    /error when retrieving token from sso|token has expired|refresh failed|sso session.*expired|unable to locate credentials|expiredtoken|security token included in the request is invalid/i.test(
      normalized,
    )
  ) {
    return {
      title: "AWS Authentication Required",
      message: "AWS 인증을 확인하지 못했습니다. 다시 로그인해 주세요.",
    };
  }
  if (/network is unreachable|no route to host/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: `${target}에 연결할 수 없습니다. 현재 네트워크에서 해당 호스트로 가는 경로가 없습니다.`,
    };
  }
  if (/connection refused/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: `${target}에서 연결을 거부했습니다.`,
    };
  }
  if (/i\/o timeout|timed out|operation timed out/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: `${target} 연결 시간이 초과되었습니다.`,
    };
  }
  if (/connection reset|\bEOF\b/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: `${target} 연결이 중간에 끊겼습니다.`,
    };
  }
  return {
    title: "Connection Failed",
    message: normalized || "연결을 완료하지 못했습니다.",
  };
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

export function isAwsSsoAuthenticationErrorMessage(message: string): boolean {
  return /sso session associated with this profile has expired|sso token.+expired|aws sso login|브라우저 로그인이 필요합니다/iu.test(
    message,
  );
}
