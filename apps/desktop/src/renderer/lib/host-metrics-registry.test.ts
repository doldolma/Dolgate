import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearHostMetrics,
  countHostMetricsEntries,
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
    system: null,
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
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: false, processes: false, system: false });
    const release = watchHostMetrics(SESSION);
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: true, processes: false, system: false });
    release();
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: false, processes: false, system: false });
  });

  it('요청이 겹치면 하나라도 프로세스를 원할 때 켠다', () => {
    // 자원 섹션과 프로세스 섹션이 동시에 열려 있을 수 있다.
    const releaseMetrics = watchHostMetrics(SESSION);
    const releaseProcesses = watchHostMetrics(SESSION, { processes: true });
    expect(getHostMetricsWatch(SESSION).processes).toBe(true);

    releaseProcesses();
    expect(getHostMetricsWatch(SESSION)).toEqual({ boosted: true, processes: false, system: false });
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

  // pane 이 먼저 정리되고 패널이 나중에 구독을 놓는 순서에서 항목이 남았다 — 세션 id 마다
  // 하나씩, 앱을 켜 둔 동안 계속.
  it('아무도 안 보게 되면 항목을 버린다', () => {
    const before = countHostMetricsEntries();
    const unsubscribe = subscribeHostMetrics(SESSION, () => undefined);
    const unwatch = watchHostMetrics(SESSION, { processes: true });
    publishHostMetrics(SESSION, snapshot(7));

    // pane 이 먼저 사라진다(값도 함께 치운다). 이때는 아직 패널이 보고 있다.
    clearHostMetrics(SESSION);
    expect(countHostMetricsEntries()).toBe(before + 1);

    unwatch();
    unsubscribe();
    expect(countHostMetricsEntries()).toBe(before);
  });

  // 반대로 발행자가 살아 있는데 패널만 닫은 경우는 지우면 안 된다 — 다시 열었을 때 다음
  // 폴링까지 빈 화면이 된다.
  it('값이 남아 있으면 구독이 끊겨도 지키다', () => {
    const unsubscribe = subscribeHostMetrics(SESSION, () => undefined);
    publishHostMetrics(SESSION, snapshot(9));
    unsubscribe();
    expect(getHostMetricsSnapshot(SESSION).metrics).toEqual({ cpuPercent: 9 });
  });
});
