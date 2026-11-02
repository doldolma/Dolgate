import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamActivityItem, TeamReplayStatus } from '@shared';
import { getTeamReplayStatuses, listTeamActivity } from '../services/desktop/team-history';

/** 한 번에 받는 줄 수. */
export const TEAM_ACTIVITY_PAGE_SIZE = 100;
/** 기간까지·끝까지 이어 받을 때 한 번에 받는 줄 수(서버 상한). */
export const TEAM_ACTIVITY_BULK_PAGE_SIZE = 200;
/**
 * 기간 시작보다 이만큼 앞까지 더 받는다. 서버가 받은 시각으로 멈추는데, 기기 시계가 서버보다 빠르면 기록 시각이 받은
 * 시각보다 늦을 수 있다.
 */
const CLOCK_SKEW_MARGIN_MS = 10 * 60 * 1000;
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

export interface LoadOlderOptions {
  since: string | null;
  onProgress?: (count: number) => void;
  /** stopped 를 true 로 바꾸면 다음 쪽을 받기 전에 멈춘다. */
  signal?: { stopped: boolean };
}

/**
 * 받은 줄 가운데 가장 오래된 것이 since 보다 앞이면 더 받을 필요가 없다. 서버가 받은 시각(receivedAt)으로 본다 — 서버
 * 순번이 내려갈수록 받은 시각도 내려가므로, 그보다 앞 순번의 줄은 모두 since 보다 앞이다(기록 시각은 받은 시각보다 늦을 수
 * 없으니 시계 차이만큼 여유를 둔다).
 */
export function reachedSince(oldest: TeamActivityItem | undefined, since: string | null): boolean {
  if (!oldest || since === null) {
    return false;
  }
  const received = Date.parse(oldest.receivedAt || oldest.createdAt);
  const limit = Date.parse(since) - CLOCK_SKEW_MARGIN_MS;
  return Number.isFinite(received) && Number.isFinite(limit) && received < limit;
}

export interface TeamActivityState {
  /** 받은 줄(최신부터). */
  items: TeamActivityItem[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** 더 오래된 줄을 받는다(목록 끝까지 내려왔을 때). */
  loadMore: () => void;
  /**
   * 지난 줄을 이어 받는다 — since(ISO) 가 있으면 그 시각까지, null 이면 서버에 있는 끝까지(기간·내보내기). 받은 줄 수를
   * onProgress 로 알린다. 다 받았으면 그때까지 받은 줄 전부(최신부터)를 주고, 멈췄거나 팀이 바뀌었으면 null 이다.
   */
  loadOlder: (options: LoadOlderOptions) => Promise<TeamActivityItem[] | null>;
  /** loadOlder 로 지난 줄을 받는 중. */
  loadingOlder: boolean;
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
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  // 처음 쪽과 화면의 '더 받기'가 끝나기를 loadOlder 가 기다린다(같은 쪽을 두 번 받지 않게).
  const firstPageRef = useRef<Promise<void>>(Promise.resolve());
  const moreRef = useRef<Promise<void>>(Promise.resolve());
  const [loadingOlder, setLoadingOlder] = useState(false);

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
    hasMoreRef.current = false;
    loadingMoreRef.current = false;
    setLoadingOlder(false);
    if (!teamId) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    // 브리지가 없으면 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡고, 이 훅을 쓰는 화면(호스트 상세 등)이 산다.
    firstPageRef.current = Promise.resolve()
      .then(() => listTeamActivity(teamId, { limit: TEAM_ACTIVITY_PAGE_SIZE }))
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        itemsRef.current = page;
        setItems(page);
        hasMoreRef.current = page.length >= TEAM_ACTIVITY_PAGE_SIZE;
        setHasMore(hasMoreRef.current);
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
    moreRef.current = Promise.resolve()
      .then(() => listTeamActivity(teamId, { before: oldest.seq, limit: TEAM_ACTIVITY_PAGE_SIZE }))
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        // 그사이 새로 받은 줄(30초마다 앞에 붙음)을 덮지 않게 함수로 붙인다.
        itemsRef.current = appendOlder(itemsRef.current, page);
        setItems((current) => appendOlder(current, page));
        hasMoreRef.current = page.length >= TEAM_ACTIVITY_PAGE_SIZE;
        setHasMore(hasMoreRef.current);
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

  const loadOlderNow = useCallback(
    async ({ since, onProgress, signal }: LoadOlderOptions): Promise<TeamActivityItem[] | null> => {
      if (!teamId) {
        return null;
      }
      const generation = generationRef.current;
      await firstPageRef.current;
      await moreRef.current;
      if (generation !== generationRef.current || loadingMoreRef.current) {
        return null;
      }
      loadingMoreRef.current = true;
      setLoadingOlder(true);
      try {
        while (hasMoreRef.current && !reachedSince(itemsRef.current[itemsRef.current.length - 1], since)) {
          const oldest = itemsRef.current[itemsRef.current.length - 1];
          if (signal?.stopped || !oldest) {
            return signal?.stopped ? null : itemsRef.current;
          }
          const page = await listTeamActivity(teamId, { before: oldest.seq, limit: TEAM_ACTIVITY_BULK_PAGE_SIZE });
          if (generation !== generationRef.current) {
            return null;
          }
          itemsRef.current = appendOlder(itemsRef.current, page);
          setItems((current) => appendOlder(current, page));
          hasMoreRef.current = page.length >= TEAM_ACTIVITY_BULK_PAGE_SIZE;
          setHasMore(hasMoreRef.current);
          onProgress?.(itemsRef.current.length);
          void checkReplays(generation, teamId, page, false);
        }
        return signal?.stopped ? null : itemsRef.current;
      } catch (reason: unknown) {
        if (generation === generationRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        throw reason;
      } finally {
        if (generation === generationRef.current) {
          loadingMoreRef.current = false;
          setLoadingOlder(false);
        }
      }
    },
    [checkReplays, teamId],
  );
  // 하나씩 — 기간을 받는 중에 내보내기를 누르면 그것이 끝난 뒤 이어 받는다.
  const olderRef = useRef<Promise<unknown>>(Promise.resolve());
  const loadOlder = useCallback(
    (options: LoadOlderOptions) => {
      const run = olderRef.current.catch(() => undefined).then(() => loadOlderNow(options));
      olderRef.current = run;
      return run;
    },
    [loadOlderNow],
  );

  return {
    items,
    loading,
    error,
    hasMore,
    loadMore,
    loadOlder,
    loadingOlder,
    replayStatuses,
    checkedRecordingIds,
  };
}

/** 받은 지난 쪽을 끝에 붙인다(이미 있는 순번은 뺀다). */
function appendOlder(current: TeamActivityItem[], page: TeamActivityItem[]): TeamActivityItem[] {
  const known = new Set(current.map((item) => item.seq));
  return [...current, ...page.filter((item) => !known.has(item.seq))];
}
