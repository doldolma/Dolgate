import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSparklineSegments,
  clearRttHistory,
  getRttHistoryVersion,
  getRttSamples,
  recordRtt,
  RTT_HISTORY_WINDOW_MS,
  subscribeToRttHistory,
  summarizeRtt,
} from './rtt-history';

afterEach(() => {
  clearRttHistory('key-1');
  clearRttHistory('key-2');
});

describe('이력 쌓기', () => {
  it('오래된 → 최신 순으로 남는다', () => {
    recordRtt('key-1', 12, 1_000);
    recordRtt('key-1', 40, 2_000);
    expect(getRttSamples('key-1', 3_000).map((sample) => sample.ms)).toEqual([12, 40]);
  });

  it('창을 벗어난 값은 읽을 때 걸러진다', () => {
    const now = 10_000_000;
    recordRtt('key-1', 99, now - RTT_HISTORY_WINDOW_MS - 1);
    recordRtt('key-1', 11, now - 1_000);
    expect(getRttSamples('key-1', now).map((sample) => sample.ms)).toEqual([11]);
  });

  it('키가 다르면 섞이지 않는다 — 세션마다 따로 본다', () => {
    recordRtt('key-1', 10, 1_000);
    recordRtt('key-2', 200, 1_000);
    expect(getRttSamples('key-1', 2_000)).toHaveLength(1);
    expect(getRttSamples('key-2', 2_000)[0].ms).toBe(200);
  });

  it('말이 안 되는 값은 버린다', () => {
    recordRtt('key-1', Number.NaN, 1_000);
    recordRtt('key-1', -5, 1_000);
    recordRtt('', 10, 1_000);
    expect(getRttSamples('key-1', 2_000)).toHaveLength(0);
  });

  it('구독자는 값이 올 때만 깨어난다', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToRttHistory('key-1', listener);
    recordRtt('key-1', 10, 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getRttHistoryVersion('key-1')).toBe(1);
    unsubscribe();
    recordRtt('key-1', 20, 2_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('요약', () => {
  it('min·avg·max 를 낸다 — 평균은 정수로 접는다', () => {
    const summary = summarizeRtt([
      { ms: 2, atMs: 1 },
      { ms: 7, atMs: 2 },
      { ms: 44, atMs: 3 },
    ]);
    expect(summary).toMatchObject({ min: 2, max: 44, avg: 18 });
  });

  it('값이 없으면 null 이다 — 막 붙은 세션에는 그릴 것이 없다', () => {
    expect(summarizeRtt([])).toBeNull();
  });
});

describe('스파크라인', () => {
  const now = 10_000_000;

  /** 10초 간격으로. 최신이 now 직전. */
  function series(values: number[]): { ms: number; atMs: number }[] {
    return values.map((ms, index) => ({
      ms,
      atMs: now - (values.length - index) * 10_000,
    }));
  }

  function flat(count: number, ms = 5): { ms: number; atMs: number }[] {
    return series(Array.from({ length: count }, () => ms));
  }

  /** 구간들을 이어 좌표 하나로 — 축·눈금 단언은 색과 무관하다. */
  function xy(
    samples: { ms: number; atMs: number }[],
    width: number,
    height: number,
  ): { xs: number[]; ys: number[] } {
    const points = buildSparklineSegments(samples, width, height)
      .flatMap((segment) => segment.points.split(' '));
    return {
      xs: points.map((point) => Number(point.split(',')[0])),
      ys: points.map((point) => Number(point.split(',')[1])),
    };
  }

  it('점이 하나뿐이면 선을 그리지 않는다 — 차트 자리만 비어 있다', () => {
    expect(buildSparklineSegments(flat(1), 120, 40)).toEqual([]);
    expect(buildSparklineSegments(flat(2), 120, 40)).not.toEqual([]);
  });

  it('왼쪽부터 차고 오른쪽이 빈칸으로 남는다 — 축 하한 2분', () => {
    // 축을 쌓인 구간에 딱 맞추면 20초치가 폭을 꽉 채워 10분처럼 읽힌다.
    const { xs } = xy(flat(2), 120, 40);
    // 두 점 사이 10초 / 축 2분 → 왼쪽 8% 만 쓴다.
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBeCloseTo(10, 0);
  });

  it('데이터가 늘면 축도 늘고 빈칸이 줄어든다 — 여유분 1.3배', () => {
    // 18점 = 170초 → 축 221초 → 선이 폭의 77% 를 왼쪽부터 채운다.
    const { xs } = xy(flat(18), 100, 40);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBeCloseTo(77, 0);
  });

  it('창이 다 차면 빈칸이 없어진다 — 축 상한 10분', () => {
    // 60점 = 590초, ×1.3 이 10분을 넘으므로 축은 10분에서 멈춘다.
    const { xs } = xy(flat(60), 120, 40);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBeCloseTo(118, 0);
  });

  it('잔변동은 평평하게 눌린다 — 1ms 차이가 오르막이 되지 않는다', () => {
    const { ys } = xy(
      series(Array.from({ length: 18 }, (_, index) => (index % 2 === 0 ? 4 : 5))),
      120,
      40,
    );
    // 눈금 하한(20ms)에 걸리므로 40px 높이에서 1ms 는 2px 다.
    expect(Math.abs(ys[0] - ys[1])).toBeCloseTo(2, 0);
    // 그리고 바닥이 아니라 중앙 근처에 놓인다.
    expect(ys[0]).toBeGreaterThan(15);
    expect(ys[0]).toBeLessThan(25);
  });

  it('범위가 넓으면 눈금을 채워 튐이 드러난다', () => {
    const { ys } = xy(series([...Array.from({ length: 17 }, () => 5), 105]), 100, 40);
    expect(Math.max(...ys)).toBeCloseTo(40, 0);
    expect(Math.min(...ys)).toBeCloseTo(0, 0);
  });

  it('모두 같은 값이면 한가운데 평평한 선이다', () => {
    const { ys } = xy(flat(18, 15), 50, 20);
    expect(new Set(ys)).toEqual(new Set([10]));
  });

  it('구간 색은 양 끝점 중 나쁜 쪽이다 — 튄 자리만 물든다', () => {
    // 5ms 평지에 300ms 하나. 그 오르내림 두 구간만 slow, 나머지는 fast 로 남아야 한다.
    const values = [...Array.from({ length: 8 }, () => 5), 300, 5, 5];
    const bands = buildSparklineSegments(series(values), 120, 40).map(
      (segment) => segment.band,
    );
    expect(bands).toEqual(['fast', 'slow', 'fast']);
  });

  it('값이 없으면 빈 배열이다', () => {
    expect(buildSparklineSegments([], 60, 20)).toEqual([]);
  });
});
