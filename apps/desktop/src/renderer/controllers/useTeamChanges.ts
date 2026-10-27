import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamChangeSet } from '@shared';
import { listTeamChanges } from '../services/desktop/team-history';

const NO_SETS: TeamChangeSet[] = [];

export interface TeamChangesState {
  /** 받은 묶음(최신부터). */
  sets: TeamChangeSet[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** 더 오래된 묶음을 받는다(목록 끝까지 내려왔을 때). */
  loadMore: () => void;
  /** 받은 만큼 처음부터 다시 받는다 — 복원한 뒤 "복원됨"과 새로 생긴 묶음을 보이게. 보던 자리는 그대로다. */
  reload: () => void;
}

/**
 * 팀 하나의 바뀐 것(관리자 이상). 처음에 최신 한 쪽을 받고, 내려가면 더 받는다. teamId 가 null 이면 아무것도
 * 하지 않는다.
 */
export function useTeamChanges(teamId: string | null): TeamChangesState {
  const [sets, setSets] = useState<TeamChangeSet[]>(NO_SETS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  // 팀을 바꾸거나 다시 받으면 늦게 온 옛 응답을 버린다.
  const generationRef = useRef(0);
  const setsRef = useRef(sets);
  setsRef.current = sets;
  const nextBeforeRef = useRef(nextBefore);
  nextBeforeRef.current = nextBefore;
  const loadingMoreRef = useRef(false);

  /** 최신부터 적어도 count 묶음(또는 끝까지)을 받는다. */
  const fetchFromTop = useCallback(async (team: string, count: number) => {
    const collected: TeamChangeSet[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await listTeamChanges(team, before === undefined ? undefined : { before });
      collected.push(...page.sets);
      if (page.nextBefore === null || collected.length >= count) {
        return { sets: collected, nextBefore: page.nextBefore };
      }
      before = page.nextBefore;
    }
  }, []);

  const load = useCallback(
    (team: string, count: number, keepShown: boolean) => {
      const generation = ++generationRef.current;
      loadingMoreRef.current = false;
      setError(null);
      if (!keepShown) {
        setSets(NO_SETS);
        setNextBefore(null);
      }
      setLoading(true);
      // 브리지가 없으면 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡는다.
      void Promise.resolve()
        .then(() => fetchFromTop(team, count))
        .then((page) => {
          if (generation !== generationRef.current) {
            return;
          }
          setSets(page.sets);
          setNextBefore(page.nextBefore);
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
    },
    [fetchFromTop],
  );

  useEffect(() => {
    if (!teamId) {
      generationRef.current += 1;
      setSets(NO_SETS);
      setNextBefore(null);
      setError(null);
      setLoading(false);
      return;
    }
    load(teamId, 1, false);
  }, [load, teamId]);

  const reload = useCallback(() => {
    if (teamId) {
      load(teamId, Math.max(1, setsRef.current.length), true);
    }
  }, [load, teamId]);

  const loadMore = useCallback(() => {
    const before = nextBeforeRef.current;
    if (!teamId || before === null || loadingMoreRef.current) {
      return;
    }
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoading(true);
    void Promise.resolve()
      .then(() => listTeamChanges(teamId, { before }))
      .then((page) => {
        if (generation !== generationRef.current) {
          return;
        }
        setSets((current) => {
          const known = new Set(current.map((set) => set.lastSeq));
          return [...current, ...page.sets.filter((set) => !known.has(set.lastSeq))];
        });
        setNextBefore(page.nextBefore);
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
  }, [teamId]);

  return { sets, loading, error, hasMore: nextBefore !== null, loadMore, reload };
}
