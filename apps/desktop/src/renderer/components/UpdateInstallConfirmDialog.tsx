import { DialogBackdrop } from "./DialogBackdrop";

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
      <div
        className="modal-card update-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-install-title"
      >
        <div className="modal-card__header">
          <div>
            <div className="eyebrow">Update Ready</div>
            <h3 id="update-install-title">
              업데이트를 적용하려면 다시 시작이 필요합니다
            </h3>
          </div>
        </div>
        <div className="modal-card__body">
          <p className="update-install-dialog__message">
            현재 열려 있는 SSH 세션, 진행 중인 전송, 생성된 포트 포워딩이 모두
            종료됩니다. 계속하면 dolssh가 정리 후 다시 시작되며 새 버전이
            적용됩니다.
          </p>
        </div>
        <div className="modal-card__footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onConfirm()}
          >
            다시 시작하고 업데이트
          </button>
        </div>
      </div>
    </DialogBackdrop>
  );
}
