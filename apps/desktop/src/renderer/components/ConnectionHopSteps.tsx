import { cn } from '../lib/cn';
import type { TerminalConnectionHop } from '@shared';
import { useTranslation } from 'react-i18next';

// 다단 ProxyJump 연결의 홉 타임라인(공통). 터미널·SFTP·컨테이너 오버레이가 재사용한다.
// 각 홉: 상태 점(연결됨/실패/진행) + 이름(선택)·계정 주소 + 상태 텍스트. 비었으면 미표시.
export function ConnectionHopSteps({
  steps,
}: {
  steps?: readonly (TerminalConnectionHop & { name?: string | null })[] | null;
}) {
  const { t: translate } = useTranslation();
  if (!steps || steps.length === 0) {
    return null;
  }
  return (
    <ol className="grid w-full gap-[0.35rem] text-left">
      {steps.map((step) => (
        <li key={step.index} className="flex items-center gap-[0.5rem]">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block h-[0.5rem] w-[0.5rem] shrink-0 rounded-full',
              step.stage === 'connected'
                ? 'bg-[var(--success-text)]'
                : step.stage === 'failed'
                  ? 'bg-[var(--danger-text)]'
                  : 'animate-pulse bg-[var(--accent-strong)]',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[0.8rem]">
            {step.count > 1 ? (
              <span className="text-[var(--text-muted)]">
                {step.index}/{step.count} ·{' '}
              </span>
            ) : null}
            {step.name ? (
              <>
                <span className="font-medium text-[var(--text)]">
                  {step.name}
                </span>
                <span className="text-[var(--text-muted)]"> · {step.label}</span>
              </>
            ) : (
              <span className="text-[var(--text-soft)]">{step.label}</span>
            )}
          </span>
          <span className="shrink-0 text-[0.72rem] text-[var(--text-muted)]">
            {step.stage === 'connected'
              ? translate('hopSteps.connected')
              : step.stage === 'failed'
                ? translate('hopSteps.failed')
                : translate('hopSteps.connecting')}
          </span>
        </li>
      ))}
    </ol>
  );
}
