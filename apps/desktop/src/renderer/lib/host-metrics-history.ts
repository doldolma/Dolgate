// 호스트 지표의 최근 이력. 세션 패널이 값 옆에 차트를 그리기 위한 것이다.
//
// 값은 이미 흐르고 있다 — pane 의 폴링(`useHostMetrics`)이 10초마다, 패널이 열려 있으면 3초마다
// 지표를 계산해 레지스트리에 발행한다. 지금까지 그 값은 매번 덮어써지고 이전 값은 버려졌다.
// 여기서 창 하나(10분)만큼 들고 있는다.
//
// **기록은 발행 지점 한 곳에서만 한다**(host-metrics-registry 의 publishHostMetrics). 그래서
// 패널을 닫아도 이력은 끊기지 않는다 — 상태바용 폴링이 계속 도니까, 다시 열면 그동안의 10분이
// 이미 그려져 있다.
//
// **스토어에 두지 않는다.** 폴링마다 스토어를 건드리면 리렌더가 앱 전체로 번진다(레지스트리를
// 따로 둔 것과 같은 이유). 보는 쪽은 구독으로 충분하다.

import type { HostMetrics } from './host-metrics';

/** 들고 있는 창. */
export const HOST_METRICS_HISTORY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 링 버퍼 상한. 창을 벗어난 값은 읽을 때 걸러지지만, 상한이 없으면 시각이 뒤로 흐르는
 * 환경(시스템 시계 조정)에서 무한히 쌓일 수 있다. 최소 주기가 3초라 10분이면 200점이다.
 */
const MAX_SAMPLES = 256;

/**
 * 이력 한 점. 차트가 그리는 값만 담는다 — 디스크 사용량·가동 시간처럼 곡선이 되지 않는 것은
 * 여기 없다(그것은 최신 스냅샷에서 읽는다).
 *
 * 메모리는 절대량이 아니라 **비율**로 접어 둔다. 총량은 세션 동안 바뀌지 않으므로 비율이면
 * 축을 0~100 으로 고정할 수 있고, 화면의 숫자는 최신 스냅샷이 절대량으로 따로 말해 준다.
 */
export interface MetricsHistorySample {
  atMs: number;
  cpuPercent: number | null;
  memPercent: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
}

/** 한 점에서 그릴 값 하나를 꺼내는 함수. 못 읽은 점은 null 이고, 거기서 선이 끊긴다. */
export type MetricsHistoryPick = (sample: MetricsHistorySample) => number | null;

interface Entry {
  samples: MetricsHistorySample[];
  version: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

/**
 * 발행 번호. **세션마다 0부터 세지 않고 모듈 전체에서 단조 증가시킨다.**
 *
 * 구독자는 이 번호를 스냅샷 키로 쓴다(`useSyncExternalStore`). 세션마다 0부터 세면 이력을 비운
 * 뒤 새로 쌓인 데이터가 방금 쓰던 번호를 다시 달게 되고, 그 사이에 렌더가 없으면 구독자는
 * 바뀐 줄 모르고 옛 배열을 계속 그린다.
 */
let nextVersion = 1;

function bump(entry: Entry): void {
  entry.version = nextVersion;
  nextVersion += 1;
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[host-metrics-history] listener threw', error);
    }
  }
}

function entryFor(sessionId: string): Entry {
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = { samples: [], version: 0, listeners: new Set() };
    entries.set(sessionId, entry);
  }
  return entry;
}

function toPercent(usedKb: number | null, totalKb: number | null): number | null {
  if (usedKb === null || totalKb === null || totalKb <= 0) {
    return null;
  }
  return (usedKb / totalKb) * 100;
}

/**
 * 새 폴링 결과를 남긴다. 발행자는 세션당 하나다.
 *
 * 같은 시각(또는 더 이른 시각)은 버린다 — 폴링이 아니라 상태만 바뀐 발행에서 같은 값이 두 번
 * 쌓이면 차트가 그 자리에서 멈춘 것처럼 보인다.
 */
export function recordHostMetricsSample(
  sessionId: string,
  metrics: HostMetrics,
  atMs: number,
): void {
  if (!sessionId || !Number.isFinite(atMs)) {
    return;
  }
  const entry = entryFor(sessionId);
  const last = entry.samples[entry.samples.length - 1];
  if (last && atMs <= last.atMs) {
    // 창 하나를 통째로 넘어설 만큼 뒤로 간 것은 "같은 초에 두 번 발행" 이 아니라 **시계가
    // 튄 것**이다. 그때 들고 있던 값은 미래 시각을 달고 있어 창에서 영영 안 빠지고, 그 뒤로
    // 오는 진짜 값을 전부 밀어낸다 — 차트가 점 하나에 멈춘 채로 굳는다. 버리고 다시 시작한다.
    if (last.atMs - atMs > HOST_METRICS_HISTORY_WINDOW_MS) {
      entry.samples = [];
    } else {
      return;
    }
  }
  entry.samples.push({
    atMs,
    cpuPercent: metrics.cpuPercent,
    memPercent: toPercent(metrics.memUsedKb, metrics.memTotalKb),
    rxBytesPerSec: metrics.rxBytesPerSec,
    txBytesPerSec: metrics.txBytesPerSec,
    diskReadBytesPerSec: metrics.diskReadBytesPerSec,
    diskWriteBytesPerSec: metrics.diskWriteBytesPerSec,
  });
  if (entry.samples.length > MAX_SAMPLES) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
  }
  bump(entry);
}

/** 창 안의 값만 오래된 → 최신 순으로. */
export function getHostMetricsHistory(
  sessionId: string,
  nowMs = Date.now(),
): MetricsHistorySample[] {
  const entry = entries.get(sessionId);
  if (!entry) {
    return [];
  }
  const since = nowMs - HOST_METRICS_HISTORY_WINDOW_MS;
  return entry.samples.filter((sample) => sample.atMs >= since);
}

export function getHostMetricsHistoryVersion(sessionId: string): number {
  return entries.get(sessionId)?.version ?? 0;
}

export function subscribeHostMetricsHistory(
  sessionId: string,
  listener: () => void,
): () => void {
  const entry = entryFor(sessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    // **지금 그 자리에 있는 항목이 내가 붙었던 그 항목일 때만** 지운다. 아니면 이미 떨어져 나간
    // 항목의 해제 함수가 살아 있는 남의 항목을 지우게 된다.
    if (
      entries.get(sessionId) === entry &&
      entry.listeners.size === 0 &&
      entry.samples.length === 0
    ) {
      entries.delete(sessionId);
    }
  };
}

/**
 * 세션이 끝나면 버린다 — 남겨 두면 다음 세션이 옛 곡선을 잠깐 보여 준다.
 *
 * 항목을 통째로 없애지 않고 **비우고 알린다.** 없애 버리면 구독자들은 떨어져 나간 항목에 붙은
 * 채로 남아 다시는 알림을 못 받는다(옆의 `clearHostMetrics` 는 알리고 있어서 짝이 안 맞았다).
 * 보는 사람이 아무도 없을 때만 항목을 지운다.
 */
export function clearHostMetricsHistory(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) {
    return;
  }
  entry.samples = [];
  bump(entry);
  if (entry.listeners.size === 0) {
    entries.delete(sessionId);
  }
}

/** 남아 있는 항목 수. 누수를 테스트로 잡기 위한 것이다. */
export function countHostMetricsHistoryEntries(): number {
  return entries.size;
}

// ── 차트 좌표 ────────────────────────────────────────────────────────────────
//
// 좌표계는 0~100 × 0~100 이다. SVG 를 `viewBox="0 0 100 100" preserveAspectRatio="none"` 로
// 두면 패널 폭이 260~720px 사이 어디든 알아서 늘어나고, 선 굵기만 `vector-effect` 로 고정한다.
// 폭을 재는 ResizeObserver 가 필요 없다.

export interface MetricsAxis {
  fromMs: number;
  toMs: number;
}

/**
 * x 축 길이의 하한. 축을 데이터 구간에 딱 맞추면 점이 셋뿐일 때도 선이 폭을 꽉 채워, 그 9초를
 * 10분처럼 읽게 된다. 3초 주기에서 1분이면 스무 점이라 곡선이 곡선으로 보인다.
 */
const MIN_AXIS_MS = 60_000;

/**
 * x 축을 정한다. **왼쪽 끝이 가장 오래된 값**이고 선은 오른쪽으로 자란다.
 *
 * 창을 10분으로 고정하고 최신을 오른쪽 끝에 박는 쪽이 모니터링 툴의 보통 모양이지만, 그것은
 * 서버에 이력이 이미 쌓여 있어 **열자마자 창이 꽉 차 있는** 도구들의 이야기다. 우리는 접속하는
 * 순간부터 모으기 시작하므로 "채워지는 중" 이라는 상태가 실제로 존재하고, 거기서 축을 고정하면
 * 접속 직후 10초가 폭의 1.7% 짜리 부스러기로 오른쪽 구석에 붙는다.
 *
 * 그래서 축 길이는 쌓인 만큼으로 잡는다(하한 1분, 상한 10분). 1분이면 폭을 다 쓰고, 10분이
 * 지나면 상한에 걸려 오래된 값이 왼쪽으로 밀려 나가는 보통의 스크롤 창이 된다.
 *
 * 폴링 주기가 3초와 10초를 오가므로 x 는 **시각**으로 놓는다 — 점 번호로 놓으면 패널을 열고
 * 닫을 때마다 같은 폭이 다른 시간을 뜻하게 된다.
 */
export function resolveMetricsAxis(
  samples: readonly MetricsHistorySample[],
): MetricsAxis | null {
  if (samples.length === 0) {
    return null;
  }
  const fromMs = samples[0].atMs;
  const span = Math.min(
    Math.max(samples[samples.length - 1].atMs - fromMs, MIN_AXIS_MS),
    HOST_METRICS_HISTORY_WINDOW_MS,
  );
  return { fromMs, toMs: fromMs + span };
}

export interface MetricsSeriesShape {
  /** 채움 도형(`M … Z`). 값이 끊긴 구간마다 하나씩. */
  areas: string[];
  /** 윤곽선(`x,y x,y …`). areas 와 같은 구간이다. */
  lines: string[];
}

export interface MetricsPlot {
  axis: MetricsAxis;
  /** 이 값이 `peakY` 에 닿는다. */
  max: number;
  /** 값 0 의 y. 아래로 그리는 판은 여기가 위쪽이 된다. */
  baselineY: number;
  /** 값 `max` 의 y. */
  peakY: number;
}

function round(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * 한 계열을 도형으로. 못 읽은 점(null)에서는 선을 **끊는다** — 0 으로 이어 버리면 읽지 못한
 * 구간이 "아무 일도 없던 구간" 으로 둔갑한다.
 */
export function buildMetricsSeries(
  samples: readonly MetricsHistorySample[],
  pick: MetricsHistoryPick,
  plot: MetricsPlot,
): MetricsSeriesShape {
  const span = plot.axis.toMs - plot.axis.fromMs;
  // 공유 상수를 돌려주면 받은 쪽이 한 번만 밀어 넣어도 이후의 모든 빈 결과가 오염된다.
  if (span <= 0) {
    return { areas: [], lines: [] };
  }
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const sample of samples) {
    const value = pick(sample);
    if (
      value === null ||
      !Number.isFinite(value) ||
      value < 0 ||
      sample.atMs < plot.axis.fromMs
    ) {
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      continue;
    }
    const ratio = plot.max > 0 ? Math.min(1, value / plot.max) : 0;
    run.push({
      x: ((sample.atMs - plot.axis.fromMs) / span) * 100,
      y: plot.baselineY + (plot.peakY - plot.baselineY) * ratio,
    });
  }
  if (run.length > 0) {
    runs.push(run);
  }

  const shape: MetricsSeriesShape = { areas: [], lines: [] };
  for (const points of runs) {
    // 점 하나로는 선도 면도 되지 않는다(폭 0). 다음 폴링을 기다린다.
    if (points.length < 2) {
      continue;
    }
    const first = points[0];
    const last = points[points.length - 1];
    shape.lines.push(points.map((point) => `${round(point.x)},${round(point.y)}`).join(' '));
    shape.areas.push(
      [
        `M${round(first.x)},${round(plot.baselineY)}`,
        ...points.map((point) => `L${round(point.x)},${round(point.y)}`),
        `L${round(last.x)},${round(plot.baselineY)}`,
        'Z',
      ].join(' '),
    );
  }
  return shape;
}

/**
 * 초당 바이트 축의 꼭대기. 창 안의 최댓값을 1·2·4·…·512 × 1024ⁿ 중 바로 위 칸으로 올린다 —
 * 그래야 꼭대기 표기가 `64 K/s` 처럼 딱 떨어지고, 폴링마다 축이 미세하게 흔들리지 않는다.
 *
 * 하한이 필요한 이유: 조용한 호스트에서 최댓값에 딱 맞추면 keepalive 몇 백 바이트가 화면을
 * 가득 채운 산맥이 된다. 하한 아래의 값은 바닥에 눌린 채로 둔다.
 */
export const METRICS_BYTE_SCALE_FLOOR = 16 * 1024;

const BYTE_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

export function resolveByteScaleMax(
  values: readonly (number | null)[],
  floor = METRICS_BYTE_SCALE_FLOOR,
): number {
  let max = floor;
  for (const value of values) {
    if (value !== null && Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  let unit = 1;
  while (max / unit >= 1024) {
    unit *= 1024;
  }
  const scaled = max / unit;
  for (const step of BYTE_STEPS) {
    if (scaled <= step) {
      return step * unit;
    }
  }
  return 1024 * unit;
}

/** 창 안에서 이 값들의 최댓값. 축 꼭대기 표기에 쓴다. */
export function collectSeriesValues(
  samples: readonly MetricsHistorySample[],
  ...picks: MetricsHistoryPick[]
): (number | null)[] {
  const values: (number | null)[] = [];
  for (const sample of samples) {
    for (const pick of picks) {
      values.push(pick(sample));
    }
  }
  return values;
}
