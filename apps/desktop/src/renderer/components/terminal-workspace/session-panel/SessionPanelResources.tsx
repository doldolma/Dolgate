// 자원·시스템 섹션. 상태바가 한 줄에 눌러 담던 값을 여기서는 제대로 펼쳐 보여 준다.
//
// 수집은 새로 하지 않는다 — pane 이 돌리는 폴링을 그대로 읽고, 이 섹션이 열려 있는 동안만
// 주기가 3초로 좁아진다(useSessionHostMetrics).

import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../store/appStore';
import {
  formatBytesPerSecond,
  formatKibibytes,
  formatPercent,
  formatUptime,
  type HostDiskUsage,
} from '../../../lib/host-metrics';
import { Button } from '../../../ui';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { useSessionHostMetrics } from './useSessionHostMetrics';

interface SessionPanelResourcesProps {
  sessionId: string;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[9px] bg-[var(--surface-muted)] px-2.5 py-2">
      <p className="truncate text-[0.68rem] uppercase tracking-[0.1em] text-[var(--text-soft)]">
        {label}
      </p>
      <p className="mt-0.5 truncate text-[0.9rem] font-medium tabular-nums text-[var(--text)]">
        {value}
      </p>
    </div>
  );
}

/** 사용률 막대. 숫자만으로는 "많이 쓰는지" 가 한눈에 안 들어온다. */
function UsageBar({ ratio }: { ratio: number }) {
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--surface-strong)]">
      <div
        className="h-full rounded-full bg-[var(--accent-strong)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function DiskRow({ disk }: { disk: HostDiskUsage }) {
  const ratio = disk.totalKb > 0 ? disk.usedKb / disk.totalKb : 0;
  return (
    <div className="px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-[var(--text)]">
          {disk.mount}
        </span>
        <span className="shrink-0 text-[0.7rem] tabular-nums text-[var(--text-soft)]">
          {formatKibibytes(disk.usedKb)} / {formatKibibytes(disk.totalKb)}
        </span>
      </div>
      <UsageBar ratio={ratio} />
    </div>
  );
}

export function SessionPanelResources({ sessionId }: SessionPanelResourcesProps) {
  const { t: translate } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.hostMetricsEnabled ?? false);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const { status, metrics } = useSessionHostMetrics(sessionId);

  // 꺼 둔 사용자에게 몰래 켜지 않는다. 대신 죽은 화면으로 두지도 않는다 — 버튼을 누르는 것은
  // 사용자의 행동이다.
  if (!enabled) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.resources.disabledTitle')}
          description={translate('sessionPanel.resources.disabled')}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void updateSettings({ hostMetricsEnabled: true });
            }}
          >
            {translate('sessionPanel.resources.enable')}
          </Button>
        </SessionPanelEmpty>
      </div>
    );
  }

  if (status === 'unsupported' || (status === 'off' && !metrics)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        <SessionPanelEmpty
          title={translate('sessionPanel.resources.unsupportedTitle')}
          description={translate('sessionPanel.resources.unsupported')}
        />
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <p className="text-[0.78rem] text-[var(--text-soft)]">
          {translate('sessionPanel.resources.loading')}
        </p>
      </div>
    );
  }

  const memRatio =
    metrics.memUsedKb !== null && metrics.memTotalKb
      ? metrics.memUsedKb / metrics.memTotalKb
      : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
      {status === 'paused' ? (
        <p className="mb-2 text-[0.72rem] text-[var(--text-soft)]">
          {translate('sessionPanel.resources.paused')}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        <Metric label="CPU" value={formatPercent(metrics.cpuPercent)} />
        <Metric
          label={translate('sessionPanel.resources.load')}
          value={
            metrics.loadAvg1 === null
              ? '—'
              : `${metrics.loadAvg1.toFixed(2)}${
                  metrics.cpuCount ? ` / ${metrics.cpuCount}` : ''
                }`
          }
        />
      </div>
      <div className="mt-1.5 rounded-[9px] bg-[var(--surface-muted)] px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className="flex-1 text-[0.68rem] uppercase tracking-[0.1em] text-[var(--text-soft)]">
            RAM
          </span>
          <span className="text-[0.8rem] tabular-nums text-[var(--text)]">
            {formatKibibytes(metrics.memUsedKb)} / {formatKibibytes(metrics.memTotalKb)}
          </span>
        </div>
        {memRatio === null ? null : <UsageBar ratio={memRatio} />}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <Metric label="NET ↓" value={formatBytesPerSecond(metrics.rxBytesPerSec)} />
        <Metric label="NET ↑" value={formatBytesPerSecond(metrics.txBytesPerSec)} />
        <Metric label="DISK R" value={formatBytesPerSecond(metrics.diskReadBytesPerSec)} />
        <Metric label="DISK W" value={formatBytesPerSecond(metrics.diskWriteBytesPerSec)} />
      </div>
      <div className="mt-1.5">
        <Metric
          label={translate('sessionPanel.resources.uptime')}
          value={formatUptime(metrics.uptimeSeconds)}
        />
      </div>
      {metrics.disks.length > 0 ? (
        <div className="mt-2.5">
          <p className="px-2.5 text-[0.68rem] uppercase tracking-[0.1em] text-[var(--text-soft)]">
            {translate('sessionPanel.resources.disks')}
          </p>
          <div className="mt-1">
            {metrics.disks.map((disk) => (
              <DiskRow key={disk.mount} disk={disk} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
