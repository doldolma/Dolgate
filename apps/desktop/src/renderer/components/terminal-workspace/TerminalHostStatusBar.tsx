// 접속한 원격 호스트의 부하를 보여주는 터미널 하단 1줄 바.
//
// 한 줄에 CPU·메모리·네트워크만 둔다. load average·코어 수·uptime·디스크처럼 초 단위로
// 변하지 않거나 덜 급한 값은 hover 툴팁으로 미룬다 — 상시 표시 항목이 늘수록 "한눈에"가
// 무너진다.

import { useState } from 'react';
import { cn } from '../../lib/cn';
import { RefreshCw } from '../../ui/icons';
import {
  formatBytesPerSecond,
  formatKibibytes,
  formatPercent,
  formatUptime,
  isHostMetricAlarming,
  type HostMetrics,
} from '../../lib/host-metrics';
import type { HostMetricsStatus } from '../../controllers/useHostMetrics';

interface TerminalHostStatusBarProps {
  status: HostMetricsStatus;
  metrics: HostMetrics | null;
  onRetry: () => void;
}

function Metric({
  label,
  value,
  alarming,
}: {
  label: string;
  value: string;
  alarming?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-[var(--text-soft)]">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          alarming ? 'font-semibold text-[var(--danger-text)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </span>
    </span>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[var(--text-soft)]">{label}</span>
      <span className="tabular-nums text-[var(--text)]">{value}</span>
    </div>
  );
}

function formatRatio(usedKb: number | null, totalKb: number | null): string {
  if (usedKb === null || !totalKb) {
    return '—';
  }
  return `${formatKibibytes(usedKb)} / ${formatKibibytes(totalKb)}`;
}

function formatCpuCount(cpuCount: number | null): string {
  return cpuCount ? `${cpuCount}개` : '—';
}

export function TerminalHostStatusBar({
  status,
  metrics,
  onRetry,
}: TerminalHostStatusBarProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  // 이 연결에서 못 읽는 경우엔 바 자체를 그리지 않는다. 빈 값이 계속 떠 있으면 고장으로 보인다.
  if (status === 'off' || status === 'unsupported') {
    return null;
  }

  const alarming = metrics
    ? isHostMetricAlarming(metrics)
    : { cpu: false, memory: false, disk: false };
  const stale = status === 'paused';

  return (
    <div
      className="relative mx-[0.35rem] mb-[0.2rem]"
      onMouseEnter={() => setTooltipOpen(true)}
      onMouseLeave={() => setTooltipOpen(false)}
    >
      <div
        className={cn(
          'flex items-center gap-[0.9rem] rounded-[6px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-[0.7rem] py-[0.25rem] text-[0.7rem]',
          stale && 'opacity-60',
        )}
        role="status"
        aria-live="off"
      >
        {status === 'loading' || !metrics ? (
          <span className="text-[var(--text-soft)]">호스트 상태를 읽는 중…</span>
        ) : (
          <>
            <Metric
              label="CPU"
              value={formatPercent(metrics.cpuPercent)}
              alarming={alarming.cpu}
            />
            <Metric
              label="RAM"
              value={formatRatio(metrics.memUsedKb, metrics.memTotalKb)}
              alarming={alarming.memory}
            />
            {/* 네트워크와 디스크 모두 "초당 얼마"라 화살표만 두면 어느 쪽인지 알 수 없다.
                그룹마다 라벨을 붙이고, 디스크는 읽기/쓰기라 R·W 로 구분한다. */}
            <Metric label="NET ↓" value={formatBytesPerSecond(metrics.rxBytesPerSec)} />
            <Metric label="↑" value={formatBytesPerSecond(metrics.txBytesPerSec)} />
            <Metric
              label="DISK R"
              value={formatBytesPerSecond(metrics.diskReadBytesPerSec)}
            />
            <Metric
              label="W"
              value={formatBytesPerSecond(metrics.diskWriteBytesPerSec)}
            />
          </>
        )}

        {stale ? (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[0.68rem] text-[var(--text-soft)] transition-colors duration-140 hover:text-[var(--accent-strong)]"
            onClick={onRetry}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            연결이 불안정해 멈췄습니다 · 다시 시도
          </button>
        ) : null}
      </div>

      {tooltipOpen && metrics && status !== 'loading' ? (
        <div
          className="absolute bottom-[calc(100%+0.3rem)] left-0 z-[8] min-w-[13rem] rounded-[8px] border border-[var(--border)] bg-[var(--surface-strong)] px-[0.7rem] py-[0.55rem] text-[0.72rem] shadow-[var(--shadow)]"
          role="tooltip"
        >
          <div className="grid gap-[0.3rem]">
            {/* load average 는 넣지 않는다. 바의 CPU% 와 창(10초 vs 1분)도 측정 대상(사용
                시간 vs 실행 대기 큐)도 달라 값이 어긋나는데, 나란히 두면 사용자는 둘 중
                무엇이 맞는지부터 고민하게 된다. "지금 바쁜가"는 CPU% 하나로 충분하다. */}
            <TooltipRow label="CPU 코어" value={formatCpuCount(metrics.cpuCount)} />
            <TooltipRow label="가동 시간" value={formatUptime(metrics.uptimeSeconds)} />
            {metrics.disks.map((disk) => (
              <TooltipRow
                key={disk.mount}
                label={`디스크 ${disk.mount}`}
                value={formatRatio(disk.usedKb, disk.totalKb)}
              />
            ))}
          </div>
          {/* 컨테이너 안에서는 /proc 이 호스트 전체를 가리켜 값이 세션과 어긋날 수 있다. */}
          <p className="m-0 mt-[0.45rem] border-t border-[var(--border)] pt-[0.4rem] text-[0.68rem] leading-[1.4] text-[var(--text-soft)]">
            컨테이너 안에서는 호스트 전체 값이 표시됩니다.
          </p>
        </div>
      ) : null}
    </div>
  );
}
