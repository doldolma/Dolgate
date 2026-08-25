// 폴링 **간격** 을 본다. 값 계산은 lib/host-metrics.test.ts 가 덮으므로, 여기서는 언제 왕복이
// 나가는지만 — 그것이 값의 분모이고, 분모가 틀리면 차트 눈금이 통째로 틀어진다.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHostMetrics, watchHostMetrics } from '../lib/host-metrics-registry';
import { useHostMetrics } from './useHostMetrics';

const queryTerminalCompletion = vi.hoisted(() => vi.fn());
vi.mock('../services/desktop/terminal', () => ({ queryTerminalCompletion }));

const SESSION = 'poll-session';

/** 호출할 때마다 원격 시계와 카운터가 흘러간 /proc 출력. */
function reply(callIndex: number): string {
  const seconds = 100 + callIndex * 3;
  return [
    '@@dolgate:stat',
    `cpu  ${1000 + callIndex * 25} 0 890 ${900000 + callIndex * 75} 320 0 45 0 0 0`,
    '@@dolgate:mem',
    'MemTotal:       16316412 kB',
    'MemAvailable:   10245680 kB',
    '@@dolgate:net',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    `  eth0: ${900000 + callIndex * 30000}   54321    0    0    0     0          0         0 ${500000 + callIndex * 3000}   43210    0    0    0     0       0          0`,
    '@@dolgate:load',
    '0.42 0.35 0.30 2/345 12345',
    '@@dolgate:uptime',
    `${seconds.toFixed(2)} ${(seconds * 4).toFixed(2)}`,
    '@@dolgate:cpus',
    '4',
    '@@dolgate:diskio',
    '   8       0 sata1 1000 0 20000 100 500 0 8000 50 0 100 150',
    '@@dolgate:disk',
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/sata1 100000 50000 50000 50% /',
  ].join('\n');
}

beforeEach(() => {
  vi.useFakeTimers();
  queryTerminalCompletion.mockReset();
  queryTerminalCompletion.mockImplementation(() =>
    Promise.resolve(reply(queryTerminalCompletion.mock.calls.length - 1)),
  );
});

afterEach(() => {
  vi.useRealTimers();
  clearHostMetrics(SESSION);
});

/** 타이머를 밀고, 그 사이에 뜬 promise 들이 정리될 때까지 기다린다. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useHostMetrics 폴링 간격', () => {
  // 지표는 스스로 도는 폴링이다 — 두 번째 보조 채널에서 돌아야 사용자가 치는 자동완성이
  // 이 왕복 뒤에 줄 서지 않는다.
  it('백그라운드 레인으로 나간다', async () => {
    renderHook(() => useHostMetrics({ sessionId: SESSION, enabled: true, visible: true }));
    await advance(0);
    expect(queryTerminalCompletion).toHaveBeenCalledWith(SESSION, expect.any(String), {
      background: true,
    });
  });

  it('주기가 바뀌었을 뿐이면 즉시 다시 찍지 않는다 — 남은 시간만큼 기다린다', async () => {
    const view = renderHook(() =>
      useHostMetrics({ sessionId: SESSION, enabled: true, visible: true }),
    );
    // 첫 폴링은 즉시, 두 번째는 2초 뒤(차분할 짝을 빨리 만들려고).
    await advance(0);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(2);

    // 방금 찍은 지 0.5초 만에 패널을 연다 → 주기가 10초에서 3초로 좁아지며 effect 가 다시 돈다.
    await advance(500);
    let release = () => undefined as void;
    await act(async () => {
      release = watchHostMetrics(SESSION, {});
    });
    // 여기서 즉시 찍으면 간격이 0.5초가 되어 그 왕복의 초당 값이 통째로 부푼다.
    await advance(0);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(2);

    // 남은 2.5초를 채우면 그때 나간다.
    await advance(2_400);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(2);
    await advance(200);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(3);

    act(() => {
      release();
    });
    view.unmount();
  });

  it('주기보다 오래 지났으면 기다리지 않고 바로 찍는다', async () => {
    const view = renderHook(() =>
      useHostMetrics({ sessionId: SESSION, enabled: true, visible: true }),
    );
    await advance(0);
    await advance(2_000);
    expect(queryTerminalCompletion).toHaveBeenCalledTimes(2);

    // 상시 주기(10초)로 한 바퀴를 거의 다 돈 시점에 패널을 연다.
    await advance(9_000);
    const calls = queryTerminalCompletion.mock.calls.length;
    let release = () => undefined as void;
    await act(async () => {
      release = watchHostMetrics(SESSION, {});
    });
    // 이미 부스트 주기(3초)를 넘겨 지났으므로 기다릴 이유가 없다.
    await advance(0);
    expect(queryTerminalCompletion.mock.calls.length).toBe(calls + 1);

    act(() => {
      release();
    });
    view.unmount();
  });
});

/**
 * 보조 채널은 세션 패널의 다른 폴링(도커 지표)과 함께 쓴다. `docker stats` 가 몇 초씩 물고
 * 있으면 이 왕복이 차례를 놓칠 수 있는데, 그걸 곧장 "미지원" 으로 읽으면 자원 섹션이 세션
 * 내내 비어 버린다. 보조 채널이 **아예 없는** 연결(SSM raw shell)은 왕복이 성공하고 빈 출력이
 * 오므로 그쪽에서 걸린다.
 */
describe('useHostMetrics 왕복 실패', () => {
  it('한 번 실패했다고 접지 않는다 — 다시 물어보고 값을 채운다', async () => {
    let attempts = 0;
    queryTerminalCompletion.mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error('completion lane busy'));
      }
      return Promise.resolve(reply(attempts));
    });

    const view = renderHook(() =>
      useHostMetrics({ sessionId: SESSION, enabled: true, visible: true }),
    );
    await advance(0);
    expect(view.result.current.status).not.toBe('unsupported');

    // 다음 주기에 다시 묻고, 차분이 만들어지면 값이 선다.
    await advance(10_000);
    await advance(10_000);
    expect(attempts).toBeGreaterThan(2);
    expect(view.result.current.status).toBe('ready');
    view.unmount();
  });

  it('계속 실패하면 그때 접는다', async () => {
    queryTerminalCompletion.mockImplementation(() =>
      Promise.reject(new Error('completion lane busy')),
    );

    const view = renderHook(() =>
      useHostMetrics({ sessionId: SESSION, enabled: true, visible: true }),
    );
    await advance(0);
    await advance(10_000);
    await advance(10_000);
    expect(view.result.current.status).toBe('unsupported');
    view.unmount();
  });
});
