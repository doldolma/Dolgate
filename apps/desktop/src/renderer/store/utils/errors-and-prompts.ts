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
   *
   * Tailscale 관련은 그 계층이 직접 알려 주는 것만 여기 들어온다. 대상까지 못 닿았다는 사실
   * (타임아웃)로 Tailscale 을 의심하지 않는다 — 등록이 유효한지는 그 계층이 이미 확인했고,
   * 그러고도 못 닿는 것은 대상이나 경로의 문제다. 섞으면 멀쩡한 등록을 다시 로그인하라고 권하게
   * 된다.
   */
  kind?: "tailscale-expired" | "tailscale-auth";
  /**
   * 어느 계층에서 실패했는지.
   *
   * 화면이 문구를 다시 뒤져 계층을 추측하면 같은 판단이 두 곳에 생긴다. 실패를 분류하는 자리는
   * 하나여야 한다 — 사용자에게 "Tailscale 때문인지 SSH 가 거절한 것인지" 를 말해 주는 근거다.
   */
  layer?: "tailscale" | "hostKey" | "ssh";
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
  // tailnet 을 거치지 않는 실패는 대상까지 가는 길이나 SSH 자체의 문제다. 아래 분류들이 그
  // 계층을 정하고, 화면은 그 계층의 단계에 실패를 붙인다.
  // --- Tailscale 계층이 직접 알려 주는 실패들 ---
  //
  // 이것들은 그 계층에서 판정된 것이라 원인이 확실하다. 사용자가 할 일도 정해져 있다.

  // 등록 만료. 다시 로그인해야 붙는다.
  if (/node registration has expired/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailnetExpired'),
      kind: "tailscale-expired",
      layer: "tailscale",
    };
  }
  // 인증이 아직 안 끝났다. 이미 진행 중일 수 있으므로 새 로그인을 걸지 않고 브라우저로 보낸다.
  if (/this tailnet is not connected yet/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailscaleNeedsAuth'),
      kind: "tailscale-auth",
      layer: "tailscale",
    };
  }
  if (/waiting for administrator approval/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailscaleNeedsApproval'),
      layer: "tailscale",
    };
  }
  // 설정이 가리키는 tailnet 이 아닌 곳에 붙었다. 사용자가 계정을 바꿔 로그인한 경우다.
  if (/connected to a different tailnet/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailscaleMismatch'),
      layer: "tailscale",
    };
  }

  // 컨트롤 플레인과 세션이 끊긴 상태. 노드는 연결됨으로 보고되지만 낡은 값이다.
  if (/not connected to the control plane yet/i.test(normalized)) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.tailscaleOffline'),
      layer: "tailscale",
    };
  }
  if (/host key is not trusted yet/i.test(normalized)) {
    return {
      title: "Host Key Not Trusted",
      message:
        t('connectFailure.hostKeyUntrusted'),
      layer: "hostKey",
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
  // context deadline exceeded 도 여기다 — tailnet 경유 dial 이 예산을 다 쓰면 Go 의 ctx 만료가
  // 그대로 올라온다. 그것을 분류하지 않으면 원문이 화면에 뜨고, 실패한 단계도 표시되지 않는다.
  if (
    /i\/o timeout|timed out|operation timed out|context deadline exceeded|deadline exceeded/i.test(
      normalized,
    )
  ) {
    return {
      title: "Connection Failed",
      message: t('connectFailure.timeout', { target }),
      layer: "ssh",
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
