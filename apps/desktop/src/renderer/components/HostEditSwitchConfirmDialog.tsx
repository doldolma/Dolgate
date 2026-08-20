import { DialogBackdrop } from './DialogBackdrop';
import { Button, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';
import { useTranslation } from 'react-i18next';

interface HostEditSwitchConfirmDialogProps {
  open: boolean;
  isSaving: boolean;
  errorMessage?: string | null;
  /** 취소 = 여기 머문다. 이동은 일어나지 않는다. */
  onCancel: () => void;
  /** 저장 = 저장하고 원래 하려던 이동을 이어서 한다. */
  onSave: () => Promise<void>;
}

/**
 * 편집 중에 다른 곳으로 가려 할 때, 저장하지 않은 변경을 어떻게 할지 묻는다.
 *
 * **선택지는 두 개다 — 취소 아니면 저장.** 처음에는 "버리고 이동" 까지 세 개였는데, 지나가다 뜨는
 * 창에서 세 갈래를 읽고 고르게 하면 매번 생각을 요구한다. 버리고 싶으면 편집기를 X 로 닫으면 되고,
 * 그 길은 이미 화면에 있다.
 *
 * 자동저장이 아니어서 필요한 창이다 — 저장 버튼을 누르지 않은 변경은 이동과 함께 사라진다.
 */
export function HostEditSwitchConfirmDialog({
  open,
  isSaving,
  errorMessage = null,
  onCancel,
  onSave,
}: HostEditSwitchConfirmDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop dismissDisabled={isSaving} onDismiss={onCancel}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="host-edit-switch-title">
        <ModalHeader className="block">
          <SectionLabel>{translate('hostEditSwitch.eyebrow')}</SectionLabel>
          <h3 id="host-edit-switch-title">{translate('hostEditSwitch.title')}</h3>
        </ModalHeader>
        {errorMessage ? (
          <ModalBody className="grid gap-4">
            <p className="text-sm text-[var(--danger-text)]">{errorMessage}</p>
          </ModalBody>
        ) : null}
        <ModalFooter>
          <Button variant="secondary" onClick={onCancel} disabled={isSaving}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void onSave()} disabled={isSaving}>
            {translate('common.save')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
