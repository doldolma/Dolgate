import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMetricsSeries,
  getHostMetricsHistoryVersion,
  subscribeHostMetricsHistory,
  clearHostMetricsHistory,
  collectSeriesValues,
  countHostMetricsHistoryEntries,
  getHostMetricsHistory,
  HOST_METRICS_HISTORY_WINDOW_MS,
  METRICS_BYTE_SCALE_FLOOR,
  recordHostMetricsSample,
  resolveByteScaleMax,
  resolveMetricsAxis,
  type MetricsHistorySample,
} from './host-metrics-history';
import { clearHostMetrics, publishHostMetrics } from './host-metrics-registry';
import type { HostMetrics } from './host-metrics';

const SESSION = 'session-history';

function metrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    cpuPercent: 10,
    memUsedKb: 1024,
    memTotalKb: 4096,
    rxBytesPerSec: 0,
    txBytesPerSec: 0,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    loadAvg1: 0.1,
    cpuCount: 4,
    uptimeSeconds: 60,
    disks: [],
    ...overrides,
  };
}

afterEach(() => {
  clearHostMetricsHistory(SESSION);
  clearHostMetrics(SESSION);
});

describe('이력 쌓기', () => {
  it('메모리는 비율로 접어 둔다 — 총량은 세션 동안 바뀌지 않는다', () => {
    recordHostMetricsSample(SESSION, metrics({ memUsedKb: 1024, memTotalKb: 4096 }), 1000);
    expect(getHostMetricsHistory(SESSION, 1000)[0].memPercent).toBe(25);
  });

  it('총량이 0이면 비율이 없다(0% 로 적지 않는다)', () => {
    recordHostMetricsSample(SESSION, metrics({ memUsedKb: 0, memTotalKb: 0 }), 1000);
    expect(getHostMetricsHistory(SESSION, 1000)[0].memPercent).toBeNull();
  });

  it('같은 시각·더 이른 시각은 버린다 — 상태만 바뀐 발행이 곡선을 멈춰 세우면 안 된다', () => {
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 10 }), 2000);
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 99 }), 2000);
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 98 }), 1000);
    const samples = getHostMetricsHistory(SESSION, 2000);
    expect(samples).toHaveLength(1);
    expect(samples[0].cpuPercent).toBe(10);
  });

  it('창을 벗어난 점은 읽을 때 걸러진다', () => {
    recordHostMetricsSample(SESSION, metrics(), 1_000);
    recordHostMetricsSample(SESSION, metrics(), 2_000);
    const now = 1_000 + HOST_METRICS_HISTORY_WINDOW_MS + 1;
    expect(getHostMetricsHistory(SESSION, now)).toHaveLength(1);
  });

  it('발행 지점 한 곳에서 쌓인다 — 패널이 열려 있는지와 무관하다', () => {
    publishHostMetrics(SESSION, {
      status: 'ready',
      metrics: metrics({ cpuPercent: 33 }),
      processes: null,
      system: null,
      updatedAtMs: 5_000,
    });
    const samples = getHostMetricsHistory(SESSION, 5_000);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ atMs: 5_000, cpuPercent: 33 });
  });

  it('시계가 앞으로 튀어도 차트가 굳지 않는다', () => {
    // 미래 시각을 단 표본은 창에서 영영 안 빠지고, 그 뒤로 오는 진짜 값을 전부 밀어낸다.
    // 창 하나를 넘어서 뒤로 간 시각이 오면 들고 있던 것을 버리고 다시 시작한다.
    recordHostMetricsSample(SESSION, metrics(), 1_000);
    recordHostMetricsSample(SESSION, metrics(), 1_000 + 86_400_000);
    for (let i = 1; i <= 5; i += 1) {
      recordHostMetricsSample(SESSION, metrics(), 1_000 + i * 3_000);
    }
    expect(getHostMetricsHistory(SESSION, 20_000)).toHaveLength(5);
  });

  it('같은 초에 두 번 발행한 것은 여전히 버린다', () => {
    // 위 복구가 "순서가 조금 뒤집힌 것" 까지 받아들이면 안 된다.
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 10 }), 5_000);
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 99 }), 5_000);
    recordHostMetricsSample(SESSION, metrics({ cpuPercent: 98 }), 4_000);
    expect(getHostMetricsHistory(SESSION, 5_000)).toHaveLength(1);
  });

  it('이력을 비울 때도 구독자에게 알린다', () => {
    // 항목을 통째로 없애면 구독자는 떨어져 나간 항목에 붙은 채로 남아 영영 못 받는다.
    let calls = 0;
    const off = subscribeHostMetricsHistory(SESSION, () => {
      calls += 1;
    });
    recordHostMetricsSample(SESSION, metrics(), 1_000);
    clearHostMetricsHistory(SESSION);
    recordHostMetricsSample(SESSION, metrics(), 2_000);
    expect(calls).toBe(3);
    off();
  });

  it('발행 번호는 되돌아가지 않는다 — 옛 배열이 그대로 남지 않게', () => {
    recordHostMetricsSample(SESSION, metrics(), 1_000);
    const before = getHostMetricsHistoryVersion(SESSION);
    clearHostMetricsHistory(SESSION);
    recordHostMetricsSample(SESSION, metrics(), 2_000);
    expect(getHostMetricsHistoryVersion(SESSION)).toBeGreaterThan(before);
  });

  it('레지스트리에 항목이 없어도 세션 종료가 이력을 지운다', () => {
    recordHostMetricsSample(SESSION, metrics(), 1_000);
    clearHostMetrics(SESSION);
    expect(getHostMetricsHistory(SESSION, 1_000)).toHaveLength(0);
  });

  it('세션이 끝나면 이력도 함께 버린다', () => {
    publishHostMetrics(SESSION, {
      status: 'ready',
      metrics: metrics(),
      processes: null,
      system: null,
      updatedAtMs: 5_000,
    });
    clearHostMetrics(SESSION);
    expect(getHostMetricsHistory(SESSION, 5_000)).toHaveLength(0);
    expect(countHostMetricsHistoryEntries()).toBe(0);
  });
});

function sample(atMs: number, values: Partial<MetricsHistorySample> = {}): MetricsHistorySample {
  return {
    atMs,
    cpuPercent: null,
    memPercent: null,
    rxBytesPerSec: null,
    txBytesPerSec: null,
    diskReadBytesPerSec: null,
    diskWriteBytesPerSec: null,
    ...values,
  };
}

describe('x 축', () => {
  it('왼쪽 끝이 가장 오래된 값이다 — 선은 오른쪽으로 자란다', () => {
    // 접속 5분째. 쌓인 만큼이 축이므로 폭을 다 쓴다.
    const axis = resolveMetricsAxis([sample(0), sample(300_000)]);
    expect(axis).toEqual({ fromMs: 0, toMs: 300_000 });
  });

  it('점이 얼마 없으면 축을 1분까지 벌린다 — 9초를 10분처럼 읽지 않게', () => {
    // 접속 9초째. 왼쪽 끝에서 시작해 폭의 15% 만 쓰고 오른쪽은 아직 빈칸이다.
    const axis = resolveMetricsAxis([sample(0), sample(9_000)]);
    expect(axis).toEqual({ fromMs: 0, toMs: 60_000 });
  });

  it('1분이 지나면 폭을 다 쓴다', () => {
    const axis = resolveMetricsAxis([sample(0), sample(90_000)]);
    expect(axis).toEqual({ fromMs: 0, toMs: 90_000 });
  });

  it('창(10분)을 넘겨 벌어지지 않는다 — 그때부터는 보통의 스크롤 창이다', () => {
    const axis = resolveMetricsAxis([sample(0), sample(60 * 60_000)]);
    expect((axis?.toMs ?? 0) - (axis?.fromMs ?? 0)).toBe(HOST_METRICS_HISTORY_WINDOW_MS);
  });

  it('점이 없으면 축도 없다', () => {
    expect(resolveMetricsAxis([])).toBeNull();
  });
});

const AXIS = { fromMs: 0, toMs: 100_000 };

describe('곡선 좌표', () => {
  it('값이 100% 면 꼭대기, 0% 면 바닥에 붙는다', () => {
    const shape = buildMetricsSeries(
      [
        sample(0, { cpuPercent: 0 }),
        sample(50_000, { cpuPercent: 50 }),
        sample(100_000, { cpuPercent: 100 }),
      ],
      (entry) => entry.cpuPercent,
      { axis: AXIS, max: 100, baselineY: 100, peakY: 0 },
    );
    expect(shape.lines).toEqual(['0,100 50,50 100,0']);
    expect(shape.areas).toEqual(['M0,100 L0,100 L50,50 L100,0 L100,100 Z']);
  });

  it('짝 계열은 같은 눈금을 기준선 아래로 쓴다', () => {
    const shape = buildMetricsSeries(
      [sample(0, { txBytesPerSec: 0 }), sample(100_000, { txBytesPerSec: 1024 })],
      (entry) => entry.txBytesPerSec,
      { axis: AXIS, max: 1024, baselineY: 50, peakY: 100 },
    );
    expect(shape.lines).toEqual(['0,50 100,100']);
  });

  it('축 꼭대기를 넘는 값은 꼭대기에서 잘린다', () => {
    const shape = buildMetricsSeries(
      [sample(0, { rxBytesPerSec: 0 }), sample(100_000, { rxBytesPerSec: 9_999 })],
      (entry) => entry.rxBytesPerSec,
      { axis: AXIS, max: 1024, baselineY: 100, peakY: 0 },
    );
    expect(shape.lines).toEqual(['0,100 100,0']);
  });

  it('못 읽은 점에서 선을 끊는다 — 0 으로 이으면 조용한 구간으로 둔갑한다', () => {
    const shape = buildMetricsSeries(
      [
        sample(0, { cpuPercent: 10 }),
        sample(25_000, { cpuPercent: 20 }),
        sample(50_000, { cpuPercent: null }),
        sample(75_000, { cpuPercent: 30 }),
        sample(100_000, { cpuPercent: 40 }),
      ],
      (entry) => entry.cpuPercent,
      { axis: AXIS, max: 100, baselineY: 100, peakY: 0 },
    );
    expect(shape.lines).toHaveLength(2);
    expect(shape.areas).toHaveLength(2);
  });

  it('점 하나짜리 구간은 그리지 않는다(선도 면도 되지 않는다)', () => {
    const shape = buildMetricsSeries(
      [sample(0, { cpuPercent: 10 })],
      (entry) => entry.cpuPercent,
      { axis: AXIS, max: 100, baselineY: 100, peakY: 0 },
    );
    expect(shape).toEqual({ areas: [], lines: [] });
  });

  it('빈 결과를 공유하지 않는다 — 받은 쪽이 밀어 넣어도 다음 결과가 오염되지 않게', () => {
    const bad = { axis: { fromMs: 0, toMs: 0 }, max: 100, baselineY: 100, peakY: 0 };
    const first = buildMetricsSeries([], (entry) => entry.cpuPercent, bad);
    first.lines.push('오염');
    expect(buildMetricsSeries([], (entry) => entry.cpuPercent, bad).lines).toEqual([]);
  });
});

describe('초당 바이트 눈금', () => {
  it('조용한 호스트는 하한에 눌린다 — keepalive 몇 백 바이트가 산맥이 되지 않게', () => {
    expect(resolveByteScaleMax([120, 300])).toBe(METRICS_BYTE_SCALE_FLOOR);
  });

  it('창 안 최댓값을 딱 떨어지는 칸으로 올린다', () => {
    expect(resolveByteScaleMax([1.5 * 1024 * 1024])).toBe(2 * 1024 * 1024);
    expect(resolveByteScaleMax([70 * 1024])).toBe(128 * 1024);
  });

  it('못 읽은 값은 눈금을 흔들지 않는다', () => {
    expect(resolveByteScaleMax([null, null])).toBe(METRICS_BYTE_SCALE_FLOOR);
  });

  it('두 방향은 한 눈금을 나눠 쓴다', () => {
    const samples = [sample(0, { rxBytesPerSec: 4 * 1024 * 1024, txBytesPerSec: 1024 })];
    const values = collectSeriesValues(
      samples,
      (entry) => entry.rxBytesPerSec,
      (entry) => entry.txBytesPerSec,
    );
    expect(resolveByteScaleMax(values)).toBe(4 * 1024 * 1024);
  });
});
