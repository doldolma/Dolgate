import { cn } from '../lib/cn';
import { Button } from '../ui';

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
}: ConnectionStatusOverlayProps) {
  const interactive = error || showCancel;
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
        {error ? (
          <div className="flex w-full justify-end gap-[0.7rem] pt-[0.4rem]">
            {showRetry ? (
              <Button type="button" variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : showCancel ? (
          <div className="flex w-full justify-end pt-[0.4rem]">
            <Button type="button" variant="secondary" onClick={onCancel}>
              재연결 취소
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
