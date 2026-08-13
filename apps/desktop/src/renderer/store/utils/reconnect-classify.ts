// 자동 재연결 판단용 오류 분류기.
//
// 메인 프로세스의 aws-ssm-ssh-retry.ts가 가진 패턴 리스트를 렌더러로 이식해,
// "예기치 않은 끊김" 이벤트의 메시지를 보고 재연결할지 결정한다.
//
// - permanent: 인증/호스트 키/협상 실패 등 재시도해도 같은 결과인 영구 오류.
//   재연결 루프 금지(특히 host key mismatch는 보안상 무한 재시도가 위험).
//   이런 경우는 기존 pendingCredentialRetry/트러스트 플로우가 처리한다.
// - transient: 네트워크 단절/타임아웃/EOF 등 일시적 오류 → 재연결 대상.
// - unknown: 어느 쪽도 매칭 안 됨 → 호출부에서 보수적으로 소수 횟수만 재시도.

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

// 일시적 오류(재연결 대상). aws-ssm-ssh-retry.ts의 TRANSIENT_ERROR_PATTERNS +
// keepalive/원격 단절 메시지를 보강.
// tailnet 경유 세션은 OS 소켓이 아니라 tsnet 의 사용자 공간 스택(gvisor netstack)에서
// 끊기므로 문구가 다르다 — "connection was refused", "host is down",
// "machine is not on the network". 여기서 놓치면 일시적 단절인데 unknown 으로 떨어져
// 재연결을 몇 번만 시도하고 포기한다(connection aborted 는 이미 아래에 있다).
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /connection (was )?refused/i,
  /connection reset/i,
  /reset by peer/i,
  /broken pipe/i,
  /\beof\b/i,
  /i\/o timeout/i,
  /operation timed out/i,
  /connection timed out/i,
  /ssh handshake failed/i,
  /handshake failed/i,
  /kex_exchange_identification/i,
  /connection closed/i,
  /ssh keepalive failed/i,
  /keepalive/i,
  /network is unreachable/i,
  /no route to host/i,
  /host is down/i,
  /machine is not on the network/i,
  /connection aborted/i,
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
  return "unknown";
}

export function isCoreExitedMessage(input: unknown): boolean {
  return CORE_EXITED_PATTERN.test(toMessage(input).toLowerCase());
}

/**
 * 원격 화면(RDP·VNC)에서 다시 시도해도 결과가 같은 오류인지.
 *
 * **확실히 영구인 것만 걸러낸다** — 모르는 오류는 재시도하는 쪽이 낫다. 코어들이 아직 오류를
 * 코드로 분류하지 않고 원문을 올리므로 문자열로 가른다(rdp-core, vnc-core 의 session.rs·
 * vencrypt.rs).
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

