// 자원·시스템 섹션. 상태바가 한 줄에 눌러 담던 값을 여기서는 제대로 펼쳐 보여 준다.
//
// 수집은 새로 하지 않는다 — pane 이 돌리는 폴링을 그대로 읽고, 이 섹션이 열려 있는 동안만
// 주기가 3초로 좁아진다(useSessionHostMetrics).
//
// 값은 차트와 함께 보여 준다. 숫자 하나로는 "지금 12%" 만 알 뿐, 보러 온 것(방금 튀었는지,
// 계속 높았는지)을 알 수 없다. 이력은 발행 지점에서 쌓이므로(host-metrics-history) 이 섹션은
// 그리기만 한다.

import { useTranslation } from 'react-i18next';
import { isAwsEc2HostRecord, isSshHostRecord } from '@shared';
import { cn } from '../../../lib/cn';
import { useAppStore } from '../../../store/appStore';
import {
  diskUsedRatio,
  formatKibibytes,
  formatUptime,
  type HostDiskUsage,
} from '../../../lib/host-metrics';
import type { HostRecord } from '@shared';
import { Button } from '../../../ui';
import {
  Activity,
  Boxes,
  Clock,
  Cpu,
  MemoryStick,
  Monitor,
  SquareTerminal,
  Waypoints,
  type LucideIcon,
} from '../../../ui/icons';
import { HostBadge } from '../../host-browser/HostBadge';
import { SessionPanelEmpty } from './SessionPanelEmpty';
import { SessionPanelResourceCharts } from './SessionPanelResourceCharts';
import { useSessionHostMetrics } from './useSessionHostMetrics';

interface SessionPanelResourcesProps {
  sessionId: string;
  /** 이 세션의 호스트. OS·주소를 여기서 읽는다(로컬 터미널처럼 없으면 null). */
  hostId: string | null;
  /** 셸 종류(bash·zsh·powershell). 셸 통합이 알려 준 값. */
  shellKind?: string | null;
  /** 왕복 지연(ms). SSH keepalive·SSM 데이터채널이 재는 값. */
  rttMs?: number | null;
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
  const ratio = diskUsedRatio(disk);
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

/**
 * 요약 한 칸. 값이 없으면 **아예 그리지 않는다** — "—" 로 채운 칸이 늘면 요약이 아니게 된다.
 *
 * 라벨을 위, 값을 아래로 두는 이유: 좁은 패널에서 라벨과 값을 한 줄에 놓으면 값이 먼저 잘린다.
 */
function Fact({
  icon: Icon,
  label,
  value,
  span,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
  /** 두 칸을 다 쓰는 값(CPU 종류·커널처럼 긴 것). */
  span?: boolean;
}) {
  if (!value) {
    return null;
  }
  return (
    <div className={cn('min-w-0', span && 'col-span-2')}>
      <span className="flex items-center gap-1 text-[0.62rem] uppercase tracking-[0.08em] text-[var(--text-muted)]">
        <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span
        className="mt-px block truncate text-[0.74rem] text-[var(--text)]"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function SessionPanelResources({
  sessionId,
  hostId,
  shellKind,
  rttMs,
}: SessionPanelResourcesProps) {
  const { t: translate } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.hostMetricsEnabled ?? false);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const { status, metrics, system } = useSessionHostMetrics(sessionId, {
    system: true,
  });
  const host = useAppStore((state) =>
    hostId ? (state.hosts.find((entry) => entry.id === hostId) ?? null) : null,
  );

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
        {/* 왜 못 읽는지까지 적었더니("백그라운드 명령을 쓸 수 없습니다") 사용자가 할 수 있는
            것도 없는 설명이 한 줄 더 붙는 셈이었다. 제목만 남긴다. */}
        <SessionPanelEmpty
          title={translate('sessionPanel.resources.unsupportedTitle')}
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

  const osLabel = host?.detectedOs?.prettyName ?? host?.detectedOs?.id ?? null;
  // 호스트명은 원격이 알려 준 것을 먼저 쓴다(접속 주소와 실제 이름이 다른 경우가 흔하다).
  const hostLine = [system?.hostname, describeHost(host)]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
      {status === 'paused' ? (
        <p className="mb-2 text-[0.72rem] text-[var(--text-soft)]">
          {translate('sessionPanel.resources.paused')}
        </p>
      ) : null}
      <SessionPanelResourceCharts sessionId={sessionId} metrics={metrics} />
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
      {/* 아래는 **변하지 않는 값들**이다 — 위 타일이 초 단위로 움직이는 값이라면 여기는 이
          호스트가 무엇인지다. 위 숫자를 읽을 때 필요한 기준(코어 수·총 메모리·어떤 OS 인지)이
          여기 있다. 정적 정보는 이 섹션이 열릴 때 한 번만 받아 세션 동안 캐시한다. */}
      <div className="mt-3 overflow-hidden rounded-[10px] border border-[var(--border)]">
        {/* 머리: OS 마크 + 이름, 그 아래 접속 주소. 이 호스트의 "얼굴" 이라 배경을 한 톤 준다. */}
        <div className="flex items-center gap-2 bg-[var(--surface-muted)] px-2.5 py-2">
          {/* OS 마크는 호스트 목록과 같은 것을 쓴다(HostBadge) — 판정을 여기서 또 하면 어떤
              화면은 로고, 어떤 화면은 글자가 되는 상태가 생긴다. 칸만 이 자리에 맞게 줄인다. */}
          {host ? (
            <HostBadge host={host} className="h-[1.4rem] w-[1.4rem] rounded-[6px] text-[0.55rem]" />
          ) : (
            <Monitor className="h-3.5 w-3.5 shrink-0 text-[var(--text-soft)]" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.78rem] font-medium text-[var(--text)]">
              {osLabel ?? translate('sessionPanel.resources.system')}
            </span>
            {hostLine ? (
              <span
                className="block truncate font-mono text-[0.68rem] text-[var(--text-soft)]"
                title={hostLine}
              >
                {hostLine}
              </span>
            ) : null}
          </span>
        </div>
        {/* 값들은 두 칸 격자로. 라벨은 작게 위, 값은 아래 — 세로로 훑을 때 라벨을 다시 읽지
            않아도 위치로 무엇인지 알게 된다. */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 px-2.5 py-2">
          <Fact icon={Cpu} label={translate('sessionPanel.resources.cpuModel')} value={system?.cpuModel ?? null} span />
          <Fact
            icon={Boxes}
            label={translate('sessionPanel.resources.cores')}
            value={metrics.cpuCount === null ? null : String(metrics.cpuCount)}
          />
          <Fact
            icon={MemoryStick}
            label={translate('sessionPanel.resources.memoryTotal')}
            value={metrics.memTotalKb === null ? null : formatKibibytes(metrics.memTotalKb)}
          />
          <Fact icon={Boxes} label={translate('sessionPanel.resources.arch')} value={system?.arch ?? null} />
          <Fact icon={SquareTerminal} label={translate('sessionPanel.resources.shell')} value={shellKind ?? null} />
          <Fact icon={Waypoints} label={translate('sessionPanel.resources.kernel')} value={system?.kernel ?? null} span />
          <Fact
            icon={Clock}
            label={translate('sessionPanel.resources.uptime')}
            value={metrics.uptimeSeconds === null ? null : formatUptime(metrics.uptimeSeconds)}
          />
          <Fact
            icon={Activity}
            label={translate('sessionPanel.resources.latency')}
            value={
              rttMs === null || rttMs === undefined
                ? null
                : translate('sessionPanel.resources.latencyValue', { ms: Math.round(rttMs) })
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 이 호스트를 한 줄로. 종류마다 알아보는 단위가 다르다 — SSH 는 계정@주소, EC2 는 인스턴스다.
 */
function describeHost(host: HostRecord | null): string | null {
  if (!host) {
    return null;
  }
  if (isSshHostRecord(host)) {
    const port = host.port === 22 ? '' : `:${host.port}`;
    return `${host.username}@${host.hostname}${port}`;
  }
  if (isAwsEc2HostRecord(host)) {
    const name = host.awsInstanceName?.trim() || host.awsInstanceId;
    return `${name} · ${host.awsRegion}`;
  }
  return host.label;
}
