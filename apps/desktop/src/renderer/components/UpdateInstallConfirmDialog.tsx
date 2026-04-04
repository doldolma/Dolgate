import { DialogBackdrop } from './DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

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
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop onDismiss={onClose}>
      <ModalShell
        className="update-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-install-title"
        size="md"
      >
        <ModalHeader>
          <div>
            <SectionLabel>Update Ready</SectionLabel>
            <h3 id="update-install-title">
              업데이트를 적용하려면 다시 시작이 필요합니다
            </h3>
          </div>
        </ModalHeader>
        <ModalBody>
          <p className="update-install-dialog__message">
            현재 열려 있는 SSH 세션, 진행 중인 전송, 생성된 포트 포워딩이 모두
            종료됩니다. 계속하면 Dolgate가 정리 후 다시 시작되며 새 버전이
            적용됩니다.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={() => void onConfirm()}>
            다시 시작하고 업데이트
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
