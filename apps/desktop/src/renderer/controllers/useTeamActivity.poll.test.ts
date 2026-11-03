import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamActivityItem, TeamActivityQuery } from '@shared';

const mocks = vi.hoisted(() => ({
  listTeamActivity: vi.fn(),
  getTeamReplayStatuses: vi.fn(),
}));
vi.mock('../services/desktop/team-history', () => mocks);

import { TEAM_ACTIVITY_POLL_MS, useTeamActivity } from './useTeamActivity';

const HOUR = 3_600_000;
const ORIGIN = Date.UTC(2026, 9, 1);
const timeOf = (seq: number) => new Date(ORIGIN + seq * HOUR).toISOString();

function item(seq: number, teamId: string): TeamActivityItem {
  return {
    seq,
    id: `${teamId}-event-${seq}`,
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

/** 다음 요청 하나에 쓸 것 — 던질 오류, 또는 풀어 줄 때까지 기다렸다 답하기(오류를 주면 그때 던진다). */
type Step = { error: Error } | { released: Promise<void>; error?: Error };

/**
 * 순번 1..count 를 가진 서버 — after 는 오래된 것부터, 아니면 최신부터 주고 before·limit 을 서버처럼 따른다. 메인(team-api)처럼
 * after 가 0 이면 빼고 보낸다(그러면 최신 쪽이 온다).
 */
const server = { count: 0, steps: [] as Step[] };

function serve(teamId: string, query: TeamActivityQuery): TeamActivityItem[] {
  const limit = query.limit ?? 100;
  const out: TeamActivityItem[] = [];
  if (query.after) {
    for (let seq = query.after + 1; seq <= server.count && out.length < limit; seq += 1) {
      out.push(item(seq, teamId));
    }
    return out;
  }
  for (let seq = (query.before ?? server.count + 1) - 1; seq >= 1 && out.length < limit; seq -= 1) {
    out.push(item(seq, teamId));
  }
  return out;
}

function hold(error?: Error): () => void {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.steps.push({ released, error });
  return () => release();
}

const queries = () => mocks.listTeamActivity.mock.calls.map(([, query]) => query as TeamActivityQuery);
const afterQueries = () => queries().filter((query) => query.after !== undefined);
const firstPageQueries = () => queries().filter((query) => query.after === undefined && query.before === undefined);

describe('useTeamActivity — new rows every 30 seconds', () => {
  // 30초마다 새 줄을 받는 타이머만 붙잡아 손으로 돌린다(시험 도구의 타이머는 그대로).
  const timers = { poll: null as (() => void) | null };

  beforeEach(() => {
    server.count = 0;
    server.steps = [];
    timers.poll = null;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === TEAM_ACTIVITY_POLL_MS) {
        timers.poll = callback;
        return 9999;
      }
      return realSetInterval(callback, delay);
    }) as never);
    mocks.listTeamActivity.mockReset().mockImplementation(async (teamId: string, query: TeamActivityQuery = {}) => {
      const step = server.steps.shift();
      if (step && 'released' in step) {
        await step.released;
      }
      if (step?.error) {
        throw step.error;
      }
      return serve(teamId, query);
    });
    mocks.getTeamReplayStatuses.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function turn() {
    await act(async () => {
      timers.poll!();
    });
  }

  function open(teamId = 'team-1') {
    return renderHook(({ team }) => useTeamActivity(team), { initialProps: { team: teamId } });
  }

  const seqs = (hook: ReturnType<typeof open>) => hook.result.current.items.map((entry) => entry.seq);

  it('asks only for rows after the newest one once the first page is in', async () => {
    server.count = 5000;
    const hook = open();
    await waitFor(() => expect(hook.result.current.items).toHaveLength(100));

    server.count = 5003;
    await turn();

    await waitFor(() => expect(hook.result.current.items).toHaveLength(103));
    expect(seqs(hook).slice(0, 4)).toEqual([5003, 5002, 5001, 5000]);
    expect(afterQueries()).toEqual([{ after: 5000, limit: 100 }]);
    hook.unmount();
  });

  it('loads the newest page again on the next turn when the first page failed', async () => {
    server.count = 5000;
    server.steps.push({ error: new Error('offline') });
    const hook = open();
    await waitFor(() => expect(hook.result.current.error).toBe('offline'));
    expect(hook.result.current.items).toEqual([]);

    await turn();

    // 새 줄 받기가 아니라 처음 쪽(최신 한 쪽)을 다시 받는다 — 그래야 '더 받기'가 켜진다.
    await waitFor(() => expect(hook.result.current.items).toHaveLength(100));
    expect(seqs(hook)[0]).toBe(5000);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.hasMore).toBe(true);
    expect(afterQueries()).toEqual([]);
    expect(firstPageQueries()).toEqual([{ limit: 100 }, { limit: 100 }]);

    // 이제 끝까지 내보낼 수 있고, 다음 차례부터는 새 줄만 묻는다.
    let exported: TeamActivityItem[] | null = null;
    await act(async () => {
      exported = await hook.result.current.loadOlder({ since: null });
    });
    expect(exported).toHaveLength(5000);
    await turn();
    await waitFor(() => expect(afterQueries()).toEqual([{ after: 5000, limit: 100 }]));
    hook.unmount();
  });

  it('keeps loading the newest page every turn while it fails, never rows after nothing', async () => {
    server.count = 5000;
    server.steps.push({ error: new Error('offline') }, { error: new Error('still offline') });
    const hook = open();
    await waitFor(() => expect(hook.result.current.error).toBe('offline'));

    await turn();
    await waitFor(() => expect(hook.result.current.error).toBe('still offline'));
    expect(hook.result.current.items).toEqual([]);

    await turn();
    await waitFor(() => expect(hook.result.current.items).toHaveLength(100));
    expect(seqs(hook)[0]).toBe(5000);
    expect(firstPageQueries()).toHaveLength(3);
    expect(afterQueries()).toEqual([]);
    hook.unmount();
  });

  it('skips a turn while the first page is on its way', async () => {
    server.count = 5000;
    const release = hold();
    const hook = open();
    await waitFor(() => expect(mocks.listTeamActivity).toHaveBeenCalledTimes(1));

    await turn();
    expect(mocks.listTeamActivity).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(100));
    expect(seqs(hook)).toEqual(Array.from({ length: 100 }, (_value, index) => 5000 - index));

    server.count = 5001;
    await turn();
    await waitFor(() => expect(seqs(hook)[0]).toBe(5001));
    expect(afterQueries()).toEqual([{ after: 5000, limit: 100 }]);
    hook.unmount();
  });

  it('lets an export wait for the newest page being loaded again', async () => {
    server.count = 5000;
    server.steps.push({ error: new Error('offline') });
    const hook = open();
    await waitFor(() => expect(hook.result.current.error).toBe('offline'));
    const release = hold();
    await turn();
    // 다시 받는 중에는 다음 차례도 건너뛴다.
    await turn();
    expect(firstPageQueries()).toHaveLength(2);

    let pending: Promise<TeamActivityItem[] | null> = Promise.resolve(null);
    let settled = false;
    await act(async () => {
      pending = hook.result.current.loadOlder({ since: null });
      void pending.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(settled).toBe(false);
    await act(async () => {
      release();
      await pending;
    });

    expect((await pending)?.length).toBe(5000);
    hook.unmount();
  });

  it('waits for the first page of a team switched to before asking for new rows', async () => {
    server.count = 50;
    const hook = open('team-1');
    await waitFor(() => expect(hook.result.current.items).toHaveLength(50));
    const release = hold();
    hook.rerender({ team: 'team-2' });
    await waitFor(() => expect(firstPageQueries()).toHaveLength(2));

    await turn();
    expect(afterQueries()).toEqual([]);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(50));
    expect(seqs(hook)[0]).toBe(50);
    expect(hook.result.current.items.every((entry) => entry.id.startsWith('team-2-'))).toBe(true);
    hook.unmount();
  });

  it.each([
    ['arrives', undefined],
    ['fails', new Error('offline again')],
  ])('drops the page loaded again for a team no longer shown when it %s', async (_name, error) => {
    server.count = 50;
    server.steps.push({ error: new Error('offline') });
    const hook = open('team-1');
    await waitFor(() => expect(hook.result.current.error).toBe('offline'));
    const release = hold(error);
    await turn();

    hook.rerender({ team: 'team-2' });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(50));
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(hook.result.current.items.every((entry) => entry.id.startsWith('team-2-'))).toBe(true);
    expect(hook.result.current.error).toBeNull();
    // team-2 는 처음 쪽을 받았으니 다음 차례에 새 줄만 묻는다.
    server.count = 51;
    await turn();
    await waitFor(() => expect(seqs(hook)[0]).toBe(51));
    expect(afterQueries()).toEqual([{ after: 50, limit: 100 }]);
    hook.unmount();
  });
});
