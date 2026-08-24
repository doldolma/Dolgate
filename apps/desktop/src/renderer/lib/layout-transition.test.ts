// 패널 여닫기 동안 터미널 fit 을 미루는 신호대. 여기서 틀리면 리사이즈가 아예 안 오거나
// (셸이 화면과 다른 크기를 믿는다) 프레임마다 쏟아진다.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginLayoutTransition,
  isLayoutTransitionActive,
  resetLayoutTransition,
  subscribeToLayoutTransitionEnd,
} from './layout-transition';

afterEach(() => {
  resetLayoutTransition();
  vi.useRealTimers();
});

describe('layout-transition', () => {
  it('전환 동안 붙잡고, 끝나면 알린다', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    subscribeToLayoutTransitionEnd(onEnd);

    beginLayoutTransition(160);
    expect(isLayoutTransitionActive()).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(160);
    expect(isLayoutTransitionActive()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('겹쳐 부르면 늦게 끝나는 쪽으로 늘어난다', () => {
    // 패널을 연달아 여닫으면 두 전환이 겹친다 — 먼저 걸린 타이머가 늦은 전환을 끊어 버리면
    // 폭이 움직이는 중에 fit 이 돌아 격자가 어긋난다.
    vi.useFakeTimers();
    const onEnd = vi.fn();
    subscribeToLayoutTransitionEnd(onEnd);

    beginLayoutTransition(160);
    vi.advanceTimersByTime(100);
    beginLayoutTransition(160);

    vi.advanceTimersByTime(60);
    expect(isLayoutTransitionActive()).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(isLayoutTransitionActive()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('구독을 끊으면 더는 부르지 않는다', () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const stop = subscribeToLayoutTransitionEnd(onEnd);
    stop();

    beginLayoutTransition(50);
    vi.advanceTimersByTime(50);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
