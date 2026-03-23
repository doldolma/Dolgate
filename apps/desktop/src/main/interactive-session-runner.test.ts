import { describe, expect, it } from 'vitest';
import { createInMemoryInteractiveSessionRunner, wrapNodePtyProcess } from './interactive-session-runner';

class FakePty {
  readonly writes: Array<string | Buffer> = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  readonly onData = (listener: (chunk: string) => void) => {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      }
    };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
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

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
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
    const exitEvents: Array<{ exitCode: number; signal?: number }> = [];

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
    const exitEvents: Array<{ exitCode: number; signal?: number }> = [];

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
