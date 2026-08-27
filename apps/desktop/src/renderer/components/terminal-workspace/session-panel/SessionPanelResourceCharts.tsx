// 자원 패널의 차트 네 판 — CPU · 메모리 · 네트워크 · 디스크 I/O.
//
// 축 규칙이 판마다 다르고, 그 차이가 이 화면의 전부다:
//
// - CPU·메모리는 **0~100% 고정**이다. 사용률은 100% 라는 뜻이 있는 눈금이라, 자동으로 늘리면
//   3% 짜리 잔물결이 만원짜리 산맥으로 보인다.
// - 네트워크·디스크는 **자동**이다. 초당 바이트에는 천장이 없어서 고정할 눈금이 없다. 대신
//   창 안의 최댓값을 딱 떨어지는 칸으로 올리고(64 K/s, 2 M/s …) 그 값을 오른쪽 위에 적는다 —
//   축을 안 적으면 자동 눈금은 읽을 수 없는 그림이 된다.
// - 두 방향(받음/보냄, 읽기/쓰기)은 **같은 눈금**을 기준선 위아래로 나눠 쓴다. 눈금을 둘로
//   나누면(양쪽 각자 자동) 10배 차이가 같은 높이로 그려져 거짓말을 한다.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildMetricsSeries,
  collectSeriesValues,
  resolveByteScaleMax,
  resolveMetricsAxis,
  type MetricsHistoryPick,
  type MetricsHistorySample,
} from '../../../lib/host-metrics-history';
import {
  formatBytesPerSecond,
  formatKibibytes,
  formatPercent,
  type HostMetrics,
} from '../../../lib/host-metrics';
import { ChartSwatch, SessionPanelChart } from './SessionPanelChart';
import { useSessionHostMetricsHistory } from './useSessionHostMetrics';

const CHART_1 = 'var(--chart-1)';
const CHART_2 = 'var(--chart-2)';

/**
 * 사용률 판은 낮게, 위아래로 나눠 쓰는 판은 그만큼 높게.
 *
 * 짝 차트는 높이를 두 방향이 반씩 나눠 쓴다 — 56px 이면 방향당 28px 뿐이라, 한쪽이 다른 쪽의
 * 몇십 분의 일인 흔한 경우에 작은 쪽이 1~2px 로 뭉개진다. 76px 이면 방향당 38px 다.
 */
const USAGE_HEIGHT = 44;
const PAIRED_HEIGHT = 76;

const pickCpu: MetricsHistoryPick = (sample) => sample.cpuPercent;
const pickMem: MetricsHistoryPick = (sample) => sample.memPercent;
const pickRx: MetricsHistoryPick = (sample) => sample.rxBytesPerSec;
const pickTx: MetricsHistoryPick = (sample) => sample.txBytesPerSec;
const pickRead: MetricsHistoryPick = (sample) => sample.diskReadBytesPerSec;
const pickWrite: MetricsHistoryPick = (sample) => sample.diskWriteBytesPerSec;

interface SessionPanelResourceChartsProps {
  sessionId: string;
  /** 최신 스냅샷. 이력이 아직 한 점뿐일 때 머리글이 읽을 값이다. */
  metrics: HostMetrics;
}

export function SessionPanelResourceCharts({
  sessionId,
  metrics,
}: SessionPanelResourceChartsProps) {
  const { t: translate } = useTranslation();
  const history = useSessionHostMetricsHistory(sessionId);
  /**
   * 네 판이 **같은 점에서 시작하게** 자른다.
   *
   * RAM 은 그 순간 값이라 첫 표본부터 그려지는데 네트워크·디스크는 두 표본의 차분이라 한 틱
   * 뒤부터 그려진다 — 그대로 두면 RAM 곡선만 늘 한 칸 먼저 나가 판마다 시작점이 어긋난다.
   * 차분이 나오는 첫 표본부터 모두 함께 시작한다.
   *
   * **기준은 초당 값이다.** CPU 로 재면 macOS 에서 어긋난다 — 거기서는 CPU 가 차분이 아니라
   * 프로세스 %cpu 의 합이어서 첫 표본부터 값이 있다.
   *
   * 초당 값을 못 읽는 호스트에서는 자르지 않는다 — 자르면 그런 호스트에서 RAM·CPU 곡선까지
   * 사라진다.
   */
  const samples = useMemo(() => {
    const start = history.findIndex(
      (sample) => sample.rxBytesPerSec !== null || sample.diskReadBytesPerSec !== null,
    );
    return start <= 0 ? history : history.slice(start);
  }, [history]);
  // 가리킨 지점은 네 판이 함께 쓴다 — CPU 가 튄 그 순간의 메모리·네트워크를 같이 읽는다.
  // 누가 가리켰는지까지 들고 있는 이유는 "얼마나 전" 을 커서가 있는 판에만 적기 위해서다.
  const [hover, setHover] = useState<{ index: number; owner: string } | null>(null);
  const hoverProps = (owner: string) => ({
    hoverIndex: hover?.index ?? null,
    showAgo: hover?.owner === owner,
    onHoverIndexChange: (index: number | null) =>
      setHover(index === null ? null : { index, owner }),
  });

  const charts = useMemo(() => {
    const axis = resolveMetricsAxis(samples);
    if (!axis) {
      return null;
    }
    const netMax = resolveByteScaleMax(collectSeriesValues(samples, pickRx, pickTx));
    const diskMax = resolveByteScaleMax(collectSeriesValues(samples, pickRead, pickWrite));
    return {
      axis,
      netMax,
      diskMax,
      cpu: buildMetricsSeries(samples, pickCpu, {
        axis,
        max: 100,
        baselineY: 100,
        peakY: 0,
      }),
      mem: buildMetricsSeries(samples, pickMem, {
        axis,
        max: 100,
        baselineY: 100,
        peakY: 0,
      }),
      rx: buildMetricsSeries(samples, pickRx, {
        axis,
        max: netMax,
        baselineY: 50,
        peakY: 0,
      }),
      tx: buildMetricsSeries(samples, pickTx, {
        axis,
        max: netMax,
        baselineY: 50,
        peakY: 100,
      }),
      read: buildMetricsSeries(samples, pickRead, {
        axis,
        max: diskMax,
        baselineY: 50,
        peakY: 0,
      }),
      write: buildMetricsSeries(samples, pickWrite, {
        axis,
        max: diskMax,
        baselineY: 50,
        peakY: 100,
      }),
    };
  }, [samples]);

  const axis = charts?.axis ?? null;
  const empty = { areas: [], lines: [] };

  return (
    <div className="grid gap-1.5">
      <SessionPanelChart
        label="CPU"
        height={USAGE_HEIGHT}
        samples={samples}
        axis={axis}
        {...hoverProps('cpu')}
        top={{ shape: charts?.cpu ?? empty, color: CHART_1 }}
        renderReadout={(sample) =>
          formatPercent(sample ? sample.cpuPercent : metrics.cpuPercent)
        }
        meta={
          metrics.loadAvg1 === null
            ? null
            : `${translate('sessionPanel.resources.loadShort')} ${metrics.loadAvg1.toFixed(2)}${
                metrics.cpuCount ? ` / ${metrics.cpuCount}` : ''
              }`
        }
      />
      <SessionPanelChart
        label="RAM"
        height={USAGE_HEIGHT}
        samples={samples}
        axis={axis}
        {...hoverProps('mem')}
        top={{ shape: charts?.mem ?? empty, color: CHART_1 }}
        renderReadout={(sample) =>
          `${formatKibibytes(usedKbAt(sample, metrics))} / ${formatKibibytes(metrics.memTotalKb)}`
        }
      />
      <SessionPanelChart
        label="NET"
        scaleLabel={
          charts
            ? translate('sessionPanel.resources.chartScaleMax', {
                value: formatBytesPerSecond(charts.netMax),
              })
            : undefined
        }
        height={PAIRED_HEIGHT}
        samples={samples}
        axis={axis}
        {...hoverProps('net')}
        top={{ shape: charts?.rx ?? empty, color: CHART_1 }}
        bottom={{ shape: charts?.tx ?? empty, color: CHART_2 }}
        renderReadout={(sample) => (
          <PairReadout
            first={{
              color: CHART_1,
              glyph: '↓',
              title: translate('sessionPanel.resources.netIn'),
              value: formatBytesPerSecond(
                sample ? sample.rxBytesPerSec : metrics.rxBytesPerSec,
              ),
            }}
            second={{
              color: CHART_2,
              glyph: '↑',
              title: translate('sessionPanel.resources.netOut'),
              value: formatBytesPerSecond(
                sample ? sample.txBytesPerSec : metrics.txBytesPerSec,
              ),
            }}
          />
        )}
      />
      <SessionPanelChart
        label="DISK"
        scaleLabel={
          charts
            ? translate('sessionPanel.resources.chartScaleMax', {
                value: formatBytesPerSecond(charts.diskMax),
              })
            : undefined
        }
        height={PAIRED_HEIGHT}
        samples={samples}
        axis={axis}
        {...hoverProps('disk')}
        top={{ shape: charts?.read ?? empty, color: CHART_1 }}
        bottom={{ shape: charts?.write ?? empty, color: CHART_2 }}
        renderReadout={(sample) => (
          <PairReadout
            first={{
              color: CHART_1,
              glyph: 'R',
              title: translate('sessionPanel.resources.diskRead'),
              value: formatBytesPerSecond(
                sample ? sample.diskReadBytesPerSec : metrics.diskReadBytesPerSec,
              ),
            }}
            second={{
              color: CHART_2,
              glyph: 'W',
              title: translate('sessionPanel.resources.diskWrite'),
              value: formatBytesPerSecond(
                sample ? sample.diskWriteBytesPerSec : metrics.diskWriteBytesPerSec,
              ),
            }}
          />
        )}
      />
    </div>
  );
}

interface PairEntry {
  color: string;
  /** 방향 표식(↓·↑·R·W). 색만으로 구분하지 않기 위한 두 번째 단서다. */
  glyph: string;
  title: string;
  value: string;
}

function PairReadout({ first, second }: { first: PairEntry; second: PairEntry }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <PairValue entry={first} />
      <PairValue entry={second} />
    </span>
  );
}

function PairValue({ entry }: { entry: PairEntry }) {
  return (
    <span className="inline-flex items-center gap-1" title={entry.title}>
      <ChartSwatch color={entry.color} />
      <span className="text-[var(--text-soft)]">{entry.glyph}</span>
      <span>{entry.value}</span>
    </span>
  );
}

/**
 * 이 시점의 사용 메모리(KB). 이력은 **비율**만 들고 있다 — 총량은 세션 동안 바뀌지 않으므로
 * 최신 스냅샷의 총량과 곱하면 그때의 절대량이 나온다.
 */
function usedKbAt(sample: MetricsHistorySample | null, metrics: HostMetrics): number | null {
  if (!sample) {
    return metrics.memUsedKb;
  }
  if (sample.memPercent === null || metrics.memTotalKb === null) {
    return null;
  }
  return (sample.memPercent / 100) * metrics.memTotalKb;
}
