import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { Circle, RefreshCw, type LucideIcon } from '../../ui/icons';
import { useTranslation } from 'react-i18next';
import { t } from '../../i18n';

type MoshConnectionState = 'connected' | 'reconnecting' | 'disconnected';

interface TerminalMoshStatusBarProps {
  state: MoshConnectionState;
  lastResponseAt: string | null;
}

const STATE_META: Record<
  MoshConnectionState,
  { Icon: LucideIcon; labelKey: string; color: string; spin?: boolean; fill?: boolean }
> = {
  connected: { Icon: Circle, labelKey: 'mosh.connected', color: 'var(--success-text)', fill: true },
  reconnecting: {
    Icon: RefreshCw,
    labelKey: 'mosh.reconnecting',
    color: 'var(--warning-text)',
    spin: true,
  },
  disconnected: { Icon: Circle, labelKey: 'mosh.disconnected', color: 'var(--danger-text)', fill: true },
};

function formatAgo(lastResponseAt: string | null, now: number): string | null {
  if (!lastResponseAt) {
    return null;
  }
  const parsed = Date.parse(lastResponseAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 1) {
    return t('mosh.justNow');
  }
  if (seconds < 60) {
    return t('mosh.seconds', { count: seconds });
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t('mosh.minutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  return t('mosh.hours', { count: hours });
}

// mosh 세션의 연결 상태를 보여주는 터미널 하단 1줄 바. mosh는 UDP라 끊겨도 세션이
// 유지되므로, 사용자가 "지금 연결됐는지 / 재연결 중인지"를 늘 확인할 수 있게 한다.
export function TerminalMoshStatusBar({
  state,
  lastResponseAt,
}: TerminalMoshStatusBarProps) {
  const { t: translate } = useTranslation();
  // "N초 전 응답"을 흐르게 하려고 비정상 상태에서만 1초마다 리렌더한다(연결됨이면 불필요).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state === 'connected') {
      return;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [state]);

  const meta = STATE_META[state];
  const ago = state === 'connected' ? null : formatAgo(lastResponseAt, now);

  return (
    <div
      className="mx-[0.35rem] mb-[0.2rem] flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-[0.7rem] py-[0.25rem] text-[0.7rem] text-[var(--text-muted)]"
      role="status"
      aria-live="polite"
    >
      <span
        className={cn('inline-flex leading-none', meta.spin && 'animate-spin')}
        style={{ color: meta.color }}
        aria-hidden
      >
        <meta.Icon className="h-3 w-3" fill={meta.fill ? 'currentColor' : 'none'} />
      </span>
      <span className="font-medium text-[var(--text)]">Mosh</span>
      <span aria-hidden>·</span>
      <span>{translate(meta.labelKey)}</span>
      {ago ? (
        <>
          <span aria-hidden>·</span>
          <span>{translate('mosh.reply', { ago })}</span>
        </>
      ) : null}
    </div>
  );
}
