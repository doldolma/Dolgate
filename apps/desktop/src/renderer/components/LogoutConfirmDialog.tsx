// 못 민 변경이 남은 채로 로그아웃할 때만 뜨는 확인.
//
// 평소에는 뜨지 않는다 — 로그아웃 전에 한 번 밀어 보고, 다 올라갔으면 조용히 나간다. 이것은
// 동기화에 대해 묻는 것이 아니라 **되돌릴 수 없는 동작 직전의 확인**이다(저장 안 한 것을 닫을
// 때 묻는 것과 같은 결).

import { DialogBackdrop } from './DialogBackdrop';
import {
  Button,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
} from '../ui';
import { useTranslation } from 'react-i18next';

interface LogoutConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function LogoutConfirmDialog({
  open,
  onClose,
  onConfirm,
}: LogoutConfirmDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop data-testid="logout-confirm-backdrop" onDismiss={onClose}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="logout-confirm-title">
        <ModalHeader className="block">
          <SectionLabel>{translate('settings.account.logout')}</SectionLabel>
          <h3 id="logout-confirm-title">{translate('logoutConfirm.title')}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          <p className="text-sm leading-6 text-[var(--text-soft)]">
            {translate('logoutConfirm.body')}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            {translate('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void onConfirm()}>
            {translate('logoutConfirm.confirm')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
