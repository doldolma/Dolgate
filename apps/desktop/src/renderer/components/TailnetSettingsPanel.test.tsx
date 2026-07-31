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
