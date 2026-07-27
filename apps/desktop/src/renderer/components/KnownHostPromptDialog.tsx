import type { PendingHostKeyPrompt } from '../store/createAppStore';
import { DialogBackdrop } from './DialogBackdrop';
import { Button, CloseIcon, IconButton, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from 'react-i18next';

interface KnownHostPromptDialogProps {
  pending: PendingHostKeyPrompt | null;
  onAccept: (mode: 'trust' | 'replace') => Promise<void>;
  onCancel: () => void;
  onOpenSecuritySettings?: () => void;
}

export function KnownHostPromptDialog({ pending, onAccept, onCancel, onOpenSecuritySettings }: KnownHostPromptDialogProps) {
  const { t: translate } = useTranslation();
  if (!pending) {
    return null;
  }

  const isMismatch = pending.probe.status === 'mismatch';

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="known-host-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Known Hosts</SectionLabel>
            <h3 id="known-host-title">{translate(isMismatch ? 'knownHostPrompt.mismatchTitle' : 'knownHostPrompt.newTitle')}</h3>
          </div>
          <IconButton type="button" onClick={onCancel} aria-label="Close known host prompt">
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">Host</span>
              <strong>
                {pending.probe.hostLabel} (
                {pending.probe.targetDescription ??
                  `${pending.probe.host}:${pending.probe.port}`}
                )
              </strong>
            </div>
            <div className="grid gap-[0.25rem] rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.9rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">Algorithm</span>
              <strong>{pending.probe.algorithm}</strong>
            </div>
          </div>

          <div className="grid gap-3">
            {pending.probe.existing ? (
              <div className="grid gap-[0.4rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent_10%)] px-[0.9rem] py-[0.9rem]">
                <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{translate('knownHostPrompt.savedFingerprint')}</span>
                <code className="break-all rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-2 text-[0.82rem]">{pending.probe.existing.fingerprintSha256}</code>
              </div>
            ) : null}
            <div className="grid gap-[0.4rem] rounded-[10px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent_10%)] px-[0.9rem] py-[0.9rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">{translate('knownHostPrompt.currentFingerprint')}</span>
              <code className="break-all rounded-[10px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-2 text-[0.82rem]">{pending.probe.fingerprintSha256}</code>
            </div>
          </div>

          <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            {isMismatch
              ? translate('knownHostPrompt.mismatchHint')
              : translate('knownHostPrompt.newHint')}
          </p>
        </ModalBody>

        <ModalFooter>
          {onOpenSecuritySettings ? (
            <Button variant="ghost" onClick={onOpenSecuritySettings}>
              Security settings
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onCancel}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void onAccept(isMismatch ? 'replace' : 'trust')}>
            {translate(isMismatch ? 'knownHostPrompt.replaceContinue' : 'knownHostPrompt.saveContinue')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
