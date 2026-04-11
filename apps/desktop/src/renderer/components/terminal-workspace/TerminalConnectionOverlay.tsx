import { cn } from '../../lib/cn';
import { Button } from '../../ui';

interface TerminalConnectionOverlayProps {
  error: boolean;
  title: string;
  message: string;
  showRetry?: boolean;
  onRetry?: () => void;
  onClose?: () => void;
}

export function TerminalConnectionOverlay({
  error,
  title,
  message,
  showRetry = true,
  onRetry,
  onClose,
}: TerminalConnectionOverlayProps) {
  return (
    <div
      role={error ? 'alertdialog' : 'status'}
      aria-live={error ? undefined : 'polite'}
      aria-label={title}
      className={cn(
        'absolute inset-0 z-[3] flex items-center justify-center px-[1.2rem] py-[1.2rem] text-center',
        error
          ? 'pointer-events-auto bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] text-[var(--text-soft)]'
          : 'pointer-events-none bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] text-[var(--text-soft)]',
      )}
    >
      <div className="grid w-[min(24rem,100%)] content-center justify-items-center gap-[0.9rem] rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-5 py-5 text-center shadow-[var(--shadow-soft)]">
        <div className="grid w-full justify-items-center gap-[0.55rem] text-center">
          <strong className="block w-full text-center text-[0.92rem] uppercase tracking-[0.08em] text-[var(--text)]">
            {title}
          </strong>
          <p className="mx-auto w-full max-w-[20rem] text-center text-[0.86rem] leading-[1.5]">
            {message}
          </p>
        </div>
        {error ? (
          <div className="flex w-full justify-end gap-[0.65rem] pt-[0.35rem]">
            {showRetry ? (
              <Button type="button" variant="secondary" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
