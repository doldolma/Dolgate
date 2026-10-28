import { normalizeTeamHostCredentials } from "@shared";
import type {
  HostDraft,
  HostRecord,
  SavedWorkspaceRecord,
  TailnetPayload,
  TeamHostCredentials,
  TerminalThemeId,
} from "@shared";
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
 * 저장·올리기·받기를 할 때는 strip 으로 빼고, 읽어 돌려줄 때 overlay 로 얹는다. 빼는 규칙과 내 칸의 모양은
 * 모바일도 쓰므로 shared-core(team-member-prefs.ts)에 있고, 얹는 것은 이 파일에 있다.
 */

/** 팀 볼트 하나의 사람마다 다른 값. */
export interface TeamMemberPrefs {
  hosts: ReadonlyMap<string, TeamHostPrefsRecord>;
  workspaces: ReadonlyMap<string, TeamWorkspacePrefsRecord>;
  terminalThemeByHostId: Readonly<Record<string, TerminalThemeId>>;
}

// 내 자격 증명의 모양·정규화와 레코드에서 사람마다 다른 값 빼기는 모바일도 같은 것을 쓰므로 shared-core 에 있다.
export {
  hasCredentialSecret,
  normalizeTeamHostCredentials,
  stripAwsProfileKeys,
  stripHostMemberPrefs,
  type TeamHostCredentials,
} from "@shared";

/*
 * 키 — 정적 AWS 프로필의 키와 tailnet 의 auth key — 는 개인 볼트와 똑같이 그 볼트에 두고, 팀에는 올리지 않는다.
 * 사람의 인증 정보라(IAM 키로 한 일은 그 키 주인으로 남고, auth key 는 그 사람 기기를 tailnet 에 넣는다) 팀원에게
 * 갈 수 없고, 내 다른 기기에도 따라가지 않는다 — 넣은 기기(또는 내 것을 공유한 기기)에만 있다. 올릴 때 여기서 빼고,
 * 받을 때는 팀 동기화가 이 기기에 있던 키를 지킨다.
 */

/** 팀에 올릴 tailnet — auth key 를 뺀다. 키가 있는지(hasAuthKey)도 그 기기의 사정이라 싣지 않는다. */
export function stripTailnetAuthKey({ authKey: _here, ...payload }: TailnetPayload): TailnetPayload {
  return { ...payload, hasAuthKey: false };
}

/** 멤버 개인 칸에 잠가 두는 내 자격 증명의 종류마다 값 모양. 저장·동기화가 같은 것으로 정규화한다. */
export const TEAM_MEMBER_CREDENTIAL_NORMALIZERS: {
  hostCredentials: (value: unknown) => TeamHostCredentials | null;
} = {
  hostCredentials: normalizeTeamHostCredentials,
};

/** 팀 볼트 하나의 사람마다 다른 값을 두는 곳(멤버 개인 칸·이 기기). */
export interface TeamMemberPrefsStore {
  read(): TeamMemberPrefs;
  updateHost(hostId: string, patch: TeamHostPrefsPatch): void;
  updateWorkspace(workspaceId: string, patch: TeamWorkspacePrefsPatch): void;
  setHostTerminalTheme(hostId: string, terminalThemeId: TerminalThemeId | null): void;
  /** 그 팀 호스트에 둔 내 자격 증명. 없으면 null. */
  readHostCredentials(hostId: string): TeamHostCredentials | null;
  /** 내 자격 증명을 둔다. null 이면 지운다(내 다른 기기에서도). */
  writeHostCredentials(hostId: string, credentials: TeamHostCredentials | null): void;
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
  if (host.kind === "rdp" && mine?.rdpCertificateFingerprint) {
    // 읽기 전용일 때 내가 신뢰한 인증서다 — 팀 레코드에 쓰지 못해 내 칸에 있다.
    return { ...host, favorite, terminalThemeId, certificateFingerprint: mine.rdpCertificateFingerprint };
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
