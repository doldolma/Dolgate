// 자동 재연결 판단용 오류 분류기.
//
// "예기치 않은 끊김" 이벤트를 보고 재연결할지 결정한다. 소켓 원인(거부·타임아웃·끊김·경로 없음)은
// shared-core 의 분류기 한 벌에 맡기고, 여기서는 그 판정을 재연결 정책으로 옮기는 일만 한다.
//
// - permanent: 인증/호스트 키/협상 실패 등 재시도해도 같은 결과인 영구 오류.
//   재연결 루프 금지(특히 host key mismatch는 보안상 무한 재시도가 위험).
//   이런 경우는 기존 pendingCredentialRetry/트러스트 플로우가 처리한다.
// - transient: 네트워크 단절/타임아웃/EOF 등 일시적 오류 → 재연결 대상.
// - unknown: 어느 쪽도 매칭 안 됨 → 호출부에서 보수적으로 소수 횟수만 재시도.

import { isTransientConnectionFailure } from "@dolssh/shared-core";

export type ReconnectClassification = "transient" | "permanent" | "unknown";

// 영구 오류(재연결 금지). aws-ssm-ssh-retry.ts의 NON_RETRYABLE_ERROR_PATTERNS와 정합.
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  /unable to authenticate/i,
  /permission denied/i,
  /no supported methods remain/i,
  /attempted methods/i,
  /too many authentication failures/i,
  /host key mismatch/i,
  /trusted host key/i,
  // 사용자가 거절했거나 그만둔 것. 다시 붙어도 같은 물음이고, 자동 재연결은 그 결정을 무시하는
  // 셈이다 — 예전에는 "ssh handshake failed" 가 transient 로 걸려서 거절한 직후 다시 붙었다.
  /host key was not trusted/i,
  /challenge was cancelled/i,
  /prompt was cancelled/i,
  /context canceled/i,
  /no answer came back in time/i,
  /private key auth requires/i,
  /parse private key/i,
  /unsupported auth type/i,
  /password auth requires/i,
  /certificate auth requires/i,
  /no matching/i,
  /no common algorithm/i,
  /algorithm negotiation/i,
  /no common host key/i,
  /no matching host key type/i,
];

// 일시적 오류(재연결 대상) 중 **소켓 원인이 아닌 것들**.
//
// 소켓 원인(거부·타임아웃·끊김·경로 없음)은 shared-core 의 분류기가 판정한다
// (isTransientConnectionFailure). 예전에는 그 문구들이 이 목록에도 복사돼 있었는데, 같은 원인이
// 플랫폼마다 다른 문장으로 오기 때문에(유닉스 Go / 윈도우 winsock / gvisor netstack) 계통이 늘 때
// 목록마다 따로 새고 따로 고쳐야 했다 — 실제로 윈도우 계통을 통째로 놓쳐서, 원격이 끊은 세션이
// unknown 으로 떨어져 자동 재연결이 걸리지 않았다.
//
// 남은 것들은 소켓 오류가 아니라 SSH·코어 계층의 문구다(분류기가 다루지 않는다).
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /ssh handshake failed/i,
  /handshake failed/i,
  /kex_exchange_identification/i,
  /connection closed/i,
  /ssh keepalive failed/i,
  /keepalive/i,
  /use of closed network connection/i,
];

// ssh-core 프로세스가 죽어 전 세션이 닫힐 때의 메시지. transient지만 코어 재기동을
// 기다려야 하므로 호출부에서 디바운스 대상으로 식별할 수 있게 별도 노출.
const CORE_EXITED_PATTERN = /ssh core exited|ssh core process (stopped|is not running)/i;

function toMessage(input: unknown): string {
  if (input instanceof Error) {
    return input.message;
  }
  if (typeof input === "string") {
    return input;
  }
  return "";
}

export function classifyReconnect(input: unknown): ReconnectClassification {
  const message = toMessage(input).trim().toLowerCase();
  if (!message) {
    // 메시지 없는 closed는 보통 원격 정상 종료/단순 끊김 — 보수적으로 unknown.
    return "unknown";
  }
  if (PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return "permanent";
  }
  if (CORE_EXITED_PATTERN.test(message)) {
    return "transient";
  }
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return "transient";
  }
  // 소켓 원인은 한 벌뿐인 분류기가 판정한다. 코어가 원인 코드를 실어 보내는 경로에서는 문구를
  // 아예 안 봐도 되지만(ErrorPayload.failure), 이 자리는 문자열만 손에 든 호출도 있어 문구
  // 판정을 함께 쓴다.
  if (isTransientConnectionFailure(message)) {
    return "transient";
  }
  return "unknown";
}

export function isCoreExitedMessage(input: unknown): boolean {
  return CORE_EXITED_PATTERN.test(toMessage(input).toLowerCase());
}

/**
 * 원격 화면(RDP·VNC)에서 다시 시도해도 결과가 같은 오류인지.
 *
 * **확실히 영구인 것만 걸러낸다** — 모르는 오류는 재시도하는 쪽이 낫다. 소켓 실패는 코어가 원인
 * 코드로 올려 주지만(core_framing::neterr), 아래 목록의 것들(인증·계정·미지원 보안 타입)은 아직
 * 원문뿐이라 문자열로 가른다(rdp-core, vnc-core 의 session.rs·vencrypt.rs).
 *
 * 위의 SSH 분류기를 먼저 통과시킨다 — 호스트 키·알고리즘 협상처럼 영구인 것을 이미 알고 있고,
 * VNC 는 SSH 터널을 거칠 수 있어 그쪽 문구가 그대로 올라온다. 아래 목록은 원격 화면 고유의
 * 것들만이다. SSH 쪽 목록에 넣지 않는 이유는 '계정' 처럼 넓은 낱말이 섞여 있어서, 공용으로
 * 쓰면 관계없는 SSH 오류의 재연결까지 막을 수 있기 때문이다.
 */
const REMOTE_SCREEN_PERMANENT_PATTERNS: RegExp[] = [
  // RDP: rdp-core 가 올리는 NTSTATUS 계열 문자열.
  /LOGON_FAILURE/i,
  /ACCOUNT_LOCKED/i,
  /ACCOUNT_DISABLED/i,
  /ACCOUNT_RESTRICTION/i,
  /ACCOUNT_EXPIRED/i,
  /PASSWORD_EXPIRED/i,
  /PASSWORD_MUST_CHANGE/i,
  /ACCESS_DENIED/i,
  /CERTIFICATE/i,
  // VNC: vnc-core 의 한국어 문구.
  /비밀번호/,
  /계정/,
  /지원하지 않습니다/,
  /거절했습니다/,
  /authentication (failed|or authorization failure)/i,
];

export function isRemoteScreenErrorFinal(input: unknown): boolean {
  const message = toMessage(input);
  if (!message.trim()) {
    return false;
  }
  if (classifyReconnect(message) === "permanent") {
    return true;
  }
  return REMOTE_SCREEN_PERMANENT_PATTERNS.some((pattern) => pattern.test(message));
}

