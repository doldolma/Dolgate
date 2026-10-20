import {
  collectGroupPaths,
  deriveTeamInviteJoinToken,
  isKnownHostKind,
  isTeamCryptoError,
  materializeImplicitHostGroups,
  normalizeSavedWorkspaceRecord,
  normalizeServerUrl,
  openTeamInviteBox,
  parseTeamInviteLink,
  startSyncWatchLoop,
  SYNC_WATCH_CLIENT_TIMEOUT_MS,
  unwrapTeamDek,
  wrapTeamDek,
  type DnsOverrideRecord,
  type GroupRecord,
  type HostRecord,
  type KnownHostRecord,
  type ManagedAwsProfilePayload,
  type ManagedSecretPayload,
  type PortForwardRuleRecord,
  type SavedWorkspaceRecord,
  type SnippetRecord,
  type SyncRecord,
  type SyncWatchLoop,
  type SyncWatchLoopOptions,
  type SyncWatchOutcome,
  type TailnetPayload,
} from "@shared";
import type { AuthSyncContext } from "./auth-service";
import { normalizeTailnetPayloadForStorage } from "./database";
import { t } from "./i18n";
import { decodeSecretFromStorage, encodeSecretForStorage } from "./secret-store";
import {
  getDesktopStateStorage,
  normalizeTeamHostPrefsRecord,
  normalizeTeamWorkspacePrefsRecord,
  TEAM_PRIVATE_SECRET_KINDS,
  type StoredEncryptedValue,
  type SyncDeletionRecord,
  type TeamHostPrefsRecord,
  type TeamMemberPrefsSnapshot,
  type TeamPrivateSecretKind,
  type TeamPrivateSecretRecord,
  type TeamWorkspacePrefsRecord,
} from "./state-storage";
import {
  collectRenamedGroupPaths,
  decodeEncryptedPayload,
  encodeEncryptedPayload,
  rebaseSavedWorkspaceGroups,
  secretMetadataFromSyncedSecret,
} from "./sync-service";
import {
  isTeamApiError,
  TeamApi,
  TeamLeaseExpiredError,
  type TeamApiAuth,
  type TeamRequestLease,
  type TeamSummary,
  type TeamSyncPayload,
  type TeamWatchRevisions,
} from "./team-api";
import {
  stripAwsProfileKeys,
  stripHostMemberPrefs,
  stripWorkspaceMemberPrefs,
  TEAM_MEMBER_CREDENTIAL_NORMALIZERS,
} from "./team-member-prefs";
import { createTeamVaultScope } from "./team-vault-scope";
import type { TeamVaultScope, VaultSecretStore } from "./vault-catalog";
import { TeamVaultNotFoundError } from "./vault-root";

/*
 * 팀 볼트 동기화. 팀마다 따로 받고 올리며, 개인 동기화(sync-service.ts)와는 키·저장 자리·감시가 모두
 * 따로다. 개인 동기화의 코드는 건드리지 않고 같은 규칙(봉투 암호화·인증 리스·토큰 갱신)만 빌려 쓴다.
 *
 * - 팀 목록(GET /teams): 개인 pull 이 적용될 때마다 다시 읽는다. 팀 목록이 바뀌면 서버가 개인 리비전을
 *   올리므로 개인 감시가 깨어나 개인 pull 이 돈다. 팀 감시가 "팀 정보 바뀜"을 알릴 때도 읽는다.
 * - 팀 키: 각 팀의 사본을 내 개인 DEK 로 풀어 메모리에만 둔다. 안 풀리면 그 팀만 멈춘다.
 * - 팀마다 감시 루프 하나(메인에서 돈다). 레코드·팀 정보·내 개인 칸 가운데 바뀐 것만 다시 받는다.
 * - 올리기는 서버 사본보다 새 레코드만 보낸다. 통째로 올리면 암호문이 매번 달라져(IV) 서버가 모든
 *   레코드를 새로 쓴 것으로 보고, 팀원 모두를 깨우며 이전 판을 쌓는다.
 * - 받은 것은 그 사이 로컬에서 고친 것이 없을 때만 담는다. 고친 것이 있으면 그것부터 올리는 다음
 *   차례에 받는다 — 덮어 버리면 방금 고친 것이 사라진다.
 */

type DesktopStateStorage = ReturnType<typeof getDesktopStateStorage>;

/**
 * 팀 데이터 형식. 팀을 아는 앱은 모두 이 형식을 다룬다. 옛 앱이 모르는 것을 팀에 담게 되면 그때 2 를
 * 정의하고(서버 teamDataFloorMinimumVersions 와 함께) 그것이 있을 때 2 를 싣는다.
 */
export const TEAM_SYNC_DATA_FLOOR = 1;

/** 참여 중 링크(사본을 올리기 전에 끊기면 이것으로 마저 들어간다)를 두는 앱 비밀값 계정. */
export function pendingTeamJoinAccount(teamId: string): string {
  return `team-join:${teamId}`;
}

export type TeamSyncState = "ready" | "needs-rejoin" | "outdated" | "error";

export interface TeamSyncStatus {
  state: TeamSyncState;
  errorMessage: string | null;
}

export interface TeamSyncAuth extends TeamApiAuth {
  getState(): { status: string };
  getVaultStatus(): string;
  captureSyncContext(): AuthSyncContext;
  isSyncContextCurrent(context: AuthSyncContext): boolean;
}

/**
 * 팀을 쓸 수 있는 계정·볼트면 그 동기화 컨텍스트, 아니면 null. 팀은 E2EE(v2) 볼트가 열려 있어야
 * 한다 — 팀 키를 감쌀 개인 DEK 를 서버가 몰라야 하고, 그 DEK 의 세대를 서버에 알려야 한다.
 */
export function captureTeamContext(auth: TeamSyncAuth): AuthSyncContext | null {
  if (process.env.DOLSSH_E2E_DISABLE_SYNC === "1") {
    return null;
  }
  if (auth.getState().status !== "authenticated" || auth.getVaultStatus() !== "unlocked") {
    return null;
  }
  try {
    const context = auth.captureSyncContext();
    return context.vaultEpoch === null ? null : context;
  } catch {
    return null;
  }
}

export interface TeamSyncServiceOptions {
  auth: TeamSyncAuth;
  /** 참여 중 링크를 두는 곳(앱 비밀값). */
  secretStore: Pick<VaultSecretStore, "load" | "save" | "remove">;
  /** 팀 목록이나 팀 데이터가 바뀌었다 — 화면을 다시 읽히고, 코어에 tailnet 설정을 다시 알린다. */
  onChanged?: () => void;
  api?: TeamApi;
  storage?: DesktopStateStorage;
  /** 시험용. */
  startWatchLoop?: (options: SyncWatchLoopOptions) => SyncWatchLoop;
}

interface TeamLease extends TeamRequestLease {
  personalKeyBase64: string;
}

interface SnapshotCursor {
  etag: string | null;
  /** 마지막으로 받은 서버 사본의 레코드별 시각(`kind\0id` → ms). 올릴 것을 가르는 기준이다. */
  baseline: Map<string, number> | null;
}

interface WatchParts {
  records: boolean;
  info: boolean;
  private: boolean;
}

interface TeamRuntime {
  teamId: string;
  dekBase64: string;
  scope: Omit<TeamVaultScope, "id">;
  abort: AbortController;
  records: SnapshotCursor;
  private: SnapshotCursor;
  watch: {
    etag: string | null;
    seen: TeamWatchRevisions | null;
    // 받은 변경은 당기기에 성공한 뒤에야 "본 것"으로 적는다 — 실패하면 다음 대기가 바로 다시 알린다.
    pending: { etag: string | null; seen: TeamWatchRevisions; parts: WatchParts } | null;
  };
  loop: SyncWatchLoop | null;
  tail: Promise<unknown>;
  /** 줄에 서 있는(아직 시작 전) 올리기 차례. 시작하면 비운다 — 그 뒤의 변경은 새 차례를 연다. */
  queuedPush: Promise<void> | null;
}

const RECORDS_AND_PRIVATE: WatchParts = { records: true, info: false, private: true };

function nowIso(): string {
  return new Date().toISOString();
}

function baselineKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function buildBaseline(payload: TeamSyncPayload): Map<string, number> {
  const baseline = new Map<string, number>();
  for (const [kind, records] of Object.entries(payload)) {
    for (const record of records ?? []) {
      baseline.set(baselineKey(kind, record.id), Date.parse(record.updated_at));
    }
  }
  return baseline;
}

/** 서버 사본보다 새 것만 모은다. 서버에 없거나 서버 것보다 나중에 고친 레코드다. */
class DeltaBuilder {
  readonly payload: TeamSyncPayload = {};
  count = 0;

  constructor(
    private readonly baseline: Map<string, number>,
    private readonly keyBase64: string,
  ) {}

  add(kind: string, id: string, updatedAt: string, value: unknown): void {
    const known = this.baseline.get(baselineKey(kind, id));
    if (known !== undefined && !(Date.parse(updatedAt) > known)) {
      return;
    }
    this.push(kind, {
      id,
      encrypted_payload: encodeEncryptedPayload(JSON.stringify(value), this.keyBase64),
      updated_at: updatedAt,
    });
  }

  addDeletion(kind: string, id: string, deletedAt: string): void {
    this.push(kind, { id, encrypted_payload: "", updated_at: deletedAt, deleted_at: deletedAt });
  }

  private push(kind: string, record: SyncRecord): void {
    (this.payload[kind] ??= []).push(record);
    this.count += 1;
  }
}

function liveRecords(payload: TeamSyncPayload, kind: string): SyncRecord[] {
  return (payload[kind] ?? []).filter((record) => !record.deleted_at);
}

function isStale(error: unknown): boolean {
  return (
    error instanceof TeamLeaseExpiredError ||
    error instanceof TeamVaultNotFoundError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export class TeamSyncService {
  private readonly auth: TeamSyncAuth;
  private readonly secretStore: TeamSyncServiceOptions["secretStore"];
  private readonly api: TeamApi;
  private readonly storage: DesktopStateStorage;
  private readonly onChanged: () => void;
  private readonly startWatchLoop: (options: SyncWatchLoopOptions) => SyncWatchLoop;
  private readonly runtimes = new Map<string, TeamRuntime>();
  private readonly statuses = new Map<string, TeamSyncStatus>();
  private context: AuthSyncContext | null = null;
  private generation = 0;
  private abort = new AbortController();
  private watchInterrupt = new AbortController();
  private listTail: Promise<unknown> = Promise.resolve();
  private teamsSupport: { serverUrl: string; supported: boolean } | null = null;

  constructor(options: TeamSyncServiceOptions) {
    this.auth = options.auth;
    this.secretStore = options.secretStore;
    this.api = options.api ?? new TeamApi(options.auth);
    this.storage = options.storage ?? getDesktopStateStorage();
    this.onChanged = options.onChanged ?? (() => undefined);
    this.startWatchLoop = options.startWatchLoop ?? startSyncWatchLoop;
  }

  /** 팀마다의 상태. 잘 돌고 있는 팀은 "ready" 다. */
  listStatuses(): Record<string, TeamSyncStatus> {
    return Object.fromEntries(this.statuses);
  }

  /**
   * 팀 목록을 다시 읽어 이 기기의 팀 볼트를 맞춘다. 빠진 팀은 지우고, 새 팀은 키를 풀어 감시를 시작한다.
   * 볼트가 잠겼거나(팀 키를 풀 개인 DEK 가 없다) 로그인하지 않았으면 아무것도 하지 않는다.
   */
  refreshTeams(): Promise<void> {
    const lease = this.captureLease();
    if (!lease) {
      return Promise.resolve();
    }
    return this.serializeListWork(() => this.runRefreshTeams(lease));
  }

  /**
   * 로컬에서 팀 데이터·내 설정을 고쳤다. 팀마다 바뀐 것을 올린다. 줄에 선 차례가 이미 있으면 거기에
   * 붙는다. 돌려주는 Promise 는 그 차례들이 끝나면 풀린다(실패해도 던지지 않는다).
   */
  pushDirty(): Promise<void> {
    return Promise.all(
      [...this.runtimes.values()].map((runtime) => {
        if (!runtime.queuedPush) {
          runtime.queuedPush = this.syncTeam(runtime.teamId, RECORDS_AND_PRIVATE, () => {
            runtime.queuedPush = null;
          }).then(() => undefined);
        }
        return runtime.queuedPush;
      }),
    ).then(() => undefined);
  }

  /** 팀 목록이 바뀌었다고 알린다(팀 관리가 로컬 목록을 먼저 고쳤을 때). */
  notifyChanged(): void {
    this.onChanged();
  }

  /** 이 기기에서 그 팀을 지운다(나가기·팀 삭제를 마친 뒤). 서버 목록을 다시 읽기 전에도 바로 사라진다. */
  async forgetTeamLocally(teamId: string): Promise<void> {
    if (await this.forgetTeam(teamId)) {
      this.onChanged();
    }
  }

  /** 잠자기 복귀 — 진행 중인 대기를 끊는다. 루프는 바로 다시 붙는다. */
  interruptWatches(): void {
    this.watchInterrupt.abort();
    this.watchInterrupt = new AbortController();
  }

  /** 모든 감시를 멈추고 메모리의 팀 키를 버린다(로그아웃·계정 전환). 로컬 데이터는 그대로다. */
  stop(): void {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    for (const runtime of this.runtimes.values()) {
      this.stopRuntime(runtime);
    }
    this.runtimes.clear();
    this.statuses.clear();
    this.context = null;
    this.teamsSupport = null;
    this.listTail = Promise.resolve();
  }

  /** 로그아웃 — 모든 팀의 로컬 데이터와 참여 중 링크를 지운다. 원본은 서버에 있다. */
  async purgeAll(): Promise<void> {
    this.stop();
    for (const teamId of this.storage.listTeamIds()) {
      this.storage.removeTeam(teamId);
      await this.secretStore.remove(pendingTeamJoinAccount(teamId)).catch(() => undefined);
    }
    this.onChanged();
  }

  /**
   * 링크로 팀에 들어간다. 링크를 먼저 기억해 두므로, 사본을 올리기 전에 앱이 꺼져도 다음 팀 목록
   * 읽기에서 마저 들어간다. 들어간 팀 ID 를 돌려준다.
   */
  joinWithLink(link: string): Promise<string> {
    const lease = this.captureLease();
    if (!lease) {
      return Promise.reject(new Error(t("teams.needsUnlockedVault")));
    }
    // 팀 목록 읽기와 줄을 세운다 — 참여 도중의 팀을 목록 읽기가 "빠진 팀"으로 지우지 않게.
    return this.serializeListWork(async () => {
      const parsed = parseTeamInviteLink(link);
      if (normalizeServerUrl(parsed.serverUrl) !== normalizeServerUrl(lease.serverUrl)) {
        throw new Error(t("teams.inviteOtherServer"));
      }
      const info = await this.api.getInviteInfo(lease, parsed.code, deriveTeamInviteJoinToken(parsed.secret));
      assertActive(lease);
      await this.secretStore.save(pendingTeamJoinAccount(info.teamId), link);
      this.storage.upsertTeamInfo(info.teamId, {
        name: info.teamName,
        role: "member",
        wrappedTeamDek: null,
        dataFloor: 0,
        updatedAt: nowIso(),
      });
      await this.completeJoin(lease, info.teamId, link);
      this.onChanged();
      return info.teamId;
    });
  }

  private serializeListWork<T>(work: () => Promise<T>): Promise<T> {
    const result = this.listTail.then(work);
    this.listTail = result.catch(() => undefined);
    return result;
  }

  private captureLease(): TeamLease | null {
    const context = captureTeamContext(this.auth);
    if (!context) {
      return null;
    }
    if (this.context && !this.auth.isSyncContextCurrent(this.context)) {
      // 계정·서버·볼트가 바뀌었다. 옛 키와 진행 중인 일을 버리고 새로 시작한다.
      this.stop();
    }
    this.context = context;
    const generation = this.generation;
    const signal = this.abort.signal;
    return {
      serverUrl: context.serverUrl,
      accessToken: context.accessToken,
      vaultEpoch: context.vaultEpoch,
      personalKeyBase64: context.vaultKeyBase64,
      signal,
      isActive: () =>
        generation === this.generation && !signal.aborted && this.auth.isSyncContextCurrent(context),
    };
  }

  private async runRefreshTeams(lease: TeamLease): Promise<void> {
    try {
      if (!(await this.isTeamsSupported(lease))) {
        return;
      }
      let teams: TeamSummary[];
      try {
        teams = await this.api.listTeams(lease);
      } catch (error) {
        if (isTeamApiError(error) && [404, 405, 501].includes(error.status)) {
          // 팀을 모르는 서버다(옛 자체 호스팅).
          this.teamsSupport = { serverUrl: lease.serverUrl, supported: false };
          return;
        }
        throw error;
      }
      let changed = false;
      const listed = new Set(teams.map((team) => team.id));
      for (const teamId of this.storage.listTeamIds()) {
        if (!listed.has(teamId)) {
          assertActive(lease);
          changed = (await this.forgetTeam(teamId)) || changed;
        }
      }
      for (const team of teams) {
        assertActive(lease);
        changed =
          this.storage.upsertTeamInfo(team.id, {
            name: team.name,
            role: team.role,
            wrappedTeamDek: team.wrappedTeamDek,
            dataFloor: team.dataFloor,
            updatedAt: nowIso(),
          }) || changed;
        try {
          await this.openTeam(lease, team);
        } catch (error) {
          if (isStale(error) || !lease.isActive()) {
            throw error;
          }
          // 한 팀이 실패해도 다른 팀은 연다.
          this.statuses.set(team.id, { state: "error", errorMessage: errorMessage(error) });
        }
      }
      if (changed) {
        this.onChanged();
      }
    } catch (error) {
      if (isStale(error) || !lease.isActive()) {
        return;
      }
      throw error;
    }
  }

  private async isTeamsSupported(lease: TeamLease): Promise<boolean> {
    if (this.teamsSupport?.serverUrl !== lease.serverUrl) {
      let supported = true;
      try {
        const info = await this.api.getServerInfo(lease);
        // 정보를 못 읽으면(옛 서버의 /api/info 없음 등) 팀 목록을 한 번 물어보고 판정한다.
        supported = info ? info.capabilities?.teams?.enabled === true : true;
      } catch (error) {
        if (isStale(error)) {
          throw error;
        }
      }
      this.teamsSupport = { serverUrl: lease.serverUrl, supported };
    }
    return this.teamsSupport.supported;
  }

  /** 팀 키를 풀어 감시를 시작한다. 사본이 없으면 기억해 둔 링크로 마저 들어간다. */
  private async openTeam(lease: TeamLease, team: TeamSummary): Promise<void> {
    if (!team.wrappedTeamDek) {
      const link = await this.secretStore.load(pendingTeamJoinAccount(team.id));
      assertActive(lease);
      if (link) {
        await this.completeJoin(lease, team.id, link);
        return;
      }
      this.markBlocked(team.id, "needs-rejoin", null);
      return;
    }
    let teamDek: Uint8Array;
    try {
      teamDek = unwrapTeamDek(team.wrappedTeamDek, Buffer.from(lease.personalKeyBase64, "base64"), team.id);
    } catch (error) {
      if (!isTeamCryptoError(error)) {
        throw error;
      }
      // 초기화 전 DEK 로 감싼 사본 등. 그 팀만 멈추고 다른 팀과 개인 동기화는 그대로 간다.
      this.markBlocked(team.id, "needs-rejoin", error.message);
      return;
    }
    this.startRuntime(team.id, Buffer.from(teamDek).toString("base64"));
  }

  /** 링크의 상자에서 팀 키를 꺼내 내 개인 DEK 로 감싸 올린다. 끝나면 링크를 지운다. */
  private async completeJoin(lease: TeamLease, teamId: string, link: string): Promise<void> {
    try {
      const parsed = parseTeamInviteLink(link);
      const joined = await this.api.joinTeam(lease, parsed.code, deriveTeamInviteJoinToken(parsed.secret));
      if (joined.teamId !== teamId) {
        throw new Error(t("teams.inviteOtherTeam"));
      }
      const { teamDek } = openTeamInviteBox({ secret: parsed.secret, teamId, box: joined.inviteBox });
      const wrappedTeamDek = wrapTeamDek(teamDek, Buffer.from(lease.personalKeyBase64, "base64"), teamId);
      await this.api.putTeamKey(lease, teamId, wrappedTeamDek);
      assertActive(lease);
      await this.secretStore.remove(pendingTeamJoinAccount(teamId));
      const current = this.storage.getTeamState(teamId)?.info;
      this.storage.upsertTeamInfo(teamId, {
        name: joined.teamName,
        role: current?.role ?? "member",
        wrappedTeamDek,
        dataFloor: current?.dataFloor ?? 0,
        updatedAt: nowIso(),
      });
      this.startRuntime(teamId, Buffer.from(teamDek).toString("base64"));
    } catch (error) {
      if (isStale(error) || !lease.isActive()) {
        throw error;
      }
      // 링크가 만료·취소됐거나 상자가 안 열린다 — 이 링크로는 더 못 들어간다. 새 링크로 들어와야 한다.
      if (isTeamCryptoError(error) || isTeamApiError(error, "team_invite_invalid")) {
        await this.secretStore.remove(pendingTeamJoinAccount(teamId)).catch(() => undefined);
        this.markBlocked(teamId, "needs-rejoin", error.message);
        return;
      }
      throw error;
    }
  }

  private startRuntime(teamId: string, dekBase64: string): void {
    const existing = this.runtimes.get(teamId);
    if (existing?.dekBase64 === dekBase64 && existing.loop) {
      return;
    }
    if (existing) {
      this.stopRuntime(existing);
    }
    const runtime: TeamRuntime = {
      teamId,
      dekBase64,
      scope: createTeamVaultScope(teamId),
      abort: new AbortController(),
      records: { etag: null, baseline: null },
      private: { etag: null, baseline: null },
      watch: { etag: null, seen: null, pending: null },
      loop: null,
      tail: Promise.resolve(),
      queuedPush: null,
    };
    this.runtimes.set(teamId, runtime);
    this.statuses.set(teamId, { state: "ready", errorMessage: null });
    // 첫 대기는 바로 답한다(아는 값이 없다) — 그 응답으로 처음 당긴다.
    runtime.loop = this.startWatchLoop({
      watch: (signal) => this.watchTeam(runtime, signal),
      onChange: () => this.applyWatchChange(runtime),
    });
  }

  private stopRuntime(runtime: TeamRuntime): void {
    runtime.abort.abort();
    runtime.loop?.stop();
    runtime.loop = null;
  }

  private markBlocked(teamId: string, state: Exclude<TeamSyncState, "ready">, message: string | null): void {
    const runtime = this.runtimes.get(teamId);
    if (runtime) {
      this.stopRuntime(runtime);
      this.runtimes.delete(teamId);
    }
    this.statuses.set(teamId, { state, errorMessage: message });
  }

  /** 팀에서 빠졌다(목록에서 사라짐·404). 이 기기의 그 팀 데이터와 링크를 지운다. 지웠으면 true. */
  private async forgetTeam(teamId: string): Promise<boolean> {
    const runtime = this.runtimes.get(teamId);
    if (runtime) {
      this.stopRuntime(runtime);
      this.runtimes.delete(teamId);
    }
    this.statuses.delete(teamId);
    await this.secretStore.remove(pendingTeamJoinAccount(teamId)).catch(() => undefined);
    return this.storage.removeTeam(teamId);
  }

  /** 그 팀만의 리스. 팀이 멈추면(빠짐·키 바뀜) 그 팀의 요청도 끊긴다. */
  private teamLease(lease: TeamLease, runtime: TeamRuntime, signal?: AbortSignal): TeamLease {
    return {
      ...lease,
      signal: AbortSignal.any([lease.signal, runtime.abort.signal, ...(signal ? [signal] : [])]),
      isActive: () =>
        lease.isActive() && !runtime.abort.signal.aborted && this.runtimes.get(runtime.teamId) === runtime,
    };
  }

  private async watchTeam(runtime: TeamRuntime, signal: AbortSignal): Promise<SyncWatchOutcome> {
    const lease = this.captureLease();
    if (!lease || this.runtimes.get(runtime.teamId) !== runtime) {
      // 잠겼거나 로그아웃했거나 이 팀이 멈췄다. 루프를 내려놓으면 다음 팀 목록 읽기(볼트를 다시 열 때의
      // 개인 pull)가 새로 시작한다.
      this.stopRuntime(runtime);
      if (this.runtimes.get(runtime.teamId) === runtime) {
        this.runtimes.delete(runtime.teamId);
      }
      return "unchanged";
    }
    const interrupt = this.watchInterrupt.signal;
    const teamLease = this.teamLease(
      lease,
      runtime,
      AbortSignal.any([signal, interrupt, AbortSignal.timeout(SYNC_WATCH_CLIENT_TIMEOUT_MS)]),
    );
    try {
      const result = await this.api.watch(teamLease, runtime.teamId, runtime.watch.etag, teamLease.signal);
      if (!result.changed) {
        return "unchanged";
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
              private: result.revisions.privateRevision !== seen.privateRevision,
            }
          : { ...RECORDS_AND_PRIVATE },
      };
      return "changed";
    } catch (error) {
      if (interrupt.aborted || isStale(error) || !teamLease.isActive()) {
        return "unchanged";
      }
      if (await this.settleTeamFailure(runtime.teamId, error)) {
        return "unchanged";
      }
      throw error;
    }
  }

  private async applyWatchChange(runtime: TeamRuntime): Promise<boolean> {
    const pending = runtime.watch.pending;
    if (!pending) {
      return true;
    }
    if (pending.parts.info) {
      await this.refreshTeams();
      if (this.runtimes.get(runtime.teamId) !== runtime) {
        // 키가 바뀌었거나 팀에서 빠졌다 — 새 루프(또는 없음)가 이어받는다.
        return true;
      }
    }
    if (pending.parts.records || pending.parts.private) {
      if (!(await this.syncTeam(runtime.teamId, pending.parts))) {
        return false;
      }
    }
    runtime.watch.etag = pending.etag;
    runtime.watch.seen = pending.seen;
    runtime.watch.pending = null;
    return true;
  }

  /** 팀 하나를 맞춘다 — 서버보다 새 로컬 레코드를 올리고 서버 사본을 받는다. 같은 팀끼리는 줄을 선다. */
  private syncTeam(teamId: string, parts: WatchParts, onStart?: () => void): Promise<boolean> {
    const runtime = this.runtimes.get(teamId);
    const lease = this.captureLease();
    if (!runtime || !lease) {
      onStart?.();
      return Promise.resolve(false);
    }
    const teamLease = this.teamLease(lease, runtime);
    const result = runtime.tail.then(() => {
      onStart?.();
      return this.runSyncTeam(teamLease, runtime, parts);
    });
    runtime.tail = result.catch(() => undefined);
    return result;
  }

  private async runSyncTeam(lease: TeamLease, runtime: TeamRuntime, parts: WatchParts): Promise<boolean> {
    try {
      assertActive(lease);
      let changed = false;
      let pruned = false;
      if (parts.records) {
        const result = await this.syncRecords(lease, runtime);
        changed = result.applied || changed;
        pruned = result.pruned;
      }
      if (parts.private || pruned) {
        changed = (await this.syncPrivate(lease, runtime)) || changed;
      }
      this.statuses.set(runtime.teamId, { state: "ready", errorMessage: null });
      if (changed) {
        this.onChanged();
      }
      return true;
    } catch (error) {
      if (isStale(error) || !lease.isActive()) {
        return false;
      }
      await this.settleTeamFailure(runtime.teamId, error);
      return false;
    }
  }

  /** 팀 하나의 실패. 팀에서 빠졌거나(404) 앱이 낡았으면(426) 그 팀을 멈추고 true. */
  private async settleTeamFailure(teamId: string, error: unknown): Promise<boolean> {
    if (isTeamApiError(error, "team_not_found")) {
      if (await this.forgetTeam(teamId)) {
        this.onChanged();
      }
      return true;
    }
    if (isTeamApiError(error, "team_client_outdated")) {
      this.markBlocked(teamId, "outdated", error.message);
      return true;
    }
    this.statuses.set(teamId, { state: "error", errorMessage: errorMessage(error) });
    return false;
  }

  private async syncRecords(lease: TeamLease, runtime: TeamRuntime): Promise<{ applied: boolean; pruned: boolean }> {
    const teamId = runtime.teamId;
    let remote = await this.api.getRecords(lease, teamId, runtime.records.baseline ? runtime.records.etag : null);
    const baseline = remote.payload ? buildBaseline(remote.payload) : (runtime.records.baseline ?? new Map());
    this.materializeImplicitGroups(runtime);
    const before = this.storage.teamVaultFingerprint(teamId);
    const delta = await this.buildRecordDelta(runtime, baseline);
    if (delta.builder.count > 0) {
      await this.api.pushRecords(lease, teamId, delta.builder.payload, TEAM_SYNC_DATA_FLOOR);
      assertActive(lease);
      runtime.scope.syncOutbox.clearMany(delta.deletions);
      remote = await this.api.getRecords(lease, teamId, null);
    }
    if (!remote.payload) {
      return { applied: false, pruned: false };
    }
    assertActive(lease);
    if (this.storage.teamVaultFingerprint(teamId) !== before) {
      // 그 사이 로컬에서 고쳤다. 덮지 않고, 그것부터 올리는 다음 차례에 받는다.
      this.pushDirty();
      return { applied: false, pruned: false };
    }
    const rebased = this.applyRecords(runtime, remote.payload);
    runtime.records = { etag: remote.etag, baseline: buildBaseline(remote.payload) };
    if (rebased) {
      // 그룹 이름이 바뀐 것을 따라 워크스페이스 경로를 옮겼다 — 되올린다.
      this.pushDirty();
    }
    return { applied: true, pruned: this.storage.pruneTeamMemberPrefs(teamId) };
  }

  // 호스트만 있던 그룹 경로를 그룹 레코드로 만든다(개인 push 와 같다). 그래야 다른 기기가 그 그룹의
  // 이름을 바꿀 때 ID 로 따라간다.
  private materializeImplicitGroups(runtime: TeamRuntime): void {
    const groups = runtime.scope.groups.list();
    const materialized = materializeImplicitHostGroups(groups, runtime.scope.hosts.list());
    if (materialized.length !== groups.length) {
      runtime.scope.groups.replaceAll(materialized);
    }
  }

  private async buildRecordDelta(
    runtime: TeamRuntime,
    baseline: Map<string, number>,
  ): Promise<{ builder: DeltaBuilder; deletions: SyncDeletionRecord[] }> {
    const { scope } = runtime;
    const builder = new DeltaBuilder(baseline, runtime.dekBase64);
    for (const record of scope.groups.list()) builder.add("groups", record.id, record.updatedAt, record);
    // 사람마다 다른 값은 팀 레코드에 싣지 않는다(team-member-prefs.ts).
    for (const record of scope.hosts.list().map(stripHostMemberPrefs)) {
      builder.add("hosts", record.id, record.updatedAt, record);
    }
    for (const record of scope.knownHosts.list()) builder.add("knownHosts", record.id, record.updatedAt, record);
    for (const record of scope.portForwards.list()) builder.add("portForwards", record.id, record.updatedAt, record);
    for (const record of scope.dnsOverrides.list()) builder.add("dnsOverrides", record.id, record.updatedAt, record);
    for (const record of scope.snippets.list()) builder.add("snippets", record.id, record.updatedAt, record);
    for (const record of scope.savedWorkspaces.list().map(stripWorkspaceMemberPrefs)) {
      builder.add("workspaces", record.id, record.updatedAt, record);
    }
    for (const record of scope.tailnets.listPayloads()) builder.add("tailnets", record.id, record.updatedAt, record);
    for (const record of scope.awsProfiles.listPayloads()) builder.add("awsProfiles", record.id, record.updatedAt, record);
    for (const entry of scope.secretMetadata.list()) {
      const raw = await scope.secrets.load(entry.secretRef);
      if (raw) {
        const secret = JSON.parse(raw) as ManagedSecretPayload;
        builder.add("secrets", entry.secretRef, secret.updatedAt, secret);
      }
    }
    // 앱 설정(preferences)은 팀에 없다.
    const deletions = scope.syncOutbox.list().filter((entry) => entry.kind !== "preferences");
    for (const entry of deletions) {
      builder.addDeletion(entry.kind, entry.recordId, entry.deletedAt);
    }
    return { builder, deletions };
  }

  /** 받은 팀 레코드로 그 팀 볼트를 갈아 끼운다. 그룹 이름 변경을 따라 워크스페이스를 옮겼으면 true. */
  private applyRecords(runtime: TeamRuntime, payload: TeamSyncPayload): boolean {
    const { teamId, dekBase64, scope } = runtime;
    const decode = <T>(kind: string) =>
      liveRecords(payload, kind).map((record) => decodeEncryptedPayload<T>(record.encrypted_payload, dekBase64));
    // 다른 볼트(개인·먼저 있는 팀)와 id 가 겹치는 레코드는 버린다. 개인이 이긴다(설계안 4절).
    const taken = this.storage.collectRecordIdsOutsideTeam(teamId);
    const free =
      <T extends { id: string }>(ids: Set<string>) =>
      (record: T) =>
        !ids.has(record.id);

    const groups = decode<GroupRecord>("groups").filter(free(taken.groups));
    // 이 빌드가 모르는 종류는 담지 않는다(개인 pull 과 같은 이유). 서버 사본은 그대로 남는다.
    const hosts = decode<HostRecord>("hosts")
      .filter((record) => isKnownHostKind(record?.kind))
      .filter(free(taken.hosts))
      .map(stripHostMemberPrefs);
    const knownHosts = decode<KnownHostRecord>("knownHosts").filter(free(taken.knownHosts));
    const portForwards = decode<PortForwardRuleRecord>("portForwards").filter(free(taken.portForwards));
    const dnsOverrides = decode<DnsOverrideRecord>("dnsOverrides").filter(free(taken.dnsOverrides));
    const snippets = decode<SnippetRecord>("snippets").filter(free(taken.snippets));
    const workspaces = decode<SavedWorkspaceRecord>("workspaces")
      .map(normalizeSavedWorkspaceRecord)
      .filter((record): record is SavedWorkspaceRecord => record !== null)
      .filter(free(taken.savedWorkspaces))
      .map(stripWorkspaceMemberPrefs);
    const tailnets = decode<TailnetPayload>("tailnets").filter(free(taken.tailnets));
    const awsProfiles = decode<ManagedAwsProfilePayload>("awsProfiles").filter(free(taken.awsProfiles));
    const secrets = decode<ManagedSecretPayload>("secrets").filter(
      (secret) => !taken.secretMetadata.has(secret.secretRef),
    );

    // 그룹 이름 변경을 따라 워크스페이스 경로를 옮긴다(개인 pull 과 같은 규칙).
    const renamed = collectRenamedGroupPaths(
      materializeImplicitHostGroups(scope.groups.list(), scope.hosts.list()),
      groups,
    );
    const savedWorkspaces =
      renamed.length > 0
        ? rebaseSavedWorkspaceGroups(workspaces, renamed, new Set(collectGroupPaths(groups, hosts)), nowIso())
        : workspaces;

    this.storage.replaceTeamVault(
      teamId,
      {
        groups,
        hosts,
        knownHosts,
        portForwards,
        dnsOverrides,
        snippets,
        savedWorkspaces,
        // 로그인한 계정과 auth key 는 사람 것이다 — 섞여 와도 담지 않는다(내 것은 이 기기 칸과 내 개인 칸에 있다).
        tailnets: tailnets.map(({ loginName: _theirs, authKey: _person, ...tailnet }) =>
          normalizeTailnetPayloadForStorage(tailnet),
        ),
        awsProfiles: awsProfiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          kind: profile.kind,
          updatedAt: profile.updatedAt,
        })),
        secretMetadata: secrets.map(secretMetadataFromSyncedSecret),
      },
      {
        managedSecretsByRef: Object.fromEntries(
          secrets.map((secret) => [secret.secretRef, encodeSecretForStorage(JSON.stringify(secret))]),
        ),
        tailnetAuthKeysById: {},
        // 정적 프로필의 키도 사람 것이다 — 팀 쪽에는 키 없이 담는다.
        managedAwsProfilesById: Object.fromEntries(
          awsProfiles.map((profile) => [profile.id, encodeSecretForStorage(JSON.stringify(stripAwsProfileKeys(profile)))]),
        ),
      },
    );
    return savedWorkspaces.some((record, index) => record !== workspaces[index]);
  }

  /** 내 개인 칸을 맞춘다. 내 개인 DEK 로 잠그고 받는다 — 팀 키로는 안 열린다. 받은 것이 있으면 true. */
  private async syncPrivate(lease: TeamLease, runtime: TeamRuntime): Promise<boolean> {
    const teamId = runtime.teamId;
    const key = lease.personalKeyBase64;
    let remote = await this.api.getPrivate(lease, teamId, runtime.private.baseline ? runtime.private.etag : null);
    const baseline = remote.payload ? buildBaseline(remote.payload) : (runtime.private.baseline ?? new Map());
    const local = this.storage.readTeamMemberPrefs(teamId);
    if (!local) {
      throw new TeamVaultNotFoundError(teamId);
    }
    const before = JSON.stringify(memberPrefsToCompare(local));
    const deletions = this.storage.listTeamPrivateDeletions(teamId);
    const builder = new DeltaBuilder(baseline, key);
    for (const record of local.hostPrefs) builder.add("hostPrefs", record.id, record.updatedAt, record);
    for (const record of local.workspacePrefs) builder.add("workspacePrefs", record.id, record.updatedAt, record);
    // 내 자격 증명은 이 기기에서 잠근 것을 풀어 내 개인 DEK 로 다시 잠가 올린다(팀 키로는 안 열린다).
    for (const kind of TEAM_PRIVATE_SECRET_KINDS) {
      for (const record of local[kind]) {
        const credentials = readStoredCredentials(kind, record.value);
        if (credentials) {
          builder.add(kind, record.id, record.updatedAt, { id: record.id, updatedAt: record.updatedAt, credentials });
        }
      }
    }
    for (const entry of deletions) builder.addDeletion(entry.kind, entry.recordId, entry.deletedAt);
    if (builder.count > 0) {
      await this.api.putPrivate(lease, teamId, builder.payload);
      assertActive(lease);
      remote = await this.api.getPrivate(lease, teamId, null);
    }
    assertActive(lease);
    this.storage.settleTeamPrivatePush(teamId, deletions);
    if (!remote.payload) {
      return false;
    }
    const current = this.storage.readTeamMemberPrefs(teamId);
    if (!current || JSON.stringify(memberPrefsToCompare(current)) !== before) {
      // 그 사이 내 설정을 고쳤다. 덮지 않고 다음 차례에 올린 뒤 받는다.
      this.pushDirty();
      return false;
    }
    const payload = remote.payload;
    const decode = <T>(kind: string, normalize: (value: unknown) => T | null) =>
      liveRecords(payload, kind)
        .map((record) => normalize(decodeEncryptedPayload<unknown>(record.encrypted_payload, key)))
        .filter((record): record is T => record !== null);
    const receiveCredentials = (kind: TeamPrivateSecretKind): TeamPrivateSecretRecord[] => {
      const lockedHere = new Map(current[kind].map((record) => [record.id, record]));
      return decode<RemoteCredentials>(kind, (value) => normalizeRemoteCredentials(kind, value)).map((record) => {
        // 같은 판이면 이 기기에서 잠근 값을 그대로 둔다 — 다시 잠그면 내용이 같아도 상태 파일이 바뀐다.
        const local = lockedHere.get(record.id);
        return local && local.updatedAt === record.updatedAt
          ? local
          : {
              id: record.id,
              updatedAt: record.updatedAt,
              value: encodeSecretForStorage(JSON.stringify(record.credentials)),
            };
      });
    };
    this.storage.replaceTeamMemberPrefs(teamId, {
      hostPrefs: decode<TeamHostPrefsRecord>("hostPrefs", normalizeTeamHostPrefsRecord),
      workspacePrefs: decode<TeamWorkspacePrefsRecord>("workspacePrefs", normalizeTeamWorkspacePrefsRecord),
      hostCredentials: receiveCredentials("hostCredentials"),
      awsProfileCredentials: receiveCredentials("awsProfileCredentials"),
      tailnetCredentials: receiveCredentials("tailnetCredentials"),
    });
    runtime.private = { etag: remote.etag, baseline: buildBaseline(payload) };
    return true;
  }
}

/** 받기 전에 그 사이 내 설정을 고쳤는지 볼 몫(이 기기의 테마는 빼고). */
function memberPrefsToCompare(prefs: TeamMemberPrefsSnapshot): unknown[] {
  return [prefs.hostPrefs, prefs.workspacePrefs, ...TEAM_PRIVATE_SECRET_KINDS.map((kind) => prefs[kind])];
}

/** 내 개인 칸에 올린 자격 증명 한 건(호스트·AWS 프로필·tailnet). */
interface RemoteCredentials {
  id: string;
  updatedAt: string;
  credentials: object;
}

function normalizeRemoteCredentials(kind: TeamPrivateSecretKind, value: unknown): RemoteCredentials | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const credentials = TEAM_MEMBER_CREDENTIAL_NORMALIZERS[kind](record.credentials);
  return typeof record.id === "string" && record.id && typeof record.updatedAt === "string" && credentials
    ? { id: record.id, updatedAt: record.updatedAt, credentials }
    : null;
}

/** 이 기기에서 safeStorage 로 잠근 자격 증명을 푼다. 못 풀면 null(올리지 않는다). */
function readStoredCredentials(kind: TeamPrivateSecretKind, value: StoredEncryptedValue): object | null {
  const json = decodeSecretFromStorage(value);
  if (!json) {
    return null;
  }
  try {
    return TEAM_MEMBER_CREDENTIAL_NORMALIZERS[kind](JSON.parse(json));
  } catch {
    return null;
  }
}

function assertActive(lease: TeamRequestLease): void {
  if (!lease.isActive()) {
    throw new TeamLeaseExpiredError();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
