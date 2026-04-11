import { DialogBackdrop } from './DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

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
  return `더 이상 사용되지 않는 저장된 인증 정보 ${count}개도 함께 삭제`;
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
              ? '호스트를 삭제한 뒤 더 이상 사용되지 않는 저장된 인증 정보가 있습니다.'
              : '연결된 저장된 인증 정보는 유지됩니다.'}
          </p>
          {unusedLocalSecretCount > 0 ? (
            <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface-muted)] px-[0.95rem] py-[0.8rem] text-[0.92rem] text-[var(--text)]">
              <input
                type="checkbox"
                className="mt-[0.15rem] h-4 w-4 accent-[var(--accent-strong)]"
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
            취소
          </Button>
          <Button variant="danger" disabled={isDeleting} onClick={() => void onConfirm()}>
            삭제
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
