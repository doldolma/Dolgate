import { describe, expect, it, vi } from 'vitest';
import type { IDisposable } from '@xterm/xterm';
import { createTerminalRuntime, type TerminalRuntimeAppearance } from './terminal-runtime';

function createAppearance(): TerminalRuntimeAppearance {
  return {
    theme: {
      background: '#0b1020',
      foreground: '#f5f7fb'
    },
    fontFamily: 'JetBrains Mono',
    fontSize: 14
  };
}

function createFakeTerminal() {
  const dataListeners: Array<(value: string) => void> = [];
  const binaryListeners: Array<(value: string) => void> = [];

  return {
    options: {},
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
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
}

describe('terminal-runtime', () => {
  it('creates the terminal, opens it, and fits immediately', () => {
    const container = document.createElement('div');
    const terminal = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
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
        createFitAddon: createFitAddon as never
      }
    });

    expect(createTerminal).toHaveBeenCalledWith({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono',
      fontSize: 14,
      theme: {
        background: '#0b1020',
        foreground: '#f5f7fb'
      }
    });
    expect(terminal.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(terminal.open).toHaveBeenCalledWith(container);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it('attaches WebGL when enabled and disposes it when later disabled', async () => {
    const terminal = createFakeTerminal();
    const fitAddon = {
      fit: vi.fn(),
      activate: vi.fn(),
      dispose: vi.fn()
    };
    const contextLossDisposable = { dispose: vi.fn() };
    const webglAddon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: vi.fn(() => contextLossDisposable)
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
        loadWebglAddonModule
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
        createTerminal: (() => createFakeTerminal()) as never,
        createFitAddon: (() => ({ fit: vi.fn(), activate: vi.fn(), dispose: vi.fn() })) as never,
        loadWebglAddonModule: vi.fn().mockRejectedValue(new Error('missing module')),
        logger
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
    const terminal = createFakeTerminal();
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
        loadWebglAddonModule: vi.fn().mockResolvedValue({
          WebglAddon: vi.fn(() => webglAddon)
        }),
        logger
      }
    });

    await runtime.setWebglEnabled(true);
    contextLossListener();

    expect(contextLossDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(webglAddon.dispose).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('WebGL renderer context lost, falling back to the default terminal renderer.');
  });
});
