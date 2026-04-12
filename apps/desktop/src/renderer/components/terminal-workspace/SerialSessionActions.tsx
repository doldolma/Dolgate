import { useEffect, useMemo, useRef, useState } from 'react';
import { isSerialHostRecord, type HostRecord, type SerialControlAction } from '@shared';
import { sendSerialControl } from '../../services/desktop/serial';
import { Button } from '../../ui';
import { cn } from '../../lib/cn';

interface SerialSessionActionsProps {
  sessionId: string;
  host?: HostRecord;
  connected: boolean;
  onNotice?: (message: string | null) => void;
}

interface SerialActionItem {
  key: string;
  label: string;
  action: SerialControlAction;
  enabled?: boolean;
}

const serialActionItems: SerialActionItem[] = [
  { key: 'break', label: 'Send Break', action: 'break' },
  { key: 'assert-dtr', label: 'Assert DTR', action: 'set-dtr', enabled: true },
  { key: 'clear-dtr', label: 'Clear DTR', action: 'set-dtr', enabled: false },
  { key: 'assert-rts', label: 'Assert RTS', action: 'set-rts', enabled: true },
  { key: 'clear-rts', label: 'Clear RTS', action: 'set-rts', enabled: false },
];

export function SerialSessionActions({
  sessionId,
  host,
  connected,
  onNotice,
}: SerialSessionActionsProps) {
  const [open, setOpen] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const supported = Boolean(
    connected &&
      host &&
      isSerialHostRecord(host) &&
      host.transport !== 'raw-tcp',
  );

  const menuItems = useMemo(() => serialActionItems, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', close);
    return () => {
      window.removeEventListener('mousedown', close);
    };
  }, [open]);

  useEffect(() => {
    if (!supported) {
      setOpen(false);
      setPendingKey(null);
    }
  }, [supported]);

  if (!supported) {
    return null;
  }

  async function handleAction(item: SerialActionItem) {
    setPendingKey(item.key);
    onNotice?.(null);
    try {
      await sendSerialControl({
        sessionId,
        action: item.action,
        enabled: item.enabled,
      });
      setOpen(false);
    } catch (error) {
      onNotice?.(
        error instanceof Error
          ? error.message
          : '시리얼 제어 액션을 실행하지 못했습니다.',
      );
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        aria-label="Serial session actions"
        variant="secondary"
        size="sm"
        active={open}
        className="min-h-9 rounded-full px-3.5 text-[0.92rem]"
        onClick={() => setOpen((current) => !current)}
      >
        Control
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Serial session actions menu"
          className={cn(
            'absolute right-0 top-[calc(100%+0.45rem)] z-[8] grid min-w-[11rem] gap-[0.35rem] rounded-[18px] border border-[var(--border)] bg-[var(--surface-elevated)] p-[0.45rem] shadow-[var(--shadow-soft)]',
          )}
        >
          {menuItems.map((item) => (
            <Button
              key={item.key}
              role="menuitem"
              variant="ghost"
              size="sm"
              className="justify-start rounded-[12px] px-3 text-left"
              disabled={pendingKey !== null}
              onClick={() => {
                void handleAction(item);
              }}
            >
              {pendingKey === item.key ? 'Working...' : item.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
