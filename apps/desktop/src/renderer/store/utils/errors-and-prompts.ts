import type { TerminalConnectionProgress } from "@shared";
import {
  getConnectionFailureReason,
  type ConnectionFailureCode,
  type ConnectionFailureSignals,
} from "@dolssh/shared-core";
import { t } from '../../i18n';

/**
 * ssh-core 가 실패 문구에 서버 배너를 붙일 때 앞에 두는 표식(`internal/sshconn/banner.go`).
 *
 * 이 문자열을 바꾸려면 두 곳을 같이 바꿔야 한다. 배너 내용을 해석하지 않고 잘라내기만 하려고
 * 표식을 두었다 — 문구에서 URL 을 찾아 의도를 추측하면 회사 경고문의 정책 링크를 승인 요청으로
 * 잘못 안내한다.
 */
const SERVER_NOTICE_MARKER = "서버가 보낸 안내:";

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
  //
  // tailnet 을 경유하면 gvisor netstack 이 "connect tcp" 라고 쓴다 — 같은 dial 인데 낱말이 달라서,
  // 이것을 안 받으면 주소를 못 읽어 "대상 호스트" 라는 제네릭 문구로 떨어진다.
  const dial = /\b(?:dial|connect) tcp (\[[^\]]+\]|[^:\s]+):(\d+)/iu.exec(message);
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
  /**
   * 코어가 이벤트에 실어 보낸 원인 코드. 이벤트를 손에 든 자리(runtimeEventSlice)만 넘길 수 있고,
   * 문자열만 남은 자리는 생략한다 — 코어가 문구도 정규화해 올리므로 그쪽도 판정은 된다.
   */
  signals?: ConnectionFailureSignals,
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
  // `listen tcp 127.0.0.1:5555: bind: …` 에서 막힌 주소를 뽑는다. 포트 포워딩 실패에서 사용자가
  // 알아야 하는 것은 원격 대상이 아니라 이 주소다.
  const listenAddress =
    /listen (?:tcp|tcp4|tcp6|udp)6? (\[[^\]]+\]:\d+|[^\s:]+:\d+)/i.exec(normalized)?.[1] ??
    null;
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
  // 여기부터의 분류는 shared-core 의 getConnectionFailureReason 이 한다 — 모바일도 같은
  // 규칙을 써야 해서 코드만 돌려받고 문구는 이 앱이 붙인다. 규칙을 두 벌로 두면 한쪽만
  // 고쳐진다.
  const reason = getConnectionFailureReason(normalized, signals);

  /**
   * 서버가 인증 단계에 보낸 배너가 실패 문구에 실려 있으면 그 **원문**을 함께 보여준다.
   *
   * 내용을 해석하지 않는다. 문구에서 URL 을 찾아 "승인하라"고 말하면, 회사 서버가 MOTD 에 넣어 둔
   * 정책 안내 링크를 승인 요청으로 잘못 안내하게 된다 — 무엇을 하라는 글인지는 사용자가 읽고
   * 판단할 몫이다. 그래서 ssh-core 가 붙이는 표식만 보고 잘라낸다.
   *
   * 터미널이 있는 세션은 이 배너를 화면에 그대로 받으므로(runtimeEventSlice) 여기까지 오지 않는다.
   * 이 경로는 SFTP·포트포워딩·컨테이너처럼 글을 쓸 터미널이 없는 곳을 위한 것이다.
   */
  const noticeIndex = normalized.indexOf(SERVER_NOTICE_MARKER);
  const serverNotice =
    noticeIndex >= 0
      ? normalized.slice(noticeIndex + SERVER_NOTICE_MARKER.length).trim()
      : "";
  // 원문에서 안내 부분을 떼어 둔다. 아래 fallback 은 원문을 그대로 쓰므로, 떼지 않으면 같은 글이
  // 두 번 나온다.
  const withoutServerNotice =
    noticeIndex >= 0 ? normalized.slice(0, noticeIndex).trim() : normalized;
  const withServerNotice = (message: string): string =>
    serverNotice
      ? `${message}\n${t('connectFailure.serverNotice', { notice: serverNotice })}`
      : message;

  const MESSAGES: Record<
    Exclude<ConnectionFailureCode, "unknown">,
    () => string
  > = {
    // 원격이 아니라 이 컴퓨터의 포트가 막힌 것이다 — 주소를 읽어냈으면 어느 포트인지 말해 준다.
    "address-in-use": () =>
      listenAddress
        ? t('connectFailure.addressInUseAt', { address: listenAddress })
        : t('connectFailure.addressInUse'),
    "agent-unreachable": () => t('connectFailure.agentUnreachable'),
    "tailnet-expired": () => t('connectFailure.tailnetExpired'),
    "tailnet-needs-auth": () => t('connectFailure.tailscaleNeedsAuth'),
    "tailnet-needs-approval": () => t('connectFailure.tailscaleNeedsApproval'),
    "tailnet-mismatch": () => t('connectFailure.tailscaleMismatch'),
    "host-key-untrusted": () => t('connectFailure.hostKeyUntrusted'),
    "host-key-declined": () => t('connectFailure.hostKeyDeclined'),
    // RDP 인증서. 호스트 키와 같은 성격이라(신원 승인) 같은 자리에 둔다.
    "certificate-declined": () => t('connectFailure.certificateDeclined'),
    "certificate-undecided": () => t('connectFailure.certificateUndecided'),
    // 자격증명 실패. 코어가 프로토콜 수준에서 판정해 코드로 올려 준다(vnc-core 의
    // src/failure.rs) — 서버가 붙이는 거부 사유는 서버가 정하는 문장이라 문구로는 못 가른다.
    "auth-rejected": () => t('connectFailure.authRejected'),
    "account-auth-rejected": () => t('connectFailure.accountAuthRejected'),
    "password-required": () => t('connectFailure.passwordRequired'),
    "account-required": () => t('connectFailure.accountRequired'),
    "password-truncated": () => t('connectFailure.passwordTruncated'),
    cancelled: () => t('connectFailure.cancelled'),
    "aws-auth": () => t('connectFailure.awsAuthFailed'),
    // 권한 부족은 다시 로그인해도 풀리지 않는다 — 고칠 곳은 정책이다. 어느 액션이 거부됐는지
    // 분류기가 문장에서 뽑아 주므로, 있으면 그 이름을 그대로 말해 준다.
    //
    // **리소스까지 있으면 그것도 말한다.** 액션만으로는 "나는 그 권한 있는데?" 로 끝나는 일이
    // 실제로 있었다 — CLI 로는 셸이 붙는데 앱만 막힌 호스트에서, 답은 거부된 리소스(포트포워딩
    // 문서 ARN)에 이미 적혀 있었고 우리가 그 조각을 버렸다.
    "aws-permission": () =>
      reason.awsAction && reason.awsResource
        ? t('connectFailure.awsPermissionActionOn', {
            action: reason.awsAction,
            resource: reason.awsResource,
          })
        : reason.awsAction
          ? t('connectFailure.awsPermissionAction', { action: reason.awsAction })
          : t('connectFailure.awsPermission'),
    // 이름을 못 찾은 것은 경로가 없는 것과 할 일이 다르다 — 주소를 다시 보게 해야 한다.
    "dns-unresolved": () => t('connectFailure.dnsUnresolved', { target }),
    "no-route": () => t('connectFailure.noRoute', { target }),
    refused: () => t('connectFailure.refused', { target }),
    timeout: () => t('connectFailure.timeout', { target }),
    reset: () => t('connectFailure.reset', { target }),
  };
  // 제목은 기존 표기를 그대로 유지한다 — 두 분류만 전용 제목을 쓴다.
  const TITLES: Partial<Record<ConnectionFailureCode, string>> = {
    "host-key-untrusted": "Host Key Not Trusted",
    "host-key-declined": "Host Key Declined",
    "certificate-declined": "Certificate Declined",
    "certificate-undecided": "Certificate Not Confirmed",
    // 자격증명이 틀린 것과 연결이 안 되는 것은 사용자가 할 일이 다르다 — 제목에서 갈라 준다.
    "auth-rejected": "Authentication Failed",
    "account-auth-rejected": "Authentication Failed",
    "password-required": "Password Required",
    "account-required": "Account Required",
    "password-truncated": "Authentication Failed",
    "aws-auth": "AWS Authentication Required",
    "aws-permission": "AWS Permission Required",
  };
  if (reason.code !== "unknown") {
    return {
      title: TITLES[reason.code] ?? "Connection Failed",
      message: withServerNotice(MESSAGES[reason.code]()),
      ...(reason.code === "tailnet-expired"
        ? { kind: "tailscale-expired" as const }
        : {}),
      ...(reason.code === "tailnet-needs-auth"
        ? { kind: "tailscale-auth" as const }
        : {}),
      ...(reason.layer ? { layer: reason.layer } : {}),
    };
  }
  return {
    title: "Connection Failed",
    message: withServerNotice(
      withoutServerNotice || t('connectFailure.generic'),
    ),
  };
}

/**
 * invoke 경로의 **연결 실패**를 사용자에게 보여 줄 한 줄로 바꾼다.
 *
 * **언제 이것을 쓰나:** IPC 요청이 거절로 끝났고(`api.sftp.connect` 등), 그 문구를 담을 상태
 * 필드가 연결 실패만 담는 필드가 **아닐** 때. 그 필드에는 권한·경로·코어 무응답이 함께 들어오므로
 * 화면에서 일괄로 접을 수 없다 — 연결 실패 어휘를 씌우면 방향이 틀린 안내가 된다("Timed out
 * waiting for SSH core response" 를 "호스트가 응답하지 않습니다" 로 바꿔 버린다. 응답을 안 한 것은
 * 로컬 코어다).
 *
 * **반대 경우:** 필드가 연결 실패만 담으면(터미널 탭, 컨테이너 탭, RDP 오버레이) 상태에는 **원문을
 * 담고** 화면이 resolveConnectionFailurePresentation 을 부르는 쪽이 낫다 — 자동 재연결·자격증명
 * 판정처럼 원문을 봐야 하는 곳이 남기 때문이다.
 *
 * 제목이나 실패 계층까지 필요하면 이 함수 대신 resolveConnectionFailurePresentation 을 직접 쓴다.
 */
export function connectFailureCopy(
  error: unknown,
  signals?: ConnectionFailureSignals,
): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return resolveConnectionFailurePresentation(message, signals).message;
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
