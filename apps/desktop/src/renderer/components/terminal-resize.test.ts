import { describe, expect, it, vi } from 'vitest';
import { createTerminalResizeScheduler } from './terminal-resize';

describe('createTerminalResizeScheduler', () => {
  it('같은 프레임의 연속 요청을 한 번으로 묶고 동일 크기는 다시 보내지 않는다', () => {
    const fit = vi.fn();
    const sendResize = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    let size = { cols: 120, rows: 32 };

    // 정착 타이머는 직접 발화시킨다 — "연속 변화" 와 "멈춤" 의 경계를 테스트가 정한다.
    const timers: { settle?: () => void } = {};

    const scheduler = createTerminalResizeScheduler({
      fit,
      readSize: () => size,
      sendResize,
      requestFrame: (callback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, (timestamp) => {
          frames.delete(frameId);
          callback(timestamp);
        });
        return frameId;
      },
      cancelFrame: (frameId) => {
        frames.delete(frameId);
      },
      setTimer: (callback) => {
        timers.settle = callback;
        return 1;
      },
      clearTimer: () => {
        delete timers.settle;
      }
    });

    scheduler.request();
    scheduler.request();

    expect(frames.size).toBe(1);
    frames.get(1)?.(16);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenLastCalledWith({ cols: 120, rows: 32 });

    // 연속 변화 중(정착 전)의 중간 요청은 버린다 — 프레임도 잡지 않는다.
    scheduler.request();
    expect(frames.size).toBe(0);

    // 멈추면 한 번 더 맞춘다. 크기가 그대로면 보내지 않는다.
    timers.settle?.();
    frames.get(2)?.(32);
    expect(sendResize).toHaveBeenCalledTimes(1);

    size = { cols: 132, rows: 40 };
    scheduler.request();
    frames.get(3)?.(48);

    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenLastCalledWith({ cols: 132, rows: 40 });
  });

  it('0x0 크기는 무시하고 reset 시 대기 중인 프레임을 취소한다', () => {
    const fit = vi.fn();
    const sendResize = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    const cancelFrame = vi.fn((frameId: number) => {
      frames.delete(frameId);
    });
    let nextFrameId = 1;
    let size = { cols: 0, rows: 0 };

    const scheduler = createTerminalResizeScheduler({
      fit,
      readSize: () => size,
      sendResize,
      requestFrame: (callback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, (timestamp) => {
          frames.delete(frameId);
          callback(timestamp);
        });
        return frameId;
      },
      cancelFrame
    });

    scheduler.request();
    frames.get(1)?.(16);

    expect(sendResize).not.toHaveBeenCalled();

    // 첫 프레임이 이미 소비됐고 버스트가 살아 있으므로, 다음 요청은 프레임을 잡지 않는다.
    scheduler.request();
    expect(frames.size).toBe(0);

    // 새 버스트에서 잡힌 프레임은 reset 이 취소한다.
    scheduler.reset();
    scheduler.request();
    expect(frames.size).toBe(1);
    scheduler.reset();
    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(frames.size).toBe(0);
  });

  it('전환 중에는 재지 않고, 끝난 뒤 한 번만 맞춘다', () => {
    // 세션 패널 폭이 프레임마다 바뀌는 0.16초 동안 fit 이 열 번 돌면 PTY·tmux 로 리사이즈가
    // 쏟아진다. 그래서 보류 중에는 요청을 흘리고, 끝난 뒤 부르는 쪽이 한 번 더 요청한다.
    const fit = vi.fn();
    const sendResize = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    let held = true;

    const scheduler = createTerminalResizeScheduler({
      fit,
      isHeld: () => held,
      readSize: () => ({ cols: 100, rows: 30 }),
      sendResize,
      requestFrame: (callback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, (timestamp) => {
          frames.delete(frameId);
          callback(timestamp);
        });
        return frameId;
      },
      cancelFrame: (frameId) => {
        frames.delete(frameId);
      }
    });

    // 전환 중: 몇 번을 눌러도 프레임이 잡히지 않는다.
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(frames.size).toBe(0);
    expect(fit).not.toHaveBeenCalled();

    // 전환이 끝나면 한 번.
    held = false;
    scheduler.request();
    for (const frame of [...frames.values()]) {
      frame(0);
    }
    expect(fit).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it('연속 변화에서는 처음과 멈춘 뒤 두 번만 맞춘다', () => {
    // 실측: 창 드래그 한 번(21단계)에 캔버스가 31번 재지정되고 페인트의 절반이 빈 화면이었다.
    // 캔버스는 크기를 바꾸는 순간 지워지므로, 재지정 횟수가 곧 깜빡임 횟수다.
    const fit = vi.fn();
    const sendResize = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const timers: { settle?: () => void } = {};
    let width = 120;

    const scheduler = createTerminalResizeScheduler({
      fit,
      readSize: () => ({ cols: width, rows: 32 }),
      sendResize,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
      setTimer: (callback) => {
        timers.settle = callback;
        return 1;
      },
      clearTimer: () => {
        delete timers.settle;
      }
    });

    // 드래그 20프레임: 매 프레임 요청 + 그 사이 크기 변화.
    for (let step = 0; step < 20; step += 1) {
      width = 120 - step;
      scheduler.request();
      const frame = frames.shift();
      frame?.(step * 16);
    }
    // 선두 한 번만 반영됐다.
    expect(fit).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledTimes(1);

    // 손을 떼면 최종 크기로 한 번.
    timers.settle?.();
    frames.shift()?.(400);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenCalledTimes(2);
    expect(sendResize).toHaveBeenLastCalledWith({ cols: 101, rows: 32 });
  });
});
