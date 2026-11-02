import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamActivityItem, TeamActivityQuery } from '@shared';

const mocks = vi.hoisted(() => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
}));
vi.mock('../services/desktop/team-history', () => mocks);

import { reachedSince, useTeamActivity } from './useTeamActivity';

const HOUR = 3_600_000;
const ORIGIN = Date.UTC(2026, 9, 1);
/** 순번 seq 의 줄 — 순번 하나에 한 시간씩 뒤에 받았다. */
const timeOf = (seq: number) => new Date(ORIGIN + seq * HOUR).toISOString();

function item(seq: number): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: 'user-a',
    authorEmail: 'a@example.com',
    createdAt: timeOf(seq),
    receivedAt: timeOf(seq),
    activity: null,
    memberChange: null,
    unreadable: null,
  };
}

/** 순번 1..count 를 가진 서버 — 최신부터 주고, before·after·limit 을 서버처럼 따른다. */
function fakeServer(count: number) {
  const all = Array.from({ length: count }, (_value, index) => item(count - index));
  mocks.listTeamActivity.mockImplementation(async (_teamId: string, query: TeamActivityQuery = {}) => {
    if (query.after) {
      return [];
    }
    const from = query.before ? all.findIndex((entry) => entry.seq < query.before!) : 0;
    return from < 0 ? [] : all.slice(from, from + (query.limit ?? 100));
  });
}

const bulkCalls = () =>
  mocks.listTeamActivity.mock.calls.filter(([, query]) => (query as TeamActivityQuery | undefined)?.limit === 200).map(([, query]) => query);

describe('useTeamActivity — loadOlder', () => {
  beforeEach(() => {
    mocks.listTeamActivity.mockReset();
    mocks.getTeamReplayStatuses.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function opened(count: number) {
    fakeServer(count);
    const hook = renderHook(({ teamId }) => useTeamActivity(teamId), { initialProps: { teamId: 'team-1' as string | null } });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(Math.min(count, 100)));
    return hook;
  }

  it('loads older pages until one is older than the start of the period', async () => {
    const hook = await opened(1000);
    const progress: number[] = [];

    let items: TeamActivityItem[] | null = null;
    await act(async () => {
      items = await hook.result.current.loadOlder({ since: timeOf(700), onProgress: (count) => progress.push(count) });
    });

    // 1000..901 을 받아 두었고, 900..701 은 아직 그 시작 뒤라 한 쪽 더(700..501) 받고 멈춘다.
    expect(bulkCalls()).toEqual([
      { before: 901, limit: 200 },
      { before: 701, limit: 200 },
    ]);
    expect(progress).toEqual([300, 500]);
    expect(items!).toHaveLength(500);
    expect(hook.result.current.items).toHaveLength(500);
    expect(hook.result.current.hasMore).toBe(true);
    expect(hook.result.current.loadingOlder).toBe(false);
    hook.unmount();
  });

  it('loads to the end without a period', async () => {
    const hook = await opened(300);

    let items: TeamActivityItem[] | null = null;
    await act(async () => {
      items = await hook.result.current.loadOlder({ since: null });
    });

    // 200 줄이 꽉 차게 오면 더 있을 수 있어 한 번 더 묻고, 빈 쪽에서 멈춘다.
    expect(bulkCalls()).toEqual([
      { before: 201, limit: 200 },
      { before: 1, limit: 200 },
    ]);
    expect(items!.map((entry) => entry.seq)).toEqual(Array.from({ length: 300 }, (_value, index) => 300 - index));
    expect(hook.result.current.hasMore).toBe(false);
    hook.unmount();
  });

  it('stops before the next page when asked, and gives nothing', async () => {
    const hook = await opened(1000);
    const signal = { stopped: false };

    let items: TeamActivityItem[] | null = [];
    await act(async () => {
      items = await hook.result.current.loadOlder({
        since: null,
        signal,
        onProgress: () => {
          signal.stopped = true;
        },
      });
    });

    expect(items).toBeNull();
    expect(bulkCalls()).toHaveLength(1);
    expect(hook.result.current.loadingOlder).toBe(false);
    hook.unmount();
  });

  it('gives nothing when the team changes while it loads', async () => {
    const hook = await opened(1000);
    let release: () => void = () => undefined;
    const original = mocks.listTeamActivity.getMockImplementation()!;
    mocks.listTeamActivity.mockImplementationOnce(
      (teamId: string, query?: TeamActivityQuery) =>
        new Promise((resolve) => {
          release = () => resolve(original(teamId, query));
        }),
    );

    let pending: Promise<TeamActivityItem[] | null> = Promise.resolve(null);
    act(() => {
      pending = hook.result.current.loadOlder({ since: null });
    });
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    hook.rerender({ teamId: 'team-2' });
    release();

    await expect(pending).resolves.toBeNull();
    expect(bulkCalls()).toHaveLength(1);
    hook.unmount();
  });

  it('keeps new rows that arrive every 30 seconds while it loads older ones', async () => {
    // 30초마다 새 줄을 받는 타이머만 붙잡는다(시험 도구의 타이머는 그대로).
    const intervals: Array<() => void> = [];
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 30_000) {
        intervals.push(callback);
        return 9999;
      }
      return realSetInterval(callback, delay);
    }) as never);
    const hook = await opened(300);
    const original = mocks.listTeamActivity.getMockImplementation()!;
    let releasePoll: () => void = () => undefined;
    let releaseBulk: () => void = () => undefined;
    mocks.listTeamActivity.mockImplementation((teamId: string, query: TeamActivityQuery = {}) => {
      if (query.after) {
        return new Promise((resolve) => {
          releasePoll = () => resolve([item(301)]);
        });
      }
      if (query.limit === 200 && query.before === 201) {
        return new Promise((resolve) => {
          releaseBulk = () => resolve(original(teamId, query));
        });
      }
      return original(teamId, query);
    });

    let pending: Promise<TeamActivityItem[] | null> = Promise.resolve(null);
    act(() => {
      pending = hook.result.current.loadOlder({ since: null });
    });
    await waitFor(() => expect(bulkCalls()).toHaveLength(1));
    act(() => {
      intervals[0]!();
    });
    await waitFor(() => expect(mocks.listTeamActivity).toHaveBeenCalledWith('team-1', { after: 300, limit: 100 }));
    // 새 줄과 지난 쪽이 한 번에 도착한다 — 새 줄이 먼저 붙고, 화면이 다시 그려지기 전에 지난 쪽이 붙는다.
    await act(async () => {
      releasePoll();
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
      releaseBulk();
      await pending;
    });

    expect(hook.result.current.items[0]?.seq).toBe(301);
    expect(hook.result.current.items).toHaveLength(301);
    hook.unmount();
  });

  it('lets a second load wait for the first instead of giving up', async () => {
    const hook = await opened(600);

    let first: Promise<TeamActivityItem[] | null> = Promise.resolve(null);
    let second: Promise<TeamActivityItem[] | null> = Promise.resolve(null);
    await act(async () => {
      first = hook.result.current.loadOlder({ since: timeOf(450) });
      second = hook.result.current.loadOlder({ since: null });
      await Promise.all([first, second]);
    });

    expect((await first)?.length).toBe(300);
    expect((await second)?.length).toBe(600);
    // 같은 쪽을 두 번 받지 않는다.
    expect(bulkCalls()).toEqual([
      { before: 501, limit: 200 },
      { before: 301, limit: 200 },
      { before: 101, limit: 200 },
    ]);
    hook.unmount();
  });
});

describe('reachedSince', () => {
  it('waits for a row received more than ten minutes before the start (clocks can differ)', () => {
    const since = '2026-11-02T12:00:00.000Z';
    const at = (iso: string) => ({ ...item(1), receivedAt: iso });
    expect(reachedSince(at('2026-11-02T11:55:00.000Z'), since)).toBe(false);
    expect(reachedSince(at('2026-11-02T11:49:00.000Z'), since)).toBe(true);
    expect(reachedSince(at('2026-11-02T11:00:00.000Z'), null)).toBe(false);
    expect(reachedSince(undefined, since)).toBe(false);
  });
});
