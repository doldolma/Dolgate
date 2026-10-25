import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TeamInvite, TeamMember, TeamVaultEntry } from '@shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/appStore', async () =>
  (await import('../../store/appStore.test-support')).createAppStoreModuleMock(),
);

import { appStore, desktopApi } from '../../store/appStore';
import { createEmptyVaultIndex } from '../../store/utils';
import { TeamsPanel } from './TeamsPanel';

const LINK = 'https://sync.acme.dev/invite/k3Hq9xAb#v1.Qm9vYmFy';
const HOUR = 60 * 60 * 1000;

function teamEntry(overrides: Partial<TeamVaultEntry> = {}): TeamVaultEntry {
  return {
    id: 'team-1',
    name: 'Acme Infra',
    role: 'owner',
    syncState: 'ready',
    syncError: null,
    groups: [{ id: 'g1' }, { id: 'g2' }] as never,
    ...overrides,
  };
}

function member(userId: string, role: TeamMember['role'], addedBy: string, hoursAgo: number): TeamMember {
  return {
    userId,
    email: `${userId}@acme.dev`,
    role,
    hasKey: true,
    addedBy,
    addedByEmail: `${addedBy}@acme.dev`,
    addedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  };
}

// 나는 dolma. dolma 가 팀을 만들었고, minji 는 dolma 의 링크로, jun 은 minji 의 링크로 들어왔다.
const DOLMA_OWNS = [member('dolma', 'owner', 'dolma', 48), member('minji', 'member', 'dolma', 30), member('jun', 'member', 'minji', 2)];
// minji 가 소유자이고 나는 멤버다.
const MINJI_OWNS = [member('minji', 'owner', 'minji', 48), member('dolma', 'member', 'minji', 30)];

function invite(overrides: Partial<TeamInvite> = {}): TeamInvite {
  return {
    code: 'code-1',
    createdBy: 'minji',
    createdByEmail: 'minji@acme.dev',
    expiresAt: new Date(Date.now() + 6 * 24 * HOUR).toISOString(),
    useCount: 1,
    createdAt: new Date(Date.now() - 24 * HOUR).toISOString(),
    active: true,
    revokedAt: null,
    link: null,
    ...overrides,
  };
}

function setTeams(teams: TeamVaultEntry[]) {
  appStore.setState({
    vaultIndex: {
      ...createEmptyVaultIndex(),
      teams,
      // 이 팀의 호스트 둘과 다른 팀의 호스트 하나.
      teamIdByHostId: { h1: 'team-1', h2: 'team-1', h3: 'team-2' },
    },
  });
}

function renderPanel() {
  return render(<TeamsPanel currentUserId="dolma" currentUserEmail="dolma@acme.dev" />);
}

/** 멤버·초대 링크 줄. */
const rowOf = (element: HTMLElement) => element.closest('li')!;

/** 팀 메뉴를 열어 그 항목을 누른다 — 나가기·삭제는 늘 보이는 단추가 아니라 메뉴에 있다. */
function chooseTeamMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '팀 메뉴' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

const writeText = vi.fn();

beforeEach(() => {
  appStore.setState(appStore.getInitialState(), true);
  vi.clearAllMocks();
  vi.mocked(desktopApi.teams.listMembers).mockResolvedValue(DOLMA_OWNS);
  vi.mocked(desktopApi.teams.listInvites).mockResolvedValue([]);
  vi.mocked(desktopApi.teams.leave).mockResolvedValue(undefined);
  vi.mocked(desktopApi.teams.transferOwnership).mockResolvedValue(undefined);
  vi.mocked(desktopApi.teams.removeMember).mockResolvedValue(undefined);
  vi.mocked(desktopApi.teams.remove).mockResolvedValue(undefined);
  vi.mocked(desktopApi.teams.revokeInvite).mockResolvedValue(undefined);
  vi.mocked(desktopApi.teams.createInvite).mockResolvedValue({ link: LINK, invite: invite() });
  vi.mocked(desktopApi.keychain.list).mockResolvedValue([{}, {}, {}, {}] as never);
  vi.mocked(desktopApi.teams.getVaultIndex).mockImplementation(async () => appStore.getState().vaultIndex);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('TeamsPanel', () => {
  it('shows who joined through whose link, and gives the owner the member menus and delete', async () => {
    setTeams([teamEntry()]);
    renderPanel();

    const minjiRow = rowOf(await screen.findByText('minji@acme.dev'));
    expect(within(minjiRow).getByText('dolma 의 링크로 참여')).toBeInTheDocument();
    expect(within(minjiRow).getByText('Member')).toBeInTheDocument();
    const junRow = rowOf(screen.getByText('jun@acme.dev'));
    expect(within(junRow).getByText('minji 의 링크로 참여')).toBeInTheDocument();
    // 만든 사람 줄에는 어떻게 들어왔는지가 없다 — 만든 사람이다. 역할만 남는다.
    const myRow = rowOf(screen.getByText('dolma@acme.dev'));
    expect(within(myRow).queryByText(/링크로 참여|팀을 만듦/)).toBeNull();
    expect(within(myRow).getByText('나')).toBeInTheDocument();
    expect(within(myRow).getByText('Owner')).toBeInTheDocument();
    // 멤버 줄에는 머리글자 표시가 없다 — 이메일이 바로 옆에 있다.
    expect(within(myRow).queryByText('D')).toBeNull();
    expect(within(minjiRow).queryByText('M')).toBeNull();

    // 나를 뺀 두 줄에만 메뉴가 있다.
    expect(screen.getAllByRole('button', { name: '멤버 메뉴' })).toHaveLength(2);
    expect(within(myRow).queryByRole('button', { name: '멤버 메뉴' })).toBeNull();
    // 나가기·삭제는 팀 메뉴에 있다.
    expect(screen.queryByRole('button', { name: '팀 삭제' })).toBeNull();
    expect(screen.queryByRole('button', { name: '팀 나가기' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '팀 메뉴' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['이름 변경', '팀 나가기', '팀 삭제']);
    // 머리 요약: 멤버 수와 호스트 수.
    expect(screen.getByText('멤버 3명 · 호스트 2개')).toBeInTheDocument();
  });

  it('lists every team with its host count, and opens the one picked', async () => {
    setTeams([teamEntry(), teamEntry({ id: 'team-2', name: 'Ops Night', role: 'member' })]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    const acme = screen.getByRole('button', { name: /Acme Infra/ });
    const ops = screen.getByRole('button', { name: /Ops Night/ });
    expect(acme).toHaveAttribute('aria-pressed', 'true');
    expect(within(acme).getByText('호스트 2개')).toBeInTheDocument();
    expect(within(ops).getByText('호스트 1개')).toBeInTheDocument();

    fireEvent.click(ops);

    await waitFor(() => expect(desktopApi.teams.listMembers).toHaveBeenLastCalledWith('team-2'));
    expect(appStore.getState().teamsPanelTeamId).toBe('team-2');
    expect(screen.getByRole('button', { name: /Ops Night/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renames the team from the team menu', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    fireEvent.click(screen.getByRole('button', { name: '팀 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름 변경' }));
    const dialog = screen.getByRole('dialog', { name: '이름 변경' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Team name' }), { target: { value: 'Acme Ops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(desktopApi.teams.rename).toHaveBeenCalledWith('team-1', 'Acme Ops'));
  });

  it('gives a member no member menus and no delete, but invite and leave', async () => {
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue(MINJI_OWNS);
    setTeams([teamEntry({ role: 'member' })]);
    renderPanel();

    await screen.findByText('minji@acme.dev');
    expect(screen.queryByRole('button', { name: '멤버 메뉴' })).toBeNull();
    expect(screen.getByRole('button', { name: '초대 링크' })).toBeInTheDocument();
    // 이름 변경·삭제는 소유자만 — 멤버의 팀 메뉴에는 나가기만 있다.
    fireEvent.click(screen.getByRole('button', { name: '팀 메뉴' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['팀 나가기']);
  });

  it('lets a member leave after one confirmation, without handing anything over', async () => {
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue(MINJI_OWNS);
    setTeams([teamEntry({ role: 'member' })]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    chooseTeamMenu('팀 나가기');
    const dialog = screen.getByRole('dialog', { name: 'Acme Infra 나가기' });
    expect(within(dialog).getByText(/다시 들어오려면 새 초대 링크가 필요합니다/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '나가기' }));

    await waitFor(() => expect(desktopApi.teams.leave).toHaveBeenCalledWith('team-1'));
    expect(desktopApi.teams.transferOwnership).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lets an owner with other members hand over to the earliest member, then leave', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    chooseTeamMenu('팀 나가기');
    const dialog = screen.getByRole('dialog', { name: 'Acme Infra 나가기' });
    const successor = within(dialog).getByRole('combobox', { name: 'New owner' }) as HTMLSelectElement;
    // 가장 먼저 들어온 사람(minji)이 골라져 있다. 나는 목록에 없다.
    expect(successor.value).toBe('minji');
    expect(within(successor).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'minji@acme.dev · 가장 먼저 들어옴',
      'jun@acme.dev',
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: '넘기고 나가기' }));

    await waitFor(() => expect(desktopApi.teams.leave).toHaveBeenCalledWith('team-1'));
    expect(desktopApi.teams.transferOwnership).toHaveBeenCalledWith('team-1', 'minji');
    expect(vi.mocked(desktopApi.teams.transferOwnership).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(desktopApi.teams.leave).mock.invocationCallOrder[0],
    );
  });

  // 멤버 목록이 오기 전에 나가기 창을 열 수 있다(팀 메뉴는 늘 있다). 그래도 목록이 오면 가장 먼저 들어온
  // 사람이 골라져 있어야 한다 — 빈 칸에 막힌 단추가 되면 안 된다.
  it('picks the earliest member to hand over to even when the member list arrives after the window opens', async () => {
    let resolveMembers: (members: TeamMember[]) => void = () => undefined;
    vi.mocked(desktopApi.teams.listMembers).mockReturnValue(
      new Promise<TeamMember[]>((resolve) => {
        resolveMembers = resolve;
      }),
    );
    setTeams([teamEntry()]);
    renderPanel();

    chooseTeamMenu('팀 나가기');
    const dialog = screen.getByRole('dialog', { name: 'Acme Infra 나가기' });
    resolveMembers(DOLMA_OWNS);

    const successor = (await within(dialog).findByRole('combobox', { name: 'New owner' })) as HTMLSelectElement;
    expect(successor.value).toBe('minji');
    expect(within(dialog).getByRole('button', { name: '넘기고 나가기' })).toBeEnabled();
    fireEvent.change(successor, { target: { value: 'jun' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '넘기고 나가기' }));
    await waitFor(() => expect(desktopApi.teams.transferOwnership).toHaveBeenCalledWith('team-1', 'jun'));
  });

  it('warns the last member that leaving deletes the team, with what goes', async () => {
    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([member('dolma', 'owner', 'dolma', 48)]);
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('dolma@acme.dev');

    chooseTeamMenu('팀 나가기');
    const dialog = screen.getByRole('dialog', { name: 'Acme Infra 나가기' });
    expect(within(dialog).getByText(/마지막 멤버입니다/)).toBeInTheDocument();
    // 그룹 2 · 호스트 2(다른 팀 것은 빼고) · 비밀번호와 키 4.
    await within(dialog).findByText('4');
    expect(within(dialog).getAllByText('2')).toHaveLength(2);
    expect(desktopApi.keychain.list).toHaveBeenCalledWith('team-1');
    fireEvent.click(within(dialog).getByRole('button', { name: '지우고 나가기' }));

    await waitFor(() => expect(desktopApi.teams.leave).toHaveBeenCalledWith('team-1'));
    expect(desktopApi.teams.transferOwnership).not.toHaveBeenCalled();
  });

  it('copies a new invite link right away, and shows it in the window only while it is open', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    fireEvent.click(screen.getByRole('button', { name: '초대 링크' }));
    let dialog = screen.getByRole('dialog', { name: 'Acme Infra 초대' });
    expect(within(dialog).getByRole('radio', { name: '7일' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(dialog).getByRole('radio', { name: '1일' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '만들고 복사' }));

    expect(await within(dialog).findByText('링크를 복사했습니다 — 1일 동안 열립니다.')).toBeInTheDocument();
    expect(desktopApi.teams.createInvite).toHaveBeenCalledWith('team-1', { expiresInHours: 24 });
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(within(dialog).getByRole('textbox', { name: 'Invite link' })).toHaveValue(LINK);

    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    expect(screen.queryByDisplayValue(LINK)).toBeNull();
    // 다시 열면 새 링크를 만드는 창이다 — 지난 링크는 링크 목록에서 다시 복사한다.
    fireEvent.click(screen.getByRole('button', { name: '초대 링크' }));
    dialog = screen.getByRole('dialog', { name: 'Acme Infra 초대' });
    expect(within(dialog).getByRole('button', { name: '만들고 복사' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(LINK)).toBeNull();
  });

  it('says the links are all revoked after removing a member, and offers a new one', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    const minjiRow = rowOf(await screen.findByText('minji@acme.dev'));

    fireEvent.click(within(minjiRow).getByRole('button', { name: '멤버 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '제거' }));
    const dialog = screen.getByRole('dialog', { name: 'minji@acme.dev 제거' });
    expect(within(dialog).getByText(/이 팀의 초대 링크도 모두 취소됩니다/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '제거' }));

    expect(await within(dialog).findByText('뺐습니다 — 초대 링크가 모두 취소됐습니다.')).toBeInTheDocument();
    expect(desktopApi.teams.removeMember).toHaveBeenCalledWith('team-1', 'minji');
    fireEvent.click(within(dialog).getByRole('button', { name: '초대 링크' }));
    expect(screen.getByRole('dialog', { name: 'Acme Infra 초대' })).toBeInTheDocument();
  });

  it('makes a member the owner from the row menu', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    const junRow = rowOf(await screen.findByText('jun@acme.dev'));

    fireEvent.click(within(junRow).getByRole('button', { name: '멤버 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '소유자로 지정' }));
    const dialog = screen.getByRole('dialog', { name: 'jun@acme.dev 에게 소유권 넘기기' });
    fireEvent.click(within(dialog).getByRole('button', { name: '넘기기' }));

    await waitFor(() => expect(desktopApi.teams.transferOwnership).toHaveBeenCalledWith('team-1', 'jun'));
  });

  it('tells the owner how many other members lose the team when deleting it', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('minji@acme.dev');

    chooseTeamMenu('팀 삭제');
    const dialog = screen.getByRole('dialog', { name: 'Acme Infra 팀 삭제' });
    expect(within(dialog).getByText('다른 멤버 2명의 화면에서도 사라집니다.')).toBeInTheDocument();
    await within(dialog).findByText('4');
    fireEvent.click(within(dialog).getByRole('button', { name: '팀 삭제' }));

    await waitFor(() => expect(desktopApi.teams.remove).toHaveBeenCalledWith('team-1'));
  });

  it('lists live links only, and revokes one', async () => {
    vi.mocked(desktopApi.teams.listInvites).mockResolvedValue([
      invite(),
      invite({ code: 'code-old', active: false, revokedAt: new Date().toISOString() }),
    ]);
    setTeams([teamEntry()]);
    renderPanel();

    const strip = rowOf(await screen.findByText('minji 의 링크'));
    expect(screen.getAllByRole('button', { name: '링크 취소' })).toHaveLength(1);
    expect(strip).toHaveTextContent('1명 참여');
    expect(strip).toHaveTextContent('6일 후 만료');
    fireEvent.click(within(strip).getByRole('button', { name: '링크 취소' }));

    await waitFor(() => expect(desktopApi.teams.revokeInvite).toHaveBeenCalledWith('team-1', 'code-1'));
    // 취소한 뒤 목록을 다시 읽는다.
    await waitFor(() => expect(desktopApi.teams.listInvites).toHaveBeenCalledTimes(2));
  });

  it('copies a live link again from its row, and says when the copy fails', async () => {
    vi.mocked(desktopApi.teams.listInvites).mockResolvedValue([
      invite({ link: LINK }),
      // 이 기능 전에 만든 링크 — 비밀값이 서버에 없어 다시 복사할 수 없다.
      invite({ code: 'code-2', createdBy: 'jun', createdByEmail: 'jun@acme.dev', link: null }),
    ]);
    setTeams([teamEntry()]);
    renderPanel();

    const minjiLink = rowOf(await screen.findByText('minji 의 링크'));
    expect(within(rowOf(screen.getByText('jun 의 링크'))).queryByRole('button', { name: '링크 복사' })).toBeNull();
    expect(within(rowOf(screen.getByText('jun 의 링크'))).getByRole('button', { name: '링크 취소' })).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error('not focused'));
    fireEvent.click(within(minjiLink).getByRole('button', { name: '링크 복사' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('링크를 복사하지 못했습니다.');

    fireEvent.click(within(minjiLink).getByRole('button', { name: '링크 복사' }));
    expect(await within(minjiLink).findByRole('button', { name: '복사됨' })).toBeInTheDocument();
    expect(writeText).toHaveBeenLastCalledWith(LINK);
    expect(screen.queryByRole('alert')).toBeNull();
    // 잠깐 뒤 원래 단추로 돌아온다.
    await waitFor(() => expect(within(minjiLink).getByRole('button', { name: '링크 복사' })).toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it('clears a failed action line when switching to another team', async () => {
    vi.mocked(desktopApi.teams.listInvites).mockResolvedValue([invite()]);
    vi.mocked(desktopApi.teams.revokeInvite).mockRejectedValue(new Error('링크를 취소하지 못했습니다.'));
    setTeams([teamEntry(), teamEntry({ id: 'team-2', name: 'Ops Night', role: 'member' })]);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '링크 취소' }));
    expect(await screen.findByText('링크를 취소하지 못했습니다.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ops Night/ }));
    await waitFor(() => expect(screen.queryByText('링크를 취소하지 못했습니다.')).toBeNull());
  });

  // 소유자는 링크를 채팅에 보내고 돌아와 누가 들어왔는지 본다 — 탭을 다시 열지 않아도 보여야 한다.
  it('reads members and links again when the window comes back to the front', async () => {
    setTeams([teamEntry()]);
    renderPanel();
    await screen.findByText('minji@acme.dev');
    expect(desktopApi.teams.listMembers).toHaveBeenCalledTimes(1);

    vi.mocked(desktopApi.teams.listMembers).mockResolvedValue([
      ...DOLMA_OWNS,
      member('newbie', 'member', 'minji', 0),
    ]);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByText('newbie@acme.dev')).toBeInTheDocument();
    expect(desktopApi.teams.listInvites).toHaveBeenCalledTimes(2);
  });

  it('says when this device must rejoin the team', async () => {
    setTeams([teamEntry({ syncState: 'needs-rejoin' })]);
    renderPanel();
    expect(await screen.findByText(/초대 링크로 다시 들어와 주세요/)).toBeInTheDocument();
  });

  it('offers a new team or a link when there are no teams yet', async () => {
    vi.mocked(desktopApi.teams.create).mockImplementation(async (name) => ({
      id: 'team-new',
      name,
      role: 'owner',
      syncState: 'idle',
      syncError: null,
    }));
    setTeams([]);
    renderPanel();

    // 빈 상태는 무엇부터 할지 순서를 보인다. 단추는 팀이 있을 때와 같은 자리(머리 오른쪽)에 있다.
    expect(screen.getByText('아직 팀이 없습니다.')).toBeInTheDocument();
    expect(screen.getByText('‘새 팀’으로 팀을 만듭니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acme Infra/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /링크로 참여/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite link' }), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    // 붙여 넣은 링크는 링크 페이지에서 열었을 때와 같은 참여 카드로 간다.
    expect(appStore.getState().pendingInviteLink).toBe(LINK);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /새 팀/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Team name' }), { target: { value: '  Infra  ' } });
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(desktopApi.teams.create).toHaveBeenCalledWith('Infra'));
    expect(appStore.getState().teamsPanelTeamId).toBe('team-new');
  });
});
