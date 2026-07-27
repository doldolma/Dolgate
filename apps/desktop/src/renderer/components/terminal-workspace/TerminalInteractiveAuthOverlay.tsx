import type { PendingInteractiveAuth } from '../../store/createAppStore';
import { Button, Input, SectionLabel } from '../../ui';
import { Trans, useTranslation } from 'react-i18next';

interface TerminalInteractiveAuthOverlayProps {
  interactiveAuth: PendingInteractiveAuth;
  promptResponses: string[];
  onPromptResponseChange: (index: number, value: string) => void;
  onSubmit: () => void;
  onCopyApprovalUrl: () => Promise<void>;
  onReopenApprovalUrl: () => void;
  onClose: () => void;
}

export function TerminalInteractiveAuthOverlay({
  interactiveAuth,
  promptResponses,
  onPromptResponseChange,
  onSubmit,
  onCopyApprovalUrl,
  onReopenApprovalUrl,
  onClose,
}: TerminalInteractiveAuthOverlayProps) {
  const { t: translate } = useTranslation();
  if (interactiveAuth.provider === 'warpgate') {
    return (
      <div className="grid max-w-[28rem] gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
        <SectionLabel>
          Warpgate Approval
        </SectionLabel>
        <strong>{translate('authOverlay.warpgateTitle')}</strong>
        <p>
          <Trans i18nKey="authOverlay.warpgateHint" components={{ code: <code /> }} />
        </p>
        {interactiveAuth.authCode ? (
          <p className="text-sm text-[var(--text-soft)]">
            <Trans
              i18nKey="authOverlay.authCodeNote"
              values={{ code: interactiveAuth.authCode }}
              components={{ code: <code /> }}
            />
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {interactiveAuth.approvalUrl ? (
            <Button variant="secondary" size="sm" onClick={onReopenApprovalUrl}>
              {translate('authOverlay.reopenBrowser')}
            </Button>
          ) : null}
          {interactiveAuth.approvalUrl ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void onCopyApprovalUrl();
              }}
            >
              {translate('authOverlay.copyLink')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </div>
        <pre className="rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-3 py-2 text-[0.82rem] text-[var(--text-soft)] whitespace-pre-wrap break-words">
          {interactiveAuth.instruction}
        </pre>
      </div>
    );
  }

  return (
    <div className="grid max-w-[28rem] gap-4 rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <SectionLabel>
          Additional Authentication
        </SectionLabel>
        <strong>{translate('authOverlay.extraAuthTitle')}</strong>
        {interactiveAuth.instruction ? <p>{interactiveAuth.instruction}</p> : null}
        {interactiveAuth.prompts.map((prompt, index) => (
          <label
            key={`${interactiveAuth.challengeId}:${index}`}
            className="grid gap-1.5"
          >
            <span className="text-sm font-medium text-[var(--text)]">
              {prompt.label || `Prompt ${index + 1}`}
            </span>
            <Input
              type={prompt.echo ? 'text' : 'password'}
              value={promptResponses[index] ?? ''}
              onChange={(event) => {
                onPromptResponseChange(index, event.target.value);
              }}
            />
          </label>
        ))}
        <div className="flex items-center justify-end gap-3">
          <Button type="submit" variant="primary">
            {translate('authOverlay.sendResponse')}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </div>
      </form>
    </div>
  );
}
