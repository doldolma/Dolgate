import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HostRecord, TailnetRecord, TailnetStatus } from '@shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks, storeState, watchMocks } = vi.hoisted(() => ({
  // 상태는 스토어 한곳에서 온다. 이 화면이 자기 구독을 갖지 않으므로, 테스트도 스토어를 통해
  // 상태를 준다 — 화면이 실제로 읽는 자리와 같다.
  storeState: {
    openExternalUrl: () => {},
    tailnetStatuses: {} as Record<string, unknown>,
    localTailnetNodeName: 'dev' as string | null,
    hosts: [] as HostRecord[],
    refreshHostCatalog: vi.fn(),
    vaultIndex: undefined as unknown,
  },
  watchMocks: {
    acquireTailnetWatch: () => () => {},
    applyTailnetStatus: (_status: { id: string }) => {},
    forgetTailnetStatus: (_id: string) => {},
  },
  mocks: {
    listTailnets: vi.fn(),
    snapshotTailnets: vi.fn(),
    testTailnet: vi.fn(),
    cancelTailnet: vi.fn(),
    disconnectTailnet: vi.fn(),
    forgetTailnet: vi.fn(),
    removeTailnet: vi.fn(),
    saveTailnet: vi.fn(),
    onTailnetStatus: vi.fn(),
    listTeamTailnets: vi.fn(),
  },
}));

vi.mock('../services/desktop/tailnet', () => mocks);

vi.mock('../store/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

vi.mock('../services/desktop/tailnet-watch', () => watchMocks);

import { TailnetSettingsPanel } from './TailnetSettingsPanel';

function createRecord(overrides: Partial<TailnetRecord> = {}): TailnetRecord {
  return {
    id: 'net-1',
    label: 'corp',
    controlUrl: '',
    tailnetName: null,
    loginName: null,
    hasAuthKey: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as TailnetRecord;
}

/** 공유 상태에 값을 넣는다. 코어가 흘린 상태가 스토어에 닿은 것과 같은 자리다. */
function putStatus(status: TailnetStatus) {
  storeState.tailnetStatuses = { ...storeState.tailnetStatuses, [status.id]: status };
}

describe('TailnetSettingsPanel', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.listTailnets.mockResolvedValue([createRecord()]);
    mocks.snapshotTailnets.mockResolvedValue({ statuses: [], localNodeName: 'dev' });
    mocks.onTailnetStatus.mockReturnValue(() => {});
    mocks.cancelTailnet.mockResolvedValue(undefined);
    storeState.tailnetStatuses = {};
    storeState.localTailnetNodeName = 'dev';
    storeState.hosts = [];
    storeState.refreshHostCatalog.mockReset();
    storeState.refreshHostCatalog.mockResolvedValue(undefined);
  });

  // 아무도 손대지 않는 노드도 계속 needsAuth 로 보고된다. 그것을 진행 중으로 그리면 스피너와
  // "링크를 받는 중" 이 영원히 떠 있고, 접을 대상도 없는데 취소 버튼이 뜬다 — 눌러도 아무 일이
  // 없어 사용자에게는 먹통으로 보인다. 진행 여부는 코어가 알려 주는 attempting 으로만 판단한다.
  it('진행 중이 아니면 취소를 권하지 않는다', async () => {
    render(<TailnetSettingsPanel />);
    expect(await screen.findByRole('button', { name: '연결' })).toBeInTheDocument();

    // 인증이 필요하지만 아무도 시도하고 있지 않다(설정에서 켜 둔 뒤 만료된 상태).
    putStatus({ id: 'net-1', state: 'needsAuth' });
    render(<TailnetSettingsPanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '연결' }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
  });

  // 노드를 올리는 것은 이 화면만이 아니다. 호스트에 연결하면 그 경로가 노드를 올리는데, 그때
  // 브라우저 로그인이 필요하면 사람을 기다리는 구간이 생긴다. 이 화면이 자기가 시작한 시도만
  // 본다면 그 시도는 여기 없는 것이 되고, 접을 방법도 사라진다.
  it('offers a cancel while the node is coming up, whoever started it', async () => {
    render(<TailnetSettingsPanel />);
    expect(await screen.findByRole('button', { name: '연결' })).toBeInTheDocument();

    putStatus({ id: 'net-1', state: 'needsAuth', attempting: true });
    act(() => {
      render(<TailnetSettingsPanel />);
    });

    const cancel = await screen.findByRole('button', { name: '취소' });
    fireEvent.click(cancel);
    expect(mocks.cancelTailnet).toHaveBeenCalledWith('net-1');
  });

  // 접은 뒤에도 버튼이 남으면 무엇을 기다리는지 알 수 없다.
  it('goes back to connect once the attempt ends', async () => {
    render(<TailnetSettingsPanel />);
    await screen.findByRole('button', { name: '연결' });

    putStatus({ id: 'net-1', state: 'needsAuth', attempting: true });
    const { unmount } = render(<TailnetSettingsPanel />);
    await screen.findByRole('button', { name: '취소' });
    unmount();

    // 접히면 상태가 stopped 로 내려온다. 버튼이 남으면 무엇을 기다리는지 알 수 없다.
    putStatus({ id: 'net-1', state: 'stopped', cancelled: true });
    render(<TailnetSettingsPanel />);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '연결' }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
  });

  it('shows hosts that use the network without exposing backend diagnostics', async () => {
    storeState.hosts = [
      {
        id: 'host-1',
        kind: 'ssh',
        label: 'Production API',
        hostname: 'api.internal',
        port: 2222,
        username: 'deploy',
        authType: 'password',
        tailnetId: 'net-1',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'host-2',
        kind: 'ssh',
        label: 'Other network',
        hostname: 'other.internal',
        port: 22,
        username: 'root',
        authType: 'password',
        tailnetId: 'net-2',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ] as HostRecord[];
    putStatus({
      id: 'net-1',
      state: 'running',
      ready: true,
      online: true,
      backendState: 'Running',
    });

    render(<TailnetSettingsPanel />);

    expect(await screen.findByText('사용 중인 호스트 1개')).toBeInTheDocument();
    expect(screen.getByText('Production API')).toBeInTheDocument();
    expect(screen.getByText('deploy@api.internal:2222')).toBeInTheDocument();
    expect(screen.queryByText('Other network')).not.toBeInTheDocument();
    expect(screen.queryByText(/backend=Running/)).not.toBeInTheDocument();
  });

  // SSH 만 세면 그 tailnet 이 "쓰는 호스트 없음" 으로 보인다 — 지울 때 경고가 없고, 지운 뒤 RDP·VNC
  // 호스트가 조용히 못 붙는다.
  it('RDP·VNC 호스트도 사용 중으로 센다', async () => {
    storeState.hosts = [
      {
        id: 'host-rdp',
        kind: 'rdp',
        label: 'Win Box',
        hostname: '10.0.2.181',
        port: 3389,
        tailnetId: 'net-1',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'host-vnc',
        kind: 'vnc',
        label: 'Lab Screen',
        hostname: '10.0.2.90',
        port: 5900,
        tailnetId: 'net-1',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ] as HostRecord[];
    putStatus({
      id: 'net-1',
      state: 'running',
      ready: true,
      online: true,
      backendState: 'Running',
    });

    render(<TailnetSettingsPanel />);

    expect(await screen.findByText('사용 중인 호스트 2개')).toBeInTheDocument();
    expect(screen.getByText('Win Box')).toBeInTheDocument();
    // 계정은 SSH 레코드에만 있다 — RDP·VNC 는 주소만 보여준다(계정은 자격증명에 있다).
    expect(screen.getByText('10.0.2.181:3389')).toBeInTheDocument();
    expect(screen.getByText('10.0.2.90:5900')).toBeInTheDocument();
  });

  it('refreshes hosts after deleting a network that they use', async () => {
    storeState.hosts = [
      {
        id: 'host-1',
        kind: 'ssh',
        label: 'Production API',
        hostname: 'api.internal',
        port: 22,
        username: 'deploy',
        authType: 'password',
        tailnetId: 'net-1',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ] as HostRecord[];

    render(<TailnetSettingsPanel />);

    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/호스트 1개의 Tailnet 설정도 해제/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(mocks.removeTailnet).toHaveBeenCalledWith('net-1'));
    expect(storeState.refreshHostCatalog).toHaveBeenCalledTimes(1);
  });
});

// 저장된 tailnet 고치기. auth key 는 렌더러로 내려오지 않으므로 칸은 늘 비어 있고, 비우면 그대로 둔다.
describe('TailnetSettingsPanel 편집', () => {
  const saved = createRecord({
    hasAuthKey: true,
    tailnetName: 'corp.ts.net',
    loginName: 'me@corp',
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.listTailnets.mockResolvedValue([saved]);
    mocks.snapshotTailnets.mockResolvedValue({ statuses: [], localNodeName: 'dev' });
    mocks.onTailnetStatus.mockReturnValue(() => {});
    mocks.saveTailnet.mockResolvedValue(saved);
    mocks.forgetTailnet.mockResolvedValue(undefined);
    storeState.tailnetStatuses = {};
    storeState.hosts = [];
    storeState.vaultIndex = undefined;
  });

  const openEditor = async () => {
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    return screen.getByPlaceholderText('비워 두면 그대로 유지') as HTMLInputElement;
  };

  it('그 카드 자리에 폼을 열고, 키 칸은 비운 채 그대로 유지된다고 알린다', async () => {
    render(<TailnetSettingsPanel />);
    const authKey = await openEditor();

    expect(authKey.value).toBe('');
    // 폼은 하나다 — 위쪽 추가 자리에 같은 초안이 한 번 더 열리면 안 된다.
    expect(screen.getAllByDisplayValue('corp')).toHaveLength(1);
    // 카드는 폼으로 바뀐다.
    expect(screen.queryByRole('button', { name: '연결' })).toBeNull();
    // 칸은 추가와 같다. 시험 단추는 없다 — 새 키는 저장할 때 지금 등록을 풀어, 다음 연결이 그 키로 등록한다.
    expect(screen.getByText('Headscale 서버 (선택)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '연결 테스트' })).toBeNull();
    expect(screen.queryByText('연결된 Tailnet')).toBeNull();
    // 한 번에 하나만 연다.
    expect(screen.getByRole('button', { name: '네트워크 추가' })).toBeDisabled();
  });

  // 이미 등록된 노드는 Tailscale 이 새 키를 무시하고 옛 등록으로 붙는다 — 틀린 키를 넣어도 "연결됨" 으로 보였다.
  // 그래서 새 키로 고치면 지금 등록을 풀고(노드키·로그인 상태를 지운다) 저장한다. 다음 연결이 그 키로 처음부터
  // 등록한다 — 저장하면서 붙지는 않는다. 연결해서 알게 된 값은 그대로 둔다.
  it('새 키를 넣으면 지금 등록을 풀고 저장한다 — 다음 연결이 그 키로 처음부터 등록한다', async () => {
    render(<TailnetSettingsPanel />);
    fireEvent.change(await openEditor(), { target: { value: '  tskey-rotated \n' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(mocks.saveTailnet).toHaveBeenCalledTimes(1));
    expect(mocks.forgetTailnet).toHaveBeenCalledWith('net-1');
    const input = mocks.saveTailnet.mock.calls[0][0];
    expect(input.authKey).toBe('tskey-rotated');
    expect(input.record).toMatchObject({
      id: 'net-1',
      label: 'corp',
      tailnetName: 'corp.ts.net',
      loginName: 'me@corp',
      createdAt: saved.createdAt,
    });
    // 풀고 나서 저장한다. 붙는 것은 다음 연결이다.
    expect(mocks.forgetTailnet.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveTailnet.mock.invocationCallOrder[0]!);
    expect(mocks.testTailnet).not.toHaveBeenCalled();
    // 저장하면 목록을 다시 읽고 카드로 돌아온다.
    await waitFor(() => expect(mocks.listTailnets).toHaveBeenCalledTimes(2));
  });

  // 컨트롤 플레인에 닿지 못해 옛 등록을 풀지 못해도 이 기기의 노드키·로그인 상태는 지워졌다. 저장은 그대로 한다.
  it('지금 등록을 풀지 못해도 새 키는 저장한다', async () => {
    mocks.forgetTailnet.mockRejectedValue(new Error('control plane unreachable'));
    render(<TailnetSettingsPanel />);
    fireEvent.change(await openEditor(), { target: { value: 'tskey-rotated' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(mocks.saveTailnet).toHaveBeenCalledTimes(1));
    expect(mocks.saveTailnet.mock.calls[0][0].authKey).toBe('tskey-rotated');
  });

  it('키 칸을 비우거나 공백만 두면 저장된 키를 건드리지 않는다', async () => {
    render(<TailnetSettingsPanel />);
    const authKey = await openEditor();
    fireEvent.change(screen.getByDisplayValue('corp'), { target: { value: 'corp-renamed' } });
    fireEvent.change(authKey, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(mocks.saveTailnet).toHaveBeenCalledTimes(1));
    const input = mocks.saveTailnet.mock.calls[0][0];
    expect(input.authKey).toBeUndefined();
    expect(input.record).toMatchObject({ id: 'net-1', label: 'corp-renamed' });
    // 키를 바꾸지 않았으면 등록도 그대로다.
    expect(mocks.forgetTailnet).not.toHaveBeenCalled();
    expect(mocks.testTailnet).not.toHaveBeenCalled();
  });

  // 서버를 바꾸면 알고 있던 tailnet·계정은 옛 서버의 것이다. 남기면 새 서버에 붙는 순간 "다른
  // tailnet" 경고가 뜨고 지울 길이 없다. 같은 서버면 그대로 둔다(위 테스트).
  it('서버를 바꾸면 새 서버로 저장하고, 옛 서버에서 알게 된 tailnet·계정은 비운다', async () => {
    mocks.listTailnets.mockResolvedValue([
      createRecord({
        hasAuthKey: true,
        controlUrl: 'https://hs-old.example.com',
        tailnetName: 'old-tailnet',
        loginName: 'me@old',
      }),
    ]);
    render(<TailnetSettingsPanel />);
    await openEditor();
    fireEvent.change(screen.getByDisplayValue('https://hs-old.example.com'), {
      target: { value: ' https://hs-new.example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(mocks.saveTailnet).toHaveBeenCalledTimes(1));
    const { record } = mocks.saveTailnet.mock.calls[0][0];
    expect(record).toMatchObject({ id: 'net-1', controlUrl: 'https://hs-new.example.com' });
    expect(record.tailnetName).toBeUndefined();
    expect(record.loginName).toBeUndefined();
  });

  // 초안을 닫을 때는 시험이 올린 노드를 지운다(상태가 있으면). 편집은 그 id 가 저장된 네트워크의
  // 노드라, 같은 정리를 타면 등록이 풀리고 로컬 상태까지 지워진다. 키가 거부돼 고치러 들어온 바로
  // 그 상태로 시험한다.
  it('편집을 취소해도 저장된 네트워크의 노드는 지우지 않는다', async () => {
    putStatus({ id: 'net-1', state: 'needsAuth', loginError: 'invalid key' });
    render(<TailnetSettingsPanel />);
    await openEditor();
    // 저장된 노드의 상태를 폼 안에 그리면 이 폼이 시험한 결과로 읽힌다.
    expect(screen.queryByText('로그인 거부됨')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(await screen.findByRole('button', { name: '편집' })).toBeInTheDocument();
    expect(mocks.forgetTailnet).not.toHaveBeenCalled();
    expect(mocks.saveTailnet).not.toHaveBeenCalled();
  });

  // 쓰이는 노드의 키·서버가 바뀌면 코어는 그 노드를 기존 연결 밑에서 버리지 못해 폐기 대기로 두고,
  // 그 연결들이 닫힐 때까지 이 네트워크의 새 연결을 막는다. 그래서 붙어 있는 동안은 열지 않는다.
  it('붙어 있는 동안은 편집을 열지 않는다', async () => {
    putStatus({ id: 'net-1', state: 'running', ready: true });
    render(<TailnetSettingsPanel />);

    expect(await screen.findByRole('button', { name: '편집' })).toBeDisabled();
  });

  // 올리는 중인 것은 막지 않는다. 그 시도는 곧 끝나고, 키가 틀려 붙지 못하는 바로 그때가 고칠
  // 때다 — 막으면 재연결을 되풀이하는 탭 때문에 단추가 켜졌다 꺼졌다 한다.
  it('올리는 중에는 편집을 막지 않는다', async () => {
    putStatus({ id: 'net-1', state: 'needsAuth', attempting: true });
    render(<TailnetSettingsPanel />);

    expect(await screen.findByRole('button', { name: '편집' })).toBeEnabled();
  });

  // 열어 둔 사이에 붙을 수 있다(다른 창·재연결). 그때 저장하면 막아 둔 것과 같은 일이 난다.
  it('고치는 사이 붙었으면 저장하지 않고 알린다', async () => {
    const { rerender } = render(<TailnetSettingsPanel />);
    fireEvent.change(await openEditor(), { target: { value: 'tskey-rotated' } });

    putStatus({
      id: 'net-1',
      state: 'running',
      ready: true,
      tailnetName: 'corp.ts.net',
      loginName: 'me@corp',
    });
    rerender(<TailnetSettingsPanel />);
    // 그 상태는 저장된 노드의 것이다 — 폼이 시험한 결과처럼 그리지 않는다(카드는 폼으로 바뀌었다).
    expect(screen.queryByText('연결됨')).toBeNull();
    expect(screen.queryByText('me@corp')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(
      await screen.findByText(/편집하는 사이 이 네트워크가 연결돼 저장하지 않았습니다/),
    ).toBeInTheDocument();
    expect(mocks.saveTailnet).not.toHaveBeenCalled();
    // 폼은 그대로다 — 무엇을 하려 했는지 보인다.
    expect(screen.getByPlaceholderText('비워 두면 그대로 유지')).toHaveValue('tskey-rotated');
  });

  // 위의 "붙어 있으면 저장하지 않는다" 는 편집만의 규칙이다. 추가는 시험에 성공해 붙은(ready) 뒤에야
  // 저장되므로, 이 규칙이 추가로 번지면 새 네트워크를 하나도 저장할 수 없다.
  it('새 네트워크는 시험해 붙은 상태로 저장된다', async () => {
    const draftId = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('net-new' as ReturnType<typeof crypto.randomUUID>);
    const { rerender } = render(<TailnetSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '네트워크 추가' }));
    putStatus({ id: 'net-new', state: 'running', ready: true, tailnetName: 'lab.ts.net' });
    rerender(<TailnetSettingsPanel />);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(mocks.saveTailnet).toHaveBeenCalledWith(
        expect.objectContaining({ record: expect.objectContaining({ id: 'net-new' }) }),
      ),
    );
    draftId.mockRestore();
  });

  it('브라우저 로그인으로 등록한 것은 비우면 브라우저 로그인 그대로라고 알린다', async () => {
    mocks.listTailnets.mockResolvedValue([createRecord({ hasAuthKey: false })]);
    render(<TailnetSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));

    expect(screen.getByPlaceholderText('비우면 브라우저 로그인')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('비워 두면 그대로 유지')).toBeNull();
  });

  it('하나를 고치는 동안 다른 카드는 편집을 열지 않는다', async () => {
    mocks.listTailnets.mockResolvedValue([saved, createRecord({ id: 'net-2', label: 'lab' })]);
    render(<TailnetSettingsPanel />);
    const [first] = await screen.findAllByRole('button', { name: '편집' });
    fireEvent.click(first);

    expect(screen.getByRole('button', { name: '편집' })).toBeDisabled();
  });
});

// 설정의 볼트별 묶음(4-7). 새 tailnet 은 묶음 머리의 + 로 그 볼트에. 팀 tailnet 도 칸은 개인 것과 같다 — auth key 는
// 그 볼트에 두고 팀에 올리지 않을 뿐이라 화면에서 가를 것이 없다.
describe('TailnetSettingsPanel with team vaults', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.listTailnets.mockResolvedValue([createRecord()]);
    mocks.listTeamTailnets.mockResolvedValue([createRecord({ id: 'net-team', label: 'acme-tailnet', hasAuthKey: false })]);
    mocks.snapshotTailnets.mockResolvedValue({ statuses: [], localNodeName: 'dev' });
    mocks.onTailnetStatus.mockReturnValue(() => {});
    mocks.saveTailnet.mockResolvedValue(createRecord({ id: 'net-draft' }));
    storeState.tailnetStatuses = {};
    storeState.hosts = [];
    storeState.vaultIndex = {
      teams: [{ id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] }],
    };
  });

  const section = (vaultId: string) =>
    within(document.querySelector(`[data-vault-section="${vaultId}"]`)!.closest('section')!);

  it('groups tailnets by vault and adds a team one into that team, with the usual auth key field', async () => {
    const draftId = vi.spyOn(crypto, 'randomUUID').mockReturnValue('net-draft' as ReturnType<typeof crypto.randomUUID>);
    const { rerender } = render(<TailnetSettingsPanel />);

    await waitFor(() => expect(section('team-a').getByText('acme-tailnet')).toBeInTheDocument());
    expect(mocks.listTeamTailnets).toHaveBeenCalledWith('team-a');
    expect(section('personal').getByText('corp')).toBeInTheDocument();
    // 팀이 있으면 위의 추가 단추 대신 묶음 머리의 + 로 만든다.
    expect(screen.queryByRole('button', { name: '네트워크 추가' })).toBeNull();

    fireEvent.click(section('team-a').getByRole('button', { name: 'Acme Infra에 네트워크 추가' }));
    // 폼은 그 묶음 안에 열린다. 칸은 개인 것과 같다.
    fireEvent.change(section('team-a').getByPlaceholderText('비우면 브라우저 로그인'), {
      target: { value: 'tskey-here' },
    });
    // 붙은 뒤에만 저장된다 — 시험이 올린 노드가 붙은 상태를 준다.
    putStatus({ id: 'net-draft', state: 'running', tailnetName: 'acme.ts.net' } as TailnetStatus);
    rerender(<TailnetSettingsPanel />);
    fireEvent.click(section('team-a').getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(mocks.saveTailnet).toHaveBeenCalledWith(
        expect.objectContaining({ vaultId: 'team-a', authKey: 'tskey-here', record: expect.objectContaining({ id: 'net-draft' }) }),
      ),
    );
    draftId.mockRestore();
  });

  // 이 기기에 키가 있으면 개인 것처럼 "auth key" 로 보이고, 고칠 때 비워 두면 그대로다.
  it('팀 tailnet 도 개인 것과 같이 보이고 고친다 — 이 기기에 둔 키는 비워 두면 그대로', async () => {
    mocks.listTeamTailnets.mockResolvedValue([createRecord({ id: 'net-team', label: 'acme-tailnet', hasAuthKey: true })]);
    render(<TailnetSettingsPanel />);
    await waitFor(() => expect(section('team-a').getByText('acme-tailnet')).toBeInTheDocument());
    expect(section('team-a').getByText('auth key')).toBeInTheDocument();

    fireEvent.click(section('team-a').getByRole('button', { name: '편집' }));
    // 폼은 그 묶음의 그 카드 자리에 열린다.
    fireEvent.change(section('team-a').getByDisplayValue('acme-tailnet'), { target: { value: 'acme-renamed' } });
    expect(section('team-a').getByPlaceholderText('비워 두면 그대로 유지')).toHaveValue('');
    fireEvent.click(section('team-a').getByRole('button', { name: '저장' }));

    await waitFor(() =>
      expect(mocks.saveTailnet).toHaveBeenCalledWith(
        expect.objectContaining({
          authKey: undefined,
          record: expect.objectContaining({ id: 'net-team', label: 'acme-renamed' }),
        }),
      ),
    );
    expect(mocks.forgetTailnet).not.toHaveBeenCalled();
  });

  // 빈 묶음의 안내 줄은 그 묶음에 새 초안이 열렸을 때만 비킨다. 편집은 그 자리를 쓰지 않는다.
  it('팀 것을 고치는 동안에도 빈 개인 묶음은 비었다고 말한다', async () => {
    mocks.listTailnets.mockResolvedValue([]);
    render(<TailnetSettingsPanel />);
    await waitFor(() => expect(section('team-a').getByText('acme-tailnet')).toBeInTheDocument());

    fireEvent.click(section('team-a').getByRole('button', { name: '편집' }));

    expect(section('team-a').getByDisplayValue('acme-tailnet')).toBeInTheDocument();
    expect(section('personal').getByText('등록된 네트워크가 없습니다.')).toBeInTheDocument();
  });

  it('keeps a personal tailnet personal', async () => {
    render(<TailnetSettingsPanel />);
    await waitFor(() => expect(section('personal').getByText('corp')).toBeInTheDocument());

    fireEvent.click(section('personal').getByRole('button', { name: 'Personal에 네트워크 추가' }));

    // 개인 것은 auth key 를 넣을 수 있다.
    expect(section('personal').getByText('auth key')).toBeInTheDocument();
  });
});
