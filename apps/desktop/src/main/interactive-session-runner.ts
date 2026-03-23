import { createRequire } from 'node:module';

export interface InteractiveSessionExitEvent {
  exitCode: number;
  signal?: number;
}

export interface InteractiveSessionLaunchConfig {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  name?: string;
}

export interface InteractiveSessionRunner {
  write(data: string): void;
  writeBinary(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onExit(listener: (event: InteractiveSessionExitEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

type NodePtyLike = Pick<import('node-pty').IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;
type NodePtyModule = typeof import('node-pty');

const require = createRequire(import.meta.url);
let cachedNodePtyModule: NodePtyModule | null = null;

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function encodePtyOutput(chunk: string): Uint8Array {
  return new Uint8Array(Buffer.from(chunk, 'utf8'));
}

function decodeBinaryInput(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString('latin1');
}

function toUint8Array(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, 'utf8')) : new Uint8Array(chunk);
}

function loadNodePty(): NodePtyModule {
  if (cachedNodePtyModule) {
    return cachedNodePtyModule;
  }

  try {
    cachedNodePtyModule = require('node-pty') as NodePtyModule;
    return cachedNodePtyModule;
  } catch (error) {
    throw toError(
      error,
      'node-pty 로딩에 실패했습니다. Windows AWS SSM 세션에는 네이티브 PTY 모듈이 필요합니다.'
    );
  }
}

export function wrapNodePtyProcess(ptyProcess: NodePtyLike): InteractiveSessionRunner {
  const errorListeners = new Set<(error: Error) => void>();

  const emitError = (error: unknown, fallbackMessage: string) => {
    const resolvedError = toError(error, fallbackMessage);
    for (const listener of errorListeners) {
      listener(resolvedError);
    }
  };

  const safelyRun = (operation: () => void, fallbackMessage: string) => {
    try {
      operation();
    } catch (error) {
      emitError(error, fallbackMessage);
    }
  };

  return {
    write(data) {
      safelyRun(() => {
        ptyProcess.write(data);
      }, 'PTY에 입력을 전달하지 못했습니다.');
    },
    writeBinary(data) {
      safelyRun(() => {
        ptyProcess.write(decodeBinaryInput(data));
      }, 'PTY에 바이너리 입력을 전달하지 못했습니다.');
    },
    resize(cols, rows) {
      safelyRun(() => {
        ptyProcess.resize(cols, rows);
      }, 'PTY 크기를 조정하지 못했습니다.');
    },
    kill() {
      safelyRun(() => {
        ptyProcess.kill();
      }, 'PTY 세션을 종료하지 못했습니다.');
    },
    onData(listener) {
      const disposable = ptyProcess.onData((chunk) => {
        listener(encodePtyOutput(chunk));
      });
      return () => {
        disposable.dispose();
      };
    },
    onExit(listener) {
      const disposable = ptyProcess.onExit((event) => {
        listener({
          exitCode: event.exitCode,
          signal: event.signal
        });
      });
      return () => {
        disposable.dispose();
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    }
  };
}

export function createInMemoryInteractiveSessionRunner(initialOutput?: string | Uint8Array): InteractiveSessionRunner {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const exitListeners = new Set<(event: InteractiveSessionExitEvent) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let closed = false;

  if (initialOutput) {
    queueMicrotask(() => {
      const chunk = toUint8Array(initialOutput);
      for (const listener of dataListeners) {
        listener(chunk);
      }
    });
  }

  return {
    write() {},
    writeBinary() {},
    resize() {},
    kill() {
      if (closed) {
        return;
      }
      closed = true;
      for (const listener of exitListeners) {
        listener({ exitCode: 0 });
      }
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    }
  };
}

export function createNodePtyInteractiveSessionRunner(config: InteractiveSessionLaunchConfig): InteractiveSessionRunner {
  const nodePty = loadNodePty();
  const ptyProcess = nodePty.spawn(config.command, config.args, {
    name: config.name ?? 'xterm-256color',
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: config.env,
    useConpty: process.platform === 'win32' ? true : undefined
  });

  return wrapNodePtyProcess(ptyProcess);
}
