// 자원 패널의 차트 한 판.
//
// 좌표는 0~100 × 0~100 이고 `preserveAspectRatio="none"` 이라, 패널 폭(260~720px)이 어떻든
// 가로로 늘어난다. 늘어나면서 선까지 찌그러지는 것만 `vector-effect="non-scaling-stroke"` 로
// 막는다 — 폭을 재는 ResizeObserver 가 필요 없다.
//
// **읽는 값은 머리글에 있다.** 차트 위를 지나면 그 시점 값으로 머리글이 바뀌고 세로선이 선다.
// 떠다니는 말풍선을 따로 띄우지 않는 이유: 폭 300px 짜리 패널에서 말풍선은 차트를 가린다.
//
// 가리킨 지점은 **네 판이 함께 쓴다**(상태는 부르는 쪽에 있다). 판마다 따로 두면 CPU 가 튄
// 그때 메모리가 어땠는지를 볼 수 없다 — 이 패널을 여는 이유가 대개 그것이다.

import { useMemo, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { getFormatLocale } from '../../../i18n';
import type {
  MetricsAxis,
  MetricsHistorySample,
  MetricsSeriesShape,
} from '../../../lib/host-metrics-history';

export interface SessionPanelChartSeries {
  shape: MetricsSeriesShape;
  /** CSS 색(토큰). `--chart-1` 이 주 계열, `--chart-2` 가 짝이다. */
  color: string;
}

interface SessionPanelChartProps {
  label: string;
  /**
   * 세로 눈금 꼭대기. **자동 눈금일 때만** 적는다 — 0~100% 고정 축에 "100%" 를 또 적으면
   * 머리글의 현재값("10%") 바로 아래에 비슷한 숫자가 하나 더 붙어 서로를 방해한다.
   *
   * 숫자만 적으면 그것도 읽는 값처럼 보인다("↑ 257 K/s" 바로 아래에 "2.0 M/s"). 부르는 쪽이
   * "최대" 를 붙여 넘긴다.
   */
  scaleLabel?: string;
  height: number;
  samples: readonly MetricsHistorySample[];
  axis: MetricsAxis | null;
  top: SessionPanelChartSeries;
  /** 기준선 아래로 그리는 짝(나감·쓰기). 있으면 기준선이 한가운데로 간다. */
  bottom?: SessionPanelChartSeries;
  /** 머리글 오른쪽. `sample` 은 가리키고 있는 점(없으면 최신). */
  renderReadout: (sample: MetricsHistorySample | null) => ReactNode;
  /** 네 판이 함께 가리키는 지점. */
  hoverIndex: number | null;
  /**
   * "얼마나 전" 을 이 판이 적을지. **커서가 올라와 있는 판만** 적는다 — 네 판이 같은 문구를
   * 네 번 적으면 정작 읽을 값이 그 사이에 묻힌다.
   */
  showAgo: boolean;
  onHoverIndexChange: (index: number | null) => void;
  /** 머리글에서 라벨 옆에 붙는 곁가지 값(부하처럼 곡선이 되지 않는 것). */
  meta?: ReactNode;
}

export function SessionPanelChart({
  label,
  scaleLabel,
  height,
  samples,
  axis,
  top,
  bottom,
  renderReadout,
  meta,
  hoverIndex,
  showAgo,
  onHoverIndexChange,
}: SessionPanelChartProps) {

  // 가리킨 점은 배열 밖으로 나갈 수 있다 — 폴링이 한 번 더 돌면 창을 벗어난 점이 잘려 나간다.
  const hovered =
    hoverIndex !== null && hoverIndex < samples.length ? samples[hoverIndex] : null;
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  // 히트 테스트용 x 좌표(0~100). 곡선과 같은 축을 쓴다.
  const positions = useMemo(() => {
    if (!axis) {
      return [];
    }
    const span = axis.toMs - axis.fromMs;
    if (span <= 0) {
      return [];
    }
    return samples.map((sample) => ((sample.atMs - axis.fromMs) / span) * 100);
  }, [samples, axis]);

  const handleMove = (event: PointerEvent<HTMLDivElement>) => {
    if (positions.length === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    if (!Number.isFinite(x)) {
      return;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < positions.length; index += 1) {
      const distance = Math.abs(positions[index] - x);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    onHoverIndexChange(best);
  };

  const hoverX = hoverIndex !== null ? positions[hoverIndex] : undefined;
  const baselineY = bottom ? 50 : 100;

  return (
    <div className="rounded-[9px] bg-[var(--surface-muted)] px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-[0.68rem] uppercase tracking-[0.1em] text-[var(--text-soft)]">
          {label}
        </span>
        {meta ? (
          <span className="shrink-0 truncate text-[0.66rem] tabular-nums text-[var(--text-soft)]">
            {meta}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right text-[0.8rem] tabular-nums text-[var(--text)]">
          {renderReadout(hovered ?? latest)}
        </span>
      </div>
      <div
        className="relative mt-1.5"
        style={{ height: `${height}px` }}
        onPointerMove={handleMove}
        onPointerLeave={() => onHoverIndexChange(null)}
      >
        <svg
          className="block h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          {/* 눈금은 물러나 있어야 한다 — 곡선을 읽으러 왔지 격자를 읽으러 온 것이 아니다.
              고정 축(0~100%)에는 절반 자리에 실선을 하나 더 둔다. 꼭대기 값을 안 적는 대신
              "여기가 반" 이라는 기준이 하나는 있어야 높이를 읽을 수 있다. */}
          {bottom ? null : (
            <line
              x1="0"
              x2="100"
              y1="50"
              y2="50"
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeOpacity={0.32}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <line
            x1="0"
            x2="100"
            y1={baselineY}
            y2={baselineY}
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeOpacity={0.45}
            vectorEffect="non-scaling-stroke"
          />
          <ChartSeries series={top} />
          {bottom ? <ChartSeries series={bottom} /> : null}
          {hoverX === undefined ? null : (
            <line
              x1={hoverX}
              x2={hoverX}
              y1="0"
              y2="100"
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* 꼭대기 값과 가리킨 시각은 곡선 **위에** 얹는다. 축을 따로 세우거나 줄을 더 만들면
            폭 300px 짜리 패널에서 그림이 그만큼 줄어든다. 글자가 곡선과 겹쳐 읽히지 않도록
            카드 배경색을 깔아 그 자리만 가린다. */}
        {scaleLabel ? (
          <span className="pointer-events-none absolute right-0 top-0 bg-[var(--surface-muted)] px-0.5 text-[0.6rem] tabular-nums text-[var(--text-soft)]">
            {scaleLabel}
          </span>
        ) : null}
        {hovered && showAgo ? (
          <span className="pointer-events-none absolute left-0 top-0 bg-[var(--surface-muted)] px-0.5 text-[0.6rem] tabular-nums text-[var(--text-soft)]">
            {formatClock(hovered.atMs)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ChartSeries({ series }: { series: SessionPanelChartSeries }) {
  return (
    <g>
      {series.shape.areas.map((path, index) => (
        <path key={`a${index}`} d={path} fill={series.color} fillOpacity={0.2} />
      ))}
      {series.shape.lines.map((points, index) => (
        <polyline
          key={`l${index}`}
          points={points}
          fill="none"
          stroke={series.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/**
 * 가리킨 점의 **시각**.
 *
 * 초까지 적는다 — 점 간격이 3초라 분까지만 적으면 이웃한 점들이 같은 시각으로 보인다.
 * 24시간제로 고정하는 이유는 "오후 2:03:27" 이 이 좁은 자리에 안 들어가기 때문이다.
 */
function formatClock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(getFormatLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** 계열 표식. 색은 이 네모가 지고, 글자는 본문 색을 그대로 쓴다. */
export function ChartSwatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('inline-block h-[0.4rem] w-[0.4rem] shrink-0 rounded-[2px]', className)}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}
