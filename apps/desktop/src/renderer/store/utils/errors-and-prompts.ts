import type { TerminalConnectionProgress } from "@shared";
import { t } from '../../i18n';

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
  /**
   * 사용자가 그 자리에서 할 수 있는 일이 있는 실패의 종류.
   *
   * 실패 화면이 이것으로 동작을 고른다 — 다른 화면으로 보내지 않고 여기서 끝내기 위해서다.
   */
  kind?: "tailnet-unreachable";
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
  return t('connectFailure.targetHost');
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
        probe.viaJump && dialTarget !== t('connectFailure.targetHost') && dialTarget !== probe.addr
          ? t('connectFailure.viaJump', { target: dialTarget })
          : ""
      }`
    : dialTarget;
  const awsSsmExitCodeMatch =
    /^AWS SSM session exited with code\s+(-?\d+)/i.exec(normalized);
  if (awsSsmExitCodeMatch) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.ssmExit', { code: awsSsmExitCodeMatch[1] }),
    };
  }
  if (/ssh-agent has no keys/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message:
        t('connectFailure.agentNoKeys'),
    };
  }
  if (/ssh-agent (connection failed|key listing failed)/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message:
        t('connectFailure.agentUnreachable'),
    };
  }
  // 코어가 tailnet 경유 dial 실패에 붙이는 표식. 일반 타임아웃으로 뭉개면 사용자는 호스트가
  // 죽은 줄 알고 엉뚱한 곳을 본다.
  if (/could not reach the host through the tailnet/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailnetUnreachable'),
      // 이 실패는 사용자가 그 자리에서 할 수 있는 일이 있다 — 노드 재인증. 종류를 실어 보내
      // 실패 화면이 그 동작을 낼 수 있게 한다(설정 화면으로 보내지 않는다).
      kind: "tailnet-unreachable",
    };
  }
  if (/host key is not trusted yet/i.test(normalized)) {
    return {
      title: "Host Key Not Trusted",
      message:
        t('connectFailure.hostKeyUntrusted'),
    };
  }
  if (
    /error when retrieving token from sso|token has expired|refresh failed|sso session.*expired|unable to locate credentials|expiredtoken|security token included in the request is invalid/i.test(
      normalized,
    )
  ) {
    return {
      title: "AWS Authentication Required",
      message: t('connectFailure.awsAuthFailed'),
    };
  }
  if (/network is unreachable|no route to host/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.noRoute', { target }),
    };
  }
  if (/connection refused/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.refused', { target }),
    };
  }
  if (/i\/o timeout|timed out|operation timed out/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.timeout', { target }),
    };
  }
  if (/connection reset|\bEOF\b/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.reset', { target }),
    };
  }
  return {
    title: "Connection Failed",
    message: normalized || t('connectFailure.generic'),
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
  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  return /sso session associated with this profile has expired|sso token.+expired|aws sso login|브라우저 로그인이 필요합니다|a browser sign-in is required/iu.test(
    message,
  );
}
