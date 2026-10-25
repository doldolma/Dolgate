import type {
  AuthType,
  HostDraft,
  HostRecord,
  ManagedAwsProfilePayload,
  SavedWorkspaceRecord,
  TailnetPayload,
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
 * 저장·올리기·받기를 할 때는 strip 으로 빼고, 읽어 돌려줄 때 overlay 로 얹는다. 빼고 얹는 곳은 이
 * 파일 하나다.
 */

/** 팀 볼트 하나의 사람마다 다른 값. */
export interface TeamMemberPrefs {
  hosts: ReadonlyMap<string, TeamHostPrefsRecord>;
  workspaces: ReadonlyMap<string, TeamWorkspacePrefsRecord>;
  terminalThemeByHostId: Readonly<Record<string, TerminalThemeId>>;
}

/**
 * 팀 호스트에 쓰는 내 자격 증명(멤버 개인 칸). 비운 칸은 호스트 것을 쓴다 — 사용자 이름을 비우면 호스트의
 * 사용자 이름, 인증 방식을 비우면 호스트의 인증 방식이다. 접속할 때 내 것 → 팀 것 → 요청 창 순으로 찾는다.
 */
export interface TeamHostCredentials {
  username?: string;
  authType?: AuthType;
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
  /** RDP 계정의 도메인. */
  domain?: string;
  /** 키 파일 경로는 그 기기의 파일이라 늘 내 칸에 둔다(키는 privateKeyPem 에 들어 있다). */
  privateKeyPath?: string;
  certificatePath?: string;
}

const AUTH_TYPES: readonly AuthType[] = ["password", "privateKey", "keyboardInteractive", "certificate", "agent"];
const CREDENTIAL_TEXT_FIELDS = [
  "username",
  "password",
  "passphrase",
  "privateKeyPem",
  "certificateText",
  "domain",
  "privateKeyPath",
  "certificatePath",
] as const;

/** 저장·전송된 값을 자격 증명으로. 아는 칸의 비어 있지 않은 글만 남긴다. 남는 것이 없으면 null. */
export function normalizeTeamHostCredentials(value: unknown): TeamHostCredentials | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const credentials: TeamHostCredentials = {};
  for (const field of CREDENTIAL_TEXT_FIELDS) {
    const text = source[field];
    if (typeof text === "string" && text.length > 0) {
      credentials[field] = text;
    }
  }
  if (typeof source.authType === "string" && (AUTH_TYPES as readonly string[]).includes(source.authType)) {
    credentials.authType = source.authType as AuthType;
  }
  return Object.keys(credentials).length > 0 ? credentials : null;
}

/** 비밀값(비밀번호·키·인증서·패스프레이즈)이 하나라도 있다. 사용자 이름만 둔 것과 가른다. */
export function hasCredentialSecret(credentials: TeamHostCredentials): boolean {
  return Boolean(
    credentials.password || credentials.passphrase || credentials.privateKeyPem || credentials.certificateText,
  );
}

/*
 * 키 — 정적 AWS 프로필의 키와 tailnet 의 auth key — 는 개인 볼트와 똑같이 그 볼트에 두고, 팀에는 올리지 않는다.
 * 사람의 인증 정보라(IAM 키로 한 일은 그 키 주인으로 남고, auth key 는 그 사람 기기를 tailnet 에 넣는다) 팀원에게
 * 갈 수 없고, 내 다른 기기에도 따라가지 않는다 — 넣은 기기(또는 내 것을 공유한 기기)에만 있다. 올릴 때 여기서 빼고,
 * 받을 때는 팀 동기화가 이 기기에 있던 키를 지킨다.
 */

/** 팀에 올릴 AWS 프로필 — 정적 프로필의 키를 뺀다. 팀에는 이름·리전 같은 설정만 간다. */
export function stripAwsProfileKeys(payload: ManagedAwsProfilePayload): ManagedAwsProfilePayload {
  return payload.kind === "static" ? { ...payload, accessKeyId: "", secretAccessKey: "" } : payload;
}

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
