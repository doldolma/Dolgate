// 스니펫 삭제 확인.
//
// 확인을 두는 이유가 두 가지다.
//
//  1. 세션 패널의 줄은 좁고, 보내기 버튼(복사·입력·실행) 옆에 삭제가 붙는다. 화면 넓은 설정
//     화면의 큰 버튼과 오클릭 위험이 다르다.
//  2. **스니펫만 사라지지 않는다.** removeSnippet 은 이 스니펫을 시작 명령으로 쓰는 호스트의
//     startupCommand 까지 null 로 만든다(networkSlice). 되돌릴 수 없는 연쇄라 지우기 전에
//     몇 개가 풀리는지 보여 준다.

import { useTranslation } from 'react-i18next';
import { DialogBackdrop } from './DialogBackdrop';
import {
  Button,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
} from '../ui';

interface SnippetDeleteConfirmDialogProps {
  open: boolean;
  /** 지울 스니펫의 이름. 무엇을 지우는지 제목에 그대로 보여 준다. */
  label: string;
  /** 이 스니펫을 시작 명령으로 쓰는 호스트 수. 0 이면 경고를 띄우지 않는다. */
  hostUsageCount: number;
  isDeleting: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function SnippetDeleteConfirmDialog({
  open,
  label,
  hostUsageCount,
  isDeleting,
  errorMessage = null,
  onClose,
  onConfirm,
}: SnippetDeleteConfirmDialogProps) {
  const { t: translate } = useTranslation();
  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop dismissDisabled={isDeleting} onDismiss={onClose}>
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="snippet-delete-title"
      >
        <ModalHeader className="block">
          <SectionLabel>{translate('common.delete')}</SectionLabel>
          <h3 id="snippet-delete-title">{label}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-3">
          <p className="text-sm leading-6 text-[var(--text-soft)]">
            {translate('snippetDelete.body')}
          </p>
          {hostUsageCount > 0 ? (
            <p className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] px-[0.9rem] py-[0.7rem] text-sm leading-6 text-[var(--text)]">
              {translate('snippetDelete.hostUsage', { count: hostUsageCount })}
            </p>
          ) : null}
          {errorMessage ? (
            <p className="text-sm text-[var(--danger-text)]">{errorMessage}</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isDeleting}>
            {translate('common.cancel')}
          </Button>
          <Button variant="danger" disabled={isDeleting} onClick={onConfirm}>
            {translate('common.delete')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
