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
  // 연결 시도 실패는 "dial tcp HOST:PORT", 핸드셰이크 중 리셋 등은
  // "read/write tcp LOCAL->REMOTE" 형태로 남는다. 둘 다에서 원격 엔드포인트를 뽑아
  // 어떤 호스트에서 끊겼는지 보여준다(기존엔 dial tcp만 봐서 리셋은 제네릭으로 폴백됐다).
  const dial = /\bdial tcp (\[[^\]]+\]|[^:\s]+):(\d+)/iu.exec(message);
  if (dial) {
    return `${dial[1]}:${dial[2]}`;
  }
  const rw = /\b(?:read|write) tcp \S+->(\[[^\]]+\]|[^:\s]+):(\d+)/iu.exec(message);
  if (rw) {
    return `${rw[1]}:${rw[2]}`;
  }
  return "대상 호스트";
}

// main이 호스트 키 probe 실패에 붙이는 식별자(라벨+주소)를 파싱한다. 다단 ProxyJump에서
// 어느 호스트에서 끊겼는지 raw IP가 아니라 사용자가 붙인 이름으로 보여주기 위한 것.
function extractProbeHostIdentity(
  message: string,
): { label: string; addr: string; viaJump: boolean } | null {
  const match =
    /host-key probe failed for "(.+?)" \[([^\]]+)\](\s+via-jump)?/u.exec(message);
  if (!match) {
    return null;
  }
  return { label: match[1], addr: match[2], viaJump: Boolean(match[3]) };
}

export function resolveConnectionFailurePresentation(
  message: string,
): ConnectionFailurePresentation {
  const normalized = normalizeRemoteInvokeErrorMessage(message);
  const dialTarget = extractDialTarget(normalized);
  const probe = extractProbeHostIdentity(normalized);
  // probe 식별자가 있으면 '라벨' (주소)로 표기한다. 점프 경유 실패면 실제 끊긴 엔드포인트가
  // 타깃 주소와 다를 수 있어(예: 베스천에서 리셋) 함께 덧붙인다.
  const target = probe
    ? `'${probe.label}' (${probe.addr})${
        probe.viaJump && dialTarget !== "대상 호스트" && dialTarget !== probe.addr
          ? ` · 점프 경유 ${dialTarget}`
          : ""
      }`
    : dialTarget;
  const awsSsmExitCodeMatch =
    /^AWS SSM session exited with code\s+(-?\d+)/i.exec(normalized);
  if (awsSsmExitCodeMatch) {
    return {
      title: "Connection Failed",
      message: `AWS SSM 세션이 종료되었습니다. (code ${awsSsmExitCodeMatch[1]})`,
    };
  }
  if (/ssh-agent has no keys/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message:
        "SSH 에이전트에 등록된 키가 없습니다. 에이전트에 키를 추가한 뒤 다시 연결해 주세요.",
    };
  }
  if (/ssh-agent (connection failed|key listing failed)/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message:
        "SSH 에이전트에 연결하지 못했습니다. 에이전트가 실행 중인지 확인해 주세요.",
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
