import { cn } from '../../lib/cn';
import { IconButton } from '../../ui';

interface TerminalPaneHeaderProps {
  sessionId: string;
  title: string;
  active: boolean;
  draggingDisabled: boolean;
  closingDisabled: boolean;
  onFocus?: () => void;
  onClose?: () => void;
  onStartDrag?: () => void;
  onEndDrag?: () => void;
}

export function TerminalPaneHeader({
  sessionId,
  title,
  active,
  draggingDisabled,
  closingDisabled,
  onFocus,
  onClose,
  onStartDrag,
  onEndDrag,
}: TerminalPaneHeaderProps) {
  return (
    <div
      className={cn(
        'flex cursor-grab select-none items-center justify-between gap-2 rounded-t-[6px] border border-b-0 border-[color-mix(in_srgb,var(--border)_88%,transparent_12%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.55rem] pb-[0.4rem] pt-[0.45rem]',
        active &&
          'bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-muted)_88%)]',
      )}
      draggable={!draggingDisabled}
      onDragStart={(event) => {
        if (draggingDisabled || !onStartDrag) {
          event.preventDefault();
          return;
        }

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-dolssh-session-id', sessionId);
        onStartDrag();
      }}
      onDragEnd={() => {
        onEndDrag?.();
      }}
    >
      <button
        type="button"
        className="min-w-0 flex-1 truncate bg-transparent text-left text-[0.9rem] font-semibold text-[var(--text)]"
        onClick={onFocus}
      >
        {title}
      </button>
      <IconButton
        aria-label={`${title} 세션 종료`}
        tone="ghost"
        size="sm"
        className="h-[1.55rem] w-[1.55rem] rounded-[6px] text-[0.95rem] text-[var(--text-soft)] hover:bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)]"
        onClick={onClose}
        disabled={closingDisabled}
      >
        ×
      </IconButton>
    </div>
  );
}
