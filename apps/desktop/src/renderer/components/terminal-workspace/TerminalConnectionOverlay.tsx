import { Button } from '../../ui';

interface TerminalConnectionOverlayProps {
  error: boolean;
  title: string;
  message: string;
  onRetry?: () => void;
  onClose?: () => void;
}

export function TerminalConnectionOverlay({
  error,
  title,
  message,
  onRetry,
  onClose,
}: TerminalConnectionOverlayProps) {
  return (
    <div
      className={`terminal-connection-overlay ${
        error
          ? 'terminal-connection-overlay--error'
          : 'terminal-connection-overlay--blocking'
      }`}
    >
      <div className="terminal-connection-overlay__card">
        <div className="terminal-connection-overlay__copy">
          <strong className="terminal-connection-overlay__title">{title}</strong>
          <p className="terminal-connection-overlay__message">{message}</p>
        </div>
        {error ? (
          <div className="terminal-connection-overlay__actions">
            <Button type="button" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
