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
      return "두 입력이 일치하지 않습니다.";
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
        ? "종단간 암호화 전환에 실패했습니다."
        : isSetup
          ? "동기화 암호 설정에 실패했습니다."
          : "동기화 잠금 해제에 실패했습니다.";
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
      const fallback = "볼트 초기화에 실패했습니다.";
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
              ? "동기화 볼트 오류"
              : isSetup
                ? "동기화 암호 설정"
                : "동기화 잠금 해제"}
          </h2>
          {authState.session?.user.email ? (
            <div className="mb-3 text-[0.85rem] text-[var(--text-soft)]">
              {authState.session.user.email}
            </div>
          ) : null}
          <p className="m-0 mb-5 text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            {isError
              ? "볼트 정보를 안전하게 확인하지 못해 동기화를 중단했습니다."
              : isMigrate
                ? "종단간 암호화를 위한 동기화 암호를 설정해 주세요. 기존 데이터는 그대로 유지됩니다."
                : isSetup
                  ? "종단간 암호화를 위한 동기화 암호를 설정해 주세요. 새 기기에서 로그인할 때 필요합니다."
                  : "이 계정의 동기화 암호를 입력해 주세요."}
          </p>

          {errorMessage ? (
            <div className="mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[var(--danger-text)] shadow-none">
              {errorMessage}
            </div>
          ) : null}

          {isError ? (
            <div className="rounded-[8px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[0.88rem] leading-[1.6] text-[var(--danger-text)]">
              {authState.vault?.errorMessage ??
                "동기화 볼트 상태를 복원할 수 없습니다. 로그아웃한 뒤 다시 로그인해 주세요."}
            </div>
          ) : (
            <div className="grid gap-3">
              <Input
                type="password"
                value={passphrase}
                placeholder="동기화 암호"
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
                  placeholder="동기화 암호 확인"
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
                  암호를 잊으면 동기화된 데이터를 복구할 수 없습니다. 로그인된
                  다른 기기가 있으면 설정에서 변경할 수 있습니다.
                </p>
              ) : null}
              <Button
                variant="primary"
                disabled={!canSubmit}
                onClick={async () => handleSubmit()}
              >
                {isSubmitting
                  ? isMigrate
                    ? "전환 중..."
                    : isSetup
                      ? "설정 중..."
                      : "확인 중..."
                  : isMigrate
                    ? "종단간 암호화 켜기"
                    : isSetup
                      ? "동기화 시작"
                      : "잠금 해제"}
              </Button>
              {isMigrate && onDefer ? (
                <Button
                  variant="ghost"
                  disabled={isSubmitting}
                  onClick={async () => onDefer()}
                >
                  나중에
                </Button>
              ) : null}
            </div>
          )}

          {!isSetup && !isError ? (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              {isResetConfirmOpen ? (
                <div className="grid gap-3">
                  <p className="m-0 text-[0.85rem] leading-[1.6] text-[var(--danger-text)]">
                    동기화 암호 없이는 서버에 저장된 데이터를 복구할 수
                    없습니다. 초기화하면 서버의 동기화 데이터가 모두 삭제되고
                    새로 시작합니다. 이 작업은 되돌릴 수 없습니다.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={isSubmitting}
                      onClick={async () => setIsResetConfirmOpen(false)}
                    >
                      취소
                    </Button>
                    <Button
                      variant="danger"
                      disabled={isSubmitting}
                      onClick={async () => handleReset()}
                    >
                      모두 삭제하고 새로 시작
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent p-0 text-[0.82rem] font-semibold text-[var(--danger-text)]"
                  onClick={() => setIsResetConfirmOpen(true)}
                >
                  동기화 암호를 잊으셨나요? 데이터 초기화
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
              다른 계정으로 로그인 (로그아웃)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
