import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks, storeState, watchMocks } = vi.hoisted(() => ({
  storeState: {
    openExternalUrl: () => {},
    tailnetStatuses: {} as Record<string, unknown>,
  },
  watchMocks: {
    acquireTailnetWatch: () => () => {},
    applyTailnetStatus: (_status: { id: string }) => {},
    forgetTailnetStatus: vi.fn(),
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

vi.mock('../../services/desktop/tailnet', () => mocks);
vi.mock('../../services/desktop/tailnet-watch', () => watchMocks);
vi.mock('../../store/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

import { TailnetAddDialog } from './TailnetAddDialog';

const DRAFT_ID = '00000000-0000-4000-8000-000000000001' as const;

/**
 * 붙은 상태를 흉내 낸다. 저장 버튼은 연결에 성공해야만 열리므로 이게 없으면 저장 경로를
 * 아예 밟을 수 없다. 스토어 목은 구독이 아니라 단순 selector 라 **render 전에** 넣어야 한다.
 */
function markConnected(tailnetName = 'corp.ts.net') {
  // 저장 조건은 `state === 'running'` 이다(connectedTailnet 참고).
  storeState.tailnetStatuses = {
    [DRAFT_ID]: {
      id: DRAFT_ID,
      state: 'running',
      tailnetName,
      loginName: 'me@example.com',
    },
  };
}

describe('TailnetAddDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.tailnetStatuses = {};
    // 초안 id 는 팝업이 만들고 화면에 드러나지 않는다. 고정해야 저장 결과를 대조할 수 있다.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(DRAFT_ID);
  });

  // 붙는 것을 확인하기 전에 저장해 봐야 쓸 수 없는 설정이 하나 늘 뿐이다.
  // 그 규칙이 설정 화면에서 팝업으로 자리를 옮겨서도 그대로인지 고정한다.
  it('keeps save closed until the connection test succeeds', () => {
    render(<TailnetAddDialog onClose={vi.fn()} onAdded={vi.fn()} />);

    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  });

  // 이 팝업의 존재 이유다 — 만든 tailnet 이 곧바로 그 호스트에 적용돼야 한다. id 뿐 아니라
  // label 까지 올려 주는 이유는 호스트 폼이 상위 목록 갱신을 기다리지 않고 바로 그리기 위함이다.
  it('hands the saved tailnet up and closes', async () => {
    const onAdded = vi.fn();
    const onClose = vi.fn();
    mocks.saveTailnet.mockResolvedValue(undefined);
    markConnected();

    render(<TailnetAddDialog onClose={onClose} onAdded={onAdded} />);

    fireEvent.change(screen.getByPlaceholderText('예: 회사 네트워크'), {
      target: { value: 'corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith({ id: DRAFT_ID, label: 'corp' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 저장하고 닫았으므로 정리 대상이 아니다 — 여기서 지우면 방금 만든 것이 사라진다.
    expect(mocks.forgetTailnet).not.toHaveBeenCalled();
  });

  // 이름을 비워 두면 컨트롤 플레인이 알려 준 tailnet 이름을 쓴다.
  it('falls back to the tailnet name when the label is left empty', async () => {
    const onAdded = vi.fn();
    mocks.saveTailnet.mockResolvedValue(undefined);
    markConnected('corp.ts.net');

    render(<TailnetAddDialog onClose={vi.fn()} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledWith({ id: DRAFT_ID, label: 'corp.ts.net' });
    });
  });

  // 시험은 **진짜 노드를 올린다.** 저장하지 않고 닫으면 그 노드가 유령으로 남는다.
  // 이 정리가 설정 화면에만 있고 팝업에 없으면 여기서만 노드가 샌다.
  it('forgets the node when closed without saving', async () => {
    markConnected();
    render(<TailnetAddDialog onClose={vi.fn()} onAdded={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    await waitFor(() => {
      expect(mocks.forgetTailnet).toHaveBeenCalledWith(DRAFT_ID);
    });
  });
});
