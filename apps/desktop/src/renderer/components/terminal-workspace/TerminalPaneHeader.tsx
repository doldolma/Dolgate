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
      className={`terminal-pane-header ${active ? 'active' : ''}`}
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
        className="terminal-pane-header__title"
        onClick={onFocus}
      >
        {title}
      </button>
      <button
        type="button"
        className="terminal-pane-header__close"
        aria-label={`${title} 세션 종료`}
        onClick={onClose}
        disabled={closingDisabled}
      >
        ×
      </button>
    </div>
  );
}
