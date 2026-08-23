import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearHostMetrics,
  getHostMetricsSnapshot,
  getHostMetricsVersion,
  getHostMetricsWatch,
  publishHostMetrics,
  subscribeHostMetrics,
  watchHostMetrics,
} from './host-metrics-registry';

const SESSION = 'session-metrics';

afterEach(() => {
  clearHostMetrics(SESSION);
});

function snapshot(cpuPercent: number) {
  return {
    status: 'ready' as const,
    metrics: { cpuPercent } as never,
    processes: null,
    updatedAtMs: 1,
  };
}

describe('host-metrics-registry', () => {
  it('발행한 값을 구독자가 받는다', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHostMetrics(SESSION, listener);
    publishHostMetrics(SESSION, snapshot(12));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getHostMetricsSnapshot(SESSION).metrics).toEqual({ cpuPercent: 12 });
    expect(getHostMetricsVersion(SESSION)).toBe(1);
    unsubscribe();
    publishHostMetrics(SESSION, snapshot(13));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('세션을 치우면 빈 값이 되고 구독자에게 알린다', () => {
    // 남겨 두면 다음 세션이 옛 값을 잠깐 보여 준다.
    const listener = vi.fn();
    const unsubscribe = subscribeHostMetrics(SESSION, listener);
    publishHostMetrics(SESSION, snapshot(50));
    clearHostMetrics(SESSION);
    expect(getHostMetricsSnapshot(SESSION).metrics).toBeNull();
    expect(getHostMetricsSnapshot(SESSION).status).toBe('off');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('관찰 요청이 하나라도 있으면 주기를 좁힌다', () => {
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: false, processes: false });
    const release = watchHostMetrics(SESSION);
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: true, processes: false });
    release();
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: false, processes: false });
  });

  it('요청이 겹치면 하나라도 프로세스를 원할 때 켠다', () => {
    // 자원 섹션과 프로세스 섹션이 동시에 열려 있을 수 있다.
    const releaseMetrics = watchHostMetrics(SESSION);
    const releaseProcesses = watchHostMetrics(SESSION, { processes: true });
    expect(getHostMetricsWatch(SESSION).processes).toBe(true);

    releaseProcesses();
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: true, processes: false });
    releaseMetrics();
    expect(getHostMetricsWatch(SESSION).boosted).toBe(false);
  });

  it('같은 해제 함수를 두 번 불러도 다른 요청을 지우지 않는다', () => {
    const first = watchHostMetrics(SESSION);
    const second = watchHostMetrics(SESSION);
    first();
    first();
    expect(getHostMetricsWatch(SESSION).boosted).toBe(true);
    second();
    expect(getHostMetricsWatch(SESSION).boosted).toBe(false);
  });

  it('구독자가 던져도 발행은 계속된다', () => {
    // 이 알림은 폴링 루프 안에서 나간다 — 예외가 새면 폴링이 끊긴다.
    const unsubscribe = subscribeHostMetrics(SESSION, () => {
      throw new Error('boom');
    });
    expect(() => publishHostMetrics(SESSION, snapshot(1))).not.toThrow();
    expect(getHostMetricsSnapshot(SESSION).metrics).toEqual({ cpuPercent: 1 });
    unsubscribe();
  });

  it('빈 sessionId 는 무시한다', () => {
    expect(() => publishHostMetrics('', snapshot(1))).not.toThrow();
    const release = watchHostMetrics('');
    expect(getHostMetricsWatch('').boosted).toBe(false);
    release();
  });
});
