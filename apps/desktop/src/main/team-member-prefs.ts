import type { HostDraft, HostRecord, SavedWorkspaceRecord, TerminalThemeId } from "@shared";
import type {
  TeamHostPrefsPatch,
  TeamHostPrefsRecord,
  TeamWorkspacePrefsPatch,
  TeamWorkspacePrefsRecord,
} from "./state-storage";

/*
 * 팀 볼트에서 사람마다 다른 값.
 *
 * - 호스트: 즐겨찾기·agent forwarding 은 멤버 개인 칸(내 기기끼리 맞춰짐), 테마는 이 기기에만.
 * - 워크스페이스: 즐겨찾기·마지막으로 연 시각은 멤버 개인 칸.
 *
 * 팀 레코드에 넣으면 내 즐겨찾기·agent forwarding 이 팀원 모두에게 간다. 그래서 팀 레코드로
 * 저장·올리기·받기를 할 때는 strip 으로 빼고, 읽어 돌려줄 때 overlay 로 얹는다. 빼고 얹는 곳은 이
 * 파일 하나다.
 */

/** 팀 볼트 하나의 사람마다 다른 값. */
export interface TeamMemberPrefs {
  hosts: ReadonlyMap<string, TeamHostPrefsRecord>;
  workspaces: ReadonlyMap<string, TeamWorkspacePrefsRecord>;
  terminalThemeByHostId: Readonly<Record<string, TerminalThemeId>>;
}

/** 팀 볼트 하나의 사람마다 다른 값을 두는 곳(멤버 개인 칸·이 기기). */
export interface TeamMemberPrefsStore {
  read(): TeamMemberPrefs;
  updateHost(hostId: string, patch: TeamHostPrefsPatch): void;
  updateWorkspace(workspaceId: string, patch: TeamWorkspacePrefsPatch): void;
  setHostTerminalTheme(hostId: string, terminalThemeId: TerminalThemeId | null): void;
}

export function stripHostMemberPrefs(host: HostRecord): HostRecord {
  // agent forwarding 은 SSH 로 붙는 호스트에만 있는 칸이다.
  if (host.kind === "ssh" || host.kind === "aws-ec2") {
    return { ...host, favorite: null, terminalThemeId: null, agentForwarding: null };
  }
  return { ...host, favorite: null, terminalThemeId: null };
}

/** 레코드에 남아 있는 값이 있어도 무시하고 내 값으로 덮는다(없으면 끈 것으로 본다). */
export function overlayHostMemberPrefs(host: HostRecord, prefs: TeamMemberPrefs): HostRecord {
  const mine = prefs.hosts.get(host.id);
  const favorite = mine?.favorite === true ? true : null;
  const terminalThemeId = prefs.terminalThemeByHostId[host.id] ?? null;
  if (host.kind === "ssh" || host.kind === "aws-ec2") {
    return {
      ...host,
      favorite,
      terminalThemeId,
      agentForwarding: mine?.agentForwarding === true ? true : null,
    };
  }
  return { ...host, favorite, terminalThemeId };
}

/** 호스트 편집 초안을 팀 레코드로 저장할 몫과 나에게만 적용할 몫으로 나눈다. */
export function splitHostDraftMemberPrefs(draft: HostDraft): {
  teamDraft: HostDraft;
  hostPrefs: TeamHostPrefsPatch;
  terminalThemeId: TerminalThemeId | null;
} {
  const terminalThemeId = draft.terminalThemeId ?? null;
  if (draft.kind === "ssh" || draft.kind === "aws-ec2") {
    return {
      teamDraft: { ...draft, terminalThemeId: null, agentForwarding: null },
      hostPrefs: { agentForwarding: draft.agentForwarding === true },
      terminalThemeId,
    };
  }
  return { teamDraft: { ...draft, terminalThemeId: null }, hostPrefs: {}, terminalThemeId };
}

export function stripWorkspaceMemberPrefs(workspace: SavedWorkspaceRecord): SavedWorkspaceRecord {
  return { ...workspace, favorite: false, lastOpenedAt: null };
}

export function overlayWorkspaceMemberPrefs(
  workspace: SavedWorkspaceRecord,
  prefs: TeamMemberPrefs,
): SavedWorkspaceRecord {
  const mine = prefs.workspaces.get(workspace.id);
  return { ...workspace, favorite: mine?.favorite === true, lastOpenedAt: mine?.lastOpenedAt ?? null };
}
