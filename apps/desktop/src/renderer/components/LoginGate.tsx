import type { AuthState } from '@shared';
import { getServerUrlValidationMessage } from '@shared';
import { useEffect, useMemo, useState } from 'react';

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

export function resolveLoginGateActionLabel(status: AuthState['status'], actionLabel?: string): string {
  return actionLabel ?? (status === 'authenticating' ? '브라우저 로그인 대기 중...' : '브라우저로 로그인하기');
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
    input.isLoadingServerUrl ||
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
  const validationMessage = useMemo(() => getServerUrlValidationMessage(draftServerUrl), [draftServerUrl]);

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
      setLocalErrorMessage(error instanceof Error ? error.message : '작업을 시작하지 못했습니다.');
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
      setLocalErrorMessage(error instanceof Error ? error.message : '기본 로그인 서버를 복원하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-gate">
      <div className="login-gate__card">
        <div className="login-gate__header">
          <div className="login-gate__eyebrow">dolssh</div>
          <button
            type="button"
            className="login-gate__advanced-toggle"
            aria-label="로그인 서버 설정 열기"
            onClick={() => {
              setLocalErrorMessage(null);
              setDraftServerUrl(serverUrl);
              setIsAdvancedOpen((current) => !current);
            }}
          >
            ⚙
          </button>
        </div>
        {localErrorMessage || authState.errorMessage ? (
          <div className="login-gate__error">{localErrorMessage ?? authState.errorMessage}</div>
        ) : null}
        {isAdvancedOpen ? (
          <div className="login-gate__advanced-panel">
            <label className="login-gate__advanced-field">
              <span>Login Server</span>
              <input
                value={draftServerUrl}
                onChange={(event) => setDraftServerUrl(event.target.value)}
                placeholder="https://ssh.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="login-gate__advanced-note">경로 없이 서버 루트 주소만 입력해 주세요.</div>
            {validationMessage ? <div className="login-gate__advanced-error">{validationMessage}</div> : null}
            <div className="login-gate__advanced-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setDraftServerUrl(serverUrl);
                  setLocalErrorMessage(null);
                  setIsAdvancedOpen(false);
                }}
              >
                닫기
              </button>
              {hasServerUrlOverride ? (
                <button type="button" className="secondary-button" onClick={handleReset} disabled={isSubmitting}>
                  기본 서버로 복원
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          className="login-gate__button"
          disabled={shouldDisableLoginGatePrimaryAction({
            authStatus: authState.status,
            isSyncBootstrapping,
            isLoadingServerUrl,
            isSubmitting,
            serverUrlValidationMessage: validationMessage
          })}
          onClick={handlePrimaryAction}
        >
          <span>{label}</span>
          <span className="login-gate__button-icon" aria-hidden="true">
            ↗
          </span>
        </button>
      </div>
    </div>
  );
}
