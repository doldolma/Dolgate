import { DialogBackdrop } from './DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from 'react-i18next';

interface UpdateInstallConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function UpdateInstallConfirmDialog({
  open,
  onClose,
  onConfirm,
}: UpdateInstallConfirmDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop onDismiss={onClose}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-install-title"
        size="md"
      >
        <ModalHeader>
          <div>
            <SectionLabel>Update Ready</SectionLabel>
            <h3 id="update-install-title">
              {translate('updateConfirm.title')}
            </h3>
          </div>
        </ModalHeader>
        <ModalBody>
          <p className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            {translate('updateConfirm.body')}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void onConfirm()}>
            {translate('updateConfirm.confirm')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
