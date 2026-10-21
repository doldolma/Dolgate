import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TeamInvitePreview } from '@shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/appStore', async () =>
  (await import('../../store/appStore.test-support')).createAppStoreModuleMock(),
);

import { appStore, desktopApi } from '../../store/appStore';
import { JoinTeamDialogHost } from './JoinTeamDialogHost';

const LINK = 'https://sync.dolgate.app/invite/k3Hq9xAb#v1.Qm9vYmFy';

const OK: TeamInvitePreview = {
  status: 'ok',
  teamId: 'team-1',
  teamName: 'Acme Infra',
  inviterEmail: 'dolma@acme.dev',
  memberCount: 3,
  expiresAt: '2026-10-27T00:00:00.000Z',
  alreadyJoined: false,
};

const onRequestLogin = vi.fn();

function renderHost(link: string | null = LINK) {
  appStore.setState({ pendingInviteLink: link });
  return render(<JoinTeamDialogHost onRequestLogin={onRequestLogin} />);
}

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
  vi.clearAllMocks();
  vi.mocked(desktopApi.teams.getAvailability).mockResolvedValue({ available: true });
  vi.mocked(desktopApi.teams.previewInvite).mockResolvedValue(OK);
  vi.mocked(desktopApi.teams.join).mockResolvedValue({
    id: 'team-1',
    name: 'Acme Infra',
    role: 'member',
    syncState: 'idle',
    syncError: null,
  });
});

describe('JoinTeamDialogHost', () => {
  it('shows nothing without a link', () => {
    renderHost(null);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(desktopApi.teams.getAvailability).not.toHaveBeenCalled();
  });

  it('shows the team, who invited and what joining does, then joins and opens the team', async () => {
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra' });
    expect(within(dialog).getByText('dolma@acme.dev 님의 초대 · 멤버 3명')).toBeInTheDocument();
    expect(within(dialog).getByText(/서버는 내용을 볼 수 없습니다/)).toBeInTheDocument();
    // 들어가기 전에 안다 — 팀 호스트의 접속 기록과 녹화는 멤버 모두가 본다.
    expect(
      within(dialog).getByText('이 팀 호스트의 접속 기록과 터미널 녹화는 멤버 모두가 봅니다.'),
    ).toBeInTheDocument();
    expect(desktopApi.teams.previewInvite).toHaveBeenCalledWith(LINK);

    fireEvent.click(within(dialog).getByRole('button', { name: '참여' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(desktopApi.teams.join).toHaveBeenCalledWith(LINK);
    expect(appStore.getState()).toMatchObject({
      pendingInviteLink: null,
      homeSection: 'settings',
      settingsSection: 'teams',
      teamsPanelTeamId: 'team-1',
    });
  });

  it('keeps the card and says why when joining fails', async () => {
    vi.mocked(desktopApi.teams.join).mockRejectedValue(new Error('초대 링크가 만료되었거나 올바르지 않습니다.'));
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra' });

    fireEvent.click(within(dialog).getByRole('button', { name: '참여' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('초대 링크가 만료되었거나 올바르지 않습니다.');
    expect(appStore.getState().pendingInviteLink).toBe(LINK);
  });

  it('takes you to a team you are already in', async () => {
    vi.mocked(desktopApi.teams.previewInvite).mockResolvedValue({ ...OK, alreadyJoined: true });
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: 'Acme Infra' });
    expect(within(dialog).getByText('이미 들어가 있는 팀입니다.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '참여' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '팀으로 가기' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(desktopApi.teams.join).not.toHaveBeenCalled();
    expect(appStore.getState()).toMatchObject({ pendingInviteLink: null, settingsSection: 'teams', teamsPanelTeamId: 'team-1' });
  });

  it('names the other server for a team on another server', async () => {
    vi.mocked(desktopApi.teams.previewInvite).mockResolvedValue({ status: 'other-server', serverHost: 'sync.acme.dev' });
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: '다른 서버의 팀입니다' });
    expect(within(dialog).getByText(/이 팀은 sync\.acme\.dev 에 있습니다/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    expect(appStore.getState().pendingInviteLink).toBeNull();
  });

  it.each([
    [{ status: 'expired' } as const, '만료된 초대 링크'],
    [{ status: 'update-required' } as const, '앱 업데이트가 필요합니다'],
    [{ status: 'invalid' } as const, '열 수 없는 초대 링크'],
  ])('explains a link that cannot be opened (%o)', async (preview, title) => {
    vi.mocked(desktopApi.teams.previewInvite).mockResolvedValue(preview);
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: title });
    expect(within(dialog).queryByRole('button', { name: '참여' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: '닫기' })).toBeInTheDocument();
  });

  it('retries when the server could not be asked', async () => {
    vi.mocked(desktopApi.teams.previewInvite).mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다.'));
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: '초대를 확인하지 못했습니다' });
    expect(within(dialog).getByText('서버에 연결할 수 없습니다.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByRole('dialog', { name: 'Acme Infra' })).toBeInTheDocument();
  });

  it('asks someone using the app without an account to sign in, and brings the card back after', async () => {
    vi.mocked(desktopApi.teams.getAvailability).mockResolvedValue({ available: false, reason: 'signed-out' });
    renderHost();
    const dialog = await screen.findByRole('dialog', { name: '로그인이 필요합니다' });
    expect(desktopApi.teams.previewInvite).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '로그인' }));

    expect(onRequestLogin).toHaveBeenCalledTimes(1);
    // 로그인 창이 뜬 동안 비켜 주지만 링크는 기억한다.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appStore.getState().pendingInviteLink).toBe(LINK);

    // 로그인을 마쳐 팀을 쓸 수 있게 되면(부트스트랩이 다시 읽는다) 참여 카드가 뜬다.
    vi.mocked(desktopApi.teams.getAvailability).mockResolvedValue({ available: true });
    act(() => {
      appStore.setState({ teamAvailability: { available: true } });
    });
    expect(await screen.findByRole('dialog', { name: 'Acme Infra' })).toBeInTheDocument();
  });

  it.each([
    ['unsupported-vault', '새 동기화 볼트가 필요합니다'],
    ['server-unsupported', '이 서버는 팀을 지원하지 않습니다'],
  ] as const)('says why teams cannot be used (%s)', async (reason, title) => {
    vi.mocked(desktopApi.teams.getAvailability).mockResolvedValue({ available: false, reason });
    renderHost();
    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
    expect(desktopApi.teams.previewInvite).not.toHaveBeenCalled();
  });
});
