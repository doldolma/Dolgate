import type { AuthState, DesktopWindowState } from "@shared";
import { validateNewVaultPassphrase } from "@shared";
import { useState } from "react";
import { DesktopWindowControls } from "../components/DesktopWindowControls";
import {
  migrateVault,
  resetVault,
  setupVault,
  unlockVault,
} from "../services/desktop/auth-window-updater";
import { normalizeErrorMessage } from "../store/utils/errors-and-prompts";
import { Button, Input } from "../ui";
import { useTranslation } from "react-i18next";

interface VaultGateShellProps {
  mode: "setup-required" | "locked" | "migrate" | "error";
  authState: AuthState;
  // migrate 모드에서 "나중에" — 이번 실행 동안 프롬프트를 숨긴다.
  onDefer?: () => void;
  desktopPlatform: "darwin" | "win32" | "linux" | "unknown";
  windowState: DesktopWindowState;
  onLogout: () => Promise<void>;
  onMinimizeWindow: () => Promise<void>;
  onMaximizeWindow: () => Promise<void>;
  onRestoreWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

// E2EE 볼트 게이트 — 동기화 암호를 설정(신규 유저)하거나 입력(새 기기)하기 전에는
// 복호화된 워크스페이스를 열 수 없다. 성공 여부는 auth 이벤트(vault status)로 App 이
// 감지해 자동으로 워크스페이스로 전환된다.
export function VaultGateShell({
  mode,
  authState,
  onDefer,
  desktopPlatform,
  windowState,
  onLogout,
  onMinimizeWindow,
  onMaximizeWindow,
  onRestoreWindow,
  onCloseWindow,
}: VaultGateShellProps) {
  const { t: translate } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  const isMigrate = mode === "migrate";
  const isError = mode === "error";
  // migrate 도 새 암호를 만드는 플로우라 setup 과 같은 입력(확인 포함)을 쓴다.
  const isSetup = mode === "setup-required" || isMigrate;
  const setupValidationMessage = (() => {
    if (!isSetup || !passphrase) {
      return null;
    }
    const passphraseMessage = validateNewVaultPassphrase(passphrase);
    if (passphraseMessage) {
      return passphraseMessage;
    }
    if (confirmPassphrase && passphrase !== confirmPassphrase) {
      return translate("vaultGate.mismatch");
    }
    return null;
  })();
  const canSubmit =
    !isSubmitting &&
    !isError &&
    (isSetup
      ? validateNewVaultPassphrase(passphrase) === null &&
        passphrase === confirmPassphrase
      : passphrase.length > 0);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (isMigrate) {
        await migrateVault(passphrase);
      } else if (isSetup) {
        await setupVault(passphrase);
      } else {
        await unlockVault(passphrase);
      }
      // 성공하면 auth 이벤트로 vault 상태가 바뀌며 App 이 게이트를 걷어낸다.
    } catch (error) {
      const fallback = isMigrate
        ? translate("vaultGate.error.migrateFailed")
        : isSetup
          ? translate("vaultGate.error.setupFailed")
          : translate("vaultGate.error.unlockFailed");
      const normalized = normalizeErrorMessage(error, fallback);
      setErrorMessage(normalized || fallback);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReset(): Promise<void> {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await resetVault();
      setIsResetConfirmOpen(false);
      setPassphrase("");
      setConfirmPassphrase("");
    } catch (error) {
      const fallback = translate("vaultGate.error.resetFailed");
      setErrorMessage(normalizeErrorMessage(error, fallback) || fallback);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--shell-background)]">
      <div className="flex min-h-16 items-center justify-end px-[1.1rem] pb-0 pt-[0.9rem] [-webkit-app-region:drag]">
        <div className="flex-1" />
        <DesktopWindowControls
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          onMinimizeWindow={onMinimizeWindow}
          onMaximizeWindow={onMaximizeWindow}
          onRestoreWindow={onRestoreWindow}
          onCloseWindow={onCloseWindow}
        />
      </div>
      <div className="grid min-h-0 flex-1 place-items-center px-8 py-10">
        <div className="w-[min(34rem,100%)] rounded-[12px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[2.4rem] pb-[2.4rem] pt-[2.4rem] shadow-[var(--shadow)]">
          <h2 className="m-0 mb-1 text-[1.3rem] font-bold text-[var(--text)]">
            {isError
              ? translate("vaultGate.title.error")
              : isSetup
                ? translate("vaultGate.title.setup")
                : translate("vaultGate.title.unlock")}
          </h2>
          {authState.session?.user.email ? (
            <div className="mb-3 text-[0.85rem] text-[var(--text-soft)]">
              {authState.session.user.email}
            </div>
          ) : null}
          <p className="m-0 mb-5 text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            {isError
              ? translate("vaultGate.description.error")
              : isMigrate
                ? translate("vaultGate.description.migrate")
                : isSetup
                  ? translate("vaultGate.description.setup")
                  : translate("vaultGate.description.unlock")}
          </p>

          {errorMessage ? (
            <div className="mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[var(--danger-text)] shadow-none">
              {errorMessage}
            </div>
          ) : null}

          {isError ? (
            <div className="rounded-[8px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[0.88rem] leading-[1.6] text-[var(--danger-text)]">
              {authState.vault?.errorMessage ??
                translate("vaultGate.restoreFailed")}
            </div>
          ) : (
            <div className="grid gap-3">
              <Input
                type="password"
                value={passphrase}
                placeholder={translate("vaultGate.field.passphrase")}
                autoFocus
                onChange={(event) => setPassphrase(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleSubmit();
                  }
                }}
              />
              {isSetup ? (
                <Input
                  type="password"
                  value={confirmPassphrase}
                  placeholder={translate("vaultGate.field.confirm")}
                  onChange={(event) => setConfirmPassphrase(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleSubmit();
                    }
                  }}
                />
              ) : null}
              {setupValidationMessage ? (
                <div className="text-[0.82rem] text-[var(--warning-text,var(--text-soft))]">
                  {setupValidationMessage}
                </div>
              ) : null}
              {isSetup ? (
                <p className="m-0 text-[0.8rem] leading-[1.55] text-[var(--text-soft)]">
                  {translate("vaultGate.warning")}
                </p>
              ) : null}
              <Button
                variant="primary"
                disabled={!canSubmit}
                onClick={async () => handleSubmit()}
              >
                {isSubmitting
                  ? isMigrate
                    ? translate("vaultGate.submit.migrating")
                    : isSetup
                      ? translate("vaultGate.submit.settingUp")
                      : translate("vaultGate.submit.checking")
                  : isMigrate
                    ? translate("vaultGate.submit.enableE2ee")
                    : isSetup
                      ? translate("vaultGate.submit.startSync")
                      : translate("vaultGate.submit.unlock")}
              </Button>
              {isMigrate && onDefer ? (
                <Button
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={async () => onDefer()}
                >
                  {translate("vaultGate.submit.later")}
                </Button>
              ) : null}
            </div>
          )}

          {!isSetup && !isError ? (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              {isResetConfirmOpen ? (
                <div className="grid gap-3">
                  <p className="m-0 text-[0.85rem] leading-[1.6] text-[var(--danger-text)]">
                    {translate("vaultGate.reset.warning")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={isSubmitting}
                      onClick={async () => setIsResetConfirmOpen(false)}
                    >
                      {translate("common.cancel")}
                    </Button>
                    <Button
                      variant="danger"
                      disabled={isSubmitting}
                      onClick={async () => handleReset()}
                    >
                      {translate("vaultGate.reset.confirm")}
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent p-0 text-[0.82rem] font-semibold text-[var(--danger-text)]"
                  onClick={() => setIsResetConfirmOpen(true)}
                >
                  {translate("vaultGate.reset.open")}
                </button>
              )}
            </div>
          ) : null}

          <div className="mt-5 text-center">
            <button
              type="button"
              disabled={isSubmitting}
              className="cursor-pointer border-none bg-transparent p-0 text-[0.82rem] text-[var(--text-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void onLogout()}
            >
              {translate("vaultGate.switchAccount")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
