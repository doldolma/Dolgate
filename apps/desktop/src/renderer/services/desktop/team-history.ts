import type { TeamActivityQuery } from '@shared';
import { desktopApi } from '../desktopApi';

/** 팀 기록(서버). 앱 활동은 메인이 팀 키로 풀어 준다. */
export function listTeamActivity(teamId: string, query?: TeamActivityQuery) {
  return desktopApi.teams.listActivity(teamId, query);
}

/** 그 녹화들이 팀 서버에 있는지(기록 화면의 Replay). */
export function getTeamReplayStatuses(teamId: string, recordingIds: string[]) {
  return desktopApi.teams.getReplayStatuses(teamId, recordingIds);
}
