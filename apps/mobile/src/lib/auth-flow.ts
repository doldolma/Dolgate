import { t } from "../i18n";
export function getAuthCallbackStateErrorMessage(
  expectedState: string | null,
  actualState: string | null | undefined,
): string | null {
  if (!expectedState) {
    return t("authFlow.requestMissing");
  }
  if (!actualState) {
    return t("authFlow.stateMissing");
  }
  if (actualState !== expectedState) {
    return t("authFlow.stateMismatch");
  }
  return null;
}

export function getSyncFailureMessage(
  error: unknown,
  context: "login" | "sync",
): string {
  const fallback =
    context === "login"
      ? t("authFlow.syncFailedAfterLogin")
      : t("authFlow.syncFailed");
  const detail = error instanceof Error ? error.message.trim() : "";
  if (!detail) {
    return fallback;
  }
  return context === "login" ? `${fallback} ${detail}` : detail;
}
