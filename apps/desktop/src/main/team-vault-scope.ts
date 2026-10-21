import type { ManagedAwsProfilePayload, TailnetPayload, TailnetRecord, TerminalThemeId } from "@shared";
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
import type { TeamManagedAwsProfiles } from "./aws-service";
import type { DnsOverrideVault } from "./hosts-override-manager";
import { decodeSecretFromStorage, encodeSecretForStorage } from "./secret-store";
import {
  getDesktopStateStorage,
  type TeamHostPrefsPatch,
  type TeamPrivateSecretKind,
  type TeamWorkspacePrefsPatch,
} from "./state-storage";
import {
  normalizeTeamAwsProfileCredentials,
  stripAwsProfileKeys,
  TEAM_MEMBER_CREDENTIAL_NORMALIZERS,
  type TeamAwsProfileCredentials,
  type TeamHostCredentials,
  type TeamMemberPrefs,
  type TeamMemberPrefsStore,
  type TeamTailnetCredentials,
} from "./team-member-prefs";
import type { TeamVaultScope, TeamVaultSource, VaultSecretStore } from "./vault-catalog";
import { teamVaultRoot } from "./vault-root";

/**
 * 팀 볼트의 호스트 키는 접속해서 확인만 한 시각(`lastSeenAt`)을 남기지 않는다. 남기면 멤버 누구든
 * 접속만 해도 팀 레코드가 바뀌어, 이전 판이 쌓이고 모든 멤버의 감시가 깨어난다.
 */
class TeamKnownHostRepository extends KnownHostRepository {
  touch(): void {}
}

/**
 * 팀 볼트의 tailnet 은 사람 것을 레코드에 두지 않는다.
 * - 로그인한 계정(loginName)은 기기마다라 이 기기 칸에 두고 읽을 때만 얹는다 — 팀에 올리면 멤버마다 자기
 *   계정으로 공유 레코드를 서로 덮어쓴다.
 * - auth key 는 그 사람 기기를 tailnet 에 넣는 인증 정보라 내 개인 칸에 둔다. 코어에 넘길 때 카탈로그가 얹는다.
 */
class TeamTailnetRepository extends TailnetRepository {
  constructor(
    private readonly teamId: string,
    private readonly mine: TeamMemberPrefsStore,
  ) {
    super(teamVaultRoot(teamId));
  }

  /**
   * 이 기기의 사람에게 보이는 모양 — 로그인 계정은 이 기기 것을, 키가 있는지(hasAuthKey)는 내 auth key 가
   * 있는지를 얹는다. auth key 는 늘 각자 내 칸에 두므로 팀 레코드의 값은 쓰지 않는다.
   */
  list(): TailnetRecord[] {
    const loginNames = getDesktopStateStorage().readTeamTailnetLoginNames(this.teamId);
    return super.list().map(({ loginName: _stored, ...record }) => {
      const mine = { ...record, hasAuthKey: this.mine.readTailnetCredentials(record.id) !== null };
      return loginNames[record.id] ? { ...mine, loginName: loginNames[record.id] } : mine;
    });
  }

  save(record: TailnetRecord, authKey?: string): TailnetRecord {
    const { loginName, ...shared } = record;
    getDesktopStateStorage().setTeamTailnetLoginName(this.teamId, record.id, loginName ?? null);
    // undefined 면 지금 키를 그대로 둔다(개인 저장소와 같은 뜻). 빈 값이면 내 칸에서 지운다.
    if (authKey !== undefined) {
      const trimmed = authKey.trim();
      this.mine.writeTailnetCredentials(record.id, trimmed ? { authKey: trimmed } : null);
    }
    // 팀 비밀 칸에는 키를 두지 않는다 — 늘 지운다.
    super.save(shared, "");
    return this.list().find((item) => item.id === record.id) ?? record;
  }

  remove(id: string): void {
    super.remove(id);
    getDesktopStateStorage().setTeamTailnetLoginName(this.teamId, id, null);
    this.mine.writeTailnetCredentials(id, null);
  }

  /** 시험·연결에 쓸 키 — 팀 것은 늘 내 auth key 다(팀 칸에는 키를 두지 않는다). */
  readAuthKey(id: string): string | null {
    return this.mine.readTailnetCredentials(id)?.authKey ?? null;
  }

  /** 팀에 올리는 것 — 이 기기의 계정도, auth key 도 싣지 않는다. */
  listPayloads(): TailnetPayload[] {
    return super
      .listPayloads()
      .map(({ loginName: _mine, authKey: _person, ...payload }) => ({ ...payload, hasAuthKey: false }));
  }
}

/**
 * 팀 볼트의 AWS 프로필. 정적 프로필의 키는 사람의 인증 정보라 팀 레코드에 두지 않고 내 개인 칸에 둔다 — 팀에는
 * 이름·리전 같은 설정만 간다. 이 기기에서 펼칠 때는 내 키를 얹는다(listStoredTeamAwsProfiles).
 */
class TeamAwsProfileRepository extends AwsProfileRepository {
  constructor(
    teamId: string,
    private readonly mine: TeamMemberPrefsStore,
  ) {
    super(teamVaultRoot(teamId));
  }

  upsert(payload: ManagedAwsProfilePayload): ManagedAwsProfilePayload {
    if (payload.kind === "static") {
      const keys = normalizeTeamAwsProfileCredentials(payload);
      if (keys) {
        this.mine.writeAwsProfileCredentials(payload.id, keys);
      }
    }
    return super.upsert(stripAwsProfileKeys(payload));
  }

  remove(id: string): void {
    super.remove(id);
    this.mine.writeAwsProfileCredentials(id, null);
  }

  /** 팀 쪽에 키가 남아 있어도(옛 데이터) 읽을 때 뺀다. 목록(listPayloads)도 이것을 거친다. */
  getPayloadById(id: string): ManagedAwsProfilePayload | null {
    const payload = super.getPayloadById(id);
    return payload ? stripAwsProfileKeys(payload) : null;
  }
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

  readHostCredentials(hostId: string): TeamHostCredentials | null {
    return this.readSecret("hostCredentials", hostId);
  }

  writeHostCredentials(hostId: string, credentials: TeamHostCredentials | null): void {
    this.writeSecret("hostCredentials", hostId, credentials);
  }

  readAwsProfileCredentials(profileId: string): TeamAwsProfileCredentials | null {
    return this.readSecret("awsProfileCredentials", profileId);
  }

  writeAwsProfileCredentials(profileId: string, credentials: TeamAwsProfileCredentials | null): void {
    this.writeSecret("awsProfileCredentials", profileId, credentials);
  }

  readTailnetCredentials(tailnetId: string): TeamTailnetCredentials | null {
    return this.readSecret("tailnetCredentials", tailnetId);
  }

  writeTailnetCredentials(tailnetId: string, credentials: TeamTailnetCredentials | null): void {
    this.writeSecret("tailnetCredentials", tailnetId, credentials);
  }

  private readSecret<K extends TeamPrivateSecretKind>(
    kind: K,
    recordId: string,
  ): ReturnType<(typeof TEAM_MEMBER_CREDENTIAL_NORMALIZERS)[K]> {
    const stored = getDesktopStateStorage().readTeamPrivateSecret(this.teamId, kind, recordId);
    const json = stored ? decodeSecretFromStorage(stored) : null;
    return (json ? TEAM_MEMBER_CREDENTIAL_NORMALIZERS[kind](JSON.parse(json)) : null) as ReturnType<
      (typeof TEAM_MEMBER_CREDENTIAL_NORMALIZERS)[K]
    >;
  }

  private writeSecret(kind: TeamPrivateSecretKind, recordId: string, credentials: object | null): void {
    const normalized = credentials ? TEAM_MEMBER_CREDENTIAL_NORMALIZERS[kind](credentials) : null;
    getDesktopStateStorage().writeTeamPrivateSecret(
      this.teamId,
      kind,
      recordId,
      normalized ? encodeSecretForStorage(JSON.stringify(normalized)) : null,
    );
  }
}

export function createTeamVaultScope(teamId: string): Omit<TeamVaultScope, "id"> {
  const root = teamVaultRoot(teamId);
  const memberPrefs = new StoredTeamMemberPrefs(teamId);
  return {
    hosts: new HostRepository(root),
    groups: new GroupRepository(root),
    tailnets: new TeamTailnetRepository(teamId, memberPrefs),
    portForwards: new PortForwardRepository(root),
    dnsOverrides: new DnsOverrideRepository(root),
    snippets: new SnippetRepository(root),
    savedWorkspaces: new SavedWorkspaceRepository(root),
    knownHosts: new TeamKnownHostRepository(root),
    secretMetadata: new SecretMetadataRepository(root),
    awsProfiles: new TeamAwsProfileRepository(teamId, memberPrefs),
    syncOutbox: new SyncOutboxRepository(root),
    secrets: new TeamSecretStore(teamId),
    memberPrefs,
  };
}

/** 상태 파일(state.teams)에 있는 팀 볼트들. 부를 때마다 읽으므로 팀이 생기고 빠지는 것을 따라간다. */
export function createStoredTeamVaults(): TeamVaultSource {
  return {
    listTeamIds: () => getDesktopStateStorage().listTeamIds(),
    createScope: createTeamVaultScope,
  };
}

/**
 * 상태 파일에 있는 팀들의 관리 AWS 프로필. AWS 서비스가 펼치기와 접속 때 개인 것 다음으로 본다. 정적
 * 프로필은 내 키가 있으면 그것을 얹는다(내 것 → 팀 것). 이 목록은 이 기기에서 펼치는 데만 쓴다 — 팀에
 * 올리는 것은 저장소의 `listPayloads()` 라 내 키가 실리지 않는다.
 */
export function listStoredTeamAwsProfiles(): TeamManagedAwsProfiles[] {
  return getDesktopStateStorage()
    .listTeamIds()
    .map((teamId) => {
      const scope = createTeamVaultScope(teamId);
      return {
        teamId,
        payloads: scope.awsProfiles.listPayloads().map((payload) => {
          const mine = payload.kind === "static" ? scope.memberPrefs.readAwsProfileCredentials(payload.id) : null;
          return mine && payload.kind === "static" ? { ...payload, ...mine } : payload;
        }),
      };
    });
}

/** 상태 파일에 있는 팀들의 DNS 덮어쓰기와 포트 포워딩 규칙. 적용할 때 개인 것 뒤에 둔다. */
export function listStoredTeamDnsOverrideVaults(): DnsOverrideVault[] {
  return getDesktopStateStorage()
    .listTeamIds()
    .map((teamId) => {
      const scope = createTeamVaultScope(teamId);
      return { overrides: scope.dnsOverrides.list(), rules: scope.portForwards.list() };
    });
}
