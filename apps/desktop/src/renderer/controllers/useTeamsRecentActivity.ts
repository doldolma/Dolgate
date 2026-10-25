import { useEffect, useMemo, useState } from 'react';
import type { TeamActivityItem, TeamReplayStatus } from '@shared';
import { getTeamReplayStatuses, listTeamActivity } from '../services/desktop/team-history';
import { TEAM_ACTIVITY_PAGE_SIZE, TEAM_ACTIVITY_POLL_MS, recordingIdOf } from './useTeamActivity';

export interface TeamsRecentActivity {
  /** 팀마다 받은 최근 기록(최신부터). */
  teams: ReadonlyArray<{ teamId: string; items: readonly TeamActivityItem[] }>;
  /** 녹화 ID → 서버의 녹화 상태(받은 팀 전부). */
  replayStatuses: ReadonlyMap<string, TeamReplayStatus>;
}

const EMPTY: TeamsRecentActivity = { teams: [], replayStatuses: new Map() };

/**
 * 여러 팀의 최근 기록 한 쪽씩과 그 접속들의 녹화 상태 — 홈의 최근 로그·팀 호스트 상세가 이 기기 기록에 팀 기록(다른 멤버의
 * 접속과 녹화)을 합칠 때 쓴다. 기록 화면은 더 받기가 있는 useTeamActivity 를 쓴다.
 *
 * 열려 있는 동안 30초마다 다시 받는다. 못 받은 팀은 앞서 받은 것을 그대로 둔다 — 잠깐 끊겼다고 목록이 비면 안 된다.
 */
export function useTeamsRecentActivity(teamIds: readonly string[]): TeamsRecentActivity {
  const key = [...new Set(teamIds)].sort().join(',');
  const [state, setState] = useState<TeamsRecentActivity>(EMPTY);

  useEffect(() => {
    if (!key) {
      setState(EMPTY);
      return undefined;
    }
    const ids = key.split(',');
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(
        ids.map(async (teamId) => {
          // 브리지가 없으면 동기적으로 던진다 — Promise 로 감싸야 .catch 가 잡는다.
          const items = await Promise.resolve()
            .then(() => listTeamActivity(teamId, { limit: TEAM_ACTIVITY_PAGE_SIZE }))
            .catch(() => null);
          if (!items) {
            return { teamId, items: null, statuses: [] as TeamReplayStatus[] };
          }
          const recordingIds = [...new Set(items.map(recordingIdOf).filter((id): id is string => id !== null))];
          const statuses =
            recordingIds.length > 0
              ? await Promise.resolve()
                  .then(() => getTeamReplayStatuses(teamId, recordingIds))
                  .catch((): TeamReplayStatus[] => [])
              : [];
          return { teamId, items, statuses };
        }),
      );
      if (cancelled) {
        return;
      }
      setState((current) => {
        const previous = new Map(current.teams.map((team) => [team.teamId, team.items]));
        const replayStatuses = new Map(current.replayStatuses);
        for (const result of results) {
          for (const status of result.statuses) {
            replayStatuses.set(status.recordingId, status);
          }
        }
        return {
          teams: results.map((result) => ({
            teamId: result.teamId,
            items: result.items ?? previous.get(result.teamId) ?? [],
          })),
          replayStatuses,
        };
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), TEAM_ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [key]);

  // 팀이 바뀐 직후에는 새로 받기 전까지 앞 팀의 것을 보이지 않는다. 같은 값이면 같은 객체를 돌려준다(쓰는 쪽의 useMemo).
  return useMemo(() => {
    if (!key) {
      return EMPTY;
    }
    const ids = new Set(key.split(','));
    return { ...state, teams: state.teams.filter((team) => ids.has(team.teamId)) };
  }, [key, state]);
}
