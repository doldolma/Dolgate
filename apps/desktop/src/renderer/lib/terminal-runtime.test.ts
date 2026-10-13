import { describe, expect, it, vi } from 'vitest';
import type { IDisposable } from '@xterm/xterm';
import {
  CONPTY_WINDOWS_PTY,
  createTerminalRuntime,
  type TerminalRuntimeAppearance,
} from './terminal-runtime';

function createAppearance(): TerminalRuntimeAppearance {
  return {
    theme: {
      background: '#0b1020',
      foreground: '#f5f7fb'
    },
    fontFamily: 'JetBrains Mono',
    fontSize: 14,
    scrollbackLines: 5000,
    lineHeight: 1,
    letterSpacing: 0,
    minimumContrastRatio: 1,
    macOptionIsMeta: false
  };
}

function createFakeTerminal(lineText = 'visit https://example.com/docs now') {
  const dataListeners: Array<(value: string) => void> = [];
  const binaryListeners: Array<(value: string) => void> = [];
  const writes: Array<{ value: string | Uint8Array; callback?: () => void }> = [];

  const terminal = {
    options: {},
    unicode: {
      activeVersion: '0'
    },
    rows: 24,
    cols: 80,
    buffer: {
      active: {
        getLine: vi.fn(() => ({
          translateToString: vi.fn(() => lineText)
        }))
      }
    },
    loadAddon: vi.fn(),
    // 링크 탐지는 @xterm/addon-web-links 가 activate 안에서 등록한다. 테스트는 애드온을 주입해
    // 대체하므로 여기까지 오지 않지만, 실제 Terminal 의 API 표면은 유지해 둔다.
    registerLinkProvider: vi.fn(
      () =>
        ({
          dispose: vi.fn()
        }) satisfies IDisposable
    ),
    open: vi.fn(),
    dispose: vi.fn(),
    refresh: vi.fn(),
    focus: vi.fn(),
    write: vi.fn((value: string | Uint8Array, callback?: () => void) => {
      writes.push({ value, callback });
    }),
    onData: vi.fn((listener: (value: string) => void) => {
      dataListeners.push(listener);
      return {
        dispose: vi.fn()
      } satisfies IDisposable;
    }),
    onBinary: vi.fn((listener: (value: string) => void) => {
      binaryListeners.push(listener);
      return {
        dispose: vi.fn()
      } satisfies IDisposable;
    })
  };

  return {
    terminal,
    writes,
    triggerWriteCallback(index = writes.length - 1) {
      writes[index]?.callback?.();
    }
  };
}

describe('terminal-runtime', () => {
  // tmux pane 은 마운트 즉시 백로그(재연결 복원 바이트)가 재생되는데, 칸 수로 맞추는 resize 는
  // 다음 프레임에 온다. 기본 80x24 로 만들면 그 사이 들어온 줄이 잘리고 되돌아오지 않는다.
  // 그래서 만들 때부터 tmux 가 준 칸 수여야 한다(기억이 아니라 현재 레이아웃 값이다).
  it('initialSize 가 있으면 그 격자로 만든다', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const createTerminal = vi.fn().mockReturnValue(terminal);
    createTerminalRuntime({
      container,
      appearance: createAppearance(),
      initialSize: { cols: 101, rows: 52 },
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: createTerminal as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(), dispose: vi.fn(), findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });
    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cols: 101, rows: 52 }));
  });

  it('initialSize 가 없으면 크기를 정하지 않는다(fit 이 맞춘다)', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const createTerminal = vi.fn().mockReturnValue(terminal);
    createTerminalRuntime({
      container,
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: createTerminal as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(), dispose: vi.fn(), findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });
    const options = createTerminal.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('cols');
    expect(options).not.toHaveProperty('rows');
  });

  // ConPTY 를 거치는 세션만 windowsPty 를 받는다. 주지 않으면 생성 옵션에 아예 없다(아래 생성
  // 옵션 테스트) — 원격 PTY 세션에 ConPTY 용 처리가 끼어들면 안 된다.
  it('windowsPty 를 주면 생성 옵션에 넣고, 만든 뒤에는 바꾸거나 해제할 수 있다', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const createTerminal = vi.fn().mockReturnValue(terminal);
    const runtime = createTerminalRuntime({
      container,
      appearance: createAppearance(),
      windowsPty: CONPTY_WINDOWS_PTY,
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: createTerminal as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(), dispose: vi.fn(), findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });
    // 빌드 번호는 일부러 주지 않는다 — 그것이 바꾸는 것은 Windows 10 의 reflow 뿐이다.
    expect(createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ windowsPty: { backend: 'conpty' } })
    );

    runtime.setWindowsPty(undefined);
    expect((terminal.options as Record<string, unknown>).windowsPty).toEqual({});
    runtime.setWindowsPty(CONPTY_WINDOWS_PTY);
    expect((terminal.options as Record<string, unknown>).windowsPty).toEqual({ backend: 'conpty' });
  });

  // Ctrl+L·clear·cls 가 보내는 화면 전체 지우기(ESC[2J)를 지우기 직전에 알린다. 지우기 자체는 막지
  // 않는다(false) — 막으면 화면이 지워지지 않는다.
  it('화면 전체 지우기(ED2)만 지우기 직전에 알리고 xterm 의 지우기는 그대로 둔다', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const csiHandlers: Array<{
      id: unknown;
      callback: (params: (number | number[])[]) => boolean;
    }> = [];
    const disposeCsiHandler = vi.fn();
    Object.assign(terminal, {
      parser: {
        registerCsiHandler: vi.fn(
          (id: unknown, callback: (params: (number | number[])[]) => boolean) => {
            csiHandlers.push({ id, callback });
            return { dispose: disposeCsiHandler } satisfies IDisposable;
          }
        )
      }
    });
    const onScreenErase = vi.fn();
    const runtime = createTerminalRuntime({
      container,
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      onScreenErase,
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(), dispose: vi.fn(), findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });

    expect(csiHandlers).toHaveLength(1);
    expect(csiHandlers[0]?.id).toEqual({ final: 'J' });
    const handler = csiHandlers[0]!.callback;
    expect(handler([2])).toBe(false);
    expect(onScreenErase).toHaveBeenCalledTimes(1);
    // 커서 아래만(0)·위만(1)·스크롤백(3) 지우기는 알리지 않는다.
    for (const mode of [0, 1, 3]) {
      expect(handler([mode])).toBe(false);
    }
    expect(onScreenErase).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(disposeCsiHandler).toHaveBeenCalled();
  });

  // 실기기에서 두 번째 tmux 창이 깨진 원인. initialSize 로 만들어도 open() 직후 컨테이너에 fit 하면
  // 격자가 컨테이너 픽셀(tmux 와 한두 칸 어긋남)로 바뀌고, 마운트 직후 재생되는 백로그(복원 바이트)가
  // 그 격자에 쓰인다 — 뒤에 칸 수를 바로잡아도 감긴 줄은 되돌아오지 않는다.
  it('initialSize 가 있으면 만들 때 컨테이너에 fit 하지 않는다', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const fitAddon = { fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() };
    createTerminalRuntime({
      container,
      appearance: createAppearance(),
      initialSize: { cols: 100, rows: 50 },
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(), dispose: vi.fn(), findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });
    expect(terminal.open).toHaveBeenCalledWith(container);
    expect(fitAddon.fit).not.toHaveBeenCalled();
  });

  it('creates the terminal, opens it, fits immediately, and activates Unicode11', () => {
    const container = document.createElement('div');
    const { terminal } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const searchAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
      clearActiveDecoration: vi.fn()
    };
    const unicode11Addon = {
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const createTerminal = vi.fn().mockReturnValue(terminal);
    const createFitAddon = vi.fn().mockReturnValue(fitAddon);

    const runtime = createTerminalRuntime({
      container,
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: createTerminal as never,
        createFitAddon: createFitAddon as never,
        createSearchAddon: (() => searchAddon) as never,
        createUnicode11Addon: (() => unicode11Addon) as never,
        openExternal: vi.fn()
      }
    });

    expect(createTerminal).toHaveBeenCalledWith({
      // 명령 블록 오버레이의 marker/decoration 은 proposed API 라 이 옵션이 꺼지면
      // registerDecoration 이 OSC 핸들러 안에서 던져 터미널이 멈춘다.
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'JetBrains Mono',
      fontSize: 14,
      theme: {
        background: '#0b1020',
        foreground: '#f5f7fb'
      },
      scrollback: 5000,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 1,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true
    });
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(1, fitAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(2, searchAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(3, expect.any(Object));
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(4, unicode11Addon);
    expect(terminal.unicode.activeVersion).toBe('11');
    expect(terminal.open).toHaveBeenCalledWith(container);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  // 첫 출력은 프레임을 기다리지 않는다. 예전에는 모든 출력이 requestAnimationFrame 을 한 번
  // 거쳐서, 키 하나에 에코 하나 오는 상호작용에도 8~17ms 가 붙었다. xterm 은 내부 WriteBuffer
  // 로 이미 청크를 모으고 자기 프레임에 렌더하므로(공식 AttachAddon 도 바로 write 한다) 밖에서
  // 한 번 더 기다릴 이유가 없다. 배칭은 쓰기가 진행되는 동안으로 옮겼다.
  it('writes the first chunk immediately instead of waiting for a frame', () => {
    const { terminal, writes, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const scheduleAnimationFrame = vi.fn((_callback: (time: number) => void) => 1);
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame,
        cancelScheduledAnimationFrame: vi.fn(),
        openExternal: vi.fn()
      }
    });

    runtime.write('hello');
    // 한가할 때 도착한 첫 청크는 곧바로 나간다 — 프레임 예약 없이.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe('hello');
    expect(scheduleAnimationFrame).not.toHaveBeenCalled();

    // 쓰는 중에 도착한 것은 큐에 모인다.
    runtime.write(' world');
    expect(writes).toHaveLength(1);

    // 완료 콜백이 배칭 창을 열고, 그 창에서 남은 것이 한 번에 나간다.
    triggerWriteCallback(0);
    const flushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    flushCallback?.(16);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.value).toBe(' world');
  });

  it('flushes queued output after the current write completes', () => {
    const { terminal, writes, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const scheduleAnimationFrame = vi.fn((_callback: (time: number) => void) => 1);
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame,
        cancelScheduledAnimationFrame: vi.fn(),
        openExternal: vi.fn()
      }
    });

    // 첫 청크는 프레임 없이 즉시 나간다.
    runtime.write('first');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe('first');

    runtime.write('second');
    runtime.write('third');
    expect(writes).toHaveLength(1);

    triggerWriteCallback(0);
    // 첫 쓰기가 프레임을 예약하지 않으므로, 배칭 창이 첫 번째 예약이다.
    const secondFlushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    secondFlushCallback?.(32);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.value).toBe('secondthird');
  });

  it('merges queued text chunks into a single write', () => {
    const { terminal, writes, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const scheduleAnimationFrame = vi.fn((_callback: (time: number) => void) => 1);
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame,
        cancelScheduledAnimationFrame: vi.fn(),
        openExternal: vi.fn()
      }
    });

    // 첫 청크는 즉시 나가고, 그 쓰기가 끝나기 전에 도착한 것들이 배칭 대상이다.
    runtime.write('a'.repeat(7_000));
    expect(writes).toHaveLength(1);

    runtime.write('b'.repeat(3_000));
    runtime.write('c'.repeat(2_000));

    triggerWriteCallback(0);
    const firstFlushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    firstFlushCallback?.(16);

    // 두 청크가 한 번의 write 로 합쳐져야 한다 — 부하가 있을 때의 배칭은 그대로다.
    expect(writes).toHaveLength(2);
    expect(typeof writes[1]?.value).toBe('string');
    expect((writes[1]?.value as string).length).toBe(5_000);
  });
  it('runs write-drain callbacks only after the queued output finishes flushing', () => {
    const { terminal, writes, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const scheduleAnimationFrame = vi.fn((_callback: (time: number) => void) => 1);
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame,
        cancelScheduledAnimationFrame: vi.fn(),
        openExternal: vi.fn()
      }
    });

    runtime.write('busy');
    const flushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    flushCallback?.(16);

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    runtime.scheduleAfterWriteDrain(firstCallback);
    runtime.scheduleAfterWriteDrain(secondCallback);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).not.toHaveBeenCalled();

    triggerWriteCallback(0);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });

  it('runs write-drain callbacks immediately when the queue is already idle', () => {
    const { terminal } = createFakeTerminal();
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });

    const callback = vi.fn();
    runtime.scheduleAfterWriteDrain(callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('preserves raw binary chunks for full-screen terminal applications', () => {
    const { terminal, writes, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const scheduleAnimationFrame = vi.fn((_callback: (time: number) => void) => 1);
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame,
        cancelScheduledAnimationFrame: vi.fn(),
        openExternal: vi.fn()
      }
    });

    // 첫 청크는 즉시, 쓰기 중에 온 것들은 합쳐져 나간다. 바이너리는 문자열로 뭉개지 않는다 —
    // 전체화면 앱(vim·htop)의 제어 시퀀스가 깨지면 화면이 망가진다.
    runtime.write(Uint8Array.from([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toEqual(
      Uint8Array.from([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]),
    );

    runtime.write(Uint8Array.from([0x1b, 0x5b, 0x48]));
    runtime.write(Uint8Array.from([0x1b, 0x5b, 0x4a]));
    triggerWriteCallback(0);

    const flushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    flushCallback?.(16);

    expect(writes).toHaveLength(2);
    expect(writes[1]?.value).toEqual(
      Uint8Array.from([0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x4a])
    );

    triggerWriteCallback(0);
  });

  it('captures session-share snapshots with the serialize addon', () => {
    const { terminal } = createFakeTerminal();
    const serializedSnapshot = '\u001b[?1049h\u001b[H\tfoo\r\n\t\tbar';
    const serializeAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      serialize: vi.fn(() => serializedSnapshot),
    };

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createSerializeAddon: (() => serializeAddon) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        openExternal: vi.fn()
      }
    });

    expect(runtime.captureSnapshot()).toBe(serializedSnapshot);
    expect(serializeAddon.serialize).toHaveBeenCalledWith({ scrollback: 0 });
  });

  it('cancels pending flushes when disposed', () => {
    const { terminal, triggerWriteCallback } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const cancelScheduledAnimationFrame = vi.fn();
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame: vi.fn(() => 42),
        cancelScheduledAnimationFrame,
        openExternal: vi.fn()
      }
    });

    // 첫 쓰기는 즉시 나가므로 취소할 프레임이 없다. 그 쓰기가 끝나며 배칭 창이 열린 뒤에야
    // 취소 대상이 생긴다 — dispose 가 그 창을 걷어내는지가 이 테스트의 계약이다.
    runtime.write('queued');
    runtime.write('while writing');
    triggerWriteCallback(0);
    runtime.dispose();

    expect(cancelScheduledAnimationFrame).toHaveBeenCalledWith(42);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  // URL 탐지와 버퍼 좌표 매핑은 @xterm/addon-web-links 의 몫이므로 여기서 재검증하지 않는다.
  // 우리 계약은 두 가지다 — 애드온을 실제로 로드하는가, 그리고 링크 활성화가 main 의 스킴
  // 검증을 거치는 openExternal 로 흘러가는가(애드온 기본 동작인 window.open 이 아니라).
  it('loads the web links addon and routes activation through openExternal', () => {
    const { terminal } = createFakeTerminal();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const webLinksAddon = { activate: vi.fn(), dispose: vi.fn() };
    const createWebLinksAddon = vi.fn((_handler: (event: MouseEvent, uri: string) => void) => webLinksAddon);

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        createWebLinksAddon: createWebLinksAddon as never,
        openExternal
      }
    });

    expect(terminal.loadAddon).toHaveBeenCalledWith(webLinksAddon);

    const activateLink = createWebLinksAddon.mock.calls[0]?.[0];
    expect(activateLink).toBeTypeOf('function');
    activateLink?.(new MouseEvent('click'), 'https://example.com/docs');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');

    runtime.dispose();
    expect(webLinksAddon.dispose).toHaveBeenCalledTimes(1);
  });

  it('attaches WebGL when enabled and disposes it when later disabled', async () => {
    const { terminal } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const contextLossDisposable = { dispose: vi.fn() };
    const webglAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => contextLossDisposable),
      clearTextureAtlas: vi.fn()
    };
    const loadWebglAddonModule = vi.fn().mockResolvedValue({
      WebglAddon: vi.fn(() => webglAddon)
    });

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule,
        openExternal: vi.fn()
      }
    });

    await runtime.setWebglEnabled(true);
    expect(loadWebglAddonModule).toHaveBeenCalledTimes(1);
    expect(terminal.loadAddon).toHaveBeenCalledWith(webglAddon);

    await runtime.setWebglEnabled(false);
    expect(contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back quietly when the WebGL addon import fails', async () => {
    const logger = { warn: vi.fn() };

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => createFakeTerminal().terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule: vi.fn().mockRejectedValue(new Error('missing module')),
        logger,
        openExternal: vi.fn()
      }
    });

    await expect(runtime.setWebglEnabled(true)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'WebGL renderer unavailable, falling back to the default terminal renderer.',
      expect.any(Error)
    );
  });

  it('falls back when the WebGL context is lost', async () => {
    const logger = { warn: vi.fn() };
    const { terminal } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const contextLossDisposable = { dispose: vi.fn() };
    let contextLossListener: () => void = () => undefined;
    const webglAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      clearTextureAtlas: vi.fn(),
      onContextLoss: vi.fn((listener: () => void) => {
        contextLossListener = listener;
        return contextLossDisposable;
      })
    };

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule: vi.fn().mockResolvedValue({
          WebglAddon: vi.fn(() => webglAddon)
        }),
        logger,
        openExternal: vi.fn()
      }
    });

    await runtime.setWebglEnabled(true);
    contextLossListener();

    expect(contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.dispose).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('WebGL renderer context lost, falling back to the default terminal renderer.');
  });

  it('refreshes the WebGL texture atlas when device pixel ratio changes', async () => {
    const { terminal } = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const contextLossDisposable = { dispose: vi.fn() };
    const webglAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      clearTextureAtlas: vi.fn(),
      onContextLoss: vi.fn(() => contextLossDisposable)
    };
    let devicePixelRatio = 1;

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule: vi.fn().mockResolvedValue({
          WebglAddon: vi.fn(() => webglAddon)
        }),
        readDevicePixelRatio: () => devicePixelRatio,
        openExternal: vi.fn()
      }
    });

    await runtime.setWebglEnabled(true);
    devicePixelRatio = 2;
    runtime.syncDisplayMetrics();

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  // 고정 격자(tmux pane)는 배율이 바뀌어도 컨테이너에 맞추지 않는다 — 격자는 tmux 가 정한다.
  it('initialSize 가 있으면 화면 배율이 바뀌어도 컨테이너에 fit 하지 않는다', async () => {
    const { terminal } = createFakeTerminal();
    const fitAddon = { fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() };
    const webglAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      clearTextureAtlas: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() }))
    };
    let devicePixelRatio = 1;

    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      initialSize: { cols: 100, rows: 50 },
      onData: vi.fn(),
      onBinary: vi.fn(),
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => fitAddon) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn()
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule: vi.fn().mockResolvedValue({
          WebglAddon: vi.fn(() => webglAddon)
        }),
        readDevicePixelRatio: () => devicePixelRatio,
        openExternal: vi.fn()
      }
    });

    await runtime.setWebglEnabled(true);
    devicePixelRatio = 2;
    runtime.syncDisplayMetrics();

    expect(webglAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });
});

describe('terminal-runtime 대량 출력', () => {
  function createRuntime(
    terminal: ReturnType<typeof createFakeTerminal>['terminal'],
    logger: Pick<Console, 'warn'> = { warn: vi.fn() },
    onWriteSettled?: () => void,
  ) {
    // 프레임은 직접 돌린다. 취소된 것은 돌리지 않는다(실제 requestAnimationFrame 과 같게).
    const frames = new Map<number, (time: number) => void>();
    let nextFrame = 0;
    const runtime = createTerminalRuntime({
      container: document.createElement('div'),
      appearance: createAppearance(),
      onData: vi.fn(),
      onBinary: vi.fn(),
      onWriteSettled,
      dependencies: {
        createTerminal: (() => terminal) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        createSearchAddon: (() => ({
          activate: vi.fn(),
          dispose: vi.fn(),
          findNext: vi.fn(() => true),
          findPrevious: vi.fn(() => true),
          clearDecorations: vi.fn(),
          clearActiveDecoration: vi.fn(),
        })) as never,
        createUnicode11Addon: (() => ({ activate: vi.fn(), dispose: vi.fn() })) as never,
        scheduleAnimationFrame: (callback: (time: number) => void) => {
          nextFrame += 1;
          frames.set(nextFrame, callback);
          return nextFrame;
        },
        cancelScheduledAnimationFrame: (handle: number) => {
          frames.delete(handle);
        },
        openExternal: vi.fn(),
        logger,
      },
    });
    return { runtime, frames };
  }

  /** xterm 처럼 쓰기를 하나씩 끝내고, 그사이 예약된 프레임도 돌린다. 쓰기도 프레임도 남지 않을 때까지. */
  function drain(
    writes: Array<{ callback?: () => void }>,
    frames: Map<number, (time: number) => void>,
    completedAlready = 0,
  ) {
    let completed = completedAlready;
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (completed < writes.length) {
        writes[completed]?.callback?.();
        completed += 1;
        continue;
      }
      const [handle] = frames.keys();
      if (handle === undefined) {
        return;
      }
      const frame = frames.get(handle);
      frames.delete(handle);
      frame?.(16);
    }
    throw new Error('출력이 끝나지 않았다');
  }

  // 쌓인 큐를 한 조각으로 합치면 대량 출력에서 그 조각이 수십 MB 가 되어 파싱하는 동안 렌더러가 통째로
  // 멈췄고(앱 전체가 18초), xterm 의 50MB 한도에 걸려 탭이 영영 멈췄다. 정해진 크기씩 나눠 넘긴다.
  it('쌓인 출력은 256KB 이하로 나눠 넘기고, 순서와 내용은 그대로다', () => {
    const fake = createFakeTerminal();
    const { runtime, frames } = createRuntime(fake.terminal);
    // 코어는 출력을 4KB 씩 보낸다. 첫 쓰기가 끝나기 전에 800KB 가 쌓인다.
    const chunks = Array.from({ length: 200 }, (_, index) =>
      String.fromCharCode(65 + (index % 26)).repeat(4096),
    );

    runtime.write('first');
    for (const chunk of chunks) {
      runtime.write(chunk);
    }
    drain(fake.writes, frames);

    const values = fake.writes.map((write) => write.value as string);
    expect(values.length).toBeGreaterThan(4);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(256 * 1024);
    }
    expect(values.join('')).toBe(`first${chunks.join('')}`);
  });

  // 큐에서 꺼낼 때 Array.shift 를 쓰면 청크가 수만 개 쌓였을 때 매번 나머지를 다 옮겨, 그리는 시간의 대부분이
  // 꺼내는 데 들었다. 머리 자리만 옮기고 앞부분을 가끔 잘라 내는데, 그 잘라 내기를 거쳐도 순서는 그대로여야 한다.
  it('청크가 수천 개 쌓여도 순서와 내용을 지키며 모두 넘긴다', () => {
    const fake = createFakeTerminal();
    const { runtime, frames } = createRuntime(fake.terminal);
    const chunks = Array.from({ length: 5_000 }, (_, index) => `${index}`.padStart(100, '.'));

    runtime.write('first');
    for (const chunk of chunks) {
      runtime.write(chunk);
    }
    drain(fake.writes, frames);

    expect(fake.writes.map((write) => write.value).join('')).toBe(`first${chunks.join('')}`);
  });

  // xterm 은 밀린 양이 한도를 넘으면 쓰기를 예외로 거부한다. 우리는 다음 쓰기를 xterm 의 완료 콜백 안에서
  // 부르므로, 예외가 그대로 올라가면 xterm 의 처리 루프가 다음 처리를 예약하지 못해 탭이 다시는 그리지
  // 않았다(실측).
  it('xterm 이 쓰기를 거부해도 예외를 xterm 으로 올리지 않고, 다음 프레임에 그 출력을 다시 넘긴다', () => {
    const fake = createFakeTerminal();
    const logger = { warn: vi.fn() };
    let calls = 0;
    fake.terminal.write = vi.fn((value: string | Uint8Array, callback?: () => void) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('write data discarded, use flow control to avoid losing data');
      }
      fake.writes.push({ value, callback });
    });
    const { runtime, frames } = createRuntime(fake.terminal, logger);
    const backlog = 'x'.repeat(100 * 1024);

    runtime.write('first');
    runtime.write(backlog);
    // 쌓인 양이 64KB 를 넘으므로 첫 쓰기의 완료 콜백이 곧바로 이어 쓰고, 거기서 거부당한다.
    expect(() => fake.writes[0]?.callback?.()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    drain(fake.writes, frames, 1);
    expect(fake.writes.map((write) => write.value).join('')).toBe(`first${backlog}`);
  });

  // 출력 흐름 제어는 "받은 양 − 아직 처리 안 된 양" 을 처리한 양으로 알린다. 처리 안 된 양은 큐와 xterm 이
  // 쓰는 중인 묶음의 합이고, xterm 이 묶음을 끝낼 때마다 다시 잰다.
  it('아직 처리 안 된 출력의 크기를 알려 주고, xterm 이 묶음을 끝낼 때마다 알린다', () => {
    const fake = createFakeTerminal();
    const settled = vi.fn();
    const { runtime, frames } = createRuntime(fake.terminal, undefined, settled);

    runtime.write('a'.repeat(1000));
    expect(runtime.pendingOutputSize()).toBe(1000);
    runtime.write('b'.repeat(500));
    expect(runtime.pendingOutputSize()).toBe(1500);

    fake.writes[0]?.callback?.();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(runtime.pendingOutputSize()).toBe(500);

    drain(fake.writes, frames, 1);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(runtime.pendingOutputSize()).toBe(0);
  });

  // 알림은 xterm 의 완료 콜백 안에서 불린다. 던진 예외가 xterm 으로 올라가면 그 탭은 다시 그리지 않는다.
  it('쓰기 끝남 알림이 던져도 xterm 으로 올리지 않고 나머지 출력을 계속 넘긴다', () => {
    const fake = createFakeTerminal();
    const logger = { warn: vi.fn() };
    const settled = vi.fn(() => {
      throw new Error('boom');
    });
    const { runtime, frames } = createRuntime(fake.terminal, logger, settled);
    const backlog = 'x'.repeat(100 * 1024);

    runtime.write('first');
    runtime.write(backlog);
    expect(() => fake.writes[0]?.callback?.()).not.toThrow();

    drain(fake.writes, frames, 1);
    expect(fake.writes.map((write) => write.value).join('')).toBe(`first${backlog}`);
    expect(logger.warn).toHaveBeenCalled();
  });
});
