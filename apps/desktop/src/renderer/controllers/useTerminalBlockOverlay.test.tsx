// 오버레이 위치는 한 프레임에 한 번만 잰다. onScroll 은 줄마다 와서, 짧은 줄이 쏟아지면(`yes`) 줄마다
// 위치를 재던 것이 화면 처리를 21 → 2.4MB/s 로 떨어뜨리고 Ctrl+C 를 1초 넘게 늦췄다(실측).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalBlockOverlay } from './useTerminalBlockOverlay';

vi.mock('../lib/terminal-command-blocks', () => {
  const block = {
    id: 1,
    state: 'running',
    exitCode: null,
    durationMs: null,
    command: 'yes',
    commandUnreliable: false,
    marker: { line: 0 },
    endLine: null,
  };
  return {
    getCommandBlocks: () => [block],
    getCommandBlockAtLine: () => block,
  };
});

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function runFrames() {
  const pending = [...frames.values()];
  frames = new Map();
  for (const callback of pending) {
    callback(0);
  }
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderOverlay() {
  const listeners = { render: [] as Array<() => void>, scroll: [] as Array<() => void> };
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const element = document.createElement('div');
  element.appendChild(screen);
  // 블록이 있으면 스티키 헤더가 화면 위치를 잰다 — 이 호출 수가 곧 측정 횟수다.
  const measure = vi
    .spyOn(screen, 'getBoundingClientRect')
    .mockReturnValue({ top: 10, height: 240 } as DOMRect);
  const container = document.createElement('div');
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 300 } as DOMRect);
  // xterm 처럼 dispose 하면 리스너가 떨어진다.
  const subscribe = (list: Array<() => void>) => (listener: () => void) => {
    list.push(listener);
    return { dispose: () => list.splice(list.indexOf(listener), 1) };
  };
  const terminal = {
    rows: 24,
    element,
    buffer: { active: { type: 'normal', viewportY: 100, baseY: 100, cursorY: 23 } },
    onRender: subscribe(listeners.render),
    onScroll: subscribe(listeners.scroll),
    scrollToLine: vi.fn(),
  };
  // 앱에서처럼 ref 는 렌더마다 같은 객체다(useRef).
  const options = {
    terminalRef: { current: terminal as never },
    containerRef: { current: container },
    sessionIdRef: { current: 'session-1' },
    enabled: true,
  };
  const hook = renderHook(() => useTerminalBlockOverlay(options));
  measure.mockClear();
  return {
    hook,
    measure,
    scroll: () => listeners.scroll.forEach((listener) => listener()),
    render: () => listeners.render.forEach((listener) => listener()),
  };
}

describe('useTerminalBlockOverlay', () => {
  it('measures once per frame however many lines scroll', () => {
    const view = renderOverlay();

    act(() => {
      for (let line = 0; line < 1000; line += 1) {
        view.scroll();
      }
    });
    expect(view.measure).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    act(() => runFrames());
    expect(view.measure).toHaveBeenCalledTimes(1);
  });

  it('measures on render right away and drops the measurement scrolling scheduled', () => {
    const view = renderOverlay();

    act(() => {
      view.scroll();
      view.render();
    });
    expect(view.measure).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);

    act(() => runFrames());
    expect(view.measure).toHaveBeenCalledTimes(1);
  });

  it('cancels the scheduled measurement when it unmounts', () => {
    const view = renderOverlay();

    act(() => view.scroll());
    expect(frames.size).toBe(1);
    view.hook.unmount();

    expect(frames.size).toBe(0);
    expect(view.measure).not.toHaveBeenCalled();
  });
});
