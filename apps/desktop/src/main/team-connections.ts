import { logMessage, type ActivityLogMessage } from "./activity-log-message";
import { t } from "./i18n";
import { getDesktopStateStorage } from "./state-storage";

/** 연결을 쥔 것 하나(코어·RDP·VNC) — 이 호스트들의 연결을 까닭과 함께 닫고 닫은 수를 돌려준다. */
export interface HostConnectionCloser {
  close(hostIds: ReadonlySet<string>, notice: string): number;
}

type DesktopStateStorage = ReturnType<typeof getDesktopStateStorage>;

/**
 * 팀을 이 기기에서 잊기 직전 — 그 팀 호스트의 열린 연결을 모두 닫고 기록에 한 줄 남긴다. 팀에서 빠진 사람의 접근을 바로
 * 끊는다(정직한 앱에서만 통한다). 팀 볼트를 지운 뒤에는 호스트가 어느 팀 것인지 모르므로, 팀 동기화가 지우기 직전에 그
 * 팀 호스트의 id 를 모아 부른다(TeamSyncService 의 onTeamForgotten).
 *
 * 빠짐·팀 삭제·내가 나가기·로그아웃이 모두 이 길이다. 로그아웃이면 연결이 이미 다 닫혀 닫을 것이 없다. 기록 한 줄에는
 * 팀 볼트를 가리키는 것을 싣지 않는다 — 그 팀에는 더 올릴 수 없다.
 */
export function closeTeamConnections(
  teamId: string,
  hostIds: ReadonlySet<string>,
  closers: readonly HostConnectionCloser[],
  appendLog: (message: ActivityLogMessage, metadata: Record<string, unknown>) => void,
  storage: Pick<DesktopStateStorage, "getTeamState"> = getDesktopStateStorage(),
): number {
  if (hostIds.size === 0) {
    return 0;
  }
  const notice = t("teams.connectionsClosed.notice");
  const closed = closers.reduce((sum, closer) => sum + closer.close(hostIds, notice), 0);
  if (closed > 0) {
    const team = storage.getTeamState(teamId)?.info.name ?? teamId;
    appendLog(logMessage("teams.connectionsClosed.log", { team, count: closed }), { closed });
  }
  return closed;
}
