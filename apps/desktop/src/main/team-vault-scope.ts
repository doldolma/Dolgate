import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  canEditTeamVault,
  type KnownHostRecord,
  type KnownHostTrustInput,
  type ManagedAwsProfilePayload,
  type TailnetPayload,
  type TailnetRecord,
  type TerminalThemeId,
} from "@shared";
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
  normalizeTailnetScope,
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
  stripAwsProfileKeys,
  TEAM_MEMBER_CREDENTIAL_NORMALIZERS,
  type TeamHostCredentials,
  type TeamMemberPrefs,
  type TeamMemberPrefsStore,
} from "./team-member-prefs";
import type { TeamVaultScope, TeamVaultSource, VaultSecretStore } from "./vault-catalog";
import { teamVaultRoot } from "./vault-root";

/** 그 팀을 이 사람이 고칠 수 있는지(이 기기에 적힌 역할 — 멤버 이상). 없는 팀이면 아니다. */
function canEditStoredTeam(teamId: string): boolean {
  const role = getDesktopStateStorage().getTeamState(teamId)?.info.role;
  return role ? canEditTeamVault(role) : false;
}

/** undefined 칸을 뺀다 — 같은지 견줄 때 "칸이 없다"와 "칸이 undefined"를 같게 본다. */
function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

/**
 * 팀 볼트의 호스트 키.
 *
 * 접속해서 확인만 한 시각(`lastSeenAt`)은 남기지 않는다. 남기면 멤버 누구든 접속만 해도 팀 레코드가 바뀌어, 이전
 * 판이 쌓이고 모든 멤버의 감시가 깨어난다.
 *
 * 읽기 전용 멤버는 팀 레코드를 쓰지 못한다. 그 사람이 접속하며 신뢰한 키는 그 호스트의 내 칸(hostPrefs.knownHosts)에
 * 두고, 찾을 때 팀 것과 함께 본다 — 같은 키 자리면 내 것이 먼저다(내가 확인한 것이다). 목록(list)은 팀 것만이다:
 * 팀 동기화가 그것을 올리므로 내 것이 섞이면 팀으로 샌다.
 */
class TeamKnownHostRepository extends KnownHostRepository {
  constructor(
    private readonly teamId: string,
    private readonly memberPrefs: TeamMemberPrefsStore,
  ) {
    super(teamVaultRoot(teamId));
  }

  touch(): void {}

  getByHostPort(host: string, port: number): KnownHostRecord | null {
    return this.mine().find((record) => record.host === host && record.port === port) ?? super.getByHostPort(host, port);
  }

  getByHostPortAlgorithm(host: string, port: number, algorithm: string, tailnetId?: string): KnownHostRecord | null {
    const scope = normalizeTailnetScope(tailnetId);
    return (
      this.mine().find(
        (record) =>
          normalizeTailnetScope(record.tailnetId) === scope &&
          record.host === host &&
          record.port === port &&
          record.algorithm === algorithm,
      ) ?? super.getByHostPortAlgorithm(host, port, algorithm, tailnetId)
    );
  }

  listByHostPort(host: string, port: number, tailnetId?: string): KnownHostRecord[] {
    const scope = normalizeTailnetScope(tailnetId);
    const mine = this.mine().filter(
      (record) => normalizeTailnetScope(record.tailnetId) === scope && record.host === host && record.port === port,
    );
    const algorithms = new Set(mine.map((record) => record.algorithm));
    const team = super.listByHostPort(host, port, tailnetId).filter((record) => !algorithms.has(record.algorithm));
    return [...mine, ...team].sort((left, right) => left.algorithm.localeCompare(right.algorithm));
  }

  trust(input: KnownHostTrustInput): KnownHostRecord {
    if (canEditStoredTeam(this.teamId)) {
      return super.trust(input);
    }
    const scope = normalizeTailnetScope(input.tailnetId);
    const sameKeySlot = (record: KnownHostRecord) =>
      normalizeTailnetScope(record.tailnetId) === scope &&
      record.host === input.host &&
      record.port === input.port &&
      record.algorithm === input.algorithm;
    const kept = this.memberPrefs.read().hosts.get(input.hostId)?.knownHosts ?? [];
    const current = kept.find(sameKeySlot);
    const timestamp = new Date().toISOString();
    const record: KnownHostRecord = {
      id: current?.id ?? randomUUID(),
      ...(scope ? { tailnetId: scope } : {}),
      host: input.host,
      port: input.port,
      algorithm: input.algorithm,
      publicKeyBase64: input.publicKeyBase64,
      fingerprintSha256: input.fingerprintSha256,
      createdAt: current?.createdAt ?? timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    };
    this.memberPrefs.updateHost(input.hostId, { knownHosts: [...kept.filter((entry) => !sameKeySlot(entry)), record] });
    return record;
  }

  remove(id: string): void {
    for (const prefs of this.memberPrefs.read().hosts.values()) {
      if (prefs.knownHosts.some((record) => record.id === id)) {
        this.memberPrefs.updateHost(prefs.id, { knownHosts: prefs.knownHosts.filter((record) => record.id !== id) });
        return;
      }
    }
    super.remove(id);
  }

  /** 내 칸에 둔 호스트 키(읽기 전용일 때 신뢰한 것). */
  private mine(): KnownHostRecord[] {
    return [...this.memberPrefs.read().hosts.values()].flatMap((prefs) => prefs.knownHosts);
  }
}

/**
 * 팀 볼트의 tailnet. 로그인한 계정(loginName)은 기기마다라 이 기기 칸에 두고 읽을 때만 얹는다 — 팀에 올리면 멤버마다
 * 자기 계정으로 공유 레코드를 서로 덮어쓴다.
 *
 * auth key 는 개인 저장소와 똑같이 이 볼트에 둔다. 팀에 올리지 않을 뿐이다 — 올릴 때 빼고 받을 때 이 기기 것을
 * 지키는 것은 팀 동기화가 한다(stripTailnetAuthKey). 그래서 여기서는 키를 따로 다루지 않는다.
 */
class TeamTailnetRepository extends TailnetRepository {
  constructor(private readonly teamId: string) {
    super(teamVaultRoot(teamId));
  }

  /**
   * 이 기기에서 보이는 모양 — 로그인 계정과 키가 있는지(hasAuthKey)는 이 기기 것이다. 받은 팀 레코드에는 키가 없다고
   * 적혀 오므로 레코드 값을 믿지 않는다.
   */
  list(): TailnetRecord[] {
    const loginNames = getDesktopStateStorage().readTeamTailnetLoginNames(this.teamId);
    return super.list().map(({ loginName: _stored, ...record }) => {
      const here = { ...record, hasAuthKey: this.readAuthKey(record.id) !== null };
      return loginNames[record.id] ? { ...here, loginName: loginNames[record.id] } : here;
    });
  }

  save(record: TailnetRecord, authKey?: string): TailnetRecord {
    const { loginName, ...shared } = record;
    getDesktopStateStorage().setTeamTailnetLoginName(this.teamId, record.id, loginName ?? null);
    const current = super.list().find((item) => item.id === record.id);
    if (current && sameTailnetSettings(current, shared)) {
      // 설정이 그대로면 팀 레코드는 두고 이 기기의 키만 바꾼다 — 읽기 전용 멤버도 자기 키를 넣고, 키만 바꿔도 팀에
      // 새 판이 생기지 않는다.
      if (authKey !== undefined) {
        this.setAuthKey(record.id, authKey);
      }
    } else {
      super.save(shared, authKey);
    }
    return this.list().find((item) => item.id === record.id) ?? record;
  }

  remove(id: string): void {
    super.remove(id);
    getDesktopStateStorage().setTeamTailnetLoginName(this.teamId, id, null);
  }

  /** 이 기기의 계정은 싣지 않는다 — 코어에는 필요 없고, 팀에 올라가면 안 된다. */
  listPayloads(): TailnetPayload[] {
    return super.listPayloads().map(({ loginName: _mine, ...payload }) => payload);
  }
}

/** 팀 tailnet 의 설정이 같은지 — 이 기기의 것(키가 있는지·계정)과 시각은 보지 않는다. */
function sameTailnetSettings(current: TailnetRecord, next: TailnetRecord): boolean {
  const settings = ({
    hasAuthKey: _key,
    loginName: _login,
    createdAt: _created,
    updatedAt: _updated,
    ephemeral: _ephemeral,
    ...rest
  }: TailnetRecord) => definedFields(rest);
  return isDeepStrictEqual(settings(current), settings(next));
}

/**
 * 팀 볼트의 AWS 프로필. 정적 키는 이 기기에만 둔다(팀에 올리지 않는다) — 그래서 설정은 그대로 두고 키만 바꾸면 팀
 * 레코드를 건드리지 않는다. 읽기 전용 멤버도 자기 키를 넣고, 멤버가 키만 바꿔도 팀에 새 판이 생기지 않는다.
 */
class TeamAwsProfileRepository extends AwsProfileRepository {
  constructor(private readonly teamId: string) {
    super(teamVaultRoot(teamId));
  }

  upsert(payload: ManagedAwsProfilePayload): ManagedAwsProfilePayload {
    const current = this.getPayloadById(payload.id);
    const next: ManagedAwsProfilePayload = { ...payload, name: payload.name.trim() };
    if (current && sameAwsProfileSettings(current, next)) {
      const kept = { ...next, updatedAt: current.updatedAt };
      getDesktopStateStorage().writeManagedAwsProfileValue(kept.id, encodeSecretForStorage(JSON.stringify(kept)), this.teamId);
      return kept;
    }
    return super.upsert(payload);
  }
}

/** 팀 AWS 프로필의 설정이 같은지 — 정적 키와 시각은 보지 않는다. */
function sameAwsProfileSettings(current: ManagedAwsProfilePayload, next: ManagedAwsProfilePayload): boolean {
  const settings = (payload: ManagedAwsProfilePayload) => {
    const { updatedAt: _updated, ...rest } = stripAwsProfileKeys(payload);
    return definedFields(rest);
  };
  return isDeepStrictEqual(settings(current), settings(next));
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
    tailnets: new TeamTailnetRepository(teamId),
    portForwards: new PortForwardRepository(root),
    dnsOverrides: new DnsOverrideRepository(root),
    snippets: new SnippetRepository(root),
    savedWorkspaces: new SavedWorkspaceRepository(root),
    knownHosts: new TeamKnownHostRepository(teamId, memberPrefs),
    secretMetadata: new SecretMetadataRepository(root),
    // 정적 프로필의 키도 개인 저장소와 똑같이 이 볼트에 둔다. 팀에 올리지 않는 것은 팀 동기화가 한다(stripAwsProfileKeys).
    awsProfiles: new TeamAwsProfileRepository(teamId),
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
    canEdit: canEditStoredTeam,
  };
}

/**
 * 상태 파일에 있는 팀들의 관리 AWS 프로필. AWS 서비스가 펼치기와 접속 때 개인 것 다음으로 본다. 정적 프로필의 키는
 * 이 기기에 넣어 둔 것이다(팀에는 올라가지 않는다) — 없으면 비어 있고, AWS 서비스가 키를 넣으라고 알린다.
 */
export function listStoredTeamAwsProfiles(): TeamManagedAwsProfiles[] {
  return getDesktopStateStorage()
    .listTeamIds()
    .map((teamId) => ({ teamId, payloads: createTeamVaultScope(teamId).awsProfiles.listPayloads() }));
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
