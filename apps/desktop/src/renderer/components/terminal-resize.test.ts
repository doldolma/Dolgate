import { describe, expect, it, vi } from 'vitest';
import { createTerminalResizeScheduler } from './terminal-resize';

describe('createTerminalResizeScheduler', () => {
  it('같은 프레임의 연속 요청을 한 번으로 묶고 동일 크기는 다시 보내지 않는다', () => {
    const fit = vi.fn();
    const sendResize = vi.fn();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    let size = { cols: 120, rows: 32 };

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
      }
    });

    scheduler.request();
    scheduler.request();

    expect(frames.size).toBe(1);
    frames.get(1)?.(16);

    expect(fit).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenLastCalledWith({ cols: 120, rows: 32 });

    scheduler.request();
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

    scheduler.request();
    scheduler.reset();

    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(frames.size).toBe(0);
  });
});
