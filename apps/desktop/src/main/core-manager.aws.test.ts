import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreEvent } from '@shared';
import { ipcChannels } from '../common/ipc-channels';
import type { InteractiveSessionLaunchConfig, InteractiveSessionRunner } from './interactive-session-runner';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/dolssh',
    isPackaged: false
  },
  BrowserWindow: class {}
}));

vi.mock('./aws-service', () => ({
  resolveAwsExecutable: vi.fn(async () => '/usr/bin/aws'),
  buildAwsCommandEnv: vi.fn(async () => ({
    PATH: '/usr/bin'
  }))
}));

import { CoreManager } from './core-manager';

interface ActivityLogEntry {
  level: 'info' | 'warn' | 'error';
  category: 'session' | 'audit';
  message: string;
  metadata?: Record<string, unknown> | null;
}

class FakeInteractiveSessionRunner implements InteractiveSessionRunner {
  readonly writes: string[] = [];
  readonly binaryWrites: Uint8Array[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  writeBinary(data: Uint8Array): void {
    this.binaryWrites.push(new Uint8Array(data));
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emitData(chunk: string | Uint8Array): void {
    const payload = typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, 'utf8')) : new Uint8Array(chunk);
    for (const listener of this.dataListeners) {
      listener(payload);
    }
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) {
      listener(new Error(message));
    }
  }
}

function createFakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    window: {
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        })
      }
    }
  };
}

describe('CoreManager AWS SSM sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes text input, binary input, resize, and output through the interactive runner', async () => {
    const logs: ActivityLogEntry[] = [];
    const events: CoreEvent<Record<string, unknown>>[] = [];
    const runner = new FakeInteractiveSessionRunner();
    let launchConfig: InteractiveSessionLaunchConfig | null = null;
    const manager = new CoreManager(
      (entry) => {
        logs.push(entry);
      },
      (config) => {
        launchConfig = config;
        return runner;
      }
    );
    const fakeWindow = createFakeWindow();
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const { sessionId } = await manager.connectAwsSession({
      profileName: 'default',
      region: 'ap-northeast-2',
      instanceId: 'i-1234567890',
      title: 'AWS Host',
      hostId: 'host-1'
    });

    expect(launchConfig).toMatchObject({
      command: '/usr/bin/aws',
      args: ['ssm', 'start-session', '--target', 'i-1234567890', '--profile', 'default', '--region', 'ap-northeast-2'],
      cols: 120,
      rows: 32,
      name: 'xterm-256color'
    });
    expect(events.at(0)?.type).toBe('connected');

    manager.write(sessionId, 'ls -al\r');
    manager.writeBinary(sessionId, new Uint8Array([0x1b, 0x5b, 0x41]));
    manager.resize(sessionId, 180, 48);
    runner.emitData('hello\r\n');

    expect(runner.writes).toEqual(['ls -al\r']);
    expect(runner.binaryWrites).toEqual([new Uint8Array([0x1b, 0x5b, 0x41])]);
    expect(runner.resizes).toEqual([{ cols: 180, rows: 48 }]);

    const dataEvent = fakeWindow.sent.find((entry) => entry.channel === ipcChannels.ssh.data);
    expect(dataEvent).toBeTruthy();
    expect(Buffer.from((dataEvent?.payload as { chunk: Uint8Array }).chunk).toString('utf8')).toBe('hello\r\n');
    expect(logs.some((entry) => entry.message === 'AWS SSM 세션이 연결되었습니다.')).toBe(true);
  });

  it('emits error and closed events on abnormal exit and cleans up after disconnect', async () => {
    const events: CoreEvent<Record<string, unknown>>[] = [];
    const runner = new FakeInteractiveSessionRunner();
    const manager = new CoreManager(undefined, () => runner);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    const { sessionId } = await manager.connectAwsSession({
      profileName: 'default',
      region: 'us-east-1',
      instanceId: 'i-abcd',
      title: 'Broken Host',
      hostId: 'host-2'
    });

    runner.emitData('session-manager-plugin failed');
    runner.emitExit({ exitCode: 1 });

    expect(events.some((event) => event.type === 'error' && event.sessionId === sessionId)).toBe(true);
    expect(events.some((event) => event.type === 'closed' && event.sessionId === sessionId)).toBe(true);
    expect(manager.listTabs()).toEqual([]);

    const disconnectRunner = new FakeInteractiveSessionRunner();
    const disconnectManager = new CoreManager(undefined, () => disconnectRunner);
    const disconnectEvents: CoreEvent<Record<string, unknown>>[] = [];
    disconnectManager.setTerminalEventHandler((event) => {
      disconnectEvents.push(event);
    });

    const connection = await disconnectManager.connectAwsSession({
      profileName: 'default',
      region: 'us-west-2',
      instanceId: 'i-disconnect',
      title: 'Disconnect Host',
      hostId: 'host-3'
    });

    disconnectManager.disconnect(connection.sessionId);
    expect(disconnectRunner.killCount).toBe(1);

    disconnectRunner.emitExit({ exitCode: 0 });
    const closedEvent = disconnectEvents.find((event) => event.type === 'closed' && event.sessionId === connection.sessionId);
    expect(closedEvent?.payload).toMatchObject({
      message: 'client requested disconnect'
    });
    expect(disconnectManager.listTabs()).toEqual([]);
  });
});
