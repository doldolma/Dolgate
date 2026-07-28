import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TailnetRecord, TailnetStatus } from '@shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
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
  useAppStore: (selector: (state: { openExternalUrl: () => void }) => unknown) =>
    selector({ openExternalUrl: vi.fn() }),
}));

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

/** 화면이 구독한 상태 리스너. 코어가 상태를 흘리는 것과 같은 자리다. */
function emitStatus(status: TailnetStatus) {
  for (const [listener] of mocks.onTailnetStatus.mock.calls) {
    (listener as (value: TailnetStatus) => void)(status);
  }
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
  });

  // 노드를 올리는 것은 이 화면만이 아니다. 호스트에 연결하면 그 경로가 노드를 올리는데, 그때
  // 브라우저 로그인이 필요하면 사람을 기다리는 구간이 생긴다. 이 화면이 자기가 시작한 시도만
  // 본다면 그 시도는 여기 없는 것이 되고, 접을 방법도 사라진다.
  it('offers a cancel while the node is coming up, whoever started it', async () => {
    render(<TailnetSettingsPanel />);
    expect(await screen.findByRole('button', { name: '연결' })).toBeInTheDocument();

    act(() => {
      emitStatus({ id: 'net-1', state: 'needsAuth' });
    });

    const cancel = await screen.findByRole('button', { name: '취소' });
    fireEvent.click(cancel);
    expect(mocks.cancelTailnet).toHaveBeenCalledWith('net-1');
  });

  // 접은 뒤에도 버튼이 남으면 무엇을 기다리는지 알 수 없다.
  it('goes back to connect once the attempt ends', async () => {
    render(<TailnetSettingsPanel />);
    await screen.findByRole('button', { name: '연결' });

    act(() => {
      emitStatus({ id: 'net-1', state: 'needsAuth' });
    });
    await screen.findByRole('button', { name: '취소' });

    act(() => {
      emitStatus({ id: 'net-1', state: 'stopped', cancelled: true });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '연결' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
  });
});
