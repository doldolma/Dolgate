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
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="known-host-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Known Hosts</SectionLabel>
            <h3 id="known-host-title">{isMismatch ? '호스트 키가 변경되었습니다.' : '새 호스트 키를 확인해 주세요.'}</h3>
          </div>
          <IconButton type="button" onClick={onCancel} aria-label="Close known host prompt">
            ×
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-[0.3rem] rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.8rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">Host</span>
              <strong>
                {pending.probe.hostLabel} (
                {pending.probe.targetDescription ??
                  `${pending.probe.host}:${pending.probe.port}`}
                )
              </strong>
            </div>
            <div className="grid gap-[0.3rem] rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.8rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">Algorithm</span>
              <strong>{pending.probe.algorithm}</strong>
            </div>
          </div>

          <div className="grid gap-3">
            {pending.probe.existing ? (
              <div className="grid gap-[0.45rem] rounded-[16px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent_10%)] px-[0.95rem] py-[0.9rem]">
                <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">저장된 지문</span>
                <code className="break-all rounded-[12px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-2 text-[0.82rem]">{pending.probe.existing.fingerprintSha256}</code>
              </div>
            ) : null}
            <div className="grid gap-[0.45rem] rounded-[16px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent_10%)] px-[0.95rem] py-[0.9rem]">
              <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">현재 서버 지문</span>
              <code className="break-all rounded-[12px] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-3 py-2 text-[0.82rem]">{pending.probe.fingerprintSha256}</code>
            </div>
          </div>

          <p className="text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">
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
