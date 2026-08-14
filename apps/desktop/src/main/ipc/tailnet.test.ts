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
    settings: {
      get: vi.fn(() => ({ tailnetHostname: null }) as never),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
    },
    queueSync: vi.fn(),
    coreManager: {
      testTailnet: vi.fn<
        (
          config: TailnetConfig,
          onStatus: (status: TailnetStatus) => void,
          options?: { timeoutMs?: number },
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

  // 저장했다고 동기화에 알리지 않으면 **그 레코드가 사라진다.**
  //
   // 다음 기동의 pull 이 서버 스냅샷으로 목록을 통째로 갈아 끼우고, 서버에 없는 것은 삭제로
  // 취급된다. 실기기에서 정확히 그렇게 잃었다 — 저장한 tailnet 이 앱을 껐다 켜면 목록에서
  // 사라졌고, 종료 전에 다른 것(호스트·스니펫 …)을 건드린 경우에만 살아남았다(그때 그쪽의
  // queueSync 가 전체 스냅샷을 올려 준다).
  it('저장하면 동기화 push 를 예약한다', async () => {
    await invoke(ipcChannels.tailnet.save, { record: record(), authKey: 'tskey-new' });

    expect(ctx.queueSync).toHaveBeenCalled();
  });

  // 삭제는 툼스톤을 남기지만, 그것도 올려 주지 않으면 다른 기기에서 되살아난다.
  it('삭제하면 동기화 push 를 예약한다', async () => {
    await invoke(ipcChannels.tailnet.remove, 'net-1');

    expect(ctx.syncOutbox.upsertDeletion).toHaveBeenCalledWith('tailnets', 'net-1');
    expect(ctx.queueSync).toHaveBeenCalled();
  });

  it('reads the stored auth key on the main side when testing', async () => {
    await invoke(ipcChannels.tailnet.test, {
      id: 'net-1',
      ephemeral: true,
    });

    expect(ctx.coreManager.testTailnet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'net-1', authKey: 'tskey-secret' }),
      expect.any(Function),
    );
  });

  it('leaves authKey undefined when none is stored', async () => {
    ctx.tailnets.readAuthKey.mockReturnValue(null);

    await invoke(ipcChannels.tailnet.test, { id: 'net-1', ephemeral: true });

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      authKey: undefined,
    });
  });

  // 연결 요청에는 옵션이 없다.
  //
  // 예전에는 forceRelogin("먼저 노드를 버리고 다시 확인해라")이 렌더러에서 코어까지 흘렀다.
  // 그러면 "강도" 를 요청하는 쪽이 정하게 되고, 화면이 취소·플래그·재시도를 조립하게 된다.
  // 다시 세울지는 코어가 링크를 확보하는 과정에서 판단한다.
  it('요청 쪽이 정책을 실어 보내지 않는다', async () => {
    await invoke(ipcChannels.tailnet.test, { id: 'net-1', ephemeral: true }, {
      forceRelogin: true,
    } as unknown as undefined);

    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[2]).toBeUndefined();
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

  // 시험과 실제 연결이 다른 규칙을 쓰면 같은 tailnet 에 노드가 둘로 갈라진다. 둘 다 ephemeral 을
  // 요청하지 않는다 — 요청하면 앱 종료 때 노드가 지워지고 1회용 키는 재등록에 실패한다.
  it('never asks for an ephemeral registration', async () => {
    await invoke(ipcChannels.tailnet.test, { id: 'net-1' });
    expect(ctx.coreManager.testTailnet.mock.calls[0]?.[0]).toMatchObject({
      ephemeral: false,
    });

    ctx.tailnets.readAuthKey.mockReturnValue(null);
    await invoke(ipcChannels.tailnet.test, { id: 'net-1' });
    expect(ctx.coreManager.testTailnet.mock.calls[1]?.[0]).toMatchObject({
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

  // 몇 개가 붙잡고 있는지 말해야 한다.
  //
  // "연결이 있습니다" 만 보여 주면, 이미 다 닫았다고 믿는 사용자는 무엇을 더 닫아야 하는지 알 수
  // 없다 — 실기기에서 그 막다른 곳에 있었다. 코어가 세어 준 값을 그대로 옮긴다.
  it('연결 종료가 거절되면 몇 개가 쓰는 중인지 말한다', async () => {
    ctx.coreManager.disconnectTailnet.mockRejectedValue(
      new Error('tailnet node is in use: "net-1" (leases=3)'),
    );

    await expect(
      invoke(ipcChannels.tailnet.disconnect, 'net-1'),
    ).rejects.toThrow('3');
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
      // ephemeral 은 요청하지 않는다 — 연결 테스트와 같은 규칙이어야 노드가 둘로 갈라지지 않는다.
      {
        id: 'net-1',
        controlUrl: undefined,
        authKey: 'tskey-secret',
        ephemeral: false,
        // 설정하지 않으면 비운다 — 코어가 기본값 `dolgate-<기기이름>` 을 쓴다.
        hostname: undefined,
      },
    ]);
  });

  it('re-pushes after a save so a new tailnet works without a settings test', async () => {
    const ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);
    ctx.coreManager.pushTailnetConfigs.mockClear();

    await invoke(ipcChannels.tailnet.save, { record: record(), authKey: 'tskey-new' });

    expect(ctx.coreManager.pushTailnetConfigs).toHaveBeenCalledTimes(1);
  });

  // 연결 테스트는 코어에 저장된 설정을 덮어쓴다(TailnetTest → configs.set). 그래서 이 경로가
  // 이름을 빠뜨리면, 전체 밀어넣기로 잘 보내 둔 값이 설정 화면에서 연결을 누르는 순간 지워지고
  // 노드가 기본 이름으로 뜬다 — 저장은 됐는데 컨트롤 플레인은 안 바뀌는, 원인 찾기 어려운 실패다.
  it('carries the node name into the connection test as well', async () => {
    const ctx = createContext();
    ctx.settings.get.mockReturnValue({ tailnetHostname: 'work-laptop' } as never);
    registerTailnetIpcHandlers(ctx as never);

    await invoke(ipcChannels.tailnet.test, { id: 'net-1', controlUrl: undefined });

    expect(ctx.coreManager.testTailnet).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'work-laptop' }),
      expect.anything(),
    );
  });

  // 노드 이름은 기기 로컬 설정이라 tailnet 레코드가 아니라 settings 에서 온다. 이 배선이
  // 끊기면 사용자가 이름을 정해도 조용히 기본값으로 등록된다.
  it('carries the configured node name into every tailnet config', () => {
    const ctx = createContext();
    ctx.settings.get.mockReturnValue({ tailnetHostname: 'work-laptop' } as never);
    registerTailnetIpcHandlers(ctx as never);

    const provider = ctx.coreManager.setTailnetConfigProvider.mock.calls[0]?.[0];
    expect(provider?.()[0]).toMatchObject({ hostname: 'work-laptop' });
  });

  it('falls back to the core default when the name is blank', () => {
    const ctx = createContext();
    ctx.settings.get.mockReturnValue({ tailnetHostname: '   ' } as never);
    registerTailnetIpcHandlers(ctx as never);

    const provider = ctx.coreManager.setTailnetConfigProvider.mock.calls[0]?.[0];
    expect(provider?.()[0].hostname).toBeUndefined();
  });

  it('re-pushes after a removal so the core drops the deleted config', async () => {
    const ctx = createContext();
    registerTailnetIpcHandlers(ctx as never);
    ctx.coreManager.pushTailnetConfigs.mockClear();

    await invoke(ipcChannels.tailnet.remove, 'net-1');

    expect(ctx.coreManager.pushTailnetConfigs).toHaveBeenCalledTimes(1);
  });
});
