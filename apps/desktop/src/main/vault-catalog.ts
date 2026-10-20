import type {
  HostDraft,
  HostRecord,
  PortForwardRuleRecord,
  SavedWorkspaceRecord,
  TailnetPayload,
  TerminalThemeId,
} from "@shared";
import type {
  AwsProfileRepository,
  DnsOverrideRepository,
  GroupRepository,
  HostRepository,
  KnownHostRepository,
  PortForwardRepository,
  SavedWorkspaceRepository,
  SecretMetadataRepository,
  SnippetRepository,
  SyncOutboxRepository,
  TailnetRepository,
} from "./database";
import {
  overlayHostMemberPrefs,
  overlayWorkspaceMemberPrefs,
  splitHostDraftMemberPrefs,
  type TeamHostCredentials,
  type TeamMemberPrefs,
  type TeamMemberPrefsStore,
} from "./team-member-prefs";
import { t } from "./i18n";
import { PERSONAL_VAULT_ID } from "./vault-root";

export { PERSONAL_VAULT_ID };

/** 볼트 하나의 비밀값(`secret:*` 참조). 개인 볼트는 SecretStore 그대로다. */
export interface VaultSecretStore {
  load(secretRef: string): Promise<string | null>;
  save(secretRef: string, secret: string): Promise<string>;
  remove(secretRef: string): Promise<void>;
}

/**
 * 볼트 하나의 저장소 묶음.
 *
 * 개인 볼트와 팀 볼트는 모양이 같고 담는 자리만 다르다(vault-root.ts). 개인 동기화는 개인 볼트를 통째로
 * 올리고 받으므로, 팀 것은 팀 볼트의 묶음으로만 읽고 쓴다.
 */
export interface VaultScope {
  /** 개인 볼트는 PERSONAL_VAULT_ID, 팀 볼트는 팀 ID. */
  readonly id: string;
  readonly hosts: HostRepository;
  readonly groups: GroupRepository;
  readonly tailnets: TailnetRepository;
  readonly portForwards: PortForwardRepository;
  readonly dnsOverrides: DnsOverrideRepository;
  readonly snippets: SnippetRepository;
  readonly savedWorkspaces: SavedWorkspaceRepository;
  readonly knownHosts: KnownHostRepository;
  readonly secretMetadata: SecretMetadataRepository;
  readonly awsProfiles: AwsProfileRepository;
  readonly syncOutbox: SyncOutboxRepository;
  readonly secrets: VaultSecretStore;
  /**
   * 사람마다 다른 값(즐겨찾기·테마 등)을 레코드 밖에 두는 곳. 개인 볼트는 레코드 안에 두므로 null 이다.
   * 팀 볼트의 저장소(hosts 등)는 그 값을 뺀 팀 레코드를 돌려준다 — 얹는 것은 카탈로그가 한다.
   */
  readonly memberPrefs: TeamMemberPrefsStore | null;
}

/** 팀 볼트의 묶음. 사람마다 다른 값을 두는 곳이 따로 있다. */
export type TeamVaultScope = VaultScope & { readonly memberPrefs: TeamMemberPrefsStore };

/** 이 기기에 있는 팀 볼트들. 실제 것은 team-vault-scope.ts 가 상태 파일에서 만든다. */
export interface TeamVaultSource {
  listTeamIds(): string[];
  createScope(teamId: string): Omit<TeamVaultScope, "id">;
}

/** 개인 볼트의 묶음. main 이 만든 저장소들(의존성 묶음)에서 볼트 저장소만 고른다. */
export function pickVaultRepositories(
  repositories: Omit<VaultScope, "id" | "secrets" | "memberPrefs">,
  secrets: VaultSecretStore,
): Omit<VaultScope, "id"> {
  const {
    hosts,
    groups,
    tailnets,
    portForwards,
    dnsOverrides,
    snippets,
    savedWorkspaces,
    knownHosts,
    secretMetadata,
    awsProfiles,
    syncOutbox,
  } = repositories;
  return {
    hosts,
    groups,
    tailnets,
    portForwards,
    dnsOverrides,
    snippets,
    savedWorkspaces,
    knownHosts,
    secretMetadata,
    awsProfiles,
    syncOutbox,
    secrets,
    memberPrefs: null,
  };
}

const NO_TEAM_VAULTS: TeamVaultSource = {
  listTeamIds: () => [],
  createScope: (teamId) => {
    throw new Error(`no team vaults: ${teamId}`);
  },
};

/**
 * 메인에서 호스트를 읽는 입구.
 *
 * 호스트를 **읽는** 곳은 모두 이것을 거친다(vault-catalog-boundary.test.ts 가 지킨다). 개인과 팀 볼트를
 * 함께 보고, 개인 볼트만 봐야 하는 곳(개인 동기화, 개인 볼트로 들어가는 가져오기)은 personal 을
 * 명시한다.
 *
 * id 는 볼트를 넘어 겹치지 않게 지킨다. 그래도 겹치면 개인이 이기고, 팀끼리는 먼저 있는 팀이 이긴다.
 *
 * 팀 호스트·워크스페이스는 사람마다 다른 값(team-member-prefs.ts)을 얹어 돌려주고, 그 값을 바꾸는
 * 쓰기는 여기서 팀 레코드와 나눈다. 팀이 없으면 모든 메서드가 개인 저장소를 그대로 부른다.
 */
export interface VaultCatalog {
  readonly personal: VaultScope;
  /** 개인 또는 이 기기에 있는 팀 볼트. 모르는 id 면 null. */
  getScope(vaultId: string): VaultScope | null;
  /** 개인 볼트, 그다음 팀 볼트들. */
  listScopes(): VaultScope[];
  /** 모든 볼트에서 id 로 찾는다. */
  getHost(id: string): HostRecord | null;
  /** 모든 볼트의 호스트. 볼트 순서대로, 볼트 안에서는 저장소가 정렬한 대로다. */
  listHosts(): HostRecord[];
  /**
   * 그 호스트가 든 볼트.
   *
   * known hosts·tailnet 처럼 id 가 아닌 키로 찾는 것은 이 안에서 찾아야 한다 — 같은 주소가 개인과
   * 팀에 따로 있을 수 있다. 호스트를 못 찾으면(지워진 뒤 등) 개인이다.
   */
  scopeOfHost(hostId: string): VaultScope;
  /** 모든 볼트에서 `secret:*` 참조로 비밀값을 찾는다. */
  loadSecret(secretRef: string): Promise<string | null>;
  /**
   * 그 호스트가 든 볼트의 저장소로 쓰고, 돌려받은 레코드에 내 값을 얹는다. 사람마다 다른 값을 바꾸지
   * 않는 쓰기(감지한 OS·인증서 지문·비밀값 참조 등)에 쓴다.
   */
  writeHost<T extends HostRecord | null>(hostId: string, write: (hosts: HostRepository) => T): T;
  /** 호스트를 그 볼트에서 지운다 — 그 볼트의 삭제 대기열에 올리고 뺀다. */
  removeHost(id: string): void;
  /**
   * anchor 호스트와 같은 볼트에서만 찾는다(점프 호스트). 팀 레코드가 개인 호스트를 — 또는 그 반대를
   * — 점프로 가리켜도 따라가지 않는다.
   */
  getHostInSameVault(anchorHostId: string, id: string): HostRecord | null;
  /** 모든 볼트의 tailnet 설정(auth key 포함 — 팀 것은 내 auth key 가 먼저다). 코어에 넘길 때 쓴다. */
  listTailnetPayloads(): TailnetPayload[];
  /** 모든 볼트에서 포트 포워딩 규칙을 id 로 찾는다(켜고 끌 때). */
  getPortForward(id: string): PortForwardRuleRecord | null;
  /** 팀 호스트에 둔 내 자격 증명(멤버 개인 칸). 개인 호스트거나 없으면 null. */
  getMyHostCredentials(hostId: string): TeamHostCredentials | null;
  /** 팀 호스트에 내 자격 증명을 둔다(null 이면 지운다). 개인 호스트는 호스트의 비밀값을 쓰므로 던진다. */
  setMyHostCredentials(hostId: string, credentials: TeamHostCredentials | null): void;
  /**
   * SSH 로 붙을 사용자 이름을 둔다(요청 창·이름 묻는 창). 개인 호스트는 레코드에, 팀 호스트는 내 자격 증명에
   * 둔다 — 팀 레코드에 쓰면 팀 모두의 사용자 이름이 바뀐다. 팀 것과 같으면 내 칸에서 뺀다.
   */
  setHostLoginUsername(hostId: string, username: string): HostRecord | null;
  /** 팀 호스트면 내 개인 칸에만 둔다. */
  setHostFavorite(id: string, favorite: boolean): HostRecord | null;
  /** 팀 호스트면 이 기기에만 둔다. */
  setHostTerminalTheme(id: string, terminalThemeId: TerminalThemeId | null): HostRecord | null;
  /** 팀 호스트면 agent forwarding·테마를 떼어 내 칸에 두고 나머지만 팀 레코드로 저장한다. */
  updateHost(id: string, draft: HostDraft, secretRef?: string | null): HostRecord;
  /** vaultId 볼트에 호스트를 만든다(나누기는 updateHost 와 같다). 이 기기에 없는 볼트면 던진다. */
  createHost(vaultId: string, id: string, draft: HostDraft, secretRef?: string | null): HostRecord;
  /** 모든 볼트의 워크스페이스. 볼트 순서대로다. */
  listWorkspaces(): SavedWorkspaceRecord[];
  /** 팀 워크스페이스면 내 개인 칸에만 둔다. */
  setWorkspaceFavorite(id: string, favorite: boolean): SavedWorkspaceRecord;
  /** 팀 워크스페이스면 내 개인 칸에만 둔다. */
  touchWorkspaceOpened(id: string): SavedWorkspaceRecord;
}

/** SSH 호스트의 사용자 이름(앞뒤 공백 없이). 칸이 없으면 빈 글. */
function sshUsernameOf(host: HostRecord): string {
  return host.kind === "ssh" && typeof host.username === "string" ? host.username.trim() : "";
}

export function createVaultCatalog(
  personal: Omit<VaultScope, "id">,
  teams: TeamVaultSource = NO_TEAM_VAULTS,
): VaultCatalog {
  const personalScope: VaultScope = { id: PERSONAL_VAULT_ID, ...personal };
  // 저장소는 상태를 들고 있지 않아(읽을 때마다 상태 파일에서 찾는다) 팀마다 한 번 만들어 둔다.
  const teamScopes = new Map<string, TeamVaultScope>();
  const teamScope = (teamId: string): TeamVaultScope => {
    let scope = teamScopes.get(teamId);
    if (!scope) {
      scope = { id: teamId, ...teams.createScope(teamId) };
      teamScopes.set(teamId, scope);
    }
    return scope;
  };
  const listTeamScopes = (): TeamVaultScope[] =>
    teams
      .listTeamIds()
      .filter((teamId) => teamId !== PERSONAL_VAULT_ID)
      .map(teamScope);
  const listScopes = (): VaultScope[] => [personalScope, ...listTeamScopes()];

  /**
   * id 가 팀 볼트에만 든 경우 그 팀과 레코드. 개인에 있거나(개인이 이긴다) 어디에도 없으면 null 이고,
   * 부르는 쪽은 개인 저장소로 간다. 팀이 없으면 찾지도 않는다.
   */
  const findInTeam = <T>(
    find: (scope: VaultScope) => T | null,
  ): { scope: TeamVaultScope; record: T } | null => {
    const candidates = listTeamScopes();
    if (candidates.length === 0 || find(personalScope) !== null) {
      return null;
    }
    for (const scope of candidates) {
      const record = find(scope);
      if (record !== null) {
        return { scope, record };
      }
    }
    return null;
  };

  // 볼트 순서대로 합친다. id 가 겹치면 앞의 것(개인 → 먼저 있는 팀)만 남긴다.
  const listAcrossVaults = <T extends { id: string }>(
    list: (scope: VaultScope) => T[],
    overlay: (record: T, prefs: TeamMemberPrefs, scope: TeamVaultScope) => T,
  ): T[] => {
    const candidates = listTeamScopes();
    const personalRecords = list(personalScope);
    if (candidates.length === 0) {
      return personalRecords;
    }
    const seen = new Set(personalRecords.map((record) => record.id));
    const merged = [...personalRecords];
    for (const scope of candidates) {
      const prefs = scope.memberPrefs.read();
      for (const record of list(scope)) {
        if (!seen.has(record.id)) {
          seen.add(record.id);
          merged.push(overlay(record, prefs, scope));
        }
      }
    }
    return merged;
  };

  const findHostInTeam = (id: string) => findInTeam((scope) => scope.hosts.getById(id));

  /**
   * 팀 호스트에 내 값을 얹는다(즐겨찾기·agent forwarding·테마). 팀 레코드에 사용자 이름이 비어 있으면 내
   * 자격 증명의 사용자 이름을 채운다 — 화면은 레코드의 사용자 이름을 보고 묻는 창을 띄우므로, 안 채우면 내
   * 칸에 둔 이름이 있어도 붙을 때마다 다시 묻는다.
   */
  const overlayTeamHost = (
    scope: TeamVaultScope,
    record: HostRecord,
    prefs: TeamMemberPrefs = scope.memberPrefs.read(),
  ): HostRecord => {
    const host = overlayHostMemberPrefs(record, prefs);
    if (host.kind !== "ssh" || sshUsernameOf(host)) {
      return host;
    }
    const mine = scope.memberPrefs.readHostCredentials(host.id)?.username?.trim();
    return mine ? { ...host, username: mine } : host;
  };
  const findWorkspaceInTeam = (id: string) => findInTeam((scope) => scope.savedWorkspaces.getById(id));

  return {
    personal: personalScope,
    getScope: (vaultId) =>
      vaultId === PERSONAL_VAULT_ID
        ? personalScope
        : teams.listTeamIds().includes(vaultId)
          ? teamScope(vaultId)
          : null,
    listScopes,
    getHost: (id) => {
      for (const scope of listScopes()) {
        const host = scope.hosts.getById(id);
        if (host) {
          return scope.memberPrefs ? overlayTeamHost(scope as TeamVaultScope, host) : host;
        }
      }
      return null;
    },
    listHosts: () =>
      listAcrossVaults(
        (scope) => scope.hosts.list(),
        (record, prefs, scope) => overlayTeamHost(scope, record, prefs),
      ),
    scopeOfHost: (hostId) => findHostInTeam(hostId)?.scope ?? personalScope,
    loadSecret: async (secretRef) => {
      for (const scope of listScopes()) {
        const secret = await scope.secrets.load(secretRef);
        if (secret !== null) {
          return secret;
        }
      }
      return null;
    },
    writeHost: (hostId, write) => {
      const team = findHostInTeam(hostId);
      if (!team) {
        return write(personalScope.hosts);
      }
      const record = write(team.scope.hosts);
      return (record ? overlayTeamHost(team.scope, record) : record) as typeof record;
    },
    removeHost: (id) => {
      const scope = findHostInTeam(id)?.scope ?? personalScope;
      scope.syncOutbox.upsertDeletion("hosts", id);
      scope.hosts.remove(id);
    },
    getHostInSameVault: (anchorHostId, id) => {
      const team = findHostInTeam(anchorHostId);
      if (!team) {
        return personalScope.hosts.getById(id);
      }
      const host = team.scope.hosts.getById(id);
      return host ? overlayTeamHost(team.scope, host) : null;
    },
    getMyHostCredentials: (hostId) => findHostInTeam(hostId)?.scope.memberPrefs.readHostCredentials(hostId) ?? null,
    setMyHostCredentials: (hostId, credentials) => {
      const team = findHostInTeam(hostId);
      if (!team) {
        throw new Error(t("teams.myCredentialsTeamOnly"));
      }
      team.scope.memberPrefs.writeHostCredentials(hostId, credentials);
    },
    setHostLoginUsername: (hostId, username) => {
      const trimmed = username.trim();
      const team = findHostInTeam(hostId);
      if (!team) {
        return personalScope.hosts.setSshUsername(hostId, trimmed);
      }
      if (team.record.kind !== "ssh") {
        return overlayTeamHost(team.scope, team.record);
      }
      const current = team.scope.memberPrefs.readHostCredentials(hostId);
      const { username: _previous, ...rest } = current ?? {};
      const next: TeamHostCredentials =
        trimmed && trimmed !== sshUsernameOf(team.record) ? { ...rest, username: trimmed } : rest;
      if ((current?.username ?? "") !== (next.username ?? "")) {
        team.scope.memberPrefs.writeHostCredentials(hostId, Object.keys(next).length > 0 ? next : null);
      }
      return overlayTeamHost(team.scope, team.record);
    },
    getPortForward: (id) => {
      for (const scope of listScopes()) {
        const rule = scope.portForwards.getById(id);
        if (rule) {
          return rule;
        }
      }
      return null;
    },
    // 팀 tailnet 은 내 auth key 가 있으면 그것을 쓴다(내 것 → 팀 것). 이 목록은 코어에 넘기는 데만 쓴다 — 팀에
    // 올리는 것은 팀 저장소의 listPayloads() 라 내 키가 실리지 않는다.
    listTailnetPayloads: () =>
      listAcrossVaults(
        (scope) =>
          scope.tailnets.listPayloads().map((payload) => {
            const mine = scope.memberPrefs?.readTailnetCredentials(payload.id);
            return mine ? { ...payload, authKey: mine.authKey } : payload;
          }),
        (record) => record,
      ),
    setHostFavorite: (id, favorite) => {
      const team = findHostInTeam(id);
      if (!team) {
        return personalScope.hosts.setFavorite(id, favorite);
      }
      team.scope.memberPrefs.updateHost(id, { favorite });
      return overlayTeamHost(team.scope, team.record);
    },
    setHostTerminalTheme: (id, terminalThemeId) => {
      const team = findHostInTeam(id);
      if (!team) {
        return personalScope.hosts.setTerminalTheme(id, terminalThemeId);
      }
      team.scope.memberPrefs.setHostTerminalTheme(id, terminalThemeId);
      return overlayTeamHost(team.scope, team.record);
    },
    updateHost: (...args) => {
      const [id, draft, secretRef] = args;
      const team = findHostInTeam(id);
      if (!team) {
        // 받은 인자 그대로 넘긴다 — 개인 경로의 호출 모양을 바꾸지 않는다.
        return personalScope.hosts.update(...args);
      }
      const { teamDraft, hostPrefs, terminalThemeId } = splitHostDraftMemberPrefs(draft);
      // 팀 레코드에 사용자 이름이 비어 있으면 화면은 내 사용자 이름으로 채워 받는다(overlayTeamHost). 편집 창이
      // 그 값을 그대로 돌려보내도 팀 레코드에 쓰지 않는다 — 쓰면 내 이름이 팀 모두의 이름이 된다.
      const myUsername = team.scope.memberPrefs.readHostCredentials(id)?.username?.trim();
      const keepTeamUsername =
        teamDraft.kind === "ssh" &&
        team.record.kind === "ssh" &&
        !sshUsernameOf(team.record) &&
        Boolean(myUsername) &&
        teamDraft.username.trim() === myUsername;
      const record = team.scope.hosts.update(
        id,
        keepTeamUsername ? { ...teamDraft, username: "" } : teamDraft,
        secretRef,
      );
      team.scope.memberPrefs.updateHost(id, hostPrefs);
      team.scope.memberPrefs.setHostTerminalTheme(id, terminalThemeId);
      return overlayTeamHost(team.scope, record);
    },
    createHost: (vaultId, id, draft, secretRef) => {
      if (vaultId === PERSONAL_VAULT_ID) {
        return personalScope.hosts.create(id, draft, secretRef);
      }
      if (!teams.listTeamIds().includes(vaultId)) {
        throw new Error(t("teams.notOnDevice"));
      }
      const scope = teamScope(vaultId);
      const { teamDraft, hostPrefs, terminalThemeId } = splitHostDraftMemberPrefs(draft);
      const record = scope.hosts.create(id, teamDraft, secretRef);
      scope.memberPrefs.updateHost(id, hostPrefs);
      scope.memberPrefs.setHostTerminalTheme(id, terminalThemeId);
      return overlayTeamHost(scope, record);
    },
    listWorkspaces: () =>
      listAcrossVaults((scope) => scope.savedWorkspaces.list(), overlayWorkspaceMemberPrefs),
    setWorkspaceFavorite: (id, favorite) => {
      const team = findWorkspaceInTeam(id);
      if (!team) {
        return personalScope.savedWorkspaces.setFavorite(id, favorite);
      }
      team.scope.memberPrefs.updateWorkspace(id, { favorite });
      return overlayWorkspaceMemberPrefs(team.record, team.scope.memberPrefs.read());
    },
    touchWorkspaceOpened: (id) => {
      const team = findWorkspaceInTeam(id);
      if (!team) {
        return personalScope.savedWorkspaces.touchOpened(id);
      }
      team.scope.memberPrefs.updateWorkspace(id, { lastOpenedAt: new Date().toISOString() });
      return overlayWorkspaceMemberPrefs(team.record, team.scope.memberPrefs.read());
    },
  };
}
