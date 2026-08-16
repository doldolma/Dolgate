import { useTranslation } from 'react-i18next';
import type { PendingHostKeyPrompt } from '../../store/types';
import { Button } from '../../ui';

interface TerminalHostKeyTrustCardProps {
  pending: PendingHostKeyPrompt;
  onAccept: (mode: 'trust' | 'replace') => void;
  onCancel: () => void;
}

/**
 * 서버 키를 신뢰할지 **그 탭 안에서** 묻는다.
 *
 * **왜 전역 대화상자가 아닌가:** 이 물음은 연결 하나의 것이고, 연결에는 탭이 있다. 전역으로 띄우면
 * 연결을 여러 개 걸었을 때 보고 있던 탭 위로 남의 물음이 올라오고, 그 탭으로 화면이 끌려간다 —
 * 실기기에서 탭이 계속 튕겼다. 같은 이유로 대화형 인증(OTP)은 이미 판 안 카드다. 그 옆자리에
 * 같은 모양으로 둔다.
 *
 * 탭이 없는 연결(포워딩·SFTP·컨테이너·공개 키 설치)은 지금처럼 전역 대화상자가 받는다.
 */
export function TerminalHostKeyTrustCard({
  pending,
  onAccept,
  onCancel,
}: TerminalHostKeyTrustCardProps) {
  const { t: translate } = useTranslation();
  const isMismatch = pending.probe.status === 'mismatch';

  return (
    // 인증 카드와 같은 자리·같은 규칙으로 띄운다 — 흐름 안에 두면 터미널 크기가 바뀐다.
    <div
      role="dialog"
      aria-modal="false"
      aria-label={translate(
        isMismatch ? 'knownHostPrompt.mismatchTitle' : 'knownHostPrompt.newTitle',
      )}
      className="absolute top-[0.35rem] left-1/2 z-20 grid w-full max-w-[28rem] -translate-x-1/2 gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--surface-raised)_84%,var(--accent-strong)_16%)] px-5 py-5 text-[var(--text)] shadow-[var(--shadow-soft)]"
    >
      <strong className="text-[0.95rem]">
        {translate(
          isMismatch ? 'knownHostPrompt.mismatchTitle' : 'knownHostPrompt.newTitle',
        )}
      </strong>

      <p className="flex flex-wrap items-baseline gap-2 text-sm text-[var(--text-soft)]">
        <span>{translate('authOverlay.hopLabel')}</span>
        <code className="rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-1.5 py-0.5 text-[0.82rem] break-all text-[var(--text)]">
          {pending.probe.hostLabel} (
          {pending.probe.targetDescription ??
            `${pending.probe.host}:${pending.probe.port}`}
          )
        </code>
      </p>

      {/* 키가 바뀐 경우에는 저장된 지문을 함께 보여 준다 — 대조할 것이 없으면 판단할 수 없다. */}
      {pending.probe.existing ? (
        <div className="grid gap-[0.3rem]">
          <span className="text-[0.78rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
            {translate('knownHostPrompt.savedFingerprint')}
          </span>
          <code className="break-all rounded-[8px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-2 py-1.5 text-[0.78rem]">
            {pending.probe.existing.fingerprintSha256}
          </code>
        </div>
      ) : null}

      <div className="grid gap-[0.3rem]">
        <span className="text-[0.78rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
          {translate('knownHostPrompt.currentFingerprint')}
        </span>
        <code className="break-all rounded-[8px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-2 py-1.5 text-[0.78rem]">
          {pending.probe.fingerprintSha256}
        </code>
      </div>

      <p className="text-[0.85rem] leading-[1.6] text-[var(--text-soft)]">
        {translate(
          isMismatch ? 'knownHostPrompt.mismatchHint' : 'knownHostPrompt.newHint',
        )}
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {translate('common.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => onAccept(isMismatch ? 'replace' : 'trust')}
        >
          {translate(
            isMismatch
              ? 'knownHostPrompt.replaceContinue'
              : 'knownHostPrompt.saveContinue',
          )}
        </Button>
      </div>
    </div>
  );
}
