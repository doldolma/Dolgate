import { Button, Card } from '../../ui';

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
      <Card className="terminal-connection-overlay__card grid w-full max-w-[24rem] gap-3 p-5 text-center">
        <strong className="block w-full text-center">{title}</strong>
        <span className="block w-full text-center">{message}</span>
        {error ? (
          <div className="terminal-connection-overlay__actions flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
