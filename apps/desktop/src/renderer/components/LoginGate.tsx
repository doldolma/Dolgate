import type { AuthState } from '@shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';
import { Button, IconButton, Input, SectionLabel } from '../ui';
import { getServerUrlValidationMessage } from '../../common/shared-messages';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';

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
  /**
   * 계정 없이 시작한다. 없으면 그 버튼을 그리지 않는다 — 워크스페이스를 다시 열지 못하는
   * 자리(볼트 게이트 등)에서 이 화면을 쓸 때가 있다.
   */
  onStartLocalOnly?: () => Promise<void>;
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
  return actionLabel ?? t(status === 'authenticating' ? 'login.reopenBrowser' : 'login.openBrowser');
}

export function resolveLoginGateStatusMessage(
  isSyncBootstrapping: boolean
): string | null {
  return isSyncBootstrapping ? t('login.syncingLatestData') : null;
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
  onAction,
  onStartLocalOnly
}: LoginGateProps) {
  const { t: translate } = useTranslation();
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

  // 브라우저 로그인 대기 중에는 서버를 바꿀 수 없으므로, 열려 있던 설정 패널을 닫는다
  // (톱니바퀴도 숨긴다 — 아래 헤더 참고 — 왜 변경이 막히는지 헷갈리지 않게).
  useEffect(() => {
    if (isPendingBrowserLogin) {
      setIsAdvancedOpen(false);
    }
  }, [isPendingBrowserLogin]);

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
      // 메인에서 던진 오류는 `Error invoking remote method '...': Error: ` 가 앞에 붙어서 온다.
      // 그대로 보여 주면 사용자가 읽을 것이 아니라 우리 내부 사정이 화면에 뜬다.
      setLocalErrorMessage(
        normalizeErrorMessage(error, translate('login.startFailed')),
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
        error instanceof Error ? error.message : translate('login.cancelFailed')
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
          : translate('login.server.resetFailed')
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveServerUrl(): Promise<void> {
    if (validationMessage) {
      return;
    }
    setLocalErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onSaveServerUrl(draftServerUrl);
      setIsAdvancedOpen(false);
    } catch (error) {
      setLocalErrorMessage(
        normalizeErrorMessage(error, translate('login.server.saveFailed')),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-8 py-10">
      <div className="w-[min(34rem,100%)] rounded-[12px] border border-[var(--border)] bg-[var(--surface-elevated)] px-[2.4rem] pb-[2.4rem] pt-[2.4rem] shadow-[var(--shadow)]">
        <div className="mb-7 flex items-center justify-between gap-5">
          <SectionLabel className="mb-0 text-[1rem] tracking-[0.24em] text-[color-mix(in_srgb,var(--text-soft)_88%,var(--text)_12%)]">
            Dolgate
          </SectionLabel>
          {!isPendingBrowserLogin ? (
            <IconButton
              type="button"
              size="md"
              aria-label={translate('login.server.openSettings')}
              onClick={() => {
                setLocalErrorMessage(null);
                setDraftServerUrl(serverUrl);
                setIsAdvancedOpen((current) => !current);
              }}
              className="text-[var(--text)] shadow-none"
            >
              <SettingsGearIcon />
            </IconButton>
          ) : null}
        </div>
        {localErrorMessage || authState.errorMessage ? (
          <div className="mb-4 rounded-[12px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] px-4 py-3.5 text-[var(--danger-text)] shadow-none">
            {localErrorMessage ?? authState.errorMessage}
          </div>
        ) : null}
        {statusMessage ? (
          <div className="mb-4 text-[0.9rem] text-[var(--text-soft)]">{statusMessage}</div>
        ) : null}
        {isAdvancedOpen && !isPendingBrowserLogin ? (
          <div className="mb-4 rounded-[12px] border border-[var(--border)] bg-[var(--surface-muted)] px-4 pb-4 pt-[0.9rem] shadow-none">
            <label className="flex flex-col gap-[0.4rem]">
              <span className="text-[0.82rem] text-[var(--text-soft)]">Login Server</span>
              <Input
                value={draftServerUrl}
                onChange={(event) => setDraftServerUrl(event.target.value)}
                disabled={isSubmitting}
                placeholder="https://ssh.example.com"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="mt-[0.55rem] text-[0.82rem] leading-[1.5] text-[var(--text-soft)]">
              {translate('login.server.rootUrlHint')}
            </div>
            {effectiveValidationMessage ? (
              <div className="mt-[0.7rem] text-[0.82rem] text-[var(--danger-text)]">
                {effectiveValidationMessage}
              </div>
            ) : null}
            <div className="mt-[0.9rem] flex items-center justify-between gap-[0.7rem]">
              <div>
                {hasServerUrlOverride ? (
                  <Button
                    variant="secondary"
                    onClick={handleReset}
                    disabled={isSubmitting}
                  >
                    {translate('login.server.reset')}
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-[0.7rem]">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraftServerUrl(serverUrl);
                    setLocalErrorMessage(null);
                    setIsAdvancedOpen(false);
                  }}
                >
                  {translate('common.close')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveServerUrl}
                  disabled={
                    isSubmitting ||
                    Boolean(validationMessage) ||
                    draftServerUrl.trim() === serverUrl.trim()
                  }
                >
                  {translate('common.save')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          className="min-h-[80px] justify-between rounded-[12px] px-7 text-[1rem] shadow-none"
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
            className="mt-3 min-h-[56px] rounded-[12px]"
            disabled={isSubmitting}
            onClick={handleCancelBrowserLogin}
          >
            {translate('common.cancel')}
          </Button>
        ) : null}
        {/* 로그인을 건너뛴다. 로그인이 주고 이것이 부다 — 대등하게 두면 "일단 건너뛰기" 를 누르는
            사람이 늘어나는데, 폰에서는 로그인이 필수라 그 사람들이 거기서 다시 막힌다.

            **오른쪽에 설명을 달지 않는다.** "건너뛰기" 가 이미 "지금 안 할 뿐 나중에 할 수 있다"
            를 담고 있어서 덧붙일 말이 없다. 이 화면은 로그인 창(모달)으로도 뜨는데, 거기서도
            같은 말로 읽힌다 — 그래서 맥락별로 문구를 나누지 않는다. */}
        {onStartLocalOnly && !isPendingBrowserLogin ? (
          <Button
            variant="secondary"
            fullWidth
            className="mt-3 min-h-[56px] rounded-[12px]"
            disabled={isSubmitting}
            onClick={async () => {
              setLocalErrorMessage(null);
              setIsSubmitting(true);
              try {
                await onStartLocalOnly();
              } catch (error) {
                setLocalErrorMessage(
                  normalizeErrorMessage(error, translate('login.localOnly.failed')),
                );
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            {translate('login.localOnly.action')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
