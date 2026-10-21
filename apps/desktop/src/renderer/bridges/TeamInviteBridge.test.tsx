import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/appStore', async () =>
  (await import('../store/appStore.test-support')).createAppStoreModuleMock(),
);

import { appStore, desktopApi } from '../store/appStore';
import { TeamInviteBridge } from './TeamInviteBridge';

const LINK_A = 'https://sync.example.com/invite/a#v1.x';
const LINK_B = 'https://sync.example.com/invite/b#v1.y';

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe('TeamInviteBridge', () => {
  it('takes a link waiting in main when the window starts, and each one that arrives later', async () => {
    let notify: (() => void) | null = null;
    vi.mocked(desktopApi.teams.onInviteLink).mockImplementation((listener) => {
      notify = listener;
      return () => {
        notify = null;
      };
    });
    // 링크로 앱이 켜졌다 — 창이 뜨기 전에 온 링크가 메인에 기다리고 있다.
    vi.mocked(desktopApi.teams.takePendingInviteLink).mockResolvedValueOnce(LINK_A).mockResolvedValueOnce(LINK_B);

    const { unmount } = render(<TeamInviteBridge />);
    await waitFor(() => expect(appStore.getState().pendingInviteLink).toBe(LINK_A));

    await act(async () => {
      notify?.();
    });
    await waitFor(() => expect(appStore.getState().pendingInviteLink).toBe(LINK_B));

    unmount();
    expect(notify).toBeNull();
  });
});
