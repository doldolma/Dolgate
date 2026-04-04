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
  onSaveServerUrl: (serverUrl: string) => Promise<void>;
  onResetServerUrl: () => Promise<void>;
  actionLabel?: string;
  onAction?: () => Promise<void>;
}

export function resolveLoginGateActionLabel(
  status: AuthState['status'],
  actionLabel?: string
): string {
  return actionLabel ?? (status === 'authenticating' ? '브라우저 로그인 대기 중...' : '브라우저로 로그인하기');
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
    input.authStatus === 'authenticating' ||
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
      if (draftServerUrl.trim() !== serverUrl.trim()) {
        await onSaveServerUrl(draftServerUrl);
      }
      await handleAction();
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error ? error.message : '작업을 시작하지 못했습니다.'
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
      <div className="w-[min(34rem,100%)] rounded-[32px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-elevated)_98%,white_2%),color-mix(in_srgb,var(--surface)_94%,var(--app-bg)_6%))] px-[2.5rem] pb-[2.45rem] pt-[2.55rem] shadow-[0_28px_70px_rgba(8,16,30,0.18),inset_0_1px_0_rgba(255,255,255,0.08)]">
        <div className="flex items-center justify-between gap-4">
          <SectionLabel className="mb-0">Dolgate</SectionLabel>
          <IconButton
            type="button"
            aria-label="로그인 서버 설정 열기"
            onClick={() => {
              setLocalErrorMessage(null);
              setDraftServerUrl(serverUrl);
              setIsAdvancedOpen((current) => !current);
            }}
            className="-mt-2 text-[1.1rem]"
          >
            ⚙
          </IconButton>
        </div>
        {localErrorMessage || authState.errorMessage ? (
          <div className="mb-4 rounded-[20px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[var(--danger-text)] shadow-[0_10px_22px_rgba(12,21,35,0.06)]">
            {localErrorMessage ?? authState.errorMessage}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="mb-4 text-[0.92rem] text-[var(--text-soft)]">{statusMessage}</div>
        ) : null}
        {isAdvancedOpen ? (
          <div className="mb-4 rounded-[22px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-4 pb-4 pt-[1rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <label className="flex flex-col gap-[0.45rem]">
              <span className="text-[0.85rem] text-[var(--text-soft)]">Login Server</span>
              <Input
                value={draftServerUrl}
                onChange={(event) => setDraftServerUrl(event.target.value)}
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
                  disabled={isSubmitting}
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
          className="mt-[0.2rem] min-h-[78px] justify-between rounded-[26px] px-6 text-[1.02rem] shadow-[0_22px_38px_color-mix(in_srgb,var(--accent-strong)_20%,transparent)]"
          disabled={shouldDisableLoginGatePrimaryAction({
            authStatus: authState.status,
            isSyncBootstrapping,
            isLoadingServerUrl,
            isSubmitting,
            serverUrlValidationMessage: effectiveValidationMessage
          })}
          onClick={handlePrimaryAction}
        >
          <span>{label}</span>
          <span
            className="inline-flex h-[2rem] w-[2rem] items-center justify-center rounded-full border border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.1)] text-[1.08rem] leading-none"
            aria-hidden="true"
          >
            ↗
          </span>
        </Button>
      </div>
    </div>
  );
}
