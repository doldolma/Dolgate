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

const TRANSIENT_ERROR_PATTERNS = [
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

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
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
