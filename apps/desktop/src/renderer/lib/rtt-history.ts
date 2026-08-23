// keepalive 왕복 지연(RTT)의 최근 이력. 하단바에서 hover 하면 스파크라인과 min/avg/max 로 본다.
//
// 값은 이미 흐르고 있다 — 코어가 10초마다 keepalive 로 재서 `latency` 이벤트로 올린다. 지금까지
// 그 값은 `tab.lastRttMs` 에 덮어써지고 이전 값은 버려졌다. 여기서 창 하나만큼 들고 있는다.
//
// **스토어에 두지 않는다.** 10초마다 오는 값을 스토어에 쌓으면 그때마다 tabs 배열이 새로 만들어져
// 리렌더가 앱 전체로 번진다(자원 지표를 레지스트리로 뺀 것과 같은 이유).
//
// **키는 sessionId 가 아니라 stableId 다.** 재연결하면 sessionId 가 새로 발급되므로, 그 기준으로
// 들면 끊길 때마다 그래프가 비워진다. stableId 는 탭이 살아 있는 동안 불변이라 재연결을 건너
// 이어진다(리플레이·AI 패널이 같은 이유로 stableId 를 쓴다). tmux control 세션은 그룹 id 가
// 그 역할을 한다(재연결로 controlSessionId 가 바뀌어도 불변).

import { rttBand, worseRttBand, type RttBand } from './rtt';

/** 이력을 들고 있는 창. 10초 간격이라 60점이다 — 스파크라인 폭(60px)과 1:1 로 떨어진다. */
export const RTT_HISTORY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 링 버퍼 상한. 창을 벗어난 값은 읽을 때 걸러지지만, 상한이 없으면 시각이 뒤로 흐르는
 * 환경(시스템 시계 조정)에서 무한히 쌓일 수 있다.
 */
const MAX_SAMPLES = 256;

export interface RttSample {
  ms: number;
  atMs: number;
}

export interface RttSummary {
  samples: RttSample[];
  min: number;
  avg: number;
  max: number;
}

interface Entry {
  samples: RttSample[];
  version: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { samples: [], version: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

/** 새 측정값을 남긴다. 발행자는 `latency` 이벤트를 받는 런타임 슬라이스 하나뿐이다. */
export function recordRtt(key: string, ms: number, atMs = Date.now()): void {
  if (!key || !Number.isFinite(ms) || ms < 0) {
    return;
  }
  const entry = entryFor(key);
  entry.samples.push({ ms, atMs });
  if (entry.samples.length > MAX_SAMPLES) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
  }
  entry.version += 1;
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[rtt-history] listener threw', error);
    }
  }
}

/** 창 안의 값만 오래된 → 최신 순으로. */
export function getRttSamples(key: string, nowMs = Date.now()): RttSample[] {
  const entry = entries.get(key);
  if (!entry) {
    return [];
  }
  const since = nowMs - RTT_HISTORY_WINDOW_MS;
  return entry.samples.filter((sample) => sample.atMs >= since);
}

export function getRttHistoryVersion(key: string): number {
  return entries.get(key)?.version ?? 0;
}

export function subscribeToRttHistory(key: string, listener: () => void): () => void {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.samples.length === 0) {
      entries.delete(key);
    }
  };
}

/** 탭을 닫을 때 정리한다 — 이력이 프로세스가 사는 동안 계속 쌓일 이유가 없다. */
export function clearRttHistory(key: string): void {
  entries.delete(key);
}

/**
 * 창 안의 값을 요약한다. 점이 없으면 null — 그때는 hover 에 그릴 것이 없다(막 붙은 세션).
 */
export function summarizeRtt(samples: readonly RttSample[]): RttSummary | null {
  if (samples.length === 0) {
    return null;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let total = 0;
  for (const sample of samples) {
    min = Math.min(min, sample.ms);
    max = Math.max(max, sample.ms);
    total += sample.ms;
  }
  return {
    samples: [...samples],
    min,
    max,
    // 평균은 정수로 접는다 — 소수점은 이 창에서 아무 것도 더 말해 주지 않는다.
    avg: Math.round(total / samples.length),
  };
}

/**
 * 세로 눈금의 최소 폭(ms).
 *
 * 창의 min~max 를 그대로 높이에 꽉 채우면 4ms~5ms 처럼 1ms 차이가 패널 높이 전체를 가로지르는
 * 오르막이 된다 — 실제로는 평평한 구간인데 요란하게 보인다. 눈금을 최소 이만큼으로 벌려,
 * 이 아래의 변동은 평평하게 눌린다.
 */
const MIN_SPAN_MS = 20;

/** 선이 되려면 점이 둘은 있어야 한다. 하나뿐이면 차트 자리만 비어 있다. */
const MIN_POINTS = 2;

/**
 * x 축 길이 = `clamp(쌓인 구간 × 1.3, 2분, 10분)`.
 *
 * 축을 쌓인 구간에 딱 맞추면 점이 두 개뿐일 때도 선이 폭을 꽉 채워, 그 20초를 10분처럼 읽게
 * 된다. 축을 창(10분)에 고정하면 반대로 초기에 폭의 3% 만 쓰고 나머지가 텅 빈다. 그래서 축은
 * 데이터보다 조금 크게 잡아 **창이 다 찰 때까지 왼쪽부터 자라는 선 + 오른쪽 빈칸**을 유지하고,
 * 데이터가 늘면 빈칸이 줄어 10분에서 사라진다.
 */
const AXIS_HEADROOM = 1.3;
const MIN_AXIS_MS = 2 * 60 * 1000;

export interface SparklineSegment {
  band: RttBand;
  /** `x,y x,y …` — 이 구간의 폴리라인 좌표. */
  points: string;
}

/**
 * 스파크라인을 **구간별로** 나눠 준다. 구간의 색은 양 끝점 중 나쁜 쪽이라, 튄 자리의 오르내림이
 * 모두 그 색으로 그려진다 — 선 하나를 평균 색으로 칠하면 44ms 로 튄 지점이 초록으로 남는다.
 *
 * 차트 자리는 부르는 쪽이 늘 같은 크기로 두고, 점이 하나뿐이면 빈 배열이 온다(선이 될 수 없다).
 *
 * **x 축은 데이터보다 조금 크게 잡는다**(AXIS_HEADROOM·MIN_AXIS_MS 참고) — 선은 왼쪽 끝에서
 * 시작해 오른쪽으로 자라고, 아직 안 찬 오른쪽은 빈칸으로 남으며 창이 다 차면 빈칸이 없어진다.
 * 이력 보관과 min/avg/max 는 10분 창 그대로다.
 *
 * 세로는 창 안의 값 범위를 눈금 가운데에 놓는다(0 기준이 아니다) — 0 부터 그리면 20~30ms 를
 * 오가는 평상시 곡선이 바닥에 붙은 직선이 되어, 보러 온 것(튀는 지점)이 안 보인다. 범위가
 * 좁으면 눈금 하한(MIN_SPAN_MS)에 걸려 평평하게 눌린다.
 */
export function buildSparklineSegments(
  samples: readonly RttSample[],
  width: number,
  height: number,
): SparklineSegment[] {
  if (samples.length < MIN_POINTS) {
    return [];
  }
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const sample of samples) {
    min = Math.min(min, sample.ms);
    max = Math.max(max, sample.ms);
  }
  const span = Math.max(max - min, MIN_SPAN_MS);
  // 실제 범위를 눈금 가운데에 놓는다 — 하한에 걸린 평평한 구간이 바닥이 아니라 중앙에 오게.
  const base = min - (span - (max - min)) / 2;
  const oldestAt = samples[0].atMs;
  const dataSpan = samples[samples.length - 1].atMs - oldestAt;
  const axisMs = Math.min(
    Math.max(dataSpan * AXIS_HEADROOM, MIN_AXIS_MS),
    RTT_HISTORY_WINDOW_MS,
  );
  const placed = samples.map((sample) => ({
    ms: sample.ms,
    // 가장 오래된 값이 왼쪽 끝. 시간이 갈수록 오른쪽으로 자라고, 남는 오른쪽은 빈칸이다.
    x: ((width * (sample.atMs - oldestAt)) / axisMs).toFixed(1),
    y: (height - ((sample.ms - base) / span) * height).toFixed(1),
  }));

  const segments: SparklineSegment[] = [];
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    const band = worseRttBand(rttBand(previous.ms), rttBand(current.ms));
    const last = segments[segments.length - 1];
    // 같은 색이면 한 폴리라인으로 이어 붙인다 — 색이 바뀌는 곳에서만 끊는다.
    if (last && last.band === band) {
      last.points += ` ${current.x},${current.y}`;
      continue;
    }
    segments.push({
      band,
      points: `${previous.x},${previous.y} ${current.x},${current.y}`,
    });
  }
  return segments;
}
