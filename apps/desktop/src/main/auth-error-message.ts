import { t } from './i18n';

export const AUTH_INVALID_ERROR_MESSAGE =
  t('misc.sessionExpiredOrInvalid');

const authInvalidPattern =
  // 들어오는 오류 메시지를 판정하는 패턴이라 한국어 문구를 지우면 안 된다 — 예전
  // 메시지와 서버가 보내는 문구까지 잡아야 하므로 두 언어를 모두 유지한다.
  /token is expired|invalid claims|expired refresh token|refresh token|unauthorized|forbidden|jwt|unsupported_client|로그인이 필요|세션이 만료|허용되지 않은 접근|허용되지 않은 클라이언트/i;

export function extractApiErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
      msg?: unknown;
      detail?: unknown;
    };

    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.msg === "string" && parsed.msg.trim()) {
      return parsed.msg.trim();
    }
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
  } catch {
    // Non-JSON payloads fall back to raw text below.
  }

  return trimmed;
}

export function normalizeAuthInvalidErrorMessage(input: {
  status?: number;
  message: string;
}): string | null {
  if (input.status === 401 || input.status === 403) {
    return AUTH_INVALID_ERROR_MESSAGE;
  }
  if (authInvalidPattern.test(input.message)) {
    return AUTH_INVALID_ERROR_MESSAGE;
  }
  return null;
}
