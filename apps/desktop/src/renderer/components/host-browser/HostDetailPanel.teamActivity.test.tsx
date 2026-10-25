import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, SshHostRecord, TeamActivityItem } from '@shared';
import { HostDetailPanel } from './HostDetailPanel';
import { appStore } from '../../store/appStore';
import { createEmptyVaultIndex } from '../../store/utils';
import type { HostBrowserModel } from './useHostBrowser';
import { getTeamReplayStatuses, listTeamActivity } from '../../services/desktop/team-history';

// 팀 호스트의 Recent Activity 는 그 팀의 기록(서버)도 본다 — 다른 멤버가 붙은 것과 그 녹화. 이 기기 기록만 보면
// 다른 계정에서는 그 호스트에 아무 일도 없었던 것처럼 보였다(2026-10-24). 내 접속은 이 기기 기록과 같은 줄이라
// 하나만 남긴다.

vi.mock('../../services/desktop/tailnet', () => ({
  listTailnets: vi.fn(async () => []),
  listTeamTailnets: vi.fn(async () => []),
}));
vi.mock('../../services/desktop/team-history', () => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
}));

const TEAM = 'team-1';

function sshHost(id: string): SshHostRecord {
  return {
    id,
    kind: 'ssh',
    label: id,
    hostname: `${id}.example.com`,
    port: 22,
    username: 'ops',
    authType: 'password',
    groupName: null,
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as SshHostRecord;
}

function sessionRecord(id: string, hostId: string, createdAt: string, metadata: Record<string, unknown>): ActivityLogRecord {
  return {
    id,
    kind: 'session-lifecycle',
    level: 'info',
    category: 'session',
    message: 'SSH 세션',
    metadata: { hostId, connectionKind: 'ssh', status: 'closed', durationMs: 60_000, ...metadata },
    createdAt,
  } as unknown as ActivityLogRecord;
}

function teamItem(seq: number, author: { id: string; email: string }, record: ActivityLogRecord, phase: 'start' | 'end'): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: author.id,
    authorEmail: author.email,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    activity: { v: 1, phase, record },
    memberChange: null,
    unreadable: null,
  };
}

const ME = { id: 'u-me', email: 'me@acme.dev' };
const ALICE = { id: 'u-alice', email: 'alice@acme.dev' };

function renderHost(hostId: string, activityLogs: ActivityLogRecord[]) {
  appStore.setState({
    vaultIndex: {
      ...createEmptyVaultIndex(),
      teams: [{ id: TEAM, name: 'Acme', role: 'member', syncState: 'ready', syncError: null, groups: [] }],
      teamIdByHostId: { 'h-team': TEAM },
    },
  });
  const onOpenReplay = vi.fn();
  const hb = {
    hosts: [sshHost('h-team'), sshHost('h-mine')],
    activityLogs,
    selectedHostId: hostId,
    favoriteHostIdSet: new Set<string>(),
    keychainEntries: [],
    detailTab: 'overview',
    onOpenReplay,
    onCreateHost: vi.fn(),
    onSelectSection: vi.fn(),
  } as unknown as HostBrowserModel;
  render(<HostDetailPanel hb={hb} />);
  return { onOpenReplay };
}

afterEach(() => {
  appStore.setState(appStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe('HostDetailPanel — 팀 호스트의 Recent Activity', () => {
  it("shows another member's session with who it was and opens its team recording, and keeps mine once", async () => {
    const mine = sessionRecord('rec-mine', 'h-team', '2026-10-24T08:00:00.000Z', { recordingId: 'r-mine', hasReplay: true });
    const theirs = sessionRecord('rec-theirs', 'h-team', '2026-10-24T09:00:00.000Z', { recordingId: 'r-theirs', hasReplay: true });
    vi.mocked(listTeamActivity).mockResolvedValue([
      teamItem(4, ALICE, theirs, 'end'),
      teamItem(3, ALICE, { ...theirs, metadata: { ...theirs.metadata, status: 'connected' } }, 'start'),
      teamItem(2, ME, mine, 'end'),
      // 다른 호스트의 줄은 넣지 않는다.
      teamItem(1, ALICE, sessionRecord('rec-other', 'h-elsewhere', '2026-10-24T07:00:00.000Z', {}), 'end'),
    ]);
    vi.mocked(getTeamReplayStatuses).mockResolvedValue([
      { recordingId: 'r-theirs', state: 'ended', authorEmail: ALICE.email, segmentCount: 3 },
      { recordingId: 'r-mine', state: 'ended', authorEmail: ME.email, segmentCount: 2 },
    ]);
    const { onOpenReplay } = renderHost('h-team', [mine]);

    expect(await screen.findByText(ALICE.email)).toBeInTheDocument();
    expect(listTeamActivity).toHaveBeenCalledWith(TEAM, expect.anything());
    const replays = await screen.findAllByRole('button', { name: '세션 Replay 보기' });
    // 앨리스의 접속 하나(시작·끝은 한 줄) + 내 접속 하나(이 기기 기록과 같은 줄은 하나).
    expect(replays).toHaveLength(2);

    // 최신 순 — 앨리스(09:00)가 먼저, 내 것(08:00)이 다음이다.
    fireEvent.click(replays[0]!);
    expect(onOpenReplay).toHaveBeenLastCalledWith('r-theirs', TEAM);
    // 내 줄은 이 기기의 녹화를 연다.
    fireEvent.click(replays[1]!);
    expect(onOpenReplay).toHaveBeenLastCalledWith('r-mine');
  });

  it('keeps a team session without Replay until its recording is on the server', async () => {
    const theirs = sessionRecord('rec-theirs', 'h-team', '2026-10-24T09:00:00.000Z', { recordingId: 'r-theirs', hasReplay: true });
    vi.mocked(listTeamActivity).mockResolvedValue([teamItem(4, ALICE, theirs, 'end')]);
    vi.mocked(getTeamReplayStatuses).mockResolvedValue([]);
    renderHost('h-team', []);

    expect(await screen.findByText(ALICE.email)).toBeInTheDocument();
    await waitFor(() => expect(getTeamReplayStatuses).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '세션 Replay 보기' })).toBeNull();
  });

  it('reads nothing from the team for a personal host', async () => {
    renderHost('h-mine', [sessionRecord('rec-local', 'h-mine', '2026-10-24T08:00:00.000Z', {})]);

    await screen.findByText('Recent Activity');
    expect(listTeamActivity).not.toHaveBeenCalled();
  });
});

// 호스트를 고르지 않았을 때의 "최근 로그" — 범위(전체·볼트·그룹) 안 팀 호스트의 팀 기록도 함께. 이 기기 기록만 보면 다른
// 멤버가 붙은 것이 여기서도 보이지 않았다(2026-10-24, 호스트 상세만 고쳤을 때).
describe('HostDetailPanel — 최근 로그의 팀 기록', () => {
  const teamVault = { id: TEAM, kind: 'team', name: 'Acme', role: 'member', blocked: null, groups: [], hosts: [], workspaces: [] };
  const personalVault = { id: 'personal', kind: 'personal', name: 'Personal', role: null, blocked: null, groups: [], hosts: [], workspaces: [] };

  function renderRecent(location: { currentVault?: unknown }, activityLogs: ActivityLogRecord[]) {
    appStore.setState({
      vaultIndex: {
        ...createEmptyVaultIndex(),
        teams: [{ id: TEAM, name: 'Acme', role: 'member', syncState: 'ready', syncError: null, groups: [] }],
        teamIdByHostId: { 'h-team': TEAM },
      },
    });
    const onOpenReplay = vi.fn();
    const hb = {
      hosts: [sshHost('h-team'), sshHost('h-mine')],
      activityLogs,
      selectedHostId: null,
      favoriteHostIdSet: new Set<string>(),
      keychainEntries: [],
      detailTab: 'overview',
      vaultTrees: [
        { vaultId: 'personal', vault: personalVault },
        { vaultId: TEAM, vault: teamVault },
      ],
      currentVault: null,
      showsTeamMarks: true,
      teamOfAsset: (key: string) => (key === 'host:h-team' ? { id: TEAM, name: 'Acme' } : null),
      selectSingleHost: vi.fn(),
      onOpenReplay,
      onCreateHost: vi.fn(),
      onSelectSection: vi.fn(),
      ...location,
    } as unknown as HostBrowserModel;
    render(<HostDetailPanel hb={hb} />);
    return { onOpenReplay };
  }

  it("lists another member's session on a team host among the recent logs and opens its team recording", async () => {
    const mine = sessionRecord('rec-mine', 'h-mine', '2026-10-24T08:00:00.000Z', { recordingId: 'r-mine', hasReplay: true });
    const theirs = sessionRecord('rec-theirs', 'h-team', '2026-10-24T09:00:00.000Z', { recordingId: 'r-theirs', hasReplay: true, commandCount: 12 });
    vi.mocked(listTeamActivity).mockResolvedValue([
      teamItem(4, ALICE, theirs, 'end'),
      teamItem(3, ALICE, { ...theirs, metadata: { ...theirs.metadata, status: 'connected' } }, 'start'),
    ]);
    vi.mocked(getTeamReplayStatuses).mockResolvedValue([
      { recordingId: 'r-theirs', state: 'ended', authorEmail: ALICE.email, segmentCount: 3 },
    ]);
    const { onOpenReplay } = renderRecent({}, [mine]);

    const recent = await screen.findByTestId('recent-logs');
    await waitFor(() => expect(recent).toHaveTextContent(ALICE.email));
    expect(listTeamActivity).toHaveBeenCalledWith(TEAM, expect.anything());
    expect(recent).toHaveTextContent('명령 12개');
    const replays = await within(recent).findAllByRole('button', { name: '세션 Replay 보기' });
    expect(replays).toHaveLength(2);
    // 최신 순 — 앨리스(09:00)가 먼저다.
    fireEvent.click(replays[0]!);
    expect(onOpenReplay).toHaveBeenLastCalledWith('r-theirs', TEAM);
    fireEvent.click(replays[1]!);
    expect(onOpenReplay).toHaveBeenLastCalledWith('r-mine');
  });

  it('reads no team in the personal vault', async () => {
    renderRecent({ currentVault: personalVault }, [sessionRecord('rec-local', 'h-mine', '2026-10-24T08:00:00.000Z', {})]);

    await screen.findByTestId('recent-logs');
    expect(listTeamActivity).not.toHaveBeenCalled();
  });
});
