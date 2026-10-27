import type { ActivityLogRecord, TeamActivityItem } from '@shared';

/** 수명 줄마다 끝나지 않은 상태와, 시작·끝 시각과 까닭을 담는 칸. */
const LIFECYCLE_FIELDS: Readonly<
  Record<string, { open: readonly string[]; start: readonly string[]; end: string; reason: string }>
> = {
  'session-lifecycle': { open: ['connected'], start: ['connectedAt'], end: 'disconnectedAt', reason: 'disconnectReason' },
  'port-forward-lifecycle': { open: ['running'], start: ['startedAt'], end: 'stoppedAt', reason: 'endReason' },
  'sftp-lifecycle': { open: ['connecting', 'connected'], start: ['connectedAt', 'startedAt'], end: 'endedAt', reason: 'endReason' },
  'container-lifecycle': { open: ['connecting', 'connected'], start: ['startedAt'], end: 'endedAt', reason: 'endReason' },
};

/** 멤버가 팀에서 빠진(나감·뺌) 때. */
export interface MemberLeave {
  seq: number;
  at: string;
}

/** 멤버마다 팀에서 빠진 때(seq 오름차순). 팀 기록의 멤버 변화 줄에서 모은다. */
export function memberLeavesOf(items: readonly TeamActivityItem[]): Map<string, MemberLeave[]> {
  const leaves = new Map<string, MemberLeave[]>();
  for (const item of items) {
    const change = item.memberChange;
    if (!change?.userId || (change.type !== 'member_left' && change.type !== 'member_removed')) {
      continue;
    }
    const list = leaves.get(change.userId) ?? [];
    list.push({ seq: item.seq, at: item.createdAt });
    leaves.set(change.userId, list);
  }
  for (const list of leaves.values()) {
    list.sort((left, right) => left.seq - right.seq);
  }
  return leaves;
}

/**
 * 팀 기록의 앱 활동 줄. 시작만 있는 수명 줄(접속·포워딩·SFTP·컨테이너)은 남긴 사람이 그 뒤에 팀에서 빠졌으면(나감·뺌)
 * 그때 까닭과 함께 끝난 것으로 고친다 — 빠진 사람의 앱은 열린 연결을 닫지만 그 끝을 팀에 올릴 수 없다. 화면에서만
 * 하고 서버는 모른다.
 */
export function withMemberLeftEnd(
  record: ActivityLogRecord,
  item: Pick<TeamActivityItem, 'seq' | 'authorUserId'>,
  leaves: ReadonlyMap<string, readonly MemberLeave[]>,
  reason: string,
): ActivityLogRecord {
  const fields = record.kind ? LIFECYCLE_FIELDS[record.kind] : undefined;
  const metadata = record.metadata;
  if (!fields || !metadata || typeof metadata.status !== 'string' || !fields.open.includes(metadata.status)) {
    return record;
  }
  const leave = leaves.get(item.authorUserId)?.find((entry) => entry.seq > item.seq);
  if (!leave) {
    return record;
  }
  const startedAt = fields.start
    .map((key) => metadata[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const endMs = Date.parse(leave.at);
  return {
    ...record,
    metadata: {
      ...metadata,
      status: 'closed',
      [fields.end]: leave.at,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
      [fields.reason]: reason,
    },
  };
}
