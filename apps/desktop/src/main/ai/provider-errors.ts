import type { AiErrorPayload, AiFailureReason } from "../../shared/ai";
import { t } from '../i18n';

// AiService/어댑터 내부에서 정규화된 실패를 던질 때 쓰는 에러.
export class AiRequestError extends Error {
  readonly reason: AiFailureReason;

  constructor(reason: AiFailureReason, message: string) {
    super(message);
    this.name = "AiRequestError";
    this.reason = reason;
  }
}

// 연결 계열 에러 코드(undici/Node net). 로컬 서버 미기동·방화벽·오타 등.
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

// SDK 에러(또는 임의 throw)를 UI가 쓸 수 있는 정규화된 사유/메시지로 변환한다.
// 두 SDK 모두 APIError(.status)를 던지지만, 연결 실패는 undici가 `TypeError: fetch failed`
// (+ error.cause.code) 형태로 던질 수 있어 status/name 만으로는 부족 → cause.code 까지 본다.
// 주의: 메시지에 API 키/인증 헤더/요청 바디를 절대 담지 않는다(redact).
export function normalizeAiError(error: unknown): AiErrorPayload {
  if (error instanceof AiRequestError) {
    return { reason: error.reason, message: error.message };
  }

  const name = error instanceof Error ? error.name : "";
  const status = extractStatus(error);
  const code = extractCode(error);
  const rawMessage = error instanceof Error ? error.message : String(error);

  // 진단용: 원인 에러의 형태를 main stderr 에 남긴다(키/헤더/바디는 제외). 테스트에선 조용히.
  if (!process.env.VITEST) {
    console.error("[ai] request failed", {
      name,
      status,
      code,
      message: redactSecrets(rawMessage).slice(0, 300),
    });
  }

  if (name === "APIUserAbortError" || name === "AbortError") {
    return { reason: "timeout", message: t('providerError.cancelledOrTimeout') };
  }
  if (name === "APIConnectionTimeoutError" || (code && TIMEOUT_CODES.has(code))) {
    return { reason: "timeout", message: t('providerError.timeout') };
  }
  // 두 SDK 모두 진짜 연결 실패는 APIConnectionError 로 감싸므로, name==="TypeError" 를
  // 통째로 network 로 보지 않는다(응답 파싱/shape 버그를 network 로 가려버림).
  // undici raw 케이스는 메시지("fetch failed")/cause.code 로만 잡는다.
  if (
    name === "APIConnectionError" ||
    (code && CONNECTION_CODES.has(code)) ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|network error/i.test(rawMessage)
  ) {
    const hint = code ? ` (${code})` : "";
    return {
      reason: "network",
      message: t('providerError.connectFailed', { hint }),
    };
  }
  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return { reason: "auth", message: t('providerError.authFailed') };
    }
    if (status === 404) {
      return {
        reason: "model-not-found",
        message: t('providerError.notFound'),
      };
    }
    if (status === 429 || status >= 500) {
      return {
        reason: "server",
        message: t('providerError.providerStatus', { status }),
      };
    }
    if (status === 400 || status === 422) {
      // 이미지 첨부를 비전 미지원 모델로 보낸 경우 — 원인 메시지의 키워드로만 판별(고정 문구 반환이라 유출 없음).
      if (/image|vision|multimodal|image_url/i.test(rawMessage)) {
        return {
          reason: "invalid-response",
          message:
            t('providerError.noVision'),
        };
      }
      return { reason: "invalid-response", message: t('providerError.rejected') };
    }
  }

  // 사유 미상: 안전하게 요약한 원인을 메시지에 포함해 진단을 돕는다.
  const detail = summarize(name, code, rawMessage);
  return {
    reason: "network",
    message: t('providerError.requestFailed', { detail: detail ? `: ${detail}` : "" }),
  };
}

function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

// error.code 또는 undici 가 감싼 error.cause.code 를 추출한다.
function extractCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") {
    return direct;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") {
      return causeCode;
    }
  }
  return undefined;
}

function summarize(name: string, code: string | undefined, message: string): string {
  const parts = [name, code].filter((part): part is string => Boolean(part) && part !== "Error");
  const label = parts.join(" ");
  const safeMessage = redactSecrets(message).slice(0, 120);
  if (label && safeMessage) {
    return `${label} — ${safeMessage}`;
  }
  return label || safeMessage;
}

// API 키/Bearer 토큰 흔적을 메시지에서 제거한다.
function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, "sk-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/x-api-key["'\s:]+\S+/gi, "x-api-key ***");
}
