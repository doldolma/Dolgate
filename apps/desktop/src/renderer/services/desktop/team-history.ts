import type { TeamActivityQuery, TeamChangeRef } from '@shared';
import { desktopApi } from '../desktopApi';

/** 팀 기록(서버). 앱 활동은 메인이 팀 키로 풀어 준다. */
export function listTeamActivity(teamId: string, query?: TeamActivityQuery) {
  return desktopApi.teams.listActivity(teamId, query);
}

/** 그 녹화들이 팀 서버에 있는지(기록 화면의 Replay). */
export function getTeamReplayStatuses(teamId: string, recordingIds: string[]) {
  return desktopApi.teams.getReplayStatuses(teamId, recordingIds);
}

/** 팀 볼트에서 바뀐 것(관리자 이상). before 를 주면 그 앞을 준다. */
export function listTeamChanges(teamId: string, query?: { before?: number }) {
  return desktopApi.teams.listChanges(teamId, query);
}

/** 그 묶음을 복원한다(관리자 이상). 남이 그 뒤에 바꾼 것을 덮게 되면 overwrite 없이는 묻기만 한다. */
export function restoreTeamChange(teamId: string, change: TeamChangeRef, options?: { overwrite?: boolean }) {
  return desktopApi.teams.restoreChange(teamId, change, options);
}
