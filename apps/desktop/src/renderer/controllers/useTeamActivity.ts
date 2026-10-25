import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamActivityItem, TeamReplayStatus } from '@shared';
import { getTeamReplayStatuses, listTeamActivity } from '../services/desktop/team-history';

/** 한 번에 받는 줄 수. */
export const TEAM_ACTIVITY_PAGE_SIZE = 100;
/** 열려 있는 동안 새 줄을 받는 간격. */
export const TEAM_ACTIVITY_POLL_MS = 30_000;
/** 한 번 새로 받을 때 따라잡는 쪽 수의 상한(오래 닫혀 있었을 때). */
const CATCH_UP_PAGES = 10;

const NO_ITEMS: TeamActivityItem[] = [];
const NO_STATUSES: ReadonlyMap<string, TeamReplayStatus> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

/** 다시 물어도 바뀌지 않는 녹화 상태(끝났거나 지워짐). 진행 중이거나 아직 없는 녹화는 새로 받을 때마다 다시 묻는다. */
function isSettled(status: TeamReplayStatus | undefined): boolean {
  return status !== undefined && status.state !== 'live';
}

/** 접속 줄의 녹화 ID. 접속 줄이 아니거나 녹화가 없으면 null. */
export function recordingIdOf(item: TeamActivityItem): string | null {
  const recordingId = item.activity?.record.metadata?.recordingId;
  return item.activity?.record.kind === 'session-lifecycle' && typeof recordingId === 'string' ? recordingId : null;
}

export interface TeamActivityState {
  /** 받은 줄(최신부터). */
  items: TeamActivityItem[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** 더 오래된 줄을 받는다(목록 끝까지 내려왔을 때). */
  loadMore: () => void;
  /** 녹화 ID → 서버의 녹화 상태. */
  replayStatuses: ReadonlyMap<string, TeamReplayStatus>;
  /** 서버에 물어본 녹화 ID — 이 안에 있는데 상태가 없으면 서버에 아직 없는 녹화다. */
  checkedRecordingIds: ReadonlySet<string>;
}

/**
 * 팀 하나의 기록(서버). 처음에 최신 한 쪽을 받고, 내려가면 더 받고, 열려 있는 동안 30초마다 새 줄만 받는다.
 * 접속 줄의 녹화가 서버에 있는지도 묻는다. teamId 가 null 이면 아무것도 하지 않는다.
 */
export function useTeamActivity(teamId: string | null): TeamActivityState {
  const [items, setItems] = useState<TeamActivityItem[]>(NO_ITEMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [replayStatuses, setReplayStatuses] = useState<ReadonlyMap<string, TeamReplayStatus>>(NO_STATUSES);
  const [checkedRecordingIds, setCheckedRecordingIds] = useState<ReadonlySet<string>>(NO_IDS);
  // 팀을 바꾸면 늦게 온 옛 응답을 버린다.
  const generationRef = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const statusesRef = useRef(replayStatuses);
  statusesRef.current = replayStatuses;
  const loadingMoreRef = useRef(false);

  const checkReplays = useCallback(
    async (generation: number, team: string, candidates: TeamActivityItem[], recheck: boolean) => {
      const ids = new Set<string>();
      for (const item of candidates) {
        const recordingId = recordingIdOf(item);
        if (recordingId && (recheck ? !isSettled(statusesRef.current.get(recordingId)) : !statusesRef.current.has(recordingId))) {
          ids.add(recordingId);
        }
      }
      if (ids.size === 0) {
        return;
      }
      const statuses = await Promise.resolve()
        .then(() => getTeamReplayStatuses(team, [...ids]))
        .catch(() => null);
      if (!statuses || generation !== generationRef.current) {
        return;
      }
      setReplayStatuses((current) => {
        const next = new Map(current);
        for (const id of ids) {
          next.delete(id);
        }
        for (const status of statuses) {
          next.set(status.recordingId, status);
        }
        return next;
      });
      setCheckedRecordingIds((current) => new Set([...current, ...ids]));
    },
    [],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setItems(NO_ITEMS);
    setReplayStatuses(NO_STATUSES);
    setCheckedRecordingIds(NO_IDS);
    setError(null);
    setHasMore(false);
    loadingMoreRef.current = false;
    if (!teamId) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    // 브리지가 없으면 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡고, 이 훅을 쓰는 화면(호스트 상세 등)이 산다.
    void Promise.resolve()
      .then(() => listTeamActivity(teamId, { limit: TEAM_ACTIVITY_PAGE_SIZE }))
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        setItems(page);
        setHasMore(page.length >= TEAM_ACTIVITY_PAGE_SIZE);
        void checkReplays(generation, teamId, page, false);
      })
      .catch((reason: unknown) => {
        if (generation === generationRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          setLoading(false);
        }
      });

    // 새 줄만 받는다. 새로 고침 단추는 두지 않는다.
    const timer = window.setInterval(() => {
      void (async () => {
        let after = itemsRef.current[0]?.seq ?? 0;
        const fresh: TeamActivityItem[] = [];
        for (let page = 0; page < CATCH_UP_PAGES; page += 1) {
          const batch = await Promise.resolve()
            .then(() => listTeamActivity(teamId, { after, limit: TEAM_ACTIVITY_PAGE_SIZE }))
            .catch(() => null);
          if (!batch || generation !== generationRef.current) {
            return;
          }
          fresh.push(...batch);
          if (batch.length < TEAM_ACTIVITY_PAGE_SIZE) {
            break;
          }
          after = batch[batch.length - 1]!.seq;
        }
        if (fresh.length > 0) {
          // after 로 받은 것은 오래된 것부터다.
          const newestFirst = [...fresh].sort((left, right) => right.seq - left.seq);
          setItems((current) => {
            const known = new Set(current.map((item) => item.seq));
            return [...newestFirst.filter((item) => !known.has(item.seq)), ...current];
          });
        }
        // 진행 중이거나 아직 올라오지 않은 녹화는 다시 묻는다.
        await checkReplays(generation, teamId, [...fresh, ...itemsRef.current], true);
      })();
    }, TEAM_ACTIVITY_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [checkReplays, teamId]);

  const loadMore = useCallback(() => {
    const oldest = itemsRef.current[itemsRef.current.length - 1];
    if (!teamId || !hasMore || loadingMoreRef.current || !oldest) {
      return;
    }
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoading(true);
    void Promise.resolve()
      .then(() => listTeamActivity(teamId, { before: oldest.seq, limit: TEAM_ACTIVITY_PAGE_SIZE }))
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        setItems((current) => {
          const known = new Set(current.map((item) => item.seq));
          return [...current, ...page.filter((item) => !known.has(item.seq))];
        });
        setHasMore(page.length >= TEAM_ACTIVITY_PAGE_SIZE);
        void checkReplays(generation, teamId, page, false);
      })
      .catch((reason: unknown) => {
        if (generation === generationRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          loadingMoreRef.current = false;
          setLoading(false);
        }
      });
  }, [checkReplays, hasMore, teamId]);

  return { items, loading, error, hasMore, loadMore, replayStatuses, checkedRecordingIds };
}
