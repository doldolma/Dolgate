import { describe, expect, it } from 'vitest';
import type { ActivityLogRecord, TeamActivityItem } from '@shared';
import { memberLeavesOf, withMemberLeftEnd } from './team-member-left';
import { buildActivityEntries } from '../host-browser/HostDetailPanel';

const REASON = '팀에서 빠져 연결이 끝났습니다.';

function lifecycle(kind: ActivityLogRecord['kind'], metadata: Record<string, unknown>): ActivityLogRecord {
  return {
    id: `${kind}-1`,
    level: 'info',
    category: 'session',
    kind,
    message: kind ?? '',
    metadata: { hostId: 'h-team', ...metadata },
    createdAt: '2026-10-21T01:00:00.000Z',
  } as ActivityLogRecord;
}

function memberChange(seq: number, type: string, userId: string, createdAt: string): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'server',
    authorUserId: 'u-admin',
    authorEmail: 'admin@acme.dev',
    createdAt,
    receivedAt: createdAt,
    activity: null,
    memberChange: { type, userId },
    unreadable: null,
  };
}

function appItem(seq: number, userId: string, record: ActivityLogRecord): TeamActivityItem {
  return {
    seq,
    id: `event-${seq}`,
    source: 'app',
    authorUserId: userId,
    authorEmail: `${userId}@acme.dev`,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    activity: { v: 1, phase: 'start', record },
    memberChange: null,
    unreadable: null,
  };
}

const LEFT_AT = '2026-10-21T01:30:00.000Z';
const leaves = memberLeavesOf([
  memberChange(9, 'member_joined', 'u-bob', '2026-10-21T02:00:00.000Z'),
  memberChange(7, 'member_removed', 'u-bob', LEFT_AT),
  memberChange(3, 'member_left', 'u-bob', '2026-10-21T00:30:00.000Z'),
  memberChange(5, 'role_changed', 'u-carol', '2026-10-21T01:00:00.000Z'),
]);

describe('memberLeavesOf', () => {
  it('keeps only leaving and removal, oldest first per member', () => {
    expect(leaves).toEqual(
      new Map([
        [
          'u-bob',
          [
            { seq: 3, at: '2026-10-21T00:30:00.000Z' },
            { seq: 7, at: LEFT_AT },
          ],
        ],
      ]),
    );
  });
});

describe('withMemberLeftEnd', () => {
  it('ends an open session at the first time its author left after it started', () => {
    const record = lifecycle('session-lifecycle', { connectedAt: '2026-10-21T01:00:00.000Z', status: 'connected' });

    expect(withMemberLeftEnd(record, { seq: 4, authorUserId: 'u-bob' }, leaves, REASON).metadata).toMatchObject({
      status: 'closed',
      disconnectedAt: LEFT_AT,
      durationMs: 30 * 60_000,
      disconnectReason: REASON,
    });
  });

  it('uses each kind’s own end and start fields', () => {
    const at = { seq: 4, authorUserId: 'u-bob' };
    expect(
      withMemberLeftEnd(lifecycle('port-forward-lifecycle', { startedAt: '2026-10-21T01:20:00.000Z', status: 'running' }), at, leaves, REASON)
        .metadata,
    ).toMatchObject({ status: 'closed', stoppedAt: LEFT_AT, durationMs: 10 * 60_000, endReason: REASON });
    expect(
      withMemberLeftEnd(
        lifecycle('sftp-lifecycle', {
          startedAt: '2026-10-21T01:00:00.000Z',
          connectedAt: '2026-10-21T01:10:00.000Z',
          status: 'connected',
        }),
        at,
        leaves,
        REASON,
      ).metadata,
    ).toMatchObject({ status: 'closed', endedAt: LEFT_AT, durationMs: 20 * 60_000, endReason: REASON });
    expect(
      withMemberLeftEnd(lifecycle('container-lifecycle', { startedAt: '2026-10-21T01:25:00.000Z', status: 'connected' }), at, leaves, REASON)
        .metadata,
    ).toMatchObject({ status: 'closed', endedAt: LEFT_AT, durationMs: 5 * 60_000, endReason: REASON });
  });

  it('leaves alone rows that ended, rows started after the last leaving, and members who stayed', () => {
    const open = lifecycle('session-lifecycle', { connectedAt: '2026-10-21T02:10:00.000Z', status: 'connected' });
    const ended = lifecycle('session-lifecycle', { connectedAt: '2026-10-21T01:00:00.000Z', status: 'closed' });

    // 다시 들어온 뒤(seq 9 뒤)에 시작한 접속.
    expect(withMemberLeftEnd(open, { seq: 10, authorUserId: 'u-bob' }, leaves, REASON)).toBe(open);
    expect(withMemberLeftEnd(ended, { seq: 4, authorUserId: 'u-bob' }, leaves, REASON)).toBe(ended);
    expect(withMemberLeftEnd(open, { seq: 4, authorUserId: 'u-carol' }, leaves, REASON)).toBe(open);
  });
});

describe('buildActivityEntries — 팀에서 빠진 사람의 접속', () => {
  it('shows a left member’s open session as ended, with its length', () => {
    const record = lifecycle('session-lifecycle', {
      connectedAt: '2026-10-21T01:00:00.000Z',
      status: 'connected',
      durationMs: null,
    });

    const entries = buildActivityEntries({
      localLogs: [],
      includeHost: () => true,
      teams: [{ teamId: 'team-1', items: [memberChange(7, 'member_removed', 'u-bob', LEFT_AT), appItem(4, 'u-bob', record)] }],
      replayStatuses: new Map(),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.log.metadata).toMatchObject({ status: 'closed', durationMs: 30 * 60_000, disconnectReason: REASON });
  });
});
