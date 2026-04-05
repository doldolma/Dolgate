import type { SessionShareChatMessage } from '@shared';
import { cn } from '../../lib/cn';
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
    <div
      className="pointer-events-none absolute bottom-[0.85rem] right-[0.85rem] z-[3] flex h-[240px] w-[320px] flex-col justify-end gap-[0.55rem] overflow-hidden bg-transparent"
      aria-live="polite"
    >
      {notifications.map((notification) => (
        <div
          key={notification.id}
          data-testid="terminal-share-toast"
          className="ml-auto w-[min(100%,320px)] rounded-[14px_14px_6px_14px] border border-[var(--share-border)] bg-[var(--share-surface)] px-[0.8rem] py-[0.7rem]"
        >
          <div className="mb-[0.35rem] flex items-center justify-between gap-3 text-[0.78rem] text-[var(--share-text-soft)]">
            <strong className="text-[0.82rem] font-bold text-[var(--share-text)]">
              {notification.nickname}
            </strong>
            <span>{formatSessionShareChatTimestamp(notification.sentAt)}</span>
          </div>
          <p
            className={cn(
              'm-0 whitespace-pre-wrap break-words text-[0.84rem] leading-[1.45] text-[var(--share-text)]',
            )}
          >
            {notification.text}
          </p>
        </div>
      ))}
    </div>
  );
}
