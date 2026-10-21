import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  base64ToBytes,
  isTeamCryptoError,
  openTeamEventBody,
  sealTeamEventBody,
  TEAM_HISTORY_FORMAT_VERSION,
  type ActivityLogRecord,
  type ServerInfoResponse,
  type TeamActivityBody,
  type TeamActivityItem,
  type TeamActivityQuery,
  type TeamMemberChange,
  type TeamReplayStatus,
} from "@shared";
import { t } from "./i18n";
import { isTeamApiError, type RawTeamEvent, type TeamApi, type TeamRequestLease } from "./team-api";
import type { VaultCatalog } from "./vault-catalog";
import { PERSONAL_VAULT_ID } from "./vault-root";

/*
 * 팀 기록 — 팀 볼트의 활동을 이 기기의 기록과 함께 팀 서버에도 남긴다.
 *
 * 모든 기록은 기록 저장소의 두 입구(append·upsert)로 들어온다. 그 뒤에 붙어 기록의 볼트를 보고(기록이 가리키는
 * 호스트·규칙·DNS·비밀값의 볼트, 또는 기록에 실린 vaultId), 팀 볼트 것이면 대기열에 넣는다. 로컬 기록은 그대로다.
 *
 * - 수명 줄(접속·SFTP·포트 포워딩·컨테이너)은 시작과 끝 두 번만 올린다. 서버는 고치기를 받지 않으므로, 화면이 같은
 *   record.id 의 줄을 한 줄로 합친다. 시작을 바로 올려 두면 앱이 죽어도 붙었던 사실은 남는다.
 * - 대기열은 이 계정의 기록 자리에 파일로 둔다 — 앱을 껐다 켜도 남는다. 평문 본문을 두고 보낼 때 팀 키로 잠근다
 *   (로컬 기록도 평문이다). 팀 키가 아직 없으면(팀을 열기 전) 기다린다.
 * - 기록 ID 는 정해진 값이다(수명 줄은 그 줄 ID 와 시작·끝에서 뽑는다). 응답을 못 받아 다시 보내도 서버에는 한 줄만 남는다.
 */

/** 이 쓰임의 기록은 올리지 않는다 — 내 기기·내 칸의 일이다. */
const PERSONAL_MESSAGE_KEYS = new Set(["teams.myCredentialsSaved", "teams.myCredentialsCleared"]);

const LIFECYCLE_KINDS = new Set(["session-lifecycle", "sftp-lifecycle", "port-forward-lifecycle", "container-lifecycle"]);
const START_STATUSES = new Set(["connected", "running"]);
const END_STATUSES = new Set(["closed", "error", "unsupported"]);

/** 한 번에 올리는 줄 수(서버 상한과 같다). */
const EVENT_BATCH_SIZE = 100;
/** 팀마다 대기열 상한. 오래 오프라인이면 오래된 것부터 버린다. */
const MAX_QUEUED_PER_TEAM = 10_000;
/** 본문(잠그기 전 JSON)의 상한. 서버는 잠근 것을 16KB 까지 받는다 — base64·iv·tag 를 빼고 남는 만큼이다. */
const MAX_BODY_BYTES = 11 * 1024;
/** 쓴 직후 모아 보내기까지 기다리는 시간. */
const FLUSH_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
/** 서버의 기록·녹화 한도를 다시 묻는 간격. */
const CAPABILITY_TTL_MS = 30 * 60_000;
const OUTBOX_FILE = "events-outbox.json";
const OUTBOX_VERSION = 1;

export type TeamHistoryLimits = NonNullable<NonNullable<ServerInfoResponse["capabilities"]["teams"]>["history"]>;

export interface TeamAccess {
  lease: TeamRequestLease;
  teamKeyBase64: string;
}

interface OutboxEntry {
  eventId: string;
  createdAt: string;
  body: TeamActivityBody;
}

interface OutboxFile {
  version: number;
  teams: Record<string, OutboxEntry[]>;
}

export interface TeamHistoryServiceOptions {
  api: Pick<TeamApi, "getServerInfo" | "appendTeamEvents" | "listTeamEvents" | "listTeamReplays">;
  /** 그 팀이 열려 있으면 키와 요청 권한. 아니면 null(팀 동기화의 openTeamAccess). */
  openTeamAccess(teamId: string): TeamAccess | null;
  /** 시험용. */
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/** 기록 메타데이터가 가리키는 팀 볼트를 찾는다. 개인 볼트 것이거나 볼트를 알 수 없으면 null 이다. */
export type TeamLogResolver = (metadata: Record<string, unknown> | null) => string | null;

type LogVaults = Pick<
  VaultCatalog,
  "getScope" | "scopeOfHost" | "scopeOfPortForward" | "scopeOfDnsOverride" | "scopeOfSnippet" | "scopeOfSecret"
>;

/**
 * 기록의 볼트. 기록에 실린 볼트(vaultId — 호스트 없는 그룹 일 등, 복사의 대상·원본)가 먼저고, 없으면 기록이 가리키는
 * 레코드의 볼트다. 지운 레코드는 카탈로그에 없으므로, 지우는 곳은 지우기 전에 vaultId 를 기록에 싣는다.
 */
export function resolveLogTeamId(vaults: LogVaults, metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }
  const team = (vaultId: string | null | undefined): string | null =>
    vaultId && vaultId !== PERSONAL_VAULT_ID && vaults.getScope(vaultId) ? vaultId : null;
  for (const key of ["vaultId", "targetVaultId", "sourceVaultId"]) {
    const value = metadata[key];
    const found = typeof value === "string" ? team(value) : null;
    if (found) {
      return found;
    }
  }
  const lookups: Array<[string, (id: string) => { id: string }]> = [
    ["hostId", (id) => vaults.scopeOfHost(id)],
    ["ruleId", (id) => vaults.scopeOfPortForward(id)],
    ["portForwardRuleId", (id) => vaults.scopeOfPortForward(id)],
    ["dnsOverrideId", (id) => vaults.scopeOfDnsOverride(id)],
    ["snippetId", (id) => vaults.scopeOfSnippet(id)],
    ["secretRef", (id) => vaults.scopeOfSecret(id)],
  ];
  for (const [key, scopeOf] of lookups) {
    const value = metadata[key];
    if (typeof value === "string" && value) {
      const found = team(scopeOf(value).id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** 정해진 키에서 표준 UUID(v4 모양)를 뽑는다. 서버는 표준형 UUID 만 기록 ID 로 받는다. */
export function deriveTeamEventId(key: string): string {
  const bytes = createHash("sha256").update(key, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 수명 줄이면 시작·끝·버림, 아니면 null(한 줄 그대로). */
function lifecyclePhase(record: ActivityLogRecord): "start" | "end" | "ignore" | null {
  if (!record.kind || !LIFECYCLE_KINDS.has(record.kind)) {
    return null;
  }
  const status = (record.metadata as { status?: unknown } | null)?.status;
  if (typeof status === "string" && START_STATUSES.has(status)) {
    return "start";
  }
  if (typeof status === "string" && END_STATUSES.has(status)) {
    return "end";
  }
  return "ignore";
}

/** 본문이 너무 크면 메타데이터의 큰 값을 줄인다(긴 오류 문구 등). */
function boundedBody(body: TeamActivityBody): TeamActivityBody {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_BODY_BYTES) {
    return body;
  }
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body.record.metadata ?? {})) {
    if (typeof value === "string") {
      metadata[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    }
  }
  const message = body.record.message.length > 500 ? `${body.record.message.slice(0, 500)}…` : body.record.message;
  return { ...body, record: { ...body.record, message, metadata, messageParams: null } };
}

function defaultTimer(callback: () => void, delayMs: number): { cancel(): void } {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export class TeamHistoryService {
  private directoryPath: string | null = null;
  private outbox: OutboxFile = { version: OUTBOX_VERSION, teams: {} };
  /** 이번 실행에서 이미 대기열에 넣은 수명 줄 ID — 같은 줄을 여러 번 고쳐 써도 한 번만 넣는다. */
  private readonly queuedIds = new Set<string>();
  private timer: { cancel(): void } | null = null;
  private timerDueAt = 0;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private retryDelayMs = FLUSH_DELAY_MS;
  private readonly capabilities = new Map<string, { limits: TeamHistoryLimits | null; checkedAt: number }>();
  private readonly setTimer: (callback: () => void, delayMs: number) => { cancel(): void };
  private resolveTeamId: TeamLogResolver = () => null;

  constructor(private readonly options: TeamHistoryServiceOptions) {
    this.setTimer = options.setTimer ?? defaultTimer;
  }

  /** 기록의 볼트를 찾는 길. 볼트 카탈로그를 만드는 IPC 쪽이 넣는다(resolveLogTeamId). */
  setTeamResolver(resolver: TeamLogResolver): void {
    this.resolveTeamId = resolver;
  }

  /** 이 계정의 기록 자리를 연다. 남아 있던 대기열을 읽고 보내기를 깨운다. */
  activate(scopeDirectoryPath: string): void {
    const directoryPath = path.join(scopeDirectoryPath, "team-history");
    if (this.directoryPath === directoryPath) {
      return;
    }
    this.directoryPath = directoryPath;
    this.queuedIds.clear();
    this.outbox = this.readOutbox();
    for (const entries of Object.values(this.outbox.teams)) {
      for (const entry of entries) {
        this.queuedIds.add(entry.eventId);
      }
    }
    if (this.hasPending()) {
      this.scheduleFlush(FLUSH_DELAY_MS);
    }
  }

  deactivate(): void {
    this.timer?.cancel();
    this.timer = null;
    this.directoryPath = null;
    this.outbox = { version: OUTBOX_VERSION, teams: {} };
    this.queuedIds.clear();
  }

  /** 계정을 지운다 — 이 계정의 팀 기록 폴더(대기열·녹화 올리기 상태·팀 녹화 캐시)를 지우고 닫는다. */
  purgeLocalData(): void {
    const directoryPath = this.directoryPath;
    this.deactivate();
    if (directoryPath) {
      rmSync(directoryPath, { recursive: true, force: true });
    }
  }

  /** 기록 자리 안의 팀 기록 폴더(녹화 올리기 상태·팀 녹화 캐시도 여기 둔다). 열려 있지 않으면 null. */
  get stateDirectoryPath(): string | null {
    return this.directoryPath;
  }

  /** 로컬 기록 하나가 쓰였다. 팀 볼트 것이면 대기열에 넣는다. */
  mirror(record: ActivityLogRecord): void {
    if (!this.directoryPath) {
      return;
    }
    if (record.messageKey && PERSONAL_MESSAGE_KEYS.has(record.messageKey)) {
      return;
    }
    const phase = lifecyclePhase(record);
    if (phase === "ignore") {
      return;
    }
    const teamId = this.resolveTeamId((record.metadata as Record<string, unknown> | null) ?? null);
    if (!teamId) {
      return;
    }
    const eventId = phase
      ? deriveTeamEventId(`${record.id}|${phase}`)
      : CANONICAL_UUID.test(record.id)
        ? record.id
        : deriveTeamEventId(record.id);
    const body = boundedBody({ v: TEAM_HISTORY_FORMAT_VERSION, ...(phase ? { phase } : {}), record });
    if (this.queuedIds.has(eventId)) {
      // 아직 보내지 않았으면 새 내용으로 바꾼다 — 접속 시작 줄에는 곧이어 녹화 ID 가 붙는다(진행 중인 접속의 Replay).
      const queued = this.outbox.teams[teamId]?.find((entry) => entry.eventId === eventId);
      if (queued) {
        queued.body = body;
        queued.createdAt = record.updatedAt ?? record.createdAt;
        this.writeOutbox();
      }
      return;
    }
    this.queuedIds.add(eventId);
    const entries = (this.outbox.teams[teamId] ??= []);
    entries.push({ eventId, createdAt: record.updatedAt ?? record.createdAt, body });
    if (entries.length > MAX_QUEUED_PER_TEAM) {
      entries.splice(0, entries.length - MAX_QUEUED_PER_TEAM);
    }
    this.writeOutbox();
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  /** 팀 목록이 바뀌었다(팀이 열렸을 수 있다) — 기다리던 것을 보내 본다. */
  kick(): void {
    if (this.hasPending()) {
      this.retryDelayMs = FLUSH_DELAY_MS;
      this.scheduleFlush(0);
    }
  }

  /** 그 팀을 이 기기에서 지웠다 — 그 팀의 대기열을 버린다. */
  forgetTeam(teamId: string): void {
    if (this.outbox.teams[teamId]) {
      delete this.outbox.teams[teamId];
      this.writeOutbox();
    }
  }

  /** 앱을 끌 때 — 남은 것을 timeoutMs 안에 보내 본다. 못 보낸 것은 다음 실행 때 간다. */
  async flushBeforeQuit(timeoutMs: number): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    if (!this.hasPending()) {
      return;
    }
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        this.setTimer(resolve, timeoutMs);
      }),
    ]);
  }

  /** 서버의 팀 기록·녹화 한도. 기록·녹화를 모르는 서버면 null 이다. */
  async getHistoryLimits(lease: TeamRequestLease): Promise<TeamHistoryLimits | null> {
    const cached = this.capabilities.get(lease.serverUrl);
    if (cached && Date.now() - cached.checkedAt < CAPABILITY_TTL_MS) {
      return cached.limits;
    }
    const info = await this.options.api.getServerInfo(lease);
    const limits = info?.capabilities?.teams?.history ?? null;
    this.capabilities.set(lease.serverUrl, { limits, checkedAt: Date.now() });
    return limits;
  }

  /** 화면의 팀 기록. 앱 활동은 팀 키로 풀어 준다. */
  async listActivity(teamId: string, query: TeamActivityQuery = {}): Promise<TeamActivityItem[]> {
    const access = this.requireAccess(teamId);
    const key = base64ToBytes(access.teamKeyBase64);
    const events = await this.options.api.listTeamEvents(access.lease, teamId, {
      before: query.before,
      after: query.after,
      limit: query.limit,
    });
    return events.map((event) => toActivityItem(event, key, teamId));
  }

  /** 그 녹화들이 서버에 있는지(기록 화면의 Replay 단추). */
  async getReplayStatuses(teamId: string, recordingIds: string[]): Promise<TeamReplayStatus[]> {
    const ids = [...new Set(recordingIds)].filter((id) => CANONICAL_UUID.test(id));
    if (ids.length === 0) {
      return [];
    }
    const access = this.requireAccess(teamId);
    const statuses: TeamReplayStatus[] = [];
    for (let start = 0; start < ids.length; start += 200) {
      const replays = await this.options.api.listTeamReplays(access.lease, teamId, { ids: ids.slice(start, start + 200) });
      for (const replay of replays) {
        statuses.push({
          recordingId: replay.recordingId,
          state: replay.state,
          authorEmail: replay.authorEmail,
          segmentCount: replay.segmentCount,
        });
      }
    }
    return statuses;
  }

  private requireAccess(teamId: string): TeamAccess {
    const access = this.options.openTeamAccess(teamId);
    if (!access) {
      throw new Error(t("teams.notOnDevice"));
    }
    return access;
  }

  private hasPending(): boolean {
    return Object.values(this.outbox.teams).some((entries) => entries.length > 0);
  }

  private scheduleFlush(delayMs: number): void {
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) {
      return;
    }
    this.timer?.cancel();
    this.timerDueAt = dueAt;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  /** 대기열을 팀마다 보낸다. 이미 보내는 중이면 끝난 뒤 한 번 더 돈다. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = this.runFlush().finally(() => {
      this.flushing = null;
      if (this.flushAgain) {
        this.flushAgain = false;
        void this.flush();
      }
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    let failed = false;
    for (const teamId of Object.keys(this.outbox.teams)) {
      if (!this.directoryPath) {
        return;
      }
      const access = this.options.openTeamAccess(teamId);
      if (!access) {
        // 팀을 아직 열지 못했다(잠김·로그아웃·키를 푸는 중). 팀 목록이 바뀌면 kick 이 깨운다.
        continue;
      }
      try {
        if (!(await this.getHistoryLimits(access.lease))) {
          // 팀 기록을 모르는 서버 — 쌓아 두지 않는다.
          this.forgetTeam(teamId);
          continue;
        }
        await this.flushTeam(teamId, access);
      } catch (error) {
        if (isTeamApiError(error, "team_not_found")) {
          // 팀에서 빠졌다. 팀 동기화가 곧 로컬 팀을 지운다.
          this.forgetTeam(teamId);
          continue;
        }
        failed = true;
      }
    }
    if (failed) {
      this.retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, this.retryDelayMs * 2);
      this.scheduleFlush(this.retryDelayMs);
    } else {
      this.retryDelayMs = FLUSH_DELAY_MS;
    }
  }

  private async flushTeam(teamId: string, access: TeamAccess): Promise<void> {
    const key = base64ToBytes(access.teamKeyBase64);
    for (;;) {
      const entries = this.outbox.teams[teamId];
      if (!entries || entries.length === 0) {
        return;
      }
      const batch = entries.slice(0, EVENT_BATCH_SIZE);
      try {
        await this.options.api.appendTeamEvents(
          access.lease,
          teamId,
          batch.map((entry) => ({
            id: entry.eventId,
            createdAt: entry.createdAt,
            payload: sealTeamEventBody(key, teamId, entry.eventId, entry.body),
          })),
        );
      } catch (error) {
        // 서버가 이 묶음을 받을 수 없다고 답했다(형식 오류) — 다시 보내도 같으니 버리고 다음으로 간다.
        if (isTeamApiError(error) && error.status === 400) {
          console.warn("[team-history] the server rejected a batch of team activity", error);
        } else {
          throw error;
        }
      }
      const current = this.outbox.teams[teamId];
      if (current) {
        const sent = new Set(batch.map((entry) => entry.eventId));
        this.outbox.teams[teamId] = current.filter((entry) => !sent.has(entry.eventId));
        if (this.outbox.teams[teamId].length === 0) {
          delete this.outbox.teams[teamId];
        }
        this.writeOutbox();
      }
    }
  }

  private outboxPath(): string | null {
    return this.directoryPath ? path.join(this.directoryPath, OUTBOX_FILE) : null;
  }

  private readOutbox(): OutboxFile {
    const filePath = this.outboxPath();
    if (!filePath || !existsSync(filePath)) {
      return { version: OUTBOX_VERSION, teams: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<OutboxFile>;
      if (parsed.version !== OUTBOX_VERSION || typeof parsed.teams !== "object" || !parsed.teams) {
        return { version: OUTBOX_VERSION, teams: {} };
      }
      return { version: OUTBOX_VERSION, teams: parsed.teams };
    } catch {
      return { version: OUTBOX_VERSION, teams: {} };
    }
  }

  private writeOutbox(): void {
    const filePath = this.outboxPath();
    if (!filePath) {
      return;
    }
    try {
      if (!this.hasPending()) {
        rmSync(filePath, { force: true });
        return;
      }
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(this.outbox), "utf8");
      renameSync(temporaryPath, filePath);
    } catch (error) {
      // 디스크가 막혀도 로컬 기록 쓰기는 이어간다. 메모리의 대기열은 그대로 보낸다.
      console.warn("[team-history] could not save the team activity queue", error);
    }
  }
}

function toActivityItem(event: RawTeamEvent, key: Uint8Array, teamId: string): TeamActivityItem {
  const item: TeamActivityItem = {
    seq: event.seq,
    id: event.id,
    source: event.source,
    authorUserId: event.authorUserId,
    authorEmail: event.authorEmail,
    createdAt: event.createdAt,
    receivedAt: event.receivedAt,
    activity: null,
    memberChange: null,
    unreadable: null,
  };
  if (event.source === "server") {
    try {
      item.memberChange = JSON.parse(event.payload) as TeamMemberChange;
    } catch {
      item.unreadable = "broken";
    }
    return item;
  }
  try {
    item.activity = openTeamEventBody<TeamActivityBody>(key, teamId, event.id, event.payload);
  } catch (error) {
    item.unreadable = isTeamCryptoError(error) && error.code === "unsupported-version" ? "unsupported-version" : "broken";
  }
  return item;
}
