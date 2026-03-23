import { describe, expect, it, vi } from 'vitest';
import type { IDisposable, ILinkProvider } from '@xterm/xterm';
import { createTerminalRuntime, type TerminalRuntimeAppearance } from './terminal-runtime';

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
  const writes: Array<{ value: string; callback?: () => void }> = [];
  let registeredLinkProvider: ILinkProvider | null = null;

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
    registerLinkProvider: vi.fn((provider: ILinkProvider) => {
      registeredLinkProvider = provider;
      return {
        dispose: vi.fn()
      } satisfies IDisposable;
    }),
    open: vi.fn(),
    dispose: vi.fn(),
    refresh: vi.fn(),
    focus: vi.fn(),
    write: vi.fn((value: string, callback?: () => void) => {
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
    getRegisteredLinkProvider: () => registeredLinkProvider,
    triggerWriteCallback(index = writes.length - 1) {
      writes[index]?.callback?.();
    }
  };
}

describe('terminal-runtime', () => {
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
      macOptionIsMeta: false
    });
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(1, fitAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(2, searchAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(3, unicode11Addon);
    expect(terminal.unicode.activeVersion).toBe('11');
    expect(terminal.open).toHaveBeenCalledWith(container);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('batches output chunks until the next animation frame flush', () => {
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
    runtime.write(' world');
    expect(writes).toHaveLength(0);

    const flushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    flushCallback?.(16);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe('hello world');

    triggerWriteCallback(0);
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

    runtime.write('first');
    const firstFlushCallback = scheduleAnimationFrame.mock.calls[0]?.[0] as ((time: number) => void) | undefined;
    firstFlushCallback?.(16);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.value).toBe('first');

    runtime.write('second');
    runtime.write('third');
    expect(writes).toHaveLength(1);

    triggerWriteCallback(0);
    const secondFlushCallback = scheduleAnimationFrame.mock.calls[1]?.[0] as ((time: number) => void) | undefined;
    secondFlushCallback?.(32);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.value).toBe('secondthird');
  });

  it('cancels pending flushes when disposed', () => {
    const { terminal } = createFakeTerminal();
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

    runtime.write('queued');
    runtime.dispose();

    expect(cancelScheduledAnimationFrame).toHaveBeenCalledWith(42);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('registers clickable links that open externally', () => {
    const { terminal, getRegisteredLinkProvider } = createFakeTerminal('visit https://example.com/docs now');
    const openExternal = vi.fn().mockResolvedValue(undefined);

    createTerminalRuntime({
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
        openExternal
      }
    });

    const provider = getRegisteredLinkProvider();
    expect(provider).not.toBeNull();

    const callback = vi.fn();
    provider?.provideLinks(1, callback);
    const links = callback.mock.calls[0]?.[0];
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe('https://example.com/docs');
    links[0]?.activate(new MouseEvent('click'), links[0].text);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
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
});
