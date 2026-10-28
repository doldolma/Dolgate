import { fromByteArray, toByteArray } from 'base64-js';
import {
  isTeamCryptoError,
  normalizeTeamHostCredentials,
  normalizeTeamHostPrefsRecord,
  sealTeamEventBody,
  startSyncWatchLoop,
  stripAwsProfileKeys,
  stripHostMemberPrefs,
  unwrapTeamDek,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type LoadedManagedSecretPayload,
  type ManagedAwsProfilePayload,
  type ServerInfoResponse,
  type SnippetRecord,
  type SyncPayloadV2,
  type SyncWatchLoop,
  type SyncWatchLoopOptions,
  type SyncWatchOutcome,
  type TailnetPayload,
  type TeamHostCredentials,
  type TeamHostPrefsRecord,
  type TeamRole,
  type TeamSummary,
  type TeamSyncPayload,
  type TeamWatchRevisions,
} from '@dolssh/shared-core';
import {
  ApiError,
  clearStoredTeamSecrets,
  decodeAwsProfiles,
  decodeGroups,
  decodeKnownHosts,
  decodeManagedSecrets,
  decodeSnippets,
  decodeSupportedHosts,
  decodeSyncRecords,
  decodeTailnets,
  encodeEncryptedPayload,
  fetchServerInfo,
  loadStoredTeamSecrets,
  normalizeSyncPayload,
  saveStoredTeamSecrets,
  type StoredTeamSecrets,
  type TeamAwsKey,
} from '../lib/mobile';
import {
  appendTeamEvents,
  fetchTeamPrivate,
  fetchTeamRecords,
  fetchTeams,
  putTeamPrivate,
  watchTeamChanges,
} from '../lib/team-api';

/*
 * 폰이 내 팀들을 받는다(작업 8-2). 팀마다 레코드와 내 개인 칸을 받아 팀마다 따로 담고(teamVaults), 감시(롱폴링)로
 * 바뀐 몫만 다시 받는다 — 데스크톱 main/team-sync-service.ts 의 받는 쪽이다. 폰이 팀에 올리는 것은 내 개인 칸
 * (작업 8-4: 별표·신뢰한 호스트 키·RDP 인증서·내 자격 증명)과 팀 기록 줄(작업 8-5, store/team-history.ts)뿐이다.
 * 팀 레코드는 고치지 않는다.
 *
 * 개인 목록(hosts 등)과 섞지 않는다. 개인 동기화는 목록을 통째로 올리고 갈아 끼우므로, 섞으면 팀 것이 개인 볼트로
 * 올라가거나 지워진다. 둘을 함께 찾는 것은 vault-catalog.ts 다.
 */

/** 그 팀을 지금 받을 수 있는가. ready 가 아니면 담아 둔 것은 마지막으로 받은 그대로다. */
export type MobileTeamState = 'ready' | 'needs-rejoin' | 'outdated' | 'error';

/** 내 개인 칸에서 폰이 고치는 종류. */
export type TeamPrivateKind = 'hostPrefs' | 'hostCredentials';

/** 아직 못 올린 내 개인 칸 변경(종류·id·그때 시각). 내용은 올릴 때 지금 것을 읽는다. */
export interface TeamPrivateOutboxEntry {
  kind: TeamPrivateKind;
  id: string;
  updatedAt: string;
}

/** 폰에 담아 둔 팀 하나. 비밀값은 빼고(키체인에 따로) 앱 저장소에 남는다. */
export interface MobileTeamVault {
  id: string;
  name: string;
  role: TeamRole;
  /** 내 개인 DEK 로 감싼 팀 키. 사본이 없으면 null — 데스크톱에서 링크로 다시 들어와야 한다. */
  wrappedTeamDek: string | null;
  state: MobileTeamState;
  errorMessage: string | null;
  hosts: HostRecord[];
  groups: GroupRecord[];
  knownHosts: KnownHostRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  tailnets: TailnetPayload[];
  snippets: SnippetRecord[];
  /** 내 개인 칸 — 팀 호스트마다 내 설정(별표·agent forwarding·신뢰한 호스트 키·RDP 인증서). */
  hostPrefs: TeamHostPrefsRecord[];
  /**
   * 내 자격 증명 레코드마다 마지막 시각. 서버는 레코드마다 나중 것만 받으므로 다음 쓰기는 이것보다 뒤여야 한다.
   * 자격 증명 자체는 키체인(teamSecrets)에 있다.
   */
  credentialsUpdatedAt?: Record<string, string>;
  /** 아직 못 올린 내 개인 칸 변경 — 오프라인이어도 남았다가 다음 받기 때 올라간다. */
  privateOutbox?: TeamPrivateOutboxEntry[];
}

/** 팀 하나의 비밀값과 내 자격 증명(키체인). */
export type MobileTeamSecrets = StoredTeamSecrets[string];

/** 팀 기록 한 줄(잠그기 전). 보낼 때 그 팀 키로 잠근다. */
export interface TeamEventDraft {
  id: string;
  createdAt: string;
  body: { v: number };
}

/**
 * 팀 기록 올리기의 결과. not-open 은 그 팀을 지금 열 수 없다(잠김·로그아웃·키를 푸는 중·멈춘 팀) — 남겼다가 팀 목록이
 * 바뀌면 다시 보낸다. gone 은 팀에서 빠졌다(팀은 지운다), unsupported 는 서버가 팀 기록을 모른다, rejected 는 서버가 이
 * 묶음을 받을 수 없다고 했다(400 — 다시 보내도 같다).
 */
export type TeamEventsOutcome =
  | 'sent'
  | 'not-open'
  | 'gone'
  | 'unsupported'
  | 'rejected';

/** 스토어에 두는 팀 칸. */
export interface TeamSyncSlice {
  teamVaults: MobileTeamVault[];
  teamSecrets: StoredTeamSecrets;
}

/** 팀 레코드를 받을 때 id 가 겹치는지 볼 개인 볼트 칸. */
export interface PersonalVaultRecords {
  hosts: HostRecord[];
  groups: GroupRecord[];
  knownHosts: KnownHostRecord[];
  awsProfiles: ManagedAwsProfilePayload[];
  tailnets: TailnetPayload[];
  snippets: SnippetRecord[];
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
}

export type TeamSyncStoreState = TeamSyncSlice & PersonalVaultRecords;

/** 지금 팀을 받을 수 있는 열쇠들. */
export interface TeamSyncAccess {
  serverUrl: string;
  accessToken: string;
  personalDekBase64: string;
  /** 개인 볼트의 epoch — 내 개인 칸을 올릴 때 세대 헤더로 단다(개인 올리기와 같다). */
  vaultEpoch: number;
  /** 개인 쪽 볼트 세대. 받는 사이 바뀌면(잠금·초기화·다른 DEK) 그 결과를 버린다. */
  generation: number;
}

export interface TeamSyncDeps {
  /** 팀을 받아도 되면 그 열쇠들, 아니면 null(로그아웃·잠김·옛 v1 볼트). */
  readAccess(): TeamSyncAccess | null;
  /** 401 을 받았을 때 토큰을 갱신하고 새 것을 준다. 못 하면 null. */
  refreshAccessToken(): Promise<string | null>;
  getState(): TeamSyncStoreState;
  setState(patch: Partial<TeamSyncSlice>): void;
  /** 감시는 앱이 앞에 있을 때만 돈다(배터리 — iOS 는 어차피 뒤에서 멈춘다). */
  isForeground(): boolean;
  /**
   * 팀을 이 기기에서 지우기 직전 — 그 팀 호스트의 열린 연결을 닫게 한다(데스크톱 onTeamForgotten 과 같다). 지운 뒤에는
   * 어느 호스트가 그 팀 것인지 모른다.
   */
  onTeamForgotten?(teamId: string, hostIds: ReadonlySet<string>): void;
  /** 시험용 — 감시 루프를 대신 돌린다. */
  startLoop?: (options: SyncWatchLoopOptions) => SyncWatchLoop;
}

export interface TeamSync {
  /**
   * 팀 목록을 다시 읽고 팀마다 받는다. 개인 동기화가 끝날 때(풀림·앞으로 옴·당기기) 부른다. 그 동기화가 읽은 서버
   * 정보를 넘기면 팀을 아는 서버인지 다시 묻지 않는다.
   */
  refresh(serverInfo?: ServerInfoResponse | null): Promise<void>;
  /** 감시를 멈춘다(앱이 뒤로 감). 받은 것은 그대로 둔다. */
  stop(): void;
  /** 다 지운다(로그아웃·볼트 초기화·계정 삭제). */
  purge(): Promise<void>;
  /** 키체인의 팀 비밀값을 읽어 온다(앱을 켤 때). */
  restoreSecrets(): Promise<void>;
  /** 돌던 것(감시·받는 중인 결과·서버 판정)을 다 내려놓는다. 담아 둔 것은 그대로다 — 계정 경계·시험용. */
  resetRuntime(): void;
  /**
   * 팀 호스트에 대한 내 설정을 고친다(별표·신뢰한 호스트 키·RDP 인증서). 폰에 먼저 반영하고 내 개인 칸에 올린다 —
   * 못 올리면 남겨 두었다가 다음 받기 때 올린다.
   */
  updateHostPrefs(
    teamId: string,
    hostId: string,
    change: (current: TeamHostPrefsRecord) => TeamHostPrefsRecord,
  ): void;
  /** 팀 호스트에 쓰는 내 자격 증명을 고친다(물어서 넣은 비밀값·사용자 이름). 키체인에 두고 내 개인 칸에 올린다. */
  updateHostCredentials(
    teamId: string,
    hostId: string,
    change: (current: TeamHostCredentials) => TeamHostCredentials,
  ): Promise<void>;
  /**
   * 팀 정적 AWS 프로필에 이 기기의 키를 둔다. 키체인에만 두고 어디로도 올리지 않는다 — 키는 기기마다 넣는다(데스크톱과
   * 같다). 팀에서 빠지거나 로그아웃하면 팀 비밀값과 함께 지워진다.
   */
  setAwsKey(teamId: string, profileId: string, key: TeamAwsKey): Promise<void>;
  /**
   * 팀 기록 줄을 그 팀 키로 잠가 올린다 — 그 팀 받기와 줄을 선다. 결과는 TeamEventsOutcome 이고, 그 밖의 실패(오프라인
   * 등)는 던진다 — 부르는 쪽이 남겼다가 다시 보낸다.
   */
  sendTeamEvents(
    teamId: string,
    events: TeamEventDraft[],
  ): Promise<TeamEventsOutcome>;
}

/** 다른 볼트(개인·다른 팀)가 이미 쓰는 레코드 id — 겹치는 팀 레코드는 버린다(개인이 이긴다, 설계안 4절). */
export interface TakenRecordIds {
  hosts: Set<string>;
  groups: Set<string>;
  knownHosts: Set<string>;
  awsProfiles: Set<string>;
  tailnets: Set<string>;
  snippets: Set<string>;
  secrets: Set<string>;
}

export interface DecodedTeamRecords {
  records: Pick<
    MobileTeamVault,
    'hosts' | 'groups' | 'knownHosts' | 'awsProfiles' | 'tailnets' | 'snippets'
  >;
  secretsByRef: Record<string, LoadedManagedSecretPayload>;
}

/**
 * 받은 팀 레코드를 푼다. 모바일이 아는 종류만 담고, 다른 볼트와 id 가 겹치는 것은 버린다. 사람마다 다른 값과
 * 사람의 키(AWS 정적 키·tailnet auth key·로그인한 계정)는 옛 앱이 섞어 올렸어도 담지 않는다 — 데스크톱
 * toStoredTeamRecords 와 같은 규칙이다.
 */
export function decodeTeamRecords(
  payload: TeamSyncPayload,
  teamDekBase64: string,
  taken: TakenRecordIds,
): DecodedTeamRecords {
  const normalized = normalizeSyncPayload(payload as Partial<SyncPayloadV2>);
  const free =
    (ids: Set<string>) =>
    <T extends { id: string }>(record: T) =>
      !ids.has(record.id);
  const secretsByRef: Record<string, LoadedManagedSecretPayload> = {};
  for (const [secretRef, secret] of Object.entries(
    decodeManagedSecrets(normalized, teamDekBase64),
  )) {
    if (!taken.secrets.has(secretRef)) {
      secretsByRef[secretRef] = secret;
    }
  }
  return {
    records: {
      hosts: decodeSupportedHosts(normalized, teamDekBase64)
        .filter(free(taken.hosts))
        .map(stripHostMemberPrefs)
        .sort(compareHosts),
      groups: decodeGroups(normalized, teamDekBase64).filter(
        free(taken.groups),
      ),
      knownHosts: decodeKnownHosts(normalized, teamDekBase64).filter(
        free(taken.knownHosts),
      ),
      awsProfiles: decodeAwsProfiles(normalized, teamDekBase64)
        .filter(free(taken.awsProfiles))
        .map(stripAwsProfileKeys),
      tailnets: decodeTailnets(normalized, teamDekBase64)
        .filter(free(taken.tailnets))
        .map(({ authKey: _person, ...tailnet }) => {
          const { loginName: _theirs, ...shared } =
            tailnet as TailnetPayload & {
              loginName?: string;
            };
          return shared;
        }),
      snippets: decodeSnippets(normalized, teamDekBase64).filter(
        free(taken.snippets),
      ),
    },
    secretsByRef,
  };
}

/** 받은 내 개인 칸을 푼다(내 개인 DEK). 모르는 모양은 버린다. */
export function decodeTeamPrivate(
  payload: TeamSyncPayload,
  personalDekBase64: string,
): {
  hostPrefs: TeamHostPrefsRecord[];
  hostCredentials: Record<string, TeamHostCredentials>;
  credentialsUpdatedAt: Record<string, string>;
} {
  const hostPrefs = decodeSyncRecords<unknown>(
    payload.hostPrefs ?? [],
    personalDekBase64,
  )
    .map(normalizeTeamHostPrefsRecord)
    .filter((record): record is TeamHostPrefsRecord => record !== null);
  const hostCredentials: Record<string, TeamHostCredentials> = {};
  const credentialsUpdatedAt: Record<string, string> = {};
  for (const value of decodeSyncRecords<unknown>(
    payload.hostCredentials ?? [],
    personalDekBase64,
  )) {
    const record =
      value && typeof value === 'object'
        ? (value as {
            id?: unknown;
            updatedAt?: unknown;
            credentials?: unknown;
          })
        : null;
    const credentials = normalizeTeamHostCredentials(record?.credentials);
    if (typeof record?.id === 'string' && record.id && credentials) {
      hostCredentials[record.id] = credentials;
      if (typeof record.updatedAt === 'string') {
        credentialsUpdatedAt[record.id] = record.updatedAt;
      }
    }
  }
  return { hostPrefs, hostCredentials, credentialsUpdatedAt };
}

/** 그 팀 호스트에 내 설정이 아직 없을 때의 빈 레코드. */
function emptyHostPrefs(
  hostId: string,
  updatedAt: string,
): TeamHostPrefsRecord {
  return {
    id: hostId,
    favorite: null,
    agentForwarding: null,
    rdpCertificateFingerprint: null,
    knownHosts: [],
    updatedAt,
  };
}

/** 다음 쓰기 시각 — 지금, 단 그 레코드의 마지막 시각보다는 뒤다(서버는 나중 것만 받는다 — 데스크톱과 같다). */
function nextUpdatedAt(previous: string | undefined): string {
  const now = Date.now();
  const known = previous ? Date.parse(previous) : Number.NaN;
  return new Date(
    Number.isFinite(known) && known >= now ? known + 1 : now,
  ).toISOString();
}

/** 정적 프로필의 id — 이 기기에서 넣은 팀 AWS 키는 이것들에만 남긴다. */
function staticProfileIds(profiles: ManagedAwsProfilePayload[]): Set<string> {
  return new Set(
    profiles
      .filter(profile => profile.kind === 'static')
      .map(profile => profile.id),
  );
}

function outboxKey(entry: TeamPrivateOutboxEntry): string {
  return `${entry.kind}\u0000${entry.id}\u0000${entry.updatedAt}`;
}

function compareHosts(left: HostRecord, right: HostRecord): number {
  return (
    left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  );
}

const EMPTY_SECRETS: MobileTeamSecrets = {
  secretsByRef: {},
  hostCredentials: {},
};

interface WatchParts {
  records: boolean;
  info: boolean;
  private: boolean;
}

const RECORDS_AND_PRIVATE: WatchParts = {
  records: true,
  info: false,
  private: true,
};

interface TeamRuntime {
  teamId: string;
  dekBase64: string;
  generation: number;
  recordsEtag: string | null;
  privateEtag: string | null;
  watch: {
    etag: string | null;
    seen: TeamWatchRevisions | null;
    pending: {
      etag: string | null;
      seen: TeamWatchRevisions;
      parts: WatchParts;
    } | null;
  };
  loop: SyncWatchLoop | null;
  /** 같은 팀의 받기는 줄을 선다. */
  tail: Promise<unknown>;
}

function emptyVault(team: TeamSummary): MobileTeamVault {
  return {
    id: team.id,
    name: team.name,
    role: team.role,
    wrappedTeamDek: team.wrappedTeamDek,
    state: 'ready',
    errorMessage: null,
    hosts: [],
    groups: [],
    knownHosts: [],
    awsProfiles: [],
    tailnets: [],
    snippets: [],
    hostPrefs: [],
  };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 스토어에 저장할 팀 칸(비밀값 빼고). 앱 저장소에 남긴다. */
export function teamVaultsForPersist(
  state: Pick<TeamSyncSlice, 'teamVaults'>,
): Pick<TeamSyncSlice, 'teamVaults'> {
  return { teamVaults: state.teamVaults };
}

export function createTeamSync(deps: TeamSyncDeps): TeamSync {
  const runtimes = new Map<string, TeamRuntime>();
  const startLoop = deps.startLoop ?? startSyncWatchLoop;
  // history: 서버가 팀 기록을 아는가. 정보를 못 읽은 옛 서버면 보내 본다.
  let teamsSupport: {
    serverUrl: string;
    supported: boolean;
    history: boolean;
  } | null = null;
  let refreshing: Promise<void> | null = null;
  // 키체인 쓰기는 줄을 세운다 — 늦게 끝난 옛 쓰기가 새 것을 덮지 않게, 늘 지금 상태를 쓴다.
  let secretsWrite: Promise<void> = Promise.resolve();

  const vaults = () => deps.getState().teamVaults;

  const isLive = (access: TeamSyncAccess, runtime?: TeamRuntime): boolean => {
    const now = deps.readAccess();
    return (
      now !== null &&
      now.generation === access.generation &&
      now.serverUrl === access.serverUrl &&
      (!runtime || runtimes.get(runtime.teamId) === runtime)
    );
  };

  const persistSecrets = (): Promise<void> => {
    secretsWrite = secretsWrite
      .catch(() => undefined)
      .then(() => saveStoredTeamSecrets(deps.getState().teamSecrets));
    return secretsWrite;
  };

  const patchVault = (teamId: string, patch: Partial<MobileTeamVault>) => {
    const current = vaults();
    if (!current.some(vault => vault.id === teamId)) {
      return;
    }
    deps.setState({
      teamVaults: current.map(vault =>
        vault.id === teamId ? { ...vault, ...patch } : vault,
      ),
    });
  };

  const patchSecrets = (
    teamId: string,
    patch: Partial<MobileTeamSecrets>,
  ): Promise<void> => {
    const current = deps.getState().teamSecrets;
    deps.setState({
      teamSecrets: {
        ...current,
        [teamId]: { ...(current[teamId] ?? EMPTY_SECRETS), ...patch },
      },
    });
    return persistSecrets();
  };

  /** 그 팀 말고 다른 볼트(개인·다른 팀)에 있는 레코드 id. */
  const takenOutside = (teamId: string): TakenRecordIds => {
    const state = deps.getState();
    const taken: TakenRecordIds = {
      hosts: new Set(state.hosts.map(record => record.id)),
      groups: new Set(state.groups.map(record => record.id)),
      knownHosts: new Set(state.knownHosts.map(record => record.id)),
      awsProfiles: new Set(state.awsProfiles.map(record => record.id)),
      tailnets: new Set(state.tailnets.map(record => record.id)),
      snippets: new Set(state.snippets.map(record => record.id)),
      secrets: new Set(Object.keys(state.secretsByRef)),
    };
    for (const vault of state.teamVaults) {
      if (vault.id === teamId) {
        continue;
      }
      for (const record of vault.hosts) taken.hosts.add(record.id);
      for (const record of vault.groups) taken.groups.add(record.id);
      for (const record of vault.knownHosts) taken.knownHosts.add(record.id);
      for (const record of vault.awsProfiles) taken.awsProfiles.add(record.id);
      for (const record of vault.tailnets) taken.tailnets.add(record.id);
      for (const record of vault.snippets) taken.snippets.add(record.id);
      for (const secretRef of Object.keys(
        state.teamSecrets[vault.id]?.secretsByRef ?? {},
      )) {
        taken.secrets.add(secretRef);
      }
    }
    return taken;
  };

  /** 401 이면 토큰을 한 번 갱신해 다시 부른다. 이번 회차의 다음 요청도 새 토큰을 쓴다. */
  const withAuth = async <T>(
    access: TeamSyncAccess,
    call: (accessToken: string) => Promise<T>,
  ): Promise<T> => {
    try {
      return await call(access.accessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      const accessToken = await deps.refreshAccessToken();
      if (!accessToken) {
        throw error;
      }
      access.accessToken = accessToken;
      return call(accessToken);
    }
  };

  const stopRuntime = (teamId: string) => {
    const runtime = runtimes.get(teamId);
    runtime?.loop?.stop();
    runtimes.delete(teamId);
  };

  /** 그 팀 호스트의 열린 연결을 닫게 한다 — 팀을 지우기 직전에. */
  const closeTeamConnections = (vault: MobileTeamVault) => {
    if (vault.hosts.length > 0) {
      deps.onTeamForgotten?.(
        vault.id,
        new Set(vault.hosts.map(host => host.id)),
      );
    }
  };

  const forgetTeam = (teamId: string) => {
    stopRuntime(teamId);
    const state = deps.getState();
    const vault = state.teamVaults.find(item => item.id === teamId);
    if (vault) {
      closeTeamConnections(vault);
    }
    const { [teamId]: _gone, ...teamSecrets } = state.teamSecrets;
    deps.setState({
      teamVaults: state.teamVaults.filter(vault => vault.id !== teamId),
      teamSecrets,
    });
    void persistSecrets().catch(() => undefined);
  };

  /** 팀 하나의 실패. 팀에서 빠졌거나(404) 앱이 낡았으면(426) 그 팀을 멈추고 true. */
  const settleFailure = (teamId: string, error: unknown): boolean => {
    if (error instanceof ApiError && error.code === 'team_not_found') {
      forgetTeam(teamId);
      return true;
    }
    if (error instanceof ApiError && error.code === 'team_client_outdated') {
      stopRuntime(teamId);
      patchVault(teamId, { state: 'outdated', errorMessage: error.message });
      return true;
    }
    patchVault(teamId, { state: 'error', errorMessage: errorMessageOf(error) });
    return false;
  };

  const pullRecords = async (access: TeamSyncAccess, runtime: TeamRuntime) => {
    const result = await withAuth(access, accessToken =>
      fetchTeamRecords(
        access.serverUrl,
        accessToken,
        runtime.teamId,
        runtime.recordsEtag,
      ),
    );
    if (!isLive(access, runtime) || result.notModified) {
      return;
    }
    const decoded = decodeTeamRecords(
      result.payload,
      runtime.dekBase64,
      takenOutside(runtime.teamId),
    );
    patchVault(runtime.teamId, decoded.records);
    // 팀이 지운 정적 프로필의 키는 이 기기에도 남기지 않는다.
    const staticIds = staticProfileIds(decoded.records.awsProfiles);
    const awsKeys = deps.getState().teamSecrets[runtime.teamId]?.awsKeys ?? {};
    const keptKeys = Object.entries(awsKeys).filter(([profileId]) =>
      staticIds.has(profileId),
    );
    await patchSecrets(runtime.teamId, {
      secretsByRef: decoded.secretsByRef,
      ...(keptKeys.length < Object.keys(awsKeys).length
        ? { awsKeys: Object.fromEntries(keptKeys) }
        : {}),
    });
    runtime.recordsEtag = result.etag;
  };

  const pullPrivate = async (access: TeamSyncAccess, runtime: TeamRuntime) => {
    const result = await withAuth(access, accessToken =>
      fetchTeamPrivate(
        access.serverUrl,
        accessToken,
        runtime.teamId,
        runtime.privateEtag,
      ),
    );
    if (!isLive(access, runtime) || result.notModified) {
      return;
    }
    const decoded = decodeTeamPrivate(result.payload, access.personalDekBase64);
    // 아직 못 올린 내 변경은 받은 것으로 덮지 않는다 — 다음 차례에 올린 뒤 받는다(데스크톱과 같다).
    const vault = vaults().find(item => item.id === runtime.teamId);
    const pending = vault?.privateOutbox ?? [];
    const pendingIds = (kind: TeamPrivateKind) =>
      new Set(
        pending.filter(entry => entry.kind === kind).map(entry => entry.id),
      );
    const pendingPrefs = pendingIds('hostPrefs');
    const pendingCredentials = pendingIds('hostCredentials');
    const localCredentials =
      deps.getState().teamSecrets[runtime.teamId]?.hostCredentials ?? {};
    const hostCredentials = { ...decoded.hostCredentials };
    const credentialsUpdatedAt = { ...decoded.credentialsUpdatedAt };
    for (const hostId of pendingCredentials) {
      const local = localCredentials[hostId];
      const localUpdatedAt = vault?.credentialsUpdatedAt?.[hostId];
      if (local && localUpdatedAt) {
        hostCredentials[hostId] = local;
        credentialsUpdatedAt[hostId] = localUpdatedAt;
      }
    }
    patchVault(runtime.teamId, {
      hostPrefs: [
        ...decoded.hostPrefs.filter(record => !pendingPrefs.has(record.id)),
        ...(vault?.hostPrefs ?? []).filter(record =>
          pendingPrefs.has(record.id),
        ),
      ],
      credentialsUpdatedAt,
    });
    await patchSecrets(runtime.teamId, { hostCredentials });
    runtime.privateEtag = result.etag;
  };

  /** 못 올린 내 개인 칸 변경을 올린다(바뀐 레코드만, 내 개인 DEK 로 잠가). 올리는 사이 다시 고친 것은 남긴다. */
  const pushPrivate = async (access: TeamSyncAccess, teamId: string) => {
    const vault = vaults().find(item => item.id === teamId);
    const outbox = vault?.privateOutbox ?? [];
    if (!vault || outbox.length === 0) {
      return;
    }
    const credentials =
      deps.getState().teamSecrets[teamId]?.hostCredentials ?? {};
    const payload: TeamSyncPayload = {};
    for (const entry of outbox) {
      const value =
        entry.kind === 'hostPrefs'
          ? vault.hostPrefs.find(record => record.id === entry.id)
          : credentials[entry.id]
            ? {
                id: entry.id,
                updatedAt: entry.updatedAt,
                credentials: credentials[entry.id],
              }
            : undefined;
      if (value) {
        (payload[entry.kind] ??= []).push({
          id: entry.id,
          encrypted_payload: encodeEncryptedPayload(
            value,
            access.personalDekBase64,
          ),
          updated_at: entry.updatedAt,
        });
      }
    }
    if (Object.keys(payload).length > 0) {
      await withAuth(access, accessToken =>
        putTeamPrivate(
          access.serverUrl,
          accessToken,
          teamId,
          payload,
          access.vaultEpoch,
        ),
      );
    }
    if (!isLive(access)) {
      return;
    }
    const sent = new Set(outbox.map(outboxKey));
    const latest = vaults().find(item => item.id === teamId);
    if (latest) {
      patchVault(teamId, {
        privateOutbox: (latest.privateOutbox ?? []).filter(
          entry => !sent.has(outboxKey(entry)),
        ),
      });
    }
  };

  /**
   * 올리기 실패 — 팀에서 빠졌거나(404) 앱이 낡았으면(426) 그 팀을 멈춘다. 그 밖(오프라인·다른 기기의 볼트 초기화로
   * 세대 거절)은 남겨 두고 다음 받기 때 다시 올린다. 받기를 막지 않는다.
   */
  const pushPrivateQuietly = async (
    access: TeamSyncAccess,
    runtime: TeamRuntime,
  ) => {
    try {
      await pushPrivate(access, runtime.teamId);
    } catch (error) {
      if (!isLive(access, runtime)) {
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === 'team_not_found' ||
          error.code === 'team_client_outdated')
      ) {
        settleFailure(runtime.teamId, error);
        return;
      }
      console.warn(
        '[team-sync] kept my team settings for the next upload',
        errorMessageOf(error),
      );
    }
  };

  /** 지금 올린다 — 그 팀의 받기와 줄을 선다. 받을 수 없으면(잠김·멈춘 팀) 다음 받기에 맡긴다. */
  const drainPrivate = (teamId: string): Promise<void> => {
    const runtime = runtimes.get(teamId);
    if (!runtime) {
      return Promise.resolve();
    }
    const result = runtime.tail.then(async () => {
      const access = deps.readAccess();
      if (
        !access ||
        access.generation !== runtime.generation ||
        !isLive(access, runtime)
      ) {
        return;
      }
      await pushPrivateQuietly(access, runtime);
    });
    runtime.tail = result.catch(() => undefined);
    return result;
  };

  /** 내 개인 칸 변경을 줄에 넣는다(같은 레코드의 앞선 것은 바꾼다). */
  const queuePrivate = (
    teamId: string,
    entry: TeamPrivateOutboxEntry,
    patch: Partial<MobileTeamVault>,
  ) => {
    const vault = vaults().find(item => item.id === teamId);
    if (!vault) {
      return;
    }
    patchVault(teamId, {
      ...patch,
      privateOutbox: [
        ...(vault.privateOutbox ?? []).filter(
          item => item.kind !== entry.kind || item.id !== entry.id,
        ),
        entry,
      ],
    });
  };

  const runSyncTeam = async (
    runtime: TeamRuntime,
    parts: WatchParts,
  ): Promise<boolean> => {
    const access = deps.readAccess();
    if (!access || access.generation !== runtime.generation) {
      return false;
    }
    if (!isLive(access, runtime)) {
      return false;
    }
    try {
      // 못 올린 내 변경을 먼저 올린다 — 받은 것이 그것을 덮기 전에.
      await pushPrivateQuietly(access, runtime);
      if (!isLive(access, runtime)) {
        return false;
      }
      if (parts.records) {
        await pullRecords(access, runtime);
      }
      if (parts.private) {
        await pullPrivate(access, runtime);
      }
      if (isLive(access, runtime)) {
        patchVault(runtime.teamId, { state: 'ready', errorMessage: null });
      }
      return true;
    } catch (error) {
      if (!isLive(access, runtime)) {
        return false;
      }
      settleFailure(runtime.teamId, error);
      return false;
    }
  };

  const syncTeam = (runtime: TeamRuntime, parts: WatchParts) => {
    const result = runtime.tail.then(() => runSyncTeam(runtime, parts));
    runtime.tail = result.catch(() => undefined);
    return result;
  };

  const watchTeam = async (
    runtime: TeamRuntime,
    signal: AbortSignal,
  ): Promise<SyncWatchOutcome> => {
    const access = deps.readAccess();
    if (
      !access ||
      access.generation !== runtime.generation ||
      runtimes.get(runtime.teamId) !== runtime
    ) {
      // 잠겼거나 로그아웃했거나 이 팀이 멈췄다. 다음 refresh(볼트를 다시 열 때의 개인 당기기)가 새로 시작한다.
      runtime.loop?.stop();
      runtime.loop = null;
      return 'unchanged';
    }
    try {
      const result = await withAuth(access, accessToken =>
        watchTeamChanges(
          access.serverUrl,
          accessToken,
          runtime.teamId,
          runtime.watch.etag,
          signal,
        ),
      );
      if (!result.changed) {
        return 'unchanged';
      }
      const seen = runtime.watch.seen;
      runtime.watch.pending = {
        etag: result.etag,
        seen: result.revisions,
        // 처음 받은 값이면 레코드와 개인 칸을 당긴다. 팀 정보는 방금 목록에서 읽었다.
        parts: seen
          ? {
              records: result.revisions.revision !== seen.revision,
              info: result.revisions.infoRevision !== seen.infoRevision,
              private:
                result.revisions.privateRevision !== seen.privateRevision,
            }
          : { ...RECORDS_AND_PRIVATE },
      };
      return 'changed';
    } catch (error) {
      if (signal.aborted || !isLive(access, runtime)) {
        return 'unchanged';
      }
      if (settleFailure(runtime.teamId, error)) {
        return 'unchanged';
      }
      throw error;
    }
  };

  const applyWatchChange = async (runtime: TeamRuntime): Promise<boolean> => {
    const pending = runtime.watch.pending;
    if (!pending) {
      return true;
    }
    if (pending.parts.info) {
      await refresh();
      if (runtimes.get(runtime.teamId) !== runtime) {
        // 키가 바뀌었거나 팀에서 빠졌다 — 새 루프(또는 없음)가 이어받는다.
        return true;
      }
    }
    if (pending.parts.records || pending.parts.private) {
      if (!(await syncTeam(runtime, pending.parts))) {
        return false;
      }
    }
    runtime.watch.etag = pending.etag;
    runtime.watch.seen = pending.seen;
    runtime.watch.pending = null;
    return true;
  };

  const ensureLoop = (runtime: TeamRuntime) => {
    if (
      runtime.loop ||
      !deps.isForeground() ||
      runtimes.get(runtime.teamId) !== runtime
    ) {
      return;
    }
    runtime.loop = startLoop({
      watch: signal => watchTeam(runtime, signal),
      onChange: () => applyWatchChange(runtime),
    });
  };

  /** 팀 키를 풀어 받기를 시작한다. 처음 여는 팀은 받은 뒤에 돌아온다. */
  const openTeam = async (access: TeamSyncAccess, team: TeamSummary) => {
    if (!team.wrappedTeamDek) {
      stopRuntime(team.id);
      patchVault(team.id, { state: 'needs-rejoin', errorMessage: null });
      return;
    }
    let dekBase64: string;
    try {
      dekBase64 = fromByteArray(
        unwrapTeamDek(
          team.wrappedTeamDek,
          toByteArray(access.personalDekBase64),
          team.id,
        ),
      );
    } catch (error) {
      if (!isTeamCryptoError(error)) {
        throw error;
      }
      // 초기화 전 DEK 로 감싼 사본 등. 그 팀만 멈추고 다른 팀과 개인 동기화는 그대로 간다.
      stopRuntime(team.id);
      patchVault(team.id, {
        state: 'needs-rejoin',
        errorMessage: error.message,
      });
      return;
    }
    const existing = runtimes.get(team.id);
    if (
      existing &&
      existing.dekBase64 === dekBase64 &&
      existing.generation === access.generation
    ) {
      ensureLoop(existing);
      // 이미 연 팀은 감시가 바뀐 것을 받는다. 못 올린 내 변경(오프라인에서 돌아옴)은 감시가 깨우지 않으므로 여기서
      // 올린다 — refresh 는 개인 동기화가 끝날 때마다 불린다.
      await drainPrivate(team.id);
      return;
    }
    stopRuntime(team.id);
    const runtime: TeamRuntime = {
      teamId: team.id,
      dekBase64,
      generation: access.generation,
      recordsEtag: null,
      privateEtag: null,
      watch: { etag: null, seen: null, pending: null },
      loop: null,
      tail: Promise.resolve(),
    };
    runtimes.set(team.id, runtime);
    await syncTeam(runtime, RECORDS_AND_PRIVATE);
    ensureLoop(runtime);
  };

  const isTeamsSupported = async (access: TeamSyncAccess): Promise<boolean> => {
    if (teamsSupport?.serverUrl !== access.serverUrl) {
      let supported = true;
      let history = true;
      try {
        const info = await fetchServerInfo(access.serverUrl);
        supported = info.capabilities?.teams?.enabled === true;
        history = Boolean(info.capabilities?.teams?.history);
      } catch {
        // 정보를 못 읽으면(옛 서버의 /api/info 없음 등) 팀 목록을 한 번 물어보고 판정한다.
      }
      teamsSupport = { serverUrl: access.serverUrl, supported, history };
    }
    return teamsSupport.supported;
  };

  const runRefresh = async () => {
    const access = deps.readAccess();
    if (!access) {
      stop();
      return;
    }
    if (!(await isTeamsSupported(access))) {
      return;
    }
    let teams: TeamSummary[];
    try {
      teams = await withAuth(access, accessToken =>
        fetchTeams(access.serverUrl, accessToken),
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        [404, 405, 501].includes(error.status ?? 0)
      ) {
        // 팀을 모르는 서버다(옛 자체 호스팅).
        teamsSupport = {
          serverUrl: access.serverUrl,
          supported: false,
          history: false,
        };
        return;
      }
      throw error;
    }
    if (!isLive(access)) {
      return;
    }
    const listed = new Set(teams.map(team => team.id));
    for (const vault of vaults()) {
      if (!listed.has(vault.id)) {
        forgetTeam(vault.id);
      }
    }
    const current = vaults();
    deps.setState({
      teamVaults: teams.map(team => {
        const known = current.find(vault => vault.id === team.id);
        return known
          ? {
              ...known,
              name: team.name,
              role: team.role,
              wrappedTeamDek: team.wrappedTeamDek,
            }
          : emptyVault(team);
      }),
    });
    for (const team of teams) {
      try {
        await openTeam(access, team);
      } catch (error) {
        if (!isLive(access)) {
          return;
        }
        // 한 팀이 실패해도 다른 팀은 연다.
        patchVault(team.id, {
          state: 'error',
          errorMessage: errorMessageOf(error),
        });
      }
    }
  };

  function refresh(serverInfo?: ServerInfoResponse | null): Promise<void> {
    const access = serverInfo ? deps.readAccess() : null;
    if (serverInfo && access) {
      teamsSupport = {
        serverUrl: access.serverUrl,
        supported: serverInfo.capabilities?.teams?.enabled === true,
        history: Boolean(serverInfo.capabilities?.teams?.history),
      };
    }
    if (!refreshing) {
      refreshing = runRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  function stop(): void {
    for (const runtime of runtimes.values()) {
      runtime.loop?.stop();
      runtime.loop = null;
    }
  }

  function resetRuntime(): void {
    for (const teamId of [...runtimes.keys()]) {
      stopRuntime(teamId);
    }
    teamsSupport = null;
  }

  async function purge(): Promise<void> {
    resetRuntime();
    // 볼트 초기화 — 서버가 나를 모든 팀에서 뺐다. 팀 호스트의 열린 연결도 닫는다(빠진 팀과 같다).
    for (const vault of vaults()) {
      closeTeamConnections(vault);
    }
    deps.setState({ teamVaults: [], teamSecrets: {} });
    await secretsWrite.catch(() => undefined);
    await clearStoredTeamSecrets();
  }

  async function restoreSecrets(): Promise<void> {
    const stored = await loadStoredTeamSecrets();
    const known = new Set(vaults().map(vault => vault.id));
    const teamSecrets: StoredTeamSecrets = {};
    for (const [teamId, secrets] of Object.entries(stored)) {
      if (known.has(teamId)) {
        teamSecrets[teamId] = {
          secretsByRef: secrets?.secretsByRef ?? {},
          hostCredentials: secrets?.hostCredentials ?? {},
          ...(secrets?.awsKeys ? { awsKeys: secrets.awsKeys } : {}),
        };
      }
    }
    // 받기가 그 사이 새로 채운 팀은 그대로 둔다.
    deps.setState({
      teamSecrets: { ...teamSecrets, ...deps.getState().teamSecrets },
    });
  }

  function updateHostPrefs(
    teamId: string,
    hostId: string,
    change: (current: TeamHostPrefsRecord) => TeamHostPrefsRecord,
  ): void {
    const vault = vaults().find(item => item.id === teamId);
    if (!vault) {
      return;
    }
    const current = vault.hostPrefs.find(record => record.id === hostId);
    const updatedAt = nextUpdatedAt(current?.updatedAt);
    const next: TeamHostPrefsRecord = {
      ...change(current ?? emptyHostPrefs(hostId, updatedAt)),
      id: hostId,
      updatedAt,
    };
    queuePrivate(
      teamId,
      { kind: 'hostPrefs', id: hostId, updatedAt },
      {
        hostPrefs: [
          ...vault.hostPrefs.filter(record => record.id !== hostId),
          next,
        ],
      },
    );
    void drainPrivate(teamId);
  }

  async function updateHostCredentials(
    teamId: string,
    hostId: string,
    change: (current: TeamHostCredentials) => TeamHostCredentials,
  ): Promise<void> {
    const vault = vaults().find(item => item.id === teamId);
    if (!vault) {
      return;
    }
    const secrets = deps.getState().teamSecrets[teamId] ?? EMPTY_SECRETS;
    const next = normalizeTeamHostCredentials(
      change(secrets.hostCredentials[hostId] ?? {}),
    );
    if (!next) {
      return;
    }
    const updatedAt = nextUpdatedAt(vault.credentialsUpdatedAt?.[hostId]);
    queuePrivate(
      teamId,
      { kind: 'hostCredentials', id: hostId, updatedAt },
      {
        credentialsUpdatedAt: {
          ...vault.credentialsUpdatedAt,
          [hostId]: updatedAt,
        },
      },
    );
    await patchSecrets(teamId, {
      hostCredentials: { ...secrets.hostCredentials, [hostId]: next },
    });
    void drainPrivate(teamId);
  }

  async function setAwsKey(
    teamId: string,
    profileId: string,
    key: TeamAwsKey,
  ): Promise<void> {
    if (!vaults().some(vault => vault.id === teamId)) {
      return;
    }
    await patchSecrets(teamId, {
      awsKeys: {
        ...deps.getState().teamSecrets[teamId]?.awsKeys,
        [profileId]: key,
      },
    });
  }

  function sendTeamEvents(
    teamId: string,
    events: TeamEventDraft[],
  ): Promise<TeamEventsOutcome> {
    const runtime = runtimes.get(teamId);
    if (!runtime) {
      return Promise.resolve('not-open');
    }
    const result = runtime.tail.then(async (): Promise<TeamEventsOutcome> => {
      const access = deps.readAccess();
      if (
        !access ||
        access.generation !== runtime.generation ||
        !isLive(access, runtime)
      ) {
        return 'not-open';
      }
      if (
        teamsSupport?.serverUrl === access.serverUrl &&
        !teamsSupport.history
      ) {
        return 'unsupported';
      }
      const teamDek = toByteArray(runtime.dekBase64);
      const uploads = events.map(event => ({
        id: event.id,
        createdAt: event.createdAt,
        payload: sealTeamEventBody(teamDek, teamId, event.id, event.body),
      }));
      try {
        await withAuth(access, accessToken =>
          appendTeamEvents(access.serverUrl, accessToken, teamId, uploads),
        );
        return 'sent';
      } catch (error) {
        if (!isLive(access, runtime)) {
          return 'not-open';
        }
        if (error instanceof ApiError && error.code === 'team_not_found') {
          forgetTeam(teamId);
          return 'gone';
        }
        if (
          error instanceof ApiError &&
          error.code === 'team_client_outdated'
        ) {
          settleFailure(teamId, error);
          throw error;
        }
        if (error instanceof ApiError && error.status === 400) {
          return 'rejected';
        }
        throw error;
      }
    });
    runtime.tail = result.catch(() => undefined);
    return result;
  }

  return {
    refresh,
    stop,
    purge,
    restoreSecrets,
    resetRuntime,
    updateHostPrefs,
    updateHostCredentials,
    setAwsKey,
    sendTeamEvents,
  };
}
