import { DialogBackdrop } from './DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';

interface HostDeleteConfirmDialogProps {
  open: boolean;
  title: string;
  unusedLocalSecretCount: number;
  removeUnusedSecrets: boolean;
  onToggleRemoveUnusedSecrets: (checked: boolean) => void;
  isDeleting: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  backdropTestId?: string;
}

function formatUnusedSecretLabel(count: number): string {
  return t('hostDelete.alsoDeleteSecrets', { count });
}

export function HostDeleteConfirmDialog({
  open,
  title,
  unusedLocalSecretCount,
  removeUnusedSecrets,
  onToggleRemoveUnusedSecrets,
  isDeleting,
  errorMessage = null,
  onClose,
  onConfirm,
  backdropTestId,
}: HostDeleteConfirmDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop
      data-testid={backdropTestId}
      dismissDisabled={isDeleting}
      onDismiss={onClose}
    >
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="delete-host-title">
        <ModalHeader className="block">
          <SectionLabel>Delete</SectionLabel>
          <h3 id="delete-host-title">{title}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-sm leading-6 text-[var(--text-soft)]">
            {unusedLocalSecretCount > 0
              ? translate('hostDelete.unusedSecrets')
              : translate('hostDelete.secretsKept')}
          </p>
          {unusedLocalSecretCount > 0 ? (
            <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] px-[0.9rem] py-[0.9rem] text-[0.9rem] text-[var(--text)]">
              <input
                type="checkbox"
                className="mt-[0.25rem] h-4 w-4 accent-[var(--accent-strong)]"
                checked={removeUnusedSecrets}
                onChange={(event) => onToggleRemoveUnusedSecrets(event.target.checked)}
                aria-label={formatUnusedSecretLabel(unusedLocalSecretCount)}
              />
              <span>{formatUnusedSecretLabel(unusedLocalSecretCount)}</span>
            </label>
          ) : null}
          {errorMessage ? <p className="text-sm text-[var(--danger-text)]">{errorMessage}</p> : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
            {translate('common.cancel')}
          </Button>
          <Button variant="danger" disabled={isDeleting} onClick={() => void onConfirm()}>
            {translate('common.delete')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
