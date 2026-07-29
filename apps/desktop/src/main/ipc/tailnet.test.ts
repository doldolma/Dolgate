import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailnetConfig, TailnetRecord, TailnetStatus } from '@shared';
import { ipcChannels } from '../../common/ipc-channels';

const electronMocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  senderSend: vi.fn(),
  windowDestroyed: false,
}));

const ipcHandlers = electronMocks.ipcHandlers;

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({
      isDestroyed: () => electronMocks.windowDestroyed,
      webContents: { send: electronMocks.senderSend },
    })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      electronMocks.ipcHandlers.set(channel, handler);
    }),
  },
}));

import { registerTailnetIpcHandlers } from './tailnet';

function record(overrides: Partial<TailnetRecord> = {}): TailnetRecord {
  return {
    id: 'net-1',
    label: 'Work',
    ephemeral: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createContext() {
  return {
    tailnets: {
      list: vi.fn(() => [record({ hasAuthKey: true })]),
      listPayloads: vi.fn(() => [{ ...record({ hasAuthKey: true }), authKey: 'tskey-secret' }]),
      save: vi.fn((next: TailnetRecord) => next),
      remove: vi.fn(),
      readAuthKey: vi.fn<(id: string) => string | null>(() => 'tskey-secret'),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
    },
    coreManager: {
      testTailnet: vi.fn<
        (
          config: TailnetConfig,
          onStatus: (status: TailnetStatus) => void,
          options?: { timeoutMs?: number; forceRelogin?: boolean },
        ) => Promise<TailnetStatus>
      >(async () => ({ id: 'net-1', state: 'running' })),
      forgetTailnet: vi.fn(async (_id: string) => {}),
      disconnectTailnet: vi.fn(async (_id: string) => {}),
      cancelTailnet: vi.fn(async (_id: string) => {}),
      snapshotTailnets: vi.fn(async () => ({ statuses: [] })),
      setTailnetConfigProvider: vi.fn<(provider: () => TailnetConfig[]) => void>(),
      pushTailnetConfigs: vi.fn(),
    },
  };
}

type Context = ReturnType<typeof createContext>;

function invoke(channel: string, ...args: unknown[]) {
  const handler = ipcHandlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({ sender: {} }, ...args);
}

describe('tailnet ipc handlers', () => {
  let ctx: Context;

  beforeEach(() => {
    ipcHandlers.clear();
    electronMocks.senderSend.mockClear();
    electronMocks.windowDestroyed = false;
    ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);
  });

  it('never returns the auth key to the renderer, only whether one is set', async () => {
    const listed = await invoke(ipcChannels.tailnet.list);

    expect(listed).toEqual([expect.objectContaining({ hasAuthKey: true })]);
    expect(JSON.stringify(listed)).not.toContain('tskey-secret');
  });

  it('reads the stored auth key on the main side when testing', async () => {
    await invoke(ipcChannels.tailnet.test, {
      id: 'net-1',
      ephemeral: true,
    });

    expect(ctx.coreManager.testTailnet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'net-1', authKey: 'tskey-secret' }),
      expect.any(Function),
      expect.objectContaining({ forceRelogin: undefined }),
    );
  });

  it('leaves authKey undefined when none is stored', async () => {
    ctx.tailnets.readAuthKey.mockReturnValue(null);

    await invoke(ipcChannels.tailnet.test, { id: 'net-1', ephemeral: true });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      authKey: undefined,
    });
  });

  // 만료된 등록은 로컬에서 구분되지 않는다 — 백엔드는 연결됨이고 통신만 안 된다. 연결이 실패한
  // 뒤의 확인 요청만 컨트롤 플레인에 등록을 다시 확인시켜야 하므로, 이 플래그가 렌더러에서
  // 코어까지 가야 한다. 삼켜지면 확인이 "이미 연결됨" 으로 끝나서 아무것도 알아내지 못한다.
  it('연결 실패 뒤 확인 요청이면 forceRelogin 을 코어까지 전달한다', async () => {
    await invoke(
      ipcChannels.tailnet.test,
      { id: 'net-1', ephemeral: true },
      { forceRelogin: true },
    );

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[2]).toMatchObject({
      forceRelogin: true,
    });
  });

  // 평소 테스트가 매번 다시 물으면 살아 있는 등록에도 새 노드 키를 만들 수 있다.
  it('평소 연결 테스트에는 켜지지 않는다', async () => {
    await invoke(ipcChannels.tailnet.test, { id: 'net-1', ephemeral: true });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[2]).toMatchObject({
      forceRelogin: undefined,
    });
  });

  it('prefers a key typed in the form so a draft can be tested before saving', async () => {
    await invoke(ipcChannels.tailnet.test, {
      id: 'net-draft',
      ephemeral: true,
      authKey: 'tskey-typed',
    });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      authKey: 'tskey-typed',
    });
    expect(ctx.tailnets.readAuthKey).not.toHaveBeenCalled();
  });

  it('falls back to the stored key when the form left the field blank', async () => {
    await invoke(ipcChannels.tailnet.test, {
      id: 'net-1',
      ephemeral: true,
      authKey: '   ',
    });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      authKey: 'tskey-secret',
    });
  });

  // 시험과 저장이 다른 규칙을 쓰면 노드가 둘로 갈라진다 — 시험은 ephemeral 로 붙고 저장
  // 뒤에는 persistent 로 붙는 식으로.
  it('tests an auth-key tailnet as ephemeral', async () => {
    await invoke(ipcChannels.tailnet.test, { id: 'net-1' });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      ephemeral: true,
    });
  });

  it('tests a browser-login tailnet as persistent', async () => {
    ctx.tailnets.readAuthKey.mockReturnValue(null);

    await invoke(ipcChannels.tailnet.test, { id: 'net-1' });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      ephemeral: false,
    });
  });

  it('pushes progress to the requesting window only', async () => {
    ctx.coreManager.testTailnet.mockImplementation(async (_config, push) => {
      push({ id: 'net-1', state: 'needsAuth', authUrl: 'https://login.example' });
      return { id: 'net-1', state: 'running' };
    });

    const final = await invoke(ipcChannels.tailnet.test, {
      id: 'net-1',
      ephemeral: true,
    });

    expect(electronMocks.senderSend).toHaveBeenCalledWith(
      ipcChannels.tailnet.status,
      expect.objectContaining({ state: 'needsAuth' }),
    );
    expect(final).toEqual({ id: 'net-1', state: 'running' });
  });

  it('drops progress once the requesting window is gone', async () => {
    ctx.coreManager.testTailnet.mockImplementation(async (_config, push) => {
      electronMocks.windowDestroyed = true;
      push({ id: 'net-1', state: 'starting' });
      return { id: 'net-1', state: 'stopped' };
    });

    await expect(
      invoke(ipcChannels.tailnet.test, { id: 'net-1', ephemeral: true }),
    ).resolves.toMatchObject({ state: 'stopped' });
    expect(electronMocks.senderSend).not.toHaveBeenCalled();
  });

  it('unregisters the node before deleting the config', async () => {
    const order: string[] = [];
    ctx.coreManager.forgetTailnet.mockImplementation(async () => {
      order.push('forget');
    });
    ctx.tailnets.remove.mockImplementation(() => {
      order.push('remove');
    });

    await invoke(ipcChannels.tailnet.remove, 'net-1');

    // 반대 순서면 컨트롤 플레인에 노드가 남는데, 그것을 지울 자격증명은 이미 사라진 뒤다.
    expect(order).toEqual(['forget', 'remove']);
    // 툼스톤이 없으면 다른 기기에서 되살아난다.
    expect(ctx.syncOutbox.upsertDeletion).toHaveBeenCalledWith('tailnets', 'net-1');
  });

  it('still deletes the config when the node cannot be unregistered', async () => {
    ctx.coreManager.forgetTailnet.mockRejectedValue(new Error('control plane down'));

    await expect(invoke(ipcChannels.tailnet.remove, 'net-1')).resolves.toBeUndefined();
    expect(ctx.tailnets.remove).toHaveBeenCalledWith('net-1');
  });

  // 코어 오류는 진단용이라 식별자와 영어가 섞여 있다. 그대로 화면에 띄우면 사용자가 할 수
  // 있는 일이 없는 문장이 된다 — tailnet node is in use: "8404eb7b-…" 같은 것.
  it('turns a busy node into a message the user can act on', async () => {
    ctx.coreManager.disconnectTailnet.mockRejectedValue(
      new Error('tailnet node is in use: "8404eb7b-bdba-4451-9d68-c9f1867082a7"'),
    );

    await expect(
      invoke(ipcChannels.tailnet.disconnect, 'net-1'),
    ).rejects.toThrow(/tailnetIpc\.nodeInUse|사용하는 연결/);
    await expect(
      invoke(ipcChannels.tailnet.disconnect, 'net-1'),
    ).rejects.not.toThrow(/8404eb7b/);
  });

  // 설정을 지우면 그 노드를 정리할 자격증명도 사라진다. 쓰이는 중이면 지우지 않고 알린다.
  it('refuses to delete a tailnet whose node is still in use', async () => {
    ctx.coreManager.forgetTailnet.mockRejectedValue(
      new Error('tailnet node is in use: "net-1"'),
    );

    await expect(invoke(ipcChannels.tailnet.remove, 'net-1')).rejects.toThrow();
    expect(ctx.tailnets.remove).not.toHaveBeenCalled();
  });

  // 그 외의 실패는 설정 삭제를 막지 않는다 — 남은 노드는 콘솔에서 지울 수 있다.
  it('still deletes the config when the node merely cannot be reached', async () => {
    ctx.coreManager.forgetTailnet.mockRejectedValue(
      new Error('control plane unreachable'),
    );

    await expect(invoke(ipcChannels.tailnet.remove, 'net-1')).resolves.toBeUndefined();
    expect(ctx.tailnets.remove).toHaveBeenCalledWith('net-1');
  });

  it('keeps the config when only the node is forgotten', async () => {
    await invoke(ipcChannels.tailnet.forget, 'net-1');

    expect(ctx.coreManager.forgetTailnet).toHaveBeenCalledWith('net-1');
    expect(ctx.tailnets.remove).not.toHaveBeenCalled();
  });

  it('passes the auth key through on save but not the record back', async () => {
    const saved = record();
    await invoke(ipcChannels.tailnet.save, {
      record: saved,
      authKey: 'tskey-new',
    });

    expect(ctx.tailnets.save).toHaveBeenCalledWith(saved, 'tskey-new');
  });

  it('omits the auth key on save so the stored one survives an edit', async () => {
    const saved = record();
    await invoke(ipcChannels.tailnet.save, { record: saved });

    expect(ctx.tailnets.save).toHaveBeenCalledWith(saved, undefined);
  });
});

// 코어는 설정을 알아야 노드를 만들 수 있는데 연결 경로는 tailnetId 만 들고 온다. 이 배선이
// 없으면 설정 화면에서 미리 연결 테스트를 한 tailnet 만 쓸 수 있고, 앱을 다시 켜면 그것도
// 잊어서 호스트 연결이 "is not configured" 로 실패한다.
describe('tailnet config push', () => {
  it('registers a provider that carries the stored auth key', () => {
    const ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);

    const provider = ctx.coreManager.setTailnetConfigProvider.mock.calls[0]?.[0];
    expect(provider).toBeTypeOf('function');
    expect(provider?.()).toEqual([
      // ephemeral 은 auth key 유무로 다시 계산한다 — 연결 테스트와 어긋나면 같은 tailnet 에
      // 노드가 둘로 갈라진다.
      { id: 'net-1', controlUrl: undefined, authKey: 'tskey-secret', ephemeral: true },
    ]);
  });

  it('re-pushes after a save so a new tailnet works without a settings test', async () => {
    const ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);
    ctx.coreManager.pushTailnetConfigs.mockClear();

    await invoke(ipcChannels.tailnet.save, { record: record(), authKey: 'tskey-new' });

    expect(ctx.coreManager.pushTailnetConfigs).toHaveBeenCalledTimes(1);
  });

  it('re-pushes after a removal so the core drops the deleted config', async () => {
    const ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);
    ctx.coreManager.pushTailnetConfigs.mockClear();

    await invoke(ipcChannels.tailnet.remove, 'net-1');

    expect(ctx.coreManager.pushTailnetConfigs).toHaveBeenCalledTimes(1);
  });
});
