import { DeviceEventEmitter, NativeModules } from 'react-native';

import { resetEngine, resetGoEngineEvents } from '../src/engine';
import {
  buildEngineTailnetConfigs,
  buildTailnetRuntimeScope,
  closeSyncedTailnets,
  configureSyncedTailnets,
  forgetSyncedTailnets,
  resolveSyncedTailnetRoute,
  resetSyncedTailnetRuntimeForTests,
  startSyncedTailnet,
} from '../src/lib/tailnet-runtime';

const native = NativeModules.GoSshEngineModule as Record<string, jest.Mock>;

describe('synced Tailnet runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGoEngineEvents();
    resetEngine();
    resetSyncedTailnetRuntimeForTests();
    native.configureTailnets.mockResolvedValue(undefined);
    native.startTailnet.mockResolvedValue(undefined);
    native.cancelTailnet.mockResolvedValue(undefined);
    native.forgetTailnet.mockResolvedValue(undefined);
    native.closeTailnets.mockResolvedValue(undefined);
  });

  it('forgets each account Tailnet exactly once only when explicitly requested', async () => {
    await configureSyncedTailnets({
      serverUrl: 'https://sync.example.com',
      userId: 'user-1',
      tailnets: [],
    });
    await forgetSyncedTailnets([
      { id: 'corp', label: 'Corp', createdAt: '', updatedAt: '' },
      { id: 'corp', label: 'Duplicate', createdAt: '', updatedAt: '' },
      { id: 'personal', label: 'Personal', createdAt: '', updatedAt: '' },
    ]);

    expect(native.forgetTailnet).toHaveBeenCalledTimes(2);
    expect(native.forgetTailnet).toHaveBeenCalledWith('corp');
    expect(native.forgetTailnet).toHaveBeenCalledWith('personal');
  });

  it('normalizes the account scope and runtime configuration', () => {
    expect(
      buildTailnetRuntimeScope(' https://sync.example.com/ ', ' user-1 '),
    ).toBe('https://sync.example.com\nuser-1');
    expect(
      buildEngineTailnetConfigs([
        {
          id: 'corp',
          label: 'Corp',
          controlUrl: ' https://control.example.com ',
          authKey: ' tskey-secret ',
          ephemeral: true,
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ]),
    ).toEqual([
      {
        id: 'corp',
        controlUrl: 'https://control.example.com',
        authKey: 'tskey-secret',
        ephemeral: false,
      },
    ]);
  });

  it('resolves direct, configured, and missing host routes without fallback', () => {
    const tailnets = [
      {
        id: 'corp',
        label: 'Corp',
        tailnetName: ' example.com ',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
    ];

    expect(resolveSyncedTailnetRoute({}, tailnets)).toEqual({
      kind: 'direct',
    });
    expect(
      resolveSyncedTailnetRoute({ tailnetId: ' corp ' }, tailnets),
    ).toEqual({
      kind: 'tailnet',
      tailnetId: 'corp',
      tailnetName: 'example.com',
      configSignature: expect.any(String),
    });
    expect(
      resolveSyncedTailnetRoute({ tailnetId: 'deleted' }, tailnets),
    ).toEqual({ kind: 'missing', tailnetId: 'deleted' });
  });

  it('serializes account changes and lets a later close supersede queued configuration', async () => {
    let finishFirst: (() => void) | undefined;
    native.configureTailnets.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        }),
    );

    const first = configureSyncedTailnets({
      serverUrl: 'https://one.example.com',
      userId: 'user-1',
      tailnets: [],
    });
    for (let attempt = 0; attempt < 5 && !finishFirst; attempt += 1) {
      await Promise.resolve();
    }
    expect(native.configureTailnets).toHaveBeenCalledTimes(1);
    const staleSecond = configureSyncedTailnets({
      serverUrl: 'https://two.example.com',
      userId: 'user-2',
      tailnets: [],
    });
    const close = closeSyncedTailnets();

    finishFirst?.();
    await Promise.all([first, staleSecond, close]);

    expect(native.configureTailnets).toHaveBeenCalledTimes(1);
    expect(native.closeTailnets).toHaveBeenCalledTimes(1);
  });

  it('routes request progress while preparing one synced Tailnet', async () => {
    await configureSyncedTailnets({
      serverUrl: 'https://sync.example.com',
      userId: 'user-1',
      tailnets: [
        {
          id: 'corp',
          label: 'Corp',
          authKey: 'tskey-secret',
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
    const onStatus = jest.fn();
    native.startTailnet.mockImplementationOnce(async requestId => {
      DeviceEventEmitter.emit('GoSshEngine:tailnet', {
        eventJson: JSON.stringify({
          type: 'tailnetStatus',
          requestId,
          payload: {
            id: 'corp',
            state: 'needsAuth',
            authUrl: 'https://login.tailscale.com/a/test',
          },
        }),
      });
    });

    const status = await startSyncedTailnet({
      requestId: 'connect-1',
      tailnetId: 'corp',
      tailnets: [
        {
          id: 'corp',
          label: 'Corp',
          authKey: 'tskey-secret',
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      timeoutMs: 12_000,
      onStatus,
    });

    expect(native.startTailnet).toHaveBeenCalledWith(
      'connect-1',
      JSON.stringify({
        config: {
          id: 'corp',
          authKey: 'tskey-secret',
          ephemeral: false,
        },
        timeoutMs: 12_000,
      }),
    );
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'corp', state: 'needsAuth' }),
    );
    expect(status?.authUrl).toBe('https://login.tailscale.com/a/test');
  });

  it('cancels active starts before closing the account-scoped runtime', async () => {
    let finishStart: (() => void) | undefined;
    native.startTailnet.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishStart = resolve;
        }),
    );
    native.cancelTailnet.mockImplementationOnce(async () => {
      finishStart?.();
    });

    const start = startSyncedTailnet({
      requestId: 'connect-pending',
      tailnetId: 'corp',
      tailnets: [
        {
          id: 'corp',
          label: 'Corp',
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
    await Promise.resolve();

    await closeSyncedTailnets();
    await start;

    expect(native.cancelTailnet).toHaveBeenCalledWith(
      'connect-pending',
      'corp',
    );
    expect(native.cancelTailnet.mock.invocationCallOrder[0]).toBeLessThan(
      native.closeTailnets.mock.invocationCallOrder[0],
    );
  });

  it('cancels an active start before applying a changed Tailnet generation', async () => {
    const initial = {
      id: 'corp',
      label: 'Corp',
      authKey: 'old-key',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    };
    await configureSyncedTailnets({
      serverUrl: 'https://sync.example.com',
      userId: 'user-1',
      tailnets: [initial],
    });

    let finishStart: (() => void) | undefined;
    native.startTailnet.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishStart = resolve;
        }),
    );
    native.cancelTailnet.mockImplementationOnce(async () => finishStart?.());
    const start = startSyncedTailnet({
      requestId: 'connect-changing',
      tailnetId: 'corp',
      tailnets: [initial],
    });
    await Promise.resolve();

    await configureSyncedTailnets({
      serverUrl: 'https://sync.example.com',
      userId: 'user-1',
      tailnets: [{ ...initial, authKey: 'new-key' }],
    });
    await start;

    expect(native.cancelTailnet).toHaveBeenCalledWith(
      'connect-changing',
      'corp',
    );
    expect(native.cancelTailnet.mock.invocationCallOrder[0]).toBeLessThan(
      native.configureTailnets.mock.invocationCallOrder[1],
    );
  });
});
