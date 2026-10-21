import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, SessionLifecycleLogMetadata, TeamActivityItem, TeamReplayStatus } from '@shared';

const mocks = vi.hoisted(() => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
}));
vi.mock('../services/desktop/team-history', () => mocks);

import { LogsPanel } from './LogsPanel';

const TEAMS = [{ id: 'team-1', name: 'Platform' }];

function sessionLog(sessionId: string, overrides: Partial<SessionLifecycleLogMetadata> = {}): ActivityLogRecord {
  const metadata: SessionLifecycleLogMetadata = {
    sessionId,
    hostId: 'team-host',
    hostLabel: `web-${sessionId}`,
    title: 'Web',
    connectionKind: 'ssh',
    connectedAt: '2026-10-21T01:00:00.000Z',
    status: 'connected',
    recordingId: `rec-${sessionId}`,
    hasReplay: true,
    ...overrides,
  };
  return {
    id: `session:${sessionId}`,
    level: 'info',
    category: 'session',
    kind: 'session-lifecycle',
    message: '세션',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.connectedAt,
  };
}

function activityItem(seq: number, record: ActivityLogRecord, phase?: 'start' | 'end', author = 'b@example.com'): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: 'user-b',
    authorEmail: author,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    activity: { v: 1, ...(phase ? { phase } : {}), record },
    memberChange: null,
    unreadable: null,
  };
}

function serverItem(seq: number, createdAt: string, overrides: Partial<TeamActivityItem>): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'server',
    authorUserId: 'user-a',
    authorEmail: 'a@example.com',
    createdAt,
    receivedAt: createdAt,
    activity: null,
    memberChange: null,
    unreadable: null,
    ...overrides,
  };
}

function status(recordingId: string, state: TeamReplayStatus['state'], segmentCount = 3): TeamReplayStatus {
  return { recordingId, state, authorEmail: 'b@example.com', segmentCount };
}

function renderPanel(onOpenReplay = vi.fn().mockResolvedValue(undefined)) {
  render(
    <LogsPanel
      logs={[sessionLog('mine', { hostLabel: 'my-laptop', status: 'closed' })]}
      onClear={vi.fn().mockResolvedValue(undefined)}
      onOpenReplay={onOpenReplay}
      teams={TEAMS}
    />,
  );
  return onOpenReplay;
}

function chooseTeam() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Vault' }), { target: { value: 'team-1' } });
}

describe('LogsPanel — team history', () => {
  beforeEach(() => {
    mocks.listTeamActivity.mockReset().mockResolvedValue([]);
    mocks.getTeamReplayStatuses.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps this device’s logs under Personal and offers Vault only when there are teams', () => {
    const { unmount } = render(
      <LogsPanel logs={[sessionLog('mine', { hostLabel: 'my-laptop' })]} onClear={vi.fn()} onOpenReplay={vi.fn()} />,
    );
    expect(screen.queryByRole('combobox', { name: 'Vault' })).not.toBeInTheDocument();
    unmount();

    renderPanel();
    const vault = screen.getByRole('combobox', { name: 'Vault' });
    expect(within(vault).getAllByRole('option').map((option) => option.textContent)).toEqual(['Personal', 'Platform']);
    expect(screen.getByText('my-laptop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear logs' })).toBeInTheDocument();
    expect(mocks.listTeamActivity).not.toHaveBeenCalled();
  });

  it('shows the team’s history newest first with who did it, one row per session', async () => {
    const started = sessionLog('s1');
    const ended = sessionLog('s1', { status: 'closed', disconnectedAt: '2026-10-21T01:10:00.000Z', durationMs: 600_000 });
    mocks.listTeamActivity.mockResolvedValue([
      activityItem(3, ended, 'end'),
      serverItem(2, '2026-10-21T00:30:00.000Z', {
        memberChange: { type: 'member_joined', userId: 'user-c', email: 'c@example.com' },
      }),
      activityItem(1, started, 'start'),
    ]);
    renderPanel();
    chooseTeam();

    expect(await screen.findByText('web-s1')).toBeInTheDocument();
    expect(mocks.listTeamActivity).toHaveBeenCalledWith('team-1', { limit: 100 });
    const cards = screen.getAllByTestId('logs-lifecycle-card');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText('Closed')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('b@example.com')).toBeInTheDocument();
    expect(screen.getByText('c@example.com 님이 팀에 들어왔습니다')).toBeInTheDocument();
    expect(screen.queryByText('my-laptop')).not.toBeInTheDocument();
    // 팀 기록은 서버의 것이라 지우지 않는다.
    expect(screen.queryByRole('button', { name: 'Clear logs' })).not.toBeInTheDocument();
    // 세션(01:00)이 멤버 참여(00:30)보다 위다.
    const text = document.body.textContent ?? '';
    expect(text.indexOf('web-s1')).toBeLessThan(text.indexOf('c@example.com 님이'));
  });

  it('opens a team recording that has arrived, even while the session is on, and says why when it cannot', async () => {
    mocks.listTeamActivity.mockResolvedValue([
      activityItem(3, sessionLog('live'), 'start'),
      activityItem(2, sessionLog('gone', { status: 'closed', connectedAt: '2026-10-21T00:50:00.000Z' }), 'end'),
      activityItem(1, sessionLog('later', { status: 'closed', connectedAt: '2026-10-21T00:40:00.000Z' }), 'end'),
    ]);
    mocks.getTeamReplayStatuses.mockResolvedValue([status('rec-live', 'live'), status('rec-gone', 'deleted', 0)]);
    const onOpenReplay = renderPanel();
    chooseTeam();

    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Replay/ })).toHaveLength(3));
    expect(mocks.getTeamReplayStatuses).toHaveBeenCalledWith('team-1', ['rec-live', 'rec-gone', 'rec-later']);
    const enabled = screen.getByRole('button', { name: 'Replay' });
    fireEvent.click(enabled);
    expect(onOpenReplay).toHaveBeenCalledWith('rec-live', 'team-1');

    const deleted = screen.getByRole('button', { name: 'Replay — 팀 녹화 한도로 지워졌습니다' });
    expect(deleted).toBeDisabled();
    fireEvent.mouseEnter(deleted.parentElement!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('팀 녹화 한도로 지워졌습니다');
    fireEvent.mouseLeave(deleted.parentElement!);
    const pending = screen.getByRole('button', { name: /^Replay — 아직 올라오는 중입니다/ });
    expect(pending).toBeDisabled();
  });

  it('takes new rows every 30 seconds and older ones once scrolled to the end', async () => {
    const intervals: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: () => void) => {
      intervals.push(callback);
      return intervals.length;
    }) as never);
    let observed: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observed = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const firstPage = Array.from({ length: 100 }, (_value, index) =>
      activityItem(200 - index, sessionLog(`p${200 - index}`, { status: 'closed', connectedAt: new Date(Date.UTC(2026, 9, 21, 0, 0, 200 - index)).toISOString() }), 'end'),
    );
    mocks.listTeamActivity.mockResolvedValueOnce(firstPage);
    renderPanel();
    chooseTeam();
    expect(await screen.findByText('web-p200')).toBeInTheDocument();

    mocks.listTeamActivity.mockResolvedValueOnce([
      activityItem(201, sessionLog('fresh', { status: 'closed', connectedAt: '2026-10-21T02:00:00.000Z' }), 'end'),
    ]);
    await act(async () => {
      intervals[0]!();
    });
    expect(await screen.findByText('web-fresh')).toBeInTheDocument();
    expect(mocks.listTeamActivity).toHaveBeenLastCalledWith('team-1', { after: 200, limit: 100 });

    mocks.listTeamActivity.mockResolvedValueOnce([
      activityItem(50, sessionLog('old', { status: 'closed', connectedAt: '2026-10-20T00:00:00.000Z' }), 'end'),
    ]);
    await act(async () => {
      observed?.([{ isIntersecting: true }]);
    });
    expect(await screen.findByText('web-old')).toBeInTheDocument();
    expect(mocks.listTeamActivity).toHaveBeenLastCalledWith('team-1', { before: 101, limit: 100 });
  });

  it('asks for an update on rows written by a newer app', async () => {
    mocks.listTeamActivity.mockResolvedValue([serverItem(1, '2026-10-21T00:30:00.000Z', { source: 'app', unreadable: 'unsupported-version' })]);
    renderPanel();
    chooseTeam();
    expect(await screen.findByText('앱을 업데이트하면 볼 수 있습니다.')).toBeInTheDocument();
  });
});
