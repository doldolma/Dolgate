import { cn } from '../lib/cn';
import { Button } from '../ui';
import type { TerminalConnectionHop } from '@shared';
import { ConnectionHopSteps } from './ConnectionHopSteps';
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
