import { isTransientConnectionFailure } from "@dolssh/shared-core";

const AWS_SSM_SSH_RETRY_DELAY_MS = 500;

const NON_RETRYABLE_ERROR_PATTERNS = [
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

// 일시적 실패 중 **소켓 원인이 아닌 것들**. 소켓 원인은 shared-core 의 분류기가 판정한다
// (isTransientConnectionFailure) — 같은 거부가 플랫폼마다 다른 문장으로 오므로 이 자리에 문구를
// 또 적어 두면 계통이 늘 때 여기만 새고, 그러면 터널이 열리기 전의 흔한 경합을 조용히 넘기지
// 못해 사용자가 Retry 를 눌러야 한다.
const TRANSIENT_ERROR_PATTERNS = [
  /ssh handshake failed/i,
  /handshake failed/i,
  /kex_exchange_identification/i,
  /connection closed/i,
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}

export function isTransientAwsSsmSshError(error: unknown): boolean {
  const message = errorMessageOf(error).trim().toLowerCase();
  if (!message) {
    return false;
  }

  if (NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  return isTransientConnectionFailure(message);
}

export async function retryAwsSsmSshOperation<T>(
  operation: () => Promise<T>,
  options: {
    delayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const shouldRetry =
      options.shouldRetry?.(error) ?? isTransientAwsSsmSshError(error);
    if (!shouldRetry) {
      throw error;
    }
    await delay(options.delayMs ?? AWS_SSM_SSH_RETRY_DELAY_MS);
    return operation();
  }
}
