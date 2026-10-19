import type { TerminalThemeId } from "@shared";
import {
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
import { decodeSecretFromStorage, encodeSecretForStorage } from "./secret-store";
import {
  getDesktopStateStorage,
  type TeamHostPrefsPatch,
  type TeamWorkspacePrefsPatch,
} from "./state-storage";
import type { TeamMemberPrefs, TeamMemberPrefsStore } from "./team-member-prefs";
import type { TeamVaultScope, TeamVaultSource, VaultSecretStore } from "./vault-catalog";
import { teamVaultRoot } from "./vault-root";

/**
 * 팀 볼트의 호스트 키는 접속해서 확인만 한 시각(`lastSeenAt`)을 남기지 않는다. 남기면 멤버 누구든
 * 접속만 해도 팀 레코드가 바뀌어, 이전 판이 쌓이고 모든 멤버의 감시가 깨어난다.
 */
class TeamKnownHostRepository extends KnownHostRepository {
  touch(): void {}
}

/** 팀 볼트 하나의 비밀값. 개인 SecretStore 와 같은 방식(safeStorage)으로 잠가 그 팀 칸에 둔다. */
class TeamSecretStore implements VaultSecretStore {
  constructor(private readonly teamId: string) {}

  async load(secretRef: string): Promise<string | null> {
    const record = getDesktopStateStorage().readTeamSecret(this.teamId, secretRef);
    return record ? decodeSecretFromStorage(record) : null;
  }

  async save(secretRef: string, secret: string): Promise<string> {
    getDesktopStateStorage().writeTeamSecret(this.teamId, secretRef, encodeSecretForStorage(secret));
    return secretRef;
  }

  async remove(secretRef: string): Promise<void> {
    getDesktopStateStorage().deleteTeamSecret(this.teamId, secretRef);
  }
}

/** 팀 볼트 하나에서 사람마다 다른 값. 멤버 개인 칸과 이 기기의 테마를 그 팀 칸에 둔다. */
class StoredTeamMemberPrefs implements TeamMemberPrefsStore {
  constructor(private readonly teamId: string) {}

  read(): TeamMemberPrefs {
    const snapshot = getDesktopStateStorage().readTeamMemberPrefs(this.teamId);
    return {
      hosts: new Map((snapshot?.hostPrefs ?? []).map((record) => [record.id, record])),
      workspaces: new Map((snapshot?.workspacePrefs ?? []).map((record) => [record.id, record])),
      terminalThemeByHostId: snapshot?.terminalThemeByHostId ?? {},
    };
  }

  updateHost(hostId: string, patch: TeamHostPrefsPatch): void {
    getDesktopStateStorage().updateTeamHostPrefs(this.teamId, hostId, patch);
  }

  updateWorkspace(workspaceId: string, patch: TeamWorkspacePrefsPatch): void {
    getDesktopStateStorage().updateTeamWorkspacePrefs(this.teamId, workspaceId, patch);
  }

  setHostTerminalTheme(hostId: string, terminalThemeId: TerminalThemeId | null): void {
    getDesktopStateStorage().setTeamHostTerminalTheme(this.teamId, hostId, terminalThemeId);
  }
}

export function createTeamVaultScope(teamId: string): Omit<TeamVaultScope, "id"> {
  const root = teamVaultRoot(teamId);
  return {
    hosts: new HostRepository(root),
    groups: new GroupRepository(root),
    tailnets: new TailnetRepository(root),
    portForwards: new PortForwardRepository(root),
    dnsOverrides: new DnsOverrideRepository(root),
    snippets: new SnippetRepository(root),
    savedWorkspaces: new SavedWorkspaceRepository(root),
    knownHosts: new TeamKnownHostRepository(root),
    secretMetadata: new SecretMetadataRepository(root),
    awsProfiles: new AwsProfileRepository(root),
    syncOutbox: new SyncOutboxRepository(root),
    secrets: new TeamSecretStore(teamId),
    memberPrefs: new StoredTeamMemberPrefs(teamId),
  };
}

/** 상태 파일(state.teams)에 있는 팀 볼트들. 부를 때마다 읽으므로 팀이 생기고 빠지는 것을 따라간다. */
export function createStoredTeamVaults(): TeamVaultSource {
  return {
    listTeamIds: () => getDesktopStateStorage().listTeamIds(),
    createScope: createTeamVaultScope,
  };
}
