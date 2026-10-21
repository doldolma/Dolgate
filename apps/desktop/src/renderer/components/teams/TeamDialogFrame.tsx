import { useId, type ReactNode } from 'react';
import { DialogBackdrop } from '../DialogBackdrop';
import { ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../../ui';

interface TeamDialogFrameProps {
  /** 머리 위 작은 영어 이름(Team·Invite·Member·Leave·Delete). */
  section: string;
  title: ReactNode;
  /** 일하는 동안은 바깥을 눌러도 닫지 않는다. */
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}

/** 팀 창들의 틀 — 호스트 삭제 창과 같은 모양(머리·`grid gap-4` 본문·오른쪽 정렬 단추). */
export function TeamDialogFrame({ section, title, busy = false, onClose, footer, children }: TeamDialogFrameProps) {
  const titleId = useId();
  return (
    <DialogBackdrop dismissDisabled={busy} onDismiss={onClose}>
      <ModalShell size="sm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <ModalHeader className="block">
          <SectionLabel>{section}</SectionLabel>
          <h3 id={titleId} className="break-words">
            {title}
          </h3>
        </ModalHeader>
        <ModalBody className="grid gap-4">{children}</ModalBody>
        <ModalFooter>{footer}</ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

/** 창 안의 실패 한 줄. */
export function TeamDialogError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <p role="alert" className="m-0 text-sm text-[var(--danger-text)]">
      {message}
    </p>
  );
}
