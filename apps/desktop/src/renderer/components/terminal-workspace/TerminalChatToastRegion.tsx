import type { SessionShareChatMessage } from '@shared';
import { formatSessionShareChatTimestamp } from './terminalSessionHelpers';

interface TerminalChatToastRegionProps {
  notifications: SessionShareChatMessage[];
}

export function TerminalChatToastRegion({
  notifications,
}: TerminalChatToastRegionProps) {
  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="terminal-share-chat-toast-region" aria-live="polite">
      {notifications.map((notification) => (
        <div key={notification.id} className="terminal-share-chat-toast">
          <div className="terminal-share-chat-toast__meta">
            <strong>{notification.nickname}</strong>
            <span>{formatSessionShareChatTimestamp(notification.sentAt)}</span>
          </div>
          <p>{notification.text}</p>
        </div>
      ))}
    </div>
  );
}
