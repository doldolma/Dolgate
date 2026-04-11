import type { AuthState } from '@shared';
import { getServerUrlValidationMessage } from '@shared';
import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton, Input, SectionLabel } from '../ui';

interface LoginGateProps {
  authState: AuthState;
  isSyncBootstrapping: boolean;
  serverUrl: string;
  hasServerUrlOverride: boolean;
  isLoadingServerUrl: boolean;
  onBeginLogin: () => Promise<void>;
  onReopenBrowserLogin?: () => Promise<void>;
  onCancelBrowserLogin?: () => Promise<void>;
  onSaveServerUrl: (serverUrl: string) => Promise<void>;
  onResetServerUrl: () => Promise<void>;
  actionLabel?: string;
  onAction?: () => Promise<void>;
}

function SettingsGearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[1.35rem] w-[1.35rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.4 2.9h3.2l.55 2.18c.44.14.86.31 1.25.52l1.97-1.08 2.26 2.27-1.08 1.96c.21.39.38.81.52 1.26l2.18.55v3.2l-2.18.55a6.7 6.7 0 0 1-.52 1.26l1.08 1.96-2.26 2.27-1.97-1.08c-.39.21-.81.38-1.25.52l-.55 2.18h-3.2l-.55-2.18a6.7 6.7 0 0 1-1.25-.52l-1.97 1.08-2.26-2.27 1.08-1.96a6.7 6.7 0 0 1-.52-1.26l-2.18-.55v-3.2l2.18-.55c.14-.45.31-.87.52-1.26L4.6 6.79l2.26-2.27 1.97 1.08c.39-.21.81-.38 1.25-.52L10.4 2.9Z" />
      <circle cx="12" cy="12" r="3.15" />
    </svg>
  );
}

function OpenBrowserIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="h-[1.05rem] w-[1.05rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 4.75H5.75A2.75 2.75 0 0 0 3 7.5v6.75A2.75 2.75 0 0 0 5.75 17h6.75a2.75 2.75 0 0 0 2.75-2.75V12" />
      <path d="M10.75 4H16v5.25" />
      <path d="M15.65 4.35 8.9 11.1" />
    </svg>
  );
}

export function resolveLoginGateActionLabel(
  status: AuthState['status'],
  actionLabel?: string
): string {
  return actionLabel ?? (status === 'authenticating' ? '브라우저 다시 열기' : '브라우저로 로그인하기');
}

export function resolveLoginGateStatusMessage(
  isSyncBootstrapping: boolean
): string | null {
  return isSyncBootstrapping ? '최신 데이터 동기화 중...' : null;
}

export function shouldDisableLoginGatePrimaryAction(input: {
  authStatus: AuthState['status'];
  isSyncBootstrapping: boolean;
  isLoadingServerUrl: boolean;
  isSubmitting: boolean;
  serverUrlValidationMessage: string | null;
}): boolean {
  return (
    input.authStatus === 'loading' ||
    input.isSyncBootstrapping ||
    input.isSubmitting ||
    Boolean(input.serverUrlValidationMessage)
  );
}

export function LoginGate({
  authState,
  isSyncBootstrapping,
  serverUrl,
  hasServerUrlOverride,
  isLoadingServerUrl,
  onBeginLogin,
  onReopenBrowserLogin,
  onCancelBrowserLogin,
  onSaveServerUrl,
  onResetServerUrl,
  actionLabel,
  onAction
}: LoginGateProps) {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [draftServerUrl, setDraftServerUrl] = useState(serverUrl);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);
  const handleAction = onAction ?? onBeginLogin;
  const isPendingBrowserLogin = authState.status === 'authenticating';
  const label = resolveLoginGateActionLabel(authState.status, actionLabel);
  const statusMessage = resolveLoginGateStatusMessage(isSyncBootstrapping);
  const validationMessage = useMemo(
    () => getServerUrlValidationMessage(draftServerUrl),
    [draftServerUrl]
  );
  const shouldValidateServerUrlInput =
    isAdvancedOpen || draftServerUrl.trim() !== serverUrl.trim();
  const effectiveValidationMessage = shouldValidateServerUrlInput
    ? validationMessage
    : null;

  useEffect(() => {
    setDraftServerUrl(serverUrl);
  }, [serverUrl]);

  async function handlePrimaryAction(): Promise<void> {
    setLocalErrorMessage(null);
    setIsSubmitting(true);

    try {
      if (!isPendingBrowserLogin && draftServerUrl.trim() !== serverUrl.trim()) {
        await onSaveServerUrl(draftServerUrl);
      }
      if (isPendingBrowserLogin) {
        await (onReopenBrowserLogin ?? handleAction)();
      } else {
        await handleAction();
      }
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error ? error.message : '작업을 시작하지 못했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancelBrowserLogin(): Promise<void> {
    if (!onCancelBrowserLogin) {
      return;
    }

    setLocalErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onCancelBrowserLogin();
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error ? error.message : '로그인 대기를 취소하지 못했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReset(): Promise<void> {
    setLocalErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onResetServerUrl();
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error
          ? error.message
          : '기본 로그인 서버를 복원하지 못했습니다.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-8 py-10">
      <div className="w-[min(34rem,100%)] rounded-[32px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[2.5rem] pb-[2.45rem] pt-[2.55rem] shadow-[var(--shadow)]">
        <div className="mb-7 flex items-center justify-between gap-5">
          <SectionLabel className="mb-0 text-[0.96rem] tracking-[0.24em] text-[color-mix(in_srgb,var(--text-soft)_88%,var(--text)_12%)]">
            Dolgate
          </SectionLabel>
          <IconButton
            type="button"
            size="md"
            aria-label="로그인 서버 설정 열기"
            onClick={() => {
              setLocalErrorMessage(null);
              setDraftServerUrl(serverUrl);
              setIsAdvancedOpen((current) => !current);
            }}
            className="text-[var(--text)] shadow-none"
          >
            <SettingsGearIcon />
          </IconButton>
        </div>
        {localErrorMessage || authState.errorMessage ? (
          <div className="mb-4 rounded-[20px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[var(--danger-text)] shadow-none">
            {localErrorMessage ?? authState.errorMessage}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="mb-4 text-[0.92rem] text-[var(--text-soft)]">{statusMessage}</div>
        ) : null}
        {isAdvancedOpen ? (
          <div className="mb-4 rounded-[22px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 pb-4 pt-[1rem] shadow-none">
            <label className="flex flex-col gap-[0.45rem]">
              <span className="text-[0.85rem] text-[var(--text-soft)]">Login Server</span>
              <Input
                value={draftServerUrl}
                onChange={(event) => setDraftServerUrl(event.target.value)}
                disabled={isPendingBrowserLogin || isSubmitting}
                placeholder="https://ssh.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="mt-[0.6rem] text-[0.85rem] leading-[1.5] text-[var(--text-soft)]">
              경로 없이 서버 루트 주소만 입력해 주세요.
            </div>
            {effectiveValidationMessage ? (
              <div className="mt-[0.65rem] text-[0.85rem] text-[var(--danger-text)]">
                {effectiveValidationMessage}
              </div>
            ) : null}
            <div className="mt-[0.9rem] flex justify-end gap-[0.65rem]">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraftServerUrl(serverUrl);
                  setLocalErrorMessage(null);
                  setIsAdvancedOpen(false);
                }}
              >
                닫기
              </Button>
              {hasServerUrlOverride ? (
                <Button
                  variant="secondary"
                  onClick={handleReset}
                  disabled={isPendingBrowserLogin || isSubmitting}
                >
                  기본 서버로 복원
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          className="min-h-[80px] justify-between rounded-[26px] px-7 text-[1.06rem] shadow-none"
          disabled={shouldDisableLoginGatePrimaryAction({
            authStatus: authState.status,
            isSyncBootstrapping,
            isLoadingServerUrl,
            isSubmitting,
            serverUrlValidationMessage: effectiveValidationMessage
          })}
          onClick={handlePrimaryAction}
        >
          <span className="tracking-[-0.02em]">{label}</span>
          <span
            className="inline-flex h-[2.35rem] w-[2.35rem] items-center justify-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.1)] text-[var(--accent-contrast)] shadow-none"
            aria-hidden="true"
          >
            <OpenBrowserIcon />
          </span>
        </Button>
        {isPendingBrowserLogin ? (
          <Button
            variant="secondary"
            fullWidth
            className="mt-3 min-h-[56px] rounded-[22px]"
            disabled={isSubmitting}
            onClick={handleCancelBrowserLogin}
          >
            취소
          </Button>
        ) : null}
      </div>
    </div>
  );
}
