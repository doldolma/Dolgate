import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, TeamActivityItem } from '@shared';
import { useTeamsRecentActivity } from './useTeamsRecentActivity';
import { TEAM_ACTIVITY_POLL_MS } from './useTeamActivity';
import { getTeamReplayStatuses, listTeamActivity } from '../services/desktop/team-history';

vi.mock('../services/desktop/team-history', () => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
}));

function sessionItem(seq: number, recordingId: string): TeamActivityItem {
  const record = {
    id: `rec-${seq}`,
    kind: 'session-lifecycle',
    level: 'info',
    category: 'session',
    message: 'SSH 세션',
    metadata: { hostId: 'h-team', status: 'closed', recordingId, hasReplay: true },
    createdAt: '2026-10-24T09:00:00.000Z',
  } as unknown as ActivityLogRecord;
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: 'u-alice',
    authorEmail: 'alice@acme.dev',
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    activity: { v: 1, phase: 'end', record },
    memberChange: null,
    unreadable: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useTeamsRecentActivity', () => {
  it('reads each team with the recordings it shows, and asks nothing without teams', async () => {
    vi.mocked(listTeamActivity).mockResolvedValue([sessionItem(1, 'r-1')]);
    vi.mocked(getTeamReplayStatuses).mockResolvedValue([
      { recordingId: 'r-1', state: 'ended', authorEmail: 'alice@acme.dev', segmentCount: 2 },
    ]);

    const { result, rerender } = renderHook(({ ids }) => useTeamsRecentActivity(ids), {
      initialProps: { ids: ['team-1'] as string[] },
    });

    await waitFor(() => expect(result.current.teams).toEqual([{ teamId: 'team-1', items: [sessionItem(1, 'r-1')] }]));
    expect(getTeamReplayStatuses).toHaveBeenCalledWith('team-1', ['r-1']);
    expect(result.current.replayStatuses.get('r-1')?.segmentCount).toBe(2);

    vi.mocked(listTeamActivity).mockClear();
    rerender({ ids: [] });
    expect(result.current.teams).toEqual([]);
    expect(listTeamActivity).not.toHaveBeenCalled();
  });

  // 잠깐 끊겼다고 목록이 비면, 보던 다른 멤버의 접속이 30초마다 사라졌다 나타난다.
  it('keeps what it has when a later read fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(listTeamActivity)
      .mockResolvedValueOnce([sessionItem(1, 'r-1')])
      .mockRejectedValueOnce(new Error('offline'));
    vi.mocked(getTeamReplayStatuses).mockResolvedValue([]);

    const { result } = renderHook(() => useTeamsRecentActivity(['team-1']));
    await waitFor(() => expect(result.current.teams[0]?.items).toHaveLength(1));

    await act(async () => {
      vi.advanceTimersByTime(TEAM_ACTIVITY_POLL_MS);
    });
    await waitFor(() => expect(listTeamActivity).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.teams[0]?.items).toHaveLength(1);
  });
});
