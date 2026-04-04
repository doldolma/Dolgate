import type { PendingHostKeyPrompt } from '../store/createAppStore';
import { DialogBackdrop } from './DialogBackdrop';
import { Button, IconButton, ModalBody, ModalFooter, ModalHeader, ModalShell, SectionLabel } from '../ui';

interface KnownHostPromptDialogProps {
  pending: PendingHostKeyPrompt | null;
  onAccept: (mode: 'trust' | 'replace') => Promise<void>;
  onCancel: () => void;
  onOpenSecuritySettings?: () => void;
}

export function KnownHostPromptDialog({ pending, onAccept, onCancel, onOpenSecuritySettings }: KnownHostPromptDialogProps) {
  if (!pending) {
    return null;
  }

  const isMismatch = pending.probe.status === 'mismatch';

  return (
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell className="known-host-dialog" role="dialog" aria-modal="true" aria-labelledby="known-host-title">
        <ModalHeader>
          <div>
            <SectionLabel>Known Hosts</SectionLabel>
            <h3 id="known-host-title">{isMismatch ? '호스트 키가 변경되었습니다.' : '새 호스트 키를 확인해 주세요.'}</h3>
          </div>
          <IconButton type="button" onClick={onCancel} aria-label="Close known host prompt">
            ×
          </IconButton>
        </ModalHeader>

        <ModalBody>
          <div className="known-host-dialog__summary">
            <div className="known-host-dialog__summary-field">
              <span className="field-label">Host:</span>
              <strong>
                {pending.probe.hostLabel} (
                {pending.probe.targetDescription ??
                  `${pending.probe.host}:${pending.probe.port}`}
                )
              </strong>
            </div>
            <div className="known-host-dialog__summary-field">
              <span className="field-label">Algorithm:</span>
              <strong>{pending.probe.algorithm}</strong>
            </div>
          </div>

          <div className="known-host-dialog__fingerprints">
            {pending.probe.existing ? (
              <div className="known-host-dialog__fingerprint-card">
                <span className="field-label">저장된 지문</span>
                <code>{pending.probe.existing.fingerprintSha256}</code>
              </div>
            ) : null}
            <div className="known-host-dialog__fingerprint-card">
              <span className="field-label">현재 서버 지문</span>
              <code>{pending.probe.fingerprintSha256}</code>
            </div>
          </div>

          <p className="known-host-dialog__help">
            {isMismatch
              ? '저장된 호스트 키와 현재 서버 키가 다릅니다. 정말 교체할 서버인지 확인한 뒤 진행하세요.'
              : '처음 연결하는 서버입니다. 지문을 확인한 뒤 신뢰 목록에 저장하면 이후부터 엄격하게 검증합니다.'}
          </p>
        </ModalBody>

        <ModalFooter>
          {onOpenSecuritySettings ? (
            <Button variant="ghost" onClick={onOpenSecuritySettings}>
              Security settings
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
          <Button variant="primary" onClick={() => void onAccept(isMismatch ? 'replace' : 'trust')}>
            {isMismatch ? '교체 후 계속' : '저장 후 계속'}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
