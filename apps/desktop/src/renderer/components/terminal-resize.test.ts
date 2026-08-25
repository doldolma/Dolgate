import { describe, expect, it, vi } from 'vitest';
import { createTerminalResizeScheduler, type TerminalSize } from './terminal-resize';

/**
 * 프레임·타이머를 손으로 돌리는 대역.
 *
 * scheduleFlush 는 프레임을 **두 번** 잡는다("다음 프레임에도 요청이 오는가" 로 연속 변화를
 * 알아보기 때문에). 그래서 한 번의 맞추기 시도는 runFrames(2) 로 끝난다.
 */
function createHarness(initialSize: TerminalSize) {
  const queue: Array<{ id: number; callback: FrameRequestCallback }> = [];
  const cancelled: number[] = [];
  const timers: { settle?: () => void } = {};
  let nextFrameId = 1;
  let size = initialSize;
  const fit = vi.fn();
  const sendResize = vi.fn();

  const scheduler = createTerminalResizeScheduler({
    fit,
    readSize: () => size,
    sendResize,
    requestFrame: (callback) => {
      const id = nextFrameId++;
      queue.push({ id, callback });
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        queue.splice(index, 1);
      }
    },
    setTimer: (callback) => {
      timers.settle = callback;
      return 1;
    },
    clearTimer: () => {
      delete timers.settle;
    }
  });

  return {
    fit,
    sendResize,
    cancelled,
    scheduler,
    pendingFrames: () => queue.length,
    setSize: (next: TerminalSize) => {
      size = next;
    },
    runFrames: (count = 1) => {
      for (let index = 0; index < count; index += 1) {
        const entry = queue.shift();
        entry?.callback(index * 16);
      }
    },
    settle: () => {
      const callback = timers.settle;
      delete timers.settle;
      callback?.();
    }
  };
}

describe('createTerminalResizeScheduler', () => {
  it('한 번짜리 변화는 바로 맞추고, 같은 프레임의 중복 발화는 한 번으로 묶는다', () => {
    const harness = createHarness({ cols: 120, rows: 32 });

    // ResizeObserver 는 한 번의 레이아웃 변경에도 여러 번 발화한다 — 같은 프레임 안이다.
    harness.scheduler.request();
    harness.scheduler.request();
    expect(harness.pendingFrames()).toBe(1);

    harness.runFrames(2);

    expect(harness.fit).toHaveBeenCalledTimes(1);
    expect(harness.sendResize).toHaveBeenCalledTimes(1);
    expect(harness.sendResize).toHaveBeenLastCalledWith({ cols: 120, rows: 32 });

    // 크기가 그대로면 다시 보내지 않는다.
    harness.settle();
    harness.runFrames(2);
    expect(harness.sendResize).toHaveBeenCalledTimes(1);
  });

  it('드래그 중에는 한 번도 맞추지 않고 손을 뗀 뒤 한 번만 맞춘다', () => {
    // 캔버스는 크기를 바꾸는 순간 지워지므로 재지정 횟수가 곧 깜빡임 횟수다. 드래그 중의
    // 맞추기는 어차피 낡은 값이라 깜빡임만 남기고 값을 못 낸다.
    const harness = createHarness({ cols: 120, rows: 32 });

    for (let step = 0; step < 20; step += 1) {
      harness.setSize({ cols: 120 - step, rows: 32 });
      harness.scheduler.request();
      harness.runFrames(1);
    }

    expect(harness.fit).not.toHaveBeenCalled();
    expect(harness.sendResize).not.toHaveBeenCalled();

    harness.settle();
    harness.runFrames(2);

    expect(harness.fit).toHaveBeenCalledTimes(1);
    expect(harness.sendResize).toHaveBeenCalledTimes(1);
    expect(harness.sendResize).toHaveBeenLastCalledWith({ cols: 101, rows: 32 });
  });

  it('드래그 중 손이 멈칫해도 맞추기는 한 번씩만 늘어난다', () => {
    // 예전에는 멈칫할 때마다 "정착 fit + 다시 움직여 앞머리 fit" 이 쌍으로 붙어 두 번씩
    // 깜빡였다.
    const harness = createHarness({ cols: 120, rows: 32 });

    harness.setSize({ cols: 118, rows: 32 });
    harness.scheduler.request();
    harness.runFrames(1);
    harness.scheduler.request();
    harness.runFrames(1);

    // 멈칫 — 정착이 한 번 맞춘다.
    harness.settle();
    harness.runFrames(2);
    expect(harness.fit).toHaveBeenCalledTimes(1);

    // 다시 움직인다: 앞머리에서 또 맞추지 않는다.
    for (let step = 0; step < 5; step += 1) {
      harness.setSize({ cols: 112 - step, rows: 32 });
      harness.scheduler.request();
      harness.runFrames(1);
    }
    expect(harness.fit).toHaveBeenCalledTimes(1);

    harness.settle();
    harness.runFrames(2);
    expect(harness.fit).toHaveBeenCalledTimes(2);
    expect(harness.sendResize).toHaveBeenLastCalledWith({ cols: 108, rows: 32 });
  });

  it('0x0 크기는 보내지 않고, reset 은 대기 중인 프레임을 취소한다', () => {
    const harness = createHarness({ cols: 0, rows: 0 });

    harness.scheduler.request();
    harness.runFrames(2);
    expect(harness.sendResize).not.toHaveBeenCalled();

    harness.scheduler.reset();
    harness.scheduler.request();
    expect(harness.pendingFrames()).toBe(1);
    harness.scheduler.reset();
    expect(harness.cancelled.length).toBeGreaterThan(0);
    expect(harness.pendingFrames()).toBe(0);
  });

  it('전환 중에는 재지 않고, 끝난 뒤 한 번만 맞춘다', () => {
    // 세션 패널 폭이 프레임마다 바뀌는 0.15초 동안 fit 이 열 번 돌면 PTY·tmux 로 리사이즈가
    // 쏟아진다. 그래서 보류 중에는 요청을 흘리고, 끝난 뒤 부르는 쪽이 한 번 더 요청한다.
    const queue: FrameRequestCallback[] = [];
    const fit = vi.fn();
    const sendResize = vi.fn();
    let held = true;

    const scheduler = createTerminalResizeScheduler({
      fit,
      isHeld: () => held,
      readSize: () => ({ cols: 100, rows: 30 }),
      sendResize,
      requestFrame: (callback) => {
        queue.push(callback);
        return queue.length;
      },
      cancelFrame: () => undefined,
      setTimer: () => 1,
      clearTimer: () => undefined
    });

    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(queue.length).toBe(0);
    expect(fit).not.toHaveBeenCalled();

    held = false;
    scheduler.request();
    queue.shift()?.(0);
    queue.shift()?.(16);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it('끌기가 멈춘 직후 전환이 시작되면 정착 맞추기도 흘린다', () => {
    // 분할선을 놓자마자 세션 패널을 열면, 이미 걸려 있던 정착 타이머가 전환 도중에 발화한다.
    // `request()` 에서만 hold 를 보면 그 한 번이 그대로 나가 — 전환 중 리사이즈를 막으려던
    // 장치를 정확히 우회한다.
    const queue: FrameRequestCallback[] = [];
    const fit = vi.fn();
    const sendResize = vi.fn();
    let held = false;
    let settle: (() => void) | undefined;

    const scheduler = createTerminalResizeScheduler({
      fit,
      isHeld: () => held,
      readSize: () => ({ cols: 100, rows: 30 }),
      sendResize,
      requestFrame: (callback) => {
        queue.push(callback);
        return queue.length;
      },
      cancelFrame: () => undefined,
      setTimer: (callback) => {
        settle = callback;
        return 1;
      },
      clearTimer: () => {
        settle = undefined;
      }
    });

    // 끌기: 프레임마다 요청이 이어지므로 중간 맞추기는 버려진다.
    scheduler.request();
    scheduler.request();
    queue.shift()?.(0);
    scheduler.request();
    queue.shift()?.(16);
    expect(fit).not.toHaveBeenCalled();

    // 손을 뗀 직후 전환 시작 → 걸려 있던 정착 타이머가 전환 중에 발화한다.
    held = true;
    settle?.();
    while (queue.length > 0) {
      queue.shift()?.(32);
    }

    expect(fit).not.toHaveBeenCalled();
    expect(sendResize).not.toHaveBeenCalled();

    // 전환이 끝나면 부르는 쪽이 다시 요청하고, 그때 한 번 맞춘다.
    held = false;
    scheduler.request();
    queue.shift()?.(48);
    queue.shift()?.(64);
    expect(fit).toHaveBeenCalledTimes(1);
  });
});
