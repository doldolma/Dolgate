import { cn } from '../lib/cn';
import { Button } from '../ui';
import type { TerminalConnectionHop } from '@shared';
import { ConnectionHopSteps } from './ConnectionHopSteps';
import {
  describeConnectionStage,
} from './terminal-workspace/connectionStages';
import type { ConnectionStage, ConnectionStageState } from './terminal-workspace/connectionStages';
import { useTranslation } from 'react-i18next';

export interface ConnectionStatusOverlayProps {
  error: boolean;
  title: string;
  message: string;
  showRetry?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
  /** 자동 재연결 진행 중 표시되는 취소 버튼(에러가 아니어도 상호작용 가능). */
  showCancel?: boolean;
  onCancel?: () => void;
  /** 취소 버튼 문구. 없으면 재연결 취소 문구를 쓴다. */
  cancelLabel?: string;
  /**
   * 진행 중(에러 아님)에 함께 보여줄 보조 동작.
   *
   * 브라우저에서 사람이 무언가 해야 하는 단계에서 "브라우저 다시 열기" 로 쓴다 — AWS·warpgate
   * 로그인이 각자 화면에서 제공하는 것과 같은 동작을 연결 오버레이에서도 쓸 수 있게 한다.
   */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  /** 다단 ProxyJump 연결 시 각 홉의 진행 상태(비었으면 미표시). name은 사용자 지정 호스트 이름(선택). */
  steps?: readonly (TerminalConnectionHop & { name?: string | null })[] | null;
  /**
   * 이 연결이 무엇을 거치고 있는지 그대로 보여주는 줄들.
   *
   * 한 줄 진행 문구로는 "연결하는 중" 밖에 말할 수 없어서, 무엇 때문에 못 붙는지 사용자가 알
   * 방법이 없다. tailnet 처럼 별도 계층을 거치는 연결은 그 계층의 상태가 그대로 보여야 한다.
   */
  notes?: readonly string[] | null;
  /**
   * 이 연결이 거치는 단계들. 비었으면 미표시.
   *
   * 한 줄 진행 문구는 새 단계가 앞 단계를 덮어써서, 빨리 지나간 단계는 사용자가 못 본 것과 같고
   * 실패했을 때 어디까지 갔는지도 알 수 없다. 단계를 남기면 무엇을 거쳤는지, 어디서 막혔는지
   * 그대로 보인다 — Tailscale 때문인지 SSH 가 거절한 것인지가 여기서 갈린다.
   */
  stages?: readonly ConnectionStage[] | null;
}

export function ConnectionStatusOverlay({
  error,
  title,
  message,
  showRetry = true,
  onRetry,
  onClose,
  showCancel = false,
  onCancel,
  cancelLabel,
  secondaryActionLabel,
  onSecondaryAction,
  steps,
  notes,
  stages,
}: ConnectionStatusOverlayProps) {
  const { t: translate } = useTranslation();
  const hasSecondaryAction = Boolean(secondaryActionLabel && onSecondaryAction);
  const interactive = error || showCancel || hasSecondaryAction;
  return (
    <div
      role={error ? 'alertdialog' : 'status'}
      aria-live={error ? undefined : 'polite'}
      aria-label={title}
      className={cn(
        'absolute inset-0 z-[3] flex items-center justify-center px-[1.1rem] py-[1.1rem] text-center',
        interactive
          ? 'pointer-events-auto bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] text-[var(--text-soft)]'
          : 'pointer-events-none bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] text-[var(--text-soft)]',
      )}
    >
      <div className="grid w-[min(24rem,100%)] content-center justify-items-center gap-[0.9rem] rounded-[12px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-5 py-5 text-center shadow-[var(--shadow-soft)]">
        <div className="grid w-full justify-items-center gap-[0.55rem] text-center">
          <strong className="block w-full text-center text-[0.9rem] uppercase tracking-[0.08em] text-[var(--text)]">
            {title}
          </strong>
          <p className="mx-auto w-full max-w-[20rem] text-center text-[0.82rem] leading-[1.5]">
            {message}
          </p>
        </div>
        {stages?.length ? <ConnectionStageList stages={stages} /> : null}
        {notes?.length ? (
          <ul className="w-full space-y-[0.15rem] text-left font-mono text-[0.68rem] leading-[1.5] text-[var(--text-subtle)]">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        <ConnectionHopSteps steps={steps} />
        {error ? (
          <div className="flex w-full justify-end gap-[0.7rem] pt-[0.4rem]">
            {/* 실패에도 사용자가 그 자리에서 할 수 있는 일이 있을 수 있다(예: tailnet 재인증).
                다른 화면으로 보내지 않고 여기서 끝내게 한다. */}
            {hasSecondaryAction ? (
              <Button type="button" variant="primary" onClick={onSecondaryAction}>
                {secondaryActionLabel}
              </Button>
            ) : null}
            {showRetry ? (
              <Button type="button" variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : showCancel || hasSecondaryAction ? (
          <div className="flex w-full justify-end gap-[0.7rem] pt-[0.4rem]">
            {hasSecondaryAction ? (
              <Button type="button" variant="primary" onClick={onSecondaryAction}>
                {secondaryActionLabel}
              </Button>
            ) : null}
            {showCancel ? (
              <Button type="button" variant="secondary" onClick={onCancel}>
                {cancelLabel ?? translate('misc.cancelReconnect')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 단계 상태를 한눈에 읽히는 표시로. 색보다 기호가 먼저 읽힌다. */
const stageMark: Record<ConnectionStageState, string> = {
  pending: '·',
  active: '···',
  blocked: '!',
  done: '✓',
  failed: '✗',
  warn: '⚠',
};

const stageTone: Record<ConnectionStageState, string> = {
  pending: 'text-[var(--text-subtle)]',
  active: 'text-[var(--text)]',
  blocked: 'text-[var(--warning-strong,var(--text))]',
  done: 'text-[var(--success-strong,var(--text-soft))]',
  failed: 'text-[var(--danger-strong,var(--text))]',
  warn: 'text-[var(--warning-strong,var(--text-soft))]',
};

function ConnectionStageList({ stages }: { stages: readonly ConnectionStage[] }) {
  const { t: translate } = useTranslation();
  let lastGroup: ConnectionStage['group'] | null = null;

  return (
    <ol className="w-full space-y-[0.2rem] text-left text-[0.78rem] leading-[1.45]">
      {stages.map((stage) => {
        const groupChanged = stage.group !== lastGroup;
        lastGroup = stage.group;
        const described = describeConnectionStage(stage);
        return (
          <li key={stage.id}>
            {groupChanged ? (
              <div className="mt-[0.45rem] mb-[0.15rem] text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-subtle)] first:mt-0">
                {translate(
                  stage.group === 'tailscale'
                    ? 'connectStages.groupTailscale'
                    : 'connectStages.groupHost',
                )}
              </div>
            ) : null}
            <div className="flex items-baseline gap-[0.45rem]">
              <span className={cn('w-[1.1rem] shrink-0 text-center', stageTone[stage.state])}>
                {stageMark[stage.state]}
              </span>
              <span className={cn('flex-1', stageTone[stage.state])}>
                {described.label}
                {described.detail ? (
                  <span className="block text-[0.72rem] text-[var(--text-subtle)]">
                    {described.detail}
                  </span>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
