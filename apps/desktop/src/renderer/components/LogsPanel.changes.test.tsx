import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamChangeItem, TeamChangeSet, TeamRestoreOutcome, TeamRole } from '@shared';

const mocks = vi.hoisted(() => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
  listTeamChanges: vi.fn(),
  restoreTeamChange: vi.fn(),
}));
vi.mock('../services/desktop/team-history', () => mocks);

import { LogsPanel } from './LogsPanel';

// 기록 화면의 Changes(바뀐 것·복원) — 관리자 이상의 팀 볼트에서만 탭이 생긴다.

function item(kind: TeamChangeItem['kind'], label: string, deleted = true, currentLabel: string | null = null): TeamChangeItem {
  return { kind, recordId: `${kind}-${label}`, label, deleted, currentLabel };
}

function change(lastSeq: number, items: TeamChangeItem[], overrides: Partial<TeamChangeSet> = {}): TeamChangeSet {
  return {
    firstSeq: lastSeq - items.length + 1,
    lastSeq,
    changedBy: 'user-sora',
    changedByEmail: 'sora@example.com',
    changedAt: '2026-10-26T08:24:20.000Z',
    items,
    changedLater: false,
    restored: false,
    ...overrides,
  };
}

const DELETED = change(10, [item('hosts', 'web-1'), item('hosts', 'web-2')]);
const RENAMED = change(8, [item('hosts', 'bastion', false, 'bastion-old')], {
  changedByEmail: 'hyunwoo@example.com',
  changedLater: true,
});
const BACK = change(5, [item('snippets', 'deploy', false)], { restored: true });

function renderPanel(role: TeamRole = 'admin') {
  render(
    <LogsPanel
      logs={[]}
      onClear={vi.fn().mockResolvedValue(undefined)}
      onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      teams={[{ id: 'team-1', name: 'Platform', role }]}
    />,
  );
  fireEvent.change(screen.getByDisplayValue('Personal'), { target: { value: 'team-1' } });
}

async function openChanges() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
  return screen.findAllByTestId('team-change-card');
}

function restored(overrides: Partial<Extract<TeamRestoreOutcome, { status: 'restored' }>> = {}): TeamRestoreOutcome {
  return {
    status: 'restored',
    restored: [
      { kind: 'hosts', recordId: 'hosts-web-1', label: 'web-1' },
      { kind: 'hosts', recordId: 'hosts-web-2', label: 'web-2' },
    ],
    dependencies: [],
    skipped: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.listTeamActivity.mockResolvedValue([]);
  mocks.getTeamReplayStatuses.mockResolvedValue([]);
  mocks.listTeamChanges.mockResolvedValue({ sets: [DELETED, RENAMED, BACK], nextBefore: null });
  mocks.restoreTeamChange.mockResolvedValue(restored());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LogsPanel changes', () => {
  it('shows the Changes tab only to admins of a team vault', async () => {
    render(
      <LogsPanel
        logs={[]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
        teams={[
          { id: 'team-1', name: 'Platform', role: 'member' },
          { id: 'team-2', name: 'Data', role: 'owner' },
        ]}
      />,
    );
    expect(screen.queryByRole('tablist', { name: '기록 보기' })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Personal'), { target: { value: 'team-1' } });
    await waitFor(() => expect(mocks.listTeamActivity).toHaveBeenCalled());
    expect(screen.queryByRole('tab', { name: 'Changes' })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Platform'), { target: { value: 'team-2' } });
    expect(await screen.findByRole('tab', { name: 'Changes' })).toBeInTheDocument();
    expect(mocks.listTeamChanges).not.toHaveBeenCalled();
  });

  it('lists each push as a log card with what it did, without category and level', async () => {
    renderPanel();
    const cards = await openChanges();
    expect(mocks.listTeamChanges).toHaveBeenCalledWith('team-1', undefined);
    expect(screen.queryByText('Category')).toBeNull();
    expect(screen.queryByText('Level')).toBeNull();
    expect(screen.getByPlaceholderText('Name, member')).toBeInTheDocument();

    expect(cards).toHaveLength(3);
    const [deleted, renamed, back] = cards;
    expect(within(deleted).getByText('호스트 2개를 삭제했습니다.')).toBeInTheDocument();
    expect(within(deleted).getByText('삭제')).toBeInTheDocument();
    expect(within(deleted).getByText('sora@example.com')).toBeInTheDocument();
    expect(within(deleted).getByText('web-1')).toBeInTheDocument();
    expect(within(deleted).getByRole('button', { name: '복원' })).toBeEnabled();

    expect(within(renamed).getByText('bastion 호스트를 수정했습니다.')).toBeInTheDocument();
    expect(within(renamed).getByText('(지금 bastion-old)')).toBeInTheDocument();
    expect(within(renamed).getByText('이후 다시 수정됨')).toBeInTheDocument();

    // 이미 지금과 같은 묶음은 단추 대신 "복원됨".
    expect(within(back).getByText('복원됨')).toBeInTheDocument();
    expect(within(back).queryByRole('button', { name: '복원' })).toBeNull();
  });

  it('restores without asking, says what came back with it and reloads the list', async () => {
    mocks.restoreTeamChange.mockResolvedValue(
      restored({ dependencies: [{ kind: 'secrets', recordId: 'secret:db', label: 'legacy-db' }] }),
    );
    renderPanel();
    const [deleted] = await openChanges();
    fireEvent.click(within(deleted).getByRole('button', { name: '복원' }));

    expect(await screen.findByText('2개를 복원했습니다 — web-1, web-2')).toBeInTheDocument();
    expect(screen.getByText('함께 돌아온 것: legacy-db 비밀번호')).toBeInTheDocument();
    expect(mocks.restoreTeamChange).toHaveBeenCalledTimes(1);
    expect(mocks.restoreTeamChange).toHaveBeenCalledWith('team-1', {
      firstSeq: 9,
      lastSeq: 10,
      changedBy: 'user-sora',
      changedAt: '2026-10-26T08:24:20.000Z',
    });
    await waitFor(() => expect(mocks.listTeamChanges).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks only when the restore would overwrite a later change, and overwrites on confirm', async () => {
    mocks.restoreTeamChange.mockResolvedValueOnce({
      status: 'needs-confirm',
      overwrites: [
        { kind: 'hosts', recordId: 'hosts-bastion', label: 'bastion', byEmail: 'jiwoo@example.com', at: '2026-10-26T09:00:00.000Z' },
        { kind: 'hosts', recordId: 'hosts-web', label: 'web', byEmail: null, at: null },
      ],
    });
    renderPanel();
    const [, renamed] = await openChanges();
    fireEvent.click(within(renamed).getByRole('button', { name: '복원' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('bastion 호스트 복원')).toBeInTheDocument();
    expect(within(dialog).getByText('복원하면 그 뒤에 바뀐 것을 덮습니다.')).toBeInTheDocument();
    expect(within(dialog).getByText(/bastion — jiwoo@example\.com 님이 .+에 다시 바꿨습니다/)).toBeInTheDocument();
    expect(within(dialog).getByText('web — 그 뒤에 다시 만들어졌습니다')).toBeInTheDocument();
    expect(screen.queryByText(/를 복원했습니다/)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: '덮고 복원' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.restoreTeamChange).toHaveBeenLastCalledWith(
      'team-1',
      expect.objectContaining({ lastSeq: 8 }),
      { overwrite: true },
    );
    expect(await screen.findByText('2개를 복원했습니다 — web-1, web-2')).toBeInTheDocument();
  });

  it('leaves everything as it was when the overwrite question is cancelled', async () => {
    mocks.restoreTeamChange.mockResolvedValueOnce({
      status: 'needs-confirm',
      overwrites: [{ kind: 'hosts', recordId: 'hosts-bastion', label: 'bastion', byEmail: 'jiwoo@example.com', at: '2026-10-26T09:00:00.000Z' }],
    });
    renderPanel();
    const [, renamed] = await openChanges();
    fireEvent.click(within(renamed).getByRole('button', { name: '복원' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.restoreTeamChange).toHaveBeenCalledTimes(1);
    expect(mocks.listTeamChanges).toHaveBeenCalledTimes(1);
  });

  it('says what was skipped and why, and shows a failure in place', async () => {
    mocks.restoreTeamChange.mockResolvedValueOnce(
      restored({
        restored: [{ kind: 'groups', recordId: 'g', label: 'Staging' }],
        skipped: [
          { kind: 'hosts', recordId: 'stg-api', label: 'stg-api', reason: 'other-vault' },
          { kind: 'hosts', recordId: 'odd', label: null, reason: 'unreadable' },
        ],
      }),
    );
    renderPanel();
    const [deleted] = await openChanges();
    fireEvent.click(within(deleted).getByRole('button', { name: '복원' }));
    expect(await screen.findByText('1개를 복원했습니다 — Staging')).toBeInTheDocument();
    expect(screen.getByText('건너뛴 것: stg-api — 다른 볼트에 같은 것이 있습니다.')).toBeInTheDocument();
    expect(screen.getByText('건너뛴 것: (열 수 없음) — 이 앱이 열 수 없습니다.')).toBeInTheDocument();

    mocks.restoreTeamChange.mockRejectedValueOnce(new Error('팀 관리자만 할 수 있습니다.'));
    fireEvent.click(within(screen.getAllByTestId('team-change-card')[0]).getByRole('button', { name: '복원' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('팀 관리자만 할 수 있습니다.');
  });

  it('finds pushes by names and member, and says when there is nothing to restore', async () => {
    renderPanel();
    await openChanges();
    fireEvent.change(screen.getByPlaceholderText('Name, member'), { target: { value: 'hyunwoo' } });
    expect(screen.getAllByTestId('team-change-card')).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('Name, member'), { target: { value: 'bastion-old' } });
    expect(screen.getAllByTestId('team-change-card')).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('Name, member'), { target: { value: 'web-2' } });
    expect(within(screen.getByTestId('team-change-card')).getByText('호스트 2개를 삭제했습니다.')).toBeInTheDocument();
  });

  it('says there is nothing to restore when the team vault has no changes', async () => {
    mocks.listTeamChanges.mockResolvedValue({ sets: [], nextBefore: null });
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    expect(await screen.findByText('복원할 것이 없습니다')).toBeInTheDocument();
  });
});
