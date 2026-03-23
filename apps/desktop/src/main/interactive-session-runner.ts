import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

export interface InteractiveSessionExitEvent {
  exitCode: number | null;
  signal?: number | NodeJS.Signals | null;
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
type SpawnProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide?: boolean;
};
type SpawnProcessFactory = (
  command: string,
  args: string[],
  options: SpawnProcessOptions
) => ChildProcessWithoutNullStreams;

interface DefaultInteractiveSessionRunnerOptions {
  platform?: NodeJS.Platform;
  createNodePtyRunner?: (config: InteractiveSessionLaunchConfig) => InteractiveSessionRunner;
  createSpawnRunner?: (config: InteractiveSessionLaunchConfig) => InteractiveSessionRunner;
}

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

function mergeOutputChunk(chunk: string | Buffer): Uint8Array {
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

function createErrorEmitter() {
  const errorListeners = new Set<(error: Error) => void>();

  return {
    add(listener: (error: Error) => void) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    emit(error: unknown, fallbackMessage: string) {
      const resolvedError = toError(error, fallbackMessage);
      for (const listener of errorListeners) {
        listener(resolvedError);
      }
    }
  };
}

export function wrapNodePtyProcess(ptyProcess: NodePtyLike): InteractiveSessionRunner {
  const errorEmitter = createErrorEmitter();

  const safelyRun = (operation: () => void, fallbackMessage: string) => {
    try {
      operation();
    } catch (error) {
      errorEmitter.emit(error, fallbackMessage);
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
      return errorEmitter.add(listener);
    }
  };
}

export function wrapChildProcessInteractiveSession(process: ChildProcessWithoutNullStreams): InteractiveSessionRunner {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const exitListeners = new Set<(event: InteractiveSessionExitEvent) => void>();
  const errorEmitter = createErrorEmitter();

  const emitData = (chunk: string | Buffer) => {
    const payload = mergeOutputChunk(chunk);
    for (const listener of dataListeners) {
      listener(payload);
    }
  };

  process.stdout.on('data', (chunk: string | Buffer) => {
    emitData(chunk);
  });

  process.stderr.on('data', (chunk: string | Buffer) => {
    emitData(chunk);
  });

  process.stdout.on('error', (error) => {
    errorEmitter.emit(error, 'AWS 세션 stdout을 읽는 중 오류가 발생했습니다.');
  });

  process.stderr.on('error', (error) => {
    errorEmitter.emit(error, 'AWS 세션 stderr를 읽는 중 오류가 발생했습니다.');
  });

  process.stdin.on('error', (error) => {
    errorEmitter.emit(error, 'AWS 세션 stdin에 입력을 전달하지 못했습니다.');
  });

  process.on('error', (error) => {
    errorEmitter.emit(error, 'AWS 세션 프로세스를 시작하지 못했습니다.');
  });

  process.on('exit', (exitCode, signal) => {
    for (const listener of exitListeners) {
      listener({ exitCode, signal });
    }
  });

  const safelyRun = (operation: () => void, fallbackMessage: string) => {
    try {
      operation();
    } catch (error) {
      errorEmitter.emit(error, fallbackMessage);
    }
  };

  return {
    write(data) {
      safelyRun(() => {
        process.stdin.write(data);
      }, 'AWS 세션에 입력을 전달하지 못했습니다.');
    },
    writeBinary(data) {
      safelyRun(() => {
        process.stdin.write(Buffer.from(data));
      }, 'AWS 세션에 바이너리 입력을 전달하지 못했습니다.');
    },
    resize() {},
    kill() {
      safelyRun(() => {
        process.kill();
      }, 'AWS 세션 프로세스를 종료하지 못했습니다.');
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
      return errorEmitter.add(listener);
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

export function createSpawnInteractiveSessionRunner(
  config: InteractiveSessionLaunchConfig,
  spawnProcess: SpawnProcessFactory = spawn
): InteractiveSessionRunner {
  const childProcess = spawnProcess(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  return wrapChildProcessInteractiveSession(childProcess);
}

export function createDefaultInteractiveSessionRunner(
  config: InteractiveSessionLaunchConfig,
  options: DefaultInteractiveSessionRunnerOptions = {}
): InteractiveSessionRunner {
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    return (options.createNodePtyRunner ?? createNodePtyInteractiveSessionRunner)(config);
  }

  return (options.createSpawnRunner ?? createSpawnInteractiveSessionRunner)(config);
}
