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
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /connection refused/i,
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
