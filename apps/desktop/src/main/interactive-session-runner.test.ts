import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultInteractiveSessionRunner,
  createInMemoryInteractiveSessionRunner,
  createSpawnInteractiveSessionRunner,
  type InteractiveSessionExitEvent,
  wrapNodePtyProcess
} from './interactive-session-runner';

interface FakePtyExitEvent {
  exitCode: number;
  signal?: number;
}

class FakePty {
  readonly writes: Array<string | Buffer> = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(event: FakePtyExitEvent) => void>();

  readonly onData = (listener: (chunk: string) => void) => {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      }
    };
  };

  readonly onExit = (listener: (event: FakePtyExitEvent) => void) => {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      }
    };
  };

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  emitExit(event: FakePtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Buffer[] = [];
  killCount = 0;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.writes.push(Buffer.from(chunk));
    });
  }

  kill(): boolean {
    this.killCount += 1;
    return true;
  }

  emitExit(event: InteractiveSessionExitEvent): void {
    this.emit('exit', event.exitCode, event.signal ?? null);
  }
}

describe('wrapNodePtyProcess', () => {
  it('maps binary input to a latin1 string before writing to the PTY', () => {
    const pty = new FakePty();
    const runner = wrapNodePtyProcess(pty);
    const input = new Uint8Array([0xff, 0x00, 0x41, 0x1b]);

    runner.writeBinary(input);

    expect(pty.writes).toHaveLength(1);
    expect(pty.writes[0]).toBe(Buffer.from(input).toString('latin1'));
  });

  it('encodes PTY output as UTF-8 bytes and forwards exit events', () => {
    const pty = new FakePty();
    const runner = wrapNodePtyProcess(pty);
    const receivedChunks: Uint8Array[] = [];
    const exitEvents: InteractiveSessionExitEvent[] = [];

    runner.onData((chunk) => {
      receivedChunks.push(chunk);
    });
    runner.onExit((event) => {
      exitEvents.push(event);
    });

    pty.emitData('안녕\r\n');
    pty.emitExit({ exitCode: 7, signal: 9 });

    expect(receivedChunks).toHaveLength(1);
    expect(Buffer.from(receivedChunks[0] ?? new Uint8Array()).toString('utf8')).toBe('안녕\r\n');
    expect(exitEvents).toEqual([{ exitCode: 7, signal: 9 }]);
  });
});

describe('createInMemoryInteractiveSessionRunner', () => {
  it('replays initial output and emits a clean exit when killed', async () => {
    const runner = createInMemoryInteractiveSessionRunner('ready\r\n');
    const receivedChunks: Uint8Array[] = [];
    const exitEvents: InteractiveSessionExitEvent[] = [];

    runner.onData((chunk) => {
      receivedChunks.push(chunk);
    });
    runner.onExit((event) => {
      exitEvents.push(event);
    });

    await Promise.resolve();
    runner.kill();

    expect(Buffer.from(receivedChunks[0] ?? new Uint8Array()).toString('utf8')).toBe('ready\r\n');
    expect(exitEvents).toEqual([{ exitCode: 0 }]);
  });
});

describe('createSpawnInteractiveSessionRunner', () => {
  it('routes stdin/stdout/stderr through a child process and keeps resize as a no-op', () => {
    const childProcess = new FakeChildProcess();
    const runner = createSpawnInteractiveSessionRunner(
      {
        command: '/usr/bin/aws',
        args: ['ssm', 'start-session'],
        cols: 120,
        rows: 32
      },
      vi.fn(() => childProcess as never)
    );
    const receivedChunks: Uint8Array[] = [];
    const exitEvents: InteractiveSessionExitEvent[] = [];

    runner.onData((chunk) => {
      receivedChunks.push(chunk);
    });
    runner.onExit((event) => {
      exitEvents.push(event);
    });

    runner.write('pwd\r');
    runner.writeBinary(new Uint8Array([0x1b, 0x5b, 0x41]));
    runner.resize(180, 48);
    childProcess.stdout.write('stdout\r\n');
    childProcess.stderr.write('stderr\r\n');
    childProcess.emitExit({ exitCode: 3, signal: 'SIGTERM' });
    runner.kill();

    expect(childProcess.writes.map((chunk) => chunk.toString('latin1'))).toEqual(['pwd\r', '\u001b[A']);
    expect(receivedChunks).toHaveLength(2);
    expect(Buffer.from(receivedChunks[0] ?? new Uint8Array()).toString('utf8')).toBe('stdout\r\n');
    expect(Buffer.from(receivedChunks[1] ?? new Uint8Array()).toString('utf8')).toBe('stderr\r\n');
    expect(exitEvents).toEqual([{ exitCode: 3, signal: 'SIGTERM' }]);
    expect(childProcess.killCount).toBe(1);
  });
});

describe('createDefaultInteractiveSessionRunner', () => {
  it('uses node-pty only on Windows and spawn-based sessions elsewhere', () => {
    const config = {
      command: 'aws',
      args: ['ssm', 'start-session'],
      cols: 120,
      rows: 32
    };
    const windowsRunner = createInMemoryInteractiveSessionRunner();
    const unixRunner = createInMemoryInteractiveSessionRunner();
    const createNodePtyRunner = vi.fn(() => windowsRunner);
    const createSpawnRunner = vi.fn(() => unixRunner);

    const selectedWindowsRunner = createDefaultInteractiveSessionRunner(config, {
      platform: 'win32',
      createNodePtyRunner,
      createSpawnRunner
    });
    const selectedUnixRunner = createDefaultInteractiveSessionRunner(config, {
      platform: 'darwin',
      createNodePtyRunner,
      createSpawnRunner
    });

    expect(selectedWindowsRunner).toBe(windowsRunner);
    expect(selectedUnixRunner).toBe(unixRunner);
    expect(createNodePtyRunner).toHaveBeenCalledTimes(1);
    expect(createSpawnRunner).toHaveBeenCalledTimes(1);
  });
});
