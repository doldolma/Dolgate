export function getAuthCallbackStateErrorMessage(
  expectedState: string | null,
  actualState: string | null | undefined,
): string | null {
  if (!expectedState) {
    return "로그인 요청을 찾을 수 없습니다. 다시 로그인해 주세요.";
  }
  if (!actualState) {
    return "로그인 검증 상태가 누락되었습니다. 다시 로그인해 주세요.";
  }
  if (actualState !== expectedState) {
    return "로그인 검증 상태가 일치하지 않습니다.";
  }
  return null;
}

export function getSyncFailureMessage(
  error: unknown,
  context: "login" | "sync",
): string {
  const fallback =
    context === "login"
      ? "로그인은 완료되었지만 동기화에 실패했습니다."
      : "동기화에 실패했습니다.";
  const detail = error instanceof Error ? error.message.trim() : "";
  if (!detail) {
    return fallback;
  }
  return context === "login" ? `${fallback} ${detail}` : detail;
}
