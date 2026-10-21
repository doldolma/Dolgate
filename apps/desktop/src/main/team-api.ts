import {
  isVaultEpochRejectionCode,
  SYNC_DATA_FLOOR_HEADER,
  VAULT_EPOCH_HEADER,
  type ServerInfoResponse,
  type SyncRecord,
  type TeamInvite,
  type TeamInviteInfo,
  type TeamMember,
  type TeamReplayState,
} from "@shared";
import { AUTH_INVALID_ERROR_MESSAGE } from "./auth-error-message";
import { t } from "./i18n";
import {
  isLikelyAuthError,
  SyncAuthenticationError,
  SyncVaultDekMismatchError,
  toApiErrorMessage,
} from "./sync-service";

/*
 * 팀 볼트 API(services/sync-api/internal/http/teams.go)를 부른다. 팀 경로만 다룬다.
 *
 * 토큰이 만료돼 거절되면 한 번 갱신해 다시 보내고, 볼트 세대 거절(409)은 개인 동기화와 같은 오류로
 * 올린다 — 규칙은 개인 동기화(sync-service.ts)의 것을 그대로 쓴다. 다른 실패는 서버가 준 code 를
 * 담아 TeamApiError 로 던진다. 팀 동기화는 그 code 로 "팀에서 빠짐"(team_not_found) 같은 것을 가른다.
 */

/** 팀 요청 하나가 쓰는 계정·서버·키 세대. 개인 동기화의 lease 와 같은 뜻이다. */
export interface TeamRequestLease {
  serverUrl: string;
  accessToken: string;
  vaultEpoch: number | null;
  signal: AbortSignal;
  /** 계정·볼트가 바뀌었으면 false 다. 그 뒤에 온 응답은 버린다. */
  isActive(): boolean;
}

export interface TeamApiAuth {
  refreshSession(): Promise<{ status: string }>;
  getAccessToken(): string;
  getClientIdentificationHeaders(): Record<string, string>;
}

export class TeamApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "TeamApiError";
  }
}

/** 요청 도중 계정·볼트가 바뀌었다. 결과를 버린다. */
export class TeamLeaseExpiredError extends Error {
  constructor() {
    super(t("teams.contextChanged"));
    this.name = "TeamLeaseExpiredError";
  }
}

export function isTeamApiError(error: unknown, code?: string): error is TeamApiError {
  return error instanceof TeamApiError && (code === undefined || error.code === code);
}

export interface TeamSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  /** 내 개인 DEK 로 감싼 팀 키. 링크로 들어와 아직 올리지 않았으면 null. */
  wrappedTeamDek: string | null;
  dataFloor: number;
  memberCount: number;
  createdAt: string;
}

/** 링크 정보(GET /invite/:code/info). 참여 카드의 "이미 들어가 있음"은 앱이 얹는다. */
export type TeamInviteLookup = Omit<TeamInviteInfo, "alreadyJoined">;

export interface TeamJoinResult {
  teamId: string;
  teamName: string;
  inviteBox: string;
  /** 이미 멤버였다(사본을 올리기 전에 끊겨 다시 부른 것). */
  rejoined: boolean;
}

/** 종류 → 레코드. 개인 /sync 와 같은 모양이다. */
export type TeamSyncPayload = Record<string, SyncRecord[]>;

export interface TeamWatchRevisions {
  revision: number;
  infoRevision: number;
  privateRevision: number;
}

export type TeamWatchResult =
  | { changed: false }
  | { changed: true; etag: string | null; revisions: TeamWatchRevisions };

/** 팀 기록 한 줄(서버 모양). payload 는 앱 기록이면 팀 키로 잠근 것, 서버 기록(멤버 변화)이면 평문 JSON 이다. */
export interface RawTeamEvent {
  seq: number;
  id: string;
  source: "app" | "server";
  authorUserId: string;
  authorEmail: string;
  createdAt: string;
  receivedAt: string;
  payload: string;
}

export interface RawTeamReplay {
  recordingId: string;
  authorUserId: string;
  authorEmail: string;
  state: TeamReplayState;
  segmentCount: number;
  lastSegment: number;
  totalBytes: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
}

export type TeamReplayExtraKind = "commands" | "snapshot";

/** 녹화를 열 때 받는 것 — 메타와 구간·덧붙임의 목록(내용 없이). 메타·구간 정보는 녹화 열쇠로 잠근 것이다. */
export interface RawTeamReplayDetail extends RawTeamReplay {
  startMeta: string;
  endMeta?: string;
  segments: Array<{ index: number; info: string; size: number }>;
  extras: Array<{ kind: TeamReplayExtraKind; index: number; size: number }>;
}

/** 묶어 받은 구간·덧붙임 하나(잠긴 바이트 그대로). */
export interface TeamReplayFrame {
  index: number;
  data: Uint8Array;
}

export class TeamApi {
  constructor(private readonly auth: TeamApiAuth) {}

  /** 서버 정보. 로그인 없이 읽는 공개 경로라 토큰을 싣지 않는다. 없거나 못 읽으면 null. */
  async getServerInfo(lease: TeamRequestLease): Promise<Partial<ServerInfoResponse> | null> {
    const response = await fetch(new URL("/api/info", lease.serverUrl), { signal: lease.signal });
    assertActive(lease);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as Partial<ServerInfoResponse>;
  }

  async listTeams(lease: TeamRequestLease): Promise<TeamSummary[]> {
    const body = await this.json<{ teams?: RawTeamSummary[] }>(lease, "GET", "/teams");
    return (body.teams ?? []).map(toTeamSummary);
  }

  async createTeam(
    lease: TeamRequestLease,
    input: { id: string; name: string; wrappedTeamDek: string },
  ): Promise<TeamSummary> {
    return toTeamSummary(
      await this.json<RawTeamSummary>(lease, "POST", "/teams", { body: input, vaultEpoch: true }),
    );
  }

  async renameTeam(lease: TeamRequestLease, teamId: string, name: string): Promise<void> {
    await this.send(lease, "PATCH", teamPath(teamId), { body: { name } });
  }

  async deleteTeam(lease: TeamRequestLease, teamId: string): Promise<void> {
    await this.send(lease, "DELETE", teamPath(teamId));
  }

  async transferOwnership(lease: TeamRequestLease, teamId: string, userId: string): Promise<void> {
    await this.send(lease, "POST", `${teamPath(teamId)}/owner`, { body: { userId } });
  }

  async listMembers(lease: TeamRequestLease, teamId: string): Promise<TeamMember[]> {
    const body = await this.json<{ members?: TeamMember[] }>(lease, "GET", `${teamPath(teamId)}/members`);
    return body.members ?? [];
  }

  async removeMember(lease: TeamRequestLease, teamId: string, userId: string): Promise<void> {
    await this.send(lease, "POST", `${teamPath(teamId)}/members/${encodeURIComponent(userId)}/remove`);
  }

  async leaveTeam(lease: TeamRequestLease, teamId: string): Promise<{ teamDeleted: boolean }> {
    const body = await this.json<{ teamDeleted?: boolean }>(lease, "POST", `${teamPath(teamId)}/leave`);
    return { teamDeleted: body.teamDeleted === true };
  }

  /** 링크로 들어와 상자에서 꺼낸 팀 키를 내 개인 DEK 로 감싸 올린다. */
  async putTeamKey(lease: TeamRequestLease, teamId: string, wrappedTeamDek: string): Promise<void> {
    await this.send(lease, "PUT", `${teamPath(teamId)}/key`, { body: { wrappedTeamDek }, vaultEpoch: true });
  }

  async createInvite(
    lease: TeamRequestLease,
    teamId: string,
    input: { inviteBox: string; joinTokenHash: string; expiresAt: string },
  ): Promise<TeamInvite> {
    return toInviteSummary(
      await this.json<RawInviteSummary>(lease, "POST", `${teamPath(teamId)}/invites`, { body: input }),
    );
  }

  async listInvites(lease: TeamRequestLease, teamId: string): Promise<TeamInvite[]> {
    const body = await this.json<{ invites?: RawInviteSummary[] }>(lease, "GET", `${teamPath(teamId)}/invites`);
    return (body.invites ?? []).map(toInviteSummary);
  }

  async revokeInvite(lease: TeamRequestLease, teamId: string, code: string): Promise<void> {
    await this.send(lease, "DELETE", `${teamPath(teamId)}/invites/${encodeURIComponent(code)}`);
  }

  // 참여 토큰은 헤더로만 보낸다 — 주소에 실으면 서버 요청 로그에 남는다.
  async getInviteInfo(lease: TeamRequestLease, code: string, token: string): Promise<TeamInviteLookup> {
    return this.json<TeamInviteLookup>(lease, "GET", `/invite/${encodeURIComponent(code)}/info`, {
      headers: { "X-Dolgate-Invite-Token": token },
    });
  }

  async joinTeam(lease: TeamRequestLease, code: string, token: string): Promise<TeamJoinResult> {
    const body = await this.json<TeamJoinResult>(lease, "POST", `/invite/${encodeURIComponent(code)}/join`, {
      headers: { "X-Dolgate-Invite-Token": token },
    });
    return { ...body, rejoined: body.rejoined === true };
  }

  /** 팀 레코드. etag 가 지금과 같으면 payload 는 null 이다(304). */
  async getRecords(
    lease: TeamRequestLease,
    teamId: string,
    etag: string | null,
  ): Promise<{ payload: TeamSyncPayload | null; etag: string | null }> {
    return this.getSnapshot(lease, `${teamPath(teamId)}/sync`, etag);
  }

  async pushRecords(
    lease: TeamRequestLease,
    teamId: string,
    payload: TeamSyncPayload,
    dataFloor: number,
  ): Promise<number | null> {
    return this.pushSnapshot(lease, "POST", `${teamPath(teamId)}/sync`, payload, {
      headers: { [SYNC_DATA_FLOOR_HEADER]: String(dataFloor) },
    });
  }

  /** 내 개인 칸. 내 개인 DEK 로 잠근 것이라 나만 연다. */
  async getPrivate(
    lease: TeamRequestLease,
    teamId: string,
    etag: string | null,
  ): Promise<{ payload: TeamSyncPayload | null; etag: string | null }> {
    return this.getSnapshot(lease, `${teamPath(teamId)}/me`, etag);
  }

  async putPrivate(lease: TeamRequestLease, teamId: string, payload: TeamSyncPayload): Promise<number | null> {
    return this.pushSnapshot(lease, "PUT", `${teamPath(teamId)}/me`, payload, { vaultEpoch: true });
  }

  /** 앱 활동 기록을 올린다(여러 줄 한 번에). 이미 받은 기록 ID 는 서버가 건너뛴다 — 받은 줄 수를 돌려준다. */
  async appendTeamEvents(
    lease: TeamRequestLease,
    teamId: string,
    events: Array<{ id: string; createdAt: string; payload: string }>,
  ): Promise<number> {
    const body = await this.json<{ accepted?: number }>(lease, "POST", `${teamPath(teamId)}/events`, {
      body: { events },
      fallback: t("sync.uploadFailed"),
    });
    return typeof body.accepted === "number" ? body.accepted : 0;
  }

  /** 팀 기록. after 를 주면 그 뒤를 오래된 것부터, 아니면 before 앞을 최신부터 준다. */
  async listTeamEvents(
    lease: TeamRequestLease,
    teamId: string,
    query: { before?: number; after?: number; limit?: number },
  ): Promise<RawTeamEvent[]> {
    const params = new URLSearchParams();
    if (query.before) params.set("before", String(query.before));
    if (query.after) params.set("after", String(query.after));
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.json<{ events?: RawTeamEvent[] }>(lease, "GET", `${teamPath(teamId)}/events${suffix}`);
    return body.events ?? [];
  }

  /** 녹화를 시작한다. 같은 녹화를 다시 시작하면 서버의 지금 상태를 그대로 준다. */
  async startTeamReplay(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    startMeta: string,
  ): Promise<RawTeamReplay> {
    return this.json<RawTeamReplay>(lease, "POST", `${teamPath(teamId)}/replays`, {
      body: { recordingId, startMeta },
      fallback: t("sync.uploadFailed"),
    });
  }

  /** 구간 하나를 올린다 — 본문은 잠근 구간 바이트, 구간 정보(잠금)는 헤더에. 같은 번호를 다시 올리면 덮어쓴다. */
  async putTeamReplaySegment(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    index: number,
    info: string,
    data: Uint8Array,
  ): Promise<void> {
    await this.send(lease, "PUT", `${replayPath(teamId, recordingId)}/segments/${index}`, {
      bytes: data,
      headers: { "X-Dolgate-Segment-Info": info },
      fallback: t("sync.uploadFailed"),
    });
  }

  /** 녹화 덧붙임(구간별 명령 목록·스냅샷)을 올린다. 번호는 그 구간 번호다. */
  async putTeamReplayExtra(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    kind: TeamReplayExtraKind,
    index: number,
    data: Uint8Array,
  ): Promise<void> {
    await this.send(lease, "PUT", `${replayPath(teamId, recordingId)}/extras/${kind}/${index}`, {
      bytes: data,
      fallback: t("sync.uploadFailed"),
    });
  }

  /** 녹화 끝을 알린다. lastSegment 까지 서버에 다 있어야 받는다. cut 은 비정상 종료를 알리는 것이다. */
  async completeTeamReplay(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    input: { endMeta: string; lastSegment: number; cut: boolean },
  ): Promise<void> {
    await this.send(lease, "POST", `${replayPath(teamId, recordingId)}/complete`, {
      body: input,
      fallback: t("sync.uploadFailed"),
    });
  }

  /** 녹화 목록. ids 를 주면 그 녹화들의 상태만(지워진 것까지) 준다. */
  async listTeamReplays(
    lease: TeamRequestLease,
    teamId: string,
    query: { ids?: string[]; before?: string; limit?: number },
  ): Promise<RawTeamReplay[]> {
    const params = new URLSearchParams();
    if (query.ids && query.ids.length > 0) params.set("ids", query.ids.join(","));
    if (query.before) params.set("before", query.before);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.json<{ replays?: RawTeamReplay[] }>(lease, "GET", `${teamPath(teamId)}/replays${suffix}`);
    return body.replays ?? [];
  }

  async getTeamReplay(lease: TeamRequestLease, teamId: string, recordingId: string): Promise<RawTeamReplayDetail> {
    const body = await this.json<RawTeamReplayDetail>(lease, "GET", replayPath(teamId, recordingId));
    return { ...body, segments: body.segments ?? [], extras: body.extras ?? [] };
  }

  /** 구간을 from 부터 묶어 받는다(서버가 한 응답 상한까지 자른다). */
  async readTeamReplaySegments(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    from: number,
    limit?: number,
  ): Promise<TeamReplayFrame[]> {
    const params = new URLSearchParams({ from: String(from) });
    if (limit) params.set("limit", String(limit));
    return this.frames(lease, `${replayPath(teamId, recordingId)}/segments?${params.toString()}`);
  }

  async readTeamReplayExtras(
    lease: TeamRequestLease,
    teamId: string,
    recordingId: string,
    kind: TeamReplayExtraKind,
    from: number,
    limit?: number,
  ): Promise<TeamReplayFrame[]> {
    const params = new URLSearchParams({ from: String(from) });
    if (limit) params.set("limit", String(limit));
    return this.frames(lease, `${replayPath(teamId, recordingId)}/extras/${kind}?${params.toString()}`);
  }

  private async frames(lease: TeamRequestLease, path: string): Promise<TeamReplayFrame[]> {
    const response = await this.request(lease, "GET", path, { fallback: t("sync.fetchFailed") });
    const body = new Uint8Array(await response.arrayBuffer());
    assertActive(lease);
    return decodeTeamReplayFrames(body);
  }

  /**
   * 팀 변경을 기다린다(롱폴링). 팀 레코드·팀 정보·내 개인 칸 가운데 무엇이 바뀌었는지 리비전 셋으로
   * 돌려준다. etag 가 지금과 다르면 서버가 바로 답한다.
   */
  async watch(
    lease: TeamRequestLease,
    teamId: string,
    etag: string | null,
    signal: AbortSignal,
  ): Promise<TeamWatchResult> {
    const response = await this.request(lease, "GET", `${teamPath(teamId)}/sync/watch`, {
      headers: etag ? { "If-None-Match": etag } : {},
      signal,
    });
    if (response.status === 304) {
      await response.body?.cancel();
      return { changed: false };
    }
    const body = (await response.json()) as Partial<TeamWatchRevisions>;
    assertActive(lease);
    return {
      changed: true,
      etag: response.headers.get("etag"),
      revisions: {
        revision: Number(body.revision ?? 0),
        infoRevision: Number(body.infoRevision ?? 0),
        privateRevision: Number(body.privateRevision ?? 0),
      },
    };
  }

  private async getSnapshot(
    lease: TeamRequestLease,
    path: string,
    etag: string | null,
  ): Promise<{ payload: TeamSyncPayload | null; etag: string | null }> {
    const response = await this.request(lease, "GET", path, {
      headers: etag ? { "If-None-Match": etag } : {},
      fallback: t("sync.fetchFailed"),
    });
    if (response.status === 304) {
      await response.body?.cancel();
      return { payload: null, etag };
    }
    const nextEtag = response.headers.get("etag");
    const payload = (await response.json()) as TeamSyncPayload | null;
    assertActive(lease);
    return { payload: payload ?? {}, etag: nextEtag };
  }

  private async pushSnapshot(
    lease: TeamRequestLease,
    method: "POST" | "PUT",
    path: string,
    payload: TeamSyncPayload,
    options: { headers?: Record<string, string>; vaultEpoch?: boolean },
  ): Promise<number | null> {
    const body = await this.json<{ revision?: unknown }>(lease, method, path, {
      ...options,
      body: payload,
      fallback: t("sync.uploadFailed"),
    });
    return typeof body.revision === "number" ? body.revision : null;
  }

  private async json<T>(lease: TeamRequestLease, method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(lease, method, path, options);
    const body = (await response.json()) as T;
    assertActive(lease);
    return body;
  }

  private async send(lease: TeamRequestLease, method: string, path: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.request(lease, method, path, options);
    await response.body?.cancel();
  }

  private async request(
    lease: TeamRequestLease,
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    assertActive(lease);
    const url = new URL(path, lease.serverUrl);
    const fallback = options.fallback ?? t("sync.fetchFailed");
    let response = await fetch(url, this.init(lease, method, options, lease.accessToken));
    assertActive(lease);
    if (response.ok || response.status === 304) {
      return response;
    }
    const failure = await readFailure(response, fallback);
    assertActive(lease);
    if (!isAuthFailure(response, failure)) {
      throw toError(response.status, failure);
    }
    const refreshed = await this.auth.refreshSession();
    assertActive(lease);
    if (refreshed.status !== "authenticated") {
      throw new SyncAuthenticationError(failure.message || AUTH_INVALID_ERROR_MESSAGE);
    }
    response = await fetch(url, this.init(lease, method, options, this.auth.getAccessToken()));
    assertActive(lease);
    if (response.ok || response.status === 304) {
      return response;
    }
    const retryFailure = await readFailure(response, fallback);
    if (isAuthFailure(response, retryFailure)) {
      throw new SyncAuthenticationError(retryFailure.message);
    }
    throw toError(response.status, retryFailure);
  }

  private init(lease: TeamRequestLease, method: string, options: RequestOptions, accessToken: string): RequestInit {
    const headers = new Headers(options.headers ?? {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    for (const [name, value] of Object.entries(this.auth.getClientIdentificationHeaders())) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    // 내 개인 DEK 로 잠근 것을 올리는 요청에는 그 DEK 의 세대를 싣는다. 서버가 초기화 전 DEK 로
    // 잠근 것을 거절한다(개인 push 와 같은 펜스).
    if (options.vaultEpoch && lease.vaultEpoch !== null) {
      headers.set(VAULT_EPOCH_HEADER, String(lease.vaultEpoch));
    }
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (options.bytes !== undefined) {
      headers.set("Content-Type", "application/octet-stream");
      // 잠근 조각은 늘 ArrayBuffer 위에 있다(SharedArrayBuffer 가 아니다).
      body = options.bytes as Uint8Array<ArrayBuffer>;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
    return { method, headers, body, signal: options.signal ?? lease.signal };
  }
}

/**
 * 구간·덧붙임 묶음 응답을 푼다. 하나마다 [번호 8바이트][길이 4바이트][내용]이고 둘 다 빅엔디언이다
 * (services/sync-api/internal/http/team_history.go 의 writeTeamReplayFrames).
 */
export function decodeTeamReplayFrames(body: Uint8Array): TeamReplayFrame[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: TeamReplayFrame[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 12 > body.length) {
      throw new Error(t("sync.fetchFailed"));
    }
    const index = Number(view.getBigUint64(offset));
    const length = view.getUint32(offset + 8);
    offset += 12;
    if (offset + length > body.length) {
      throw new Error(t("sync.fetchFailed"));
    }
    frames.push({ index, data: body.slice(offset, offset + length) });
    offset += length;
  }
  return frames;
}

interface RequestOptions {
  body?: unknown;
  /** 바이트 그대로 보내는 본문(녹화 구간·덧붙임). 주면 body 는 쓰지 않는다. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  vaultEpoch?: boolean;
  signal?: AbortSignal;
  fallback?: string;
}

interface RawTeamSummary {
  id: string;
  name: string;
  role: string;
  wrappedTeamDek?: string | null;
  dataFloor?: number;
  memberCount?: number;
  createdAt?: string;
}

interface RawInviteSummary extends Omit<TeamInvite, "revokedAt"> {
  revokedAt?: string;
}

function toTeamSummary(raw: RawTeamSummary): TeamSummary {
  return {
    id: raw.id,
    name: raw.name,
    role: raw.role === "owner" ? "owner" : "member",
    // 사본을 아직 안 올린 멤버는 빈 문자열로 온다.
    wrappedTeamDek: raw.wrappedTeamDek ? raw.wrappedTeamDek : null,
    dataFloor: typeof raw.dataFloor === "number" ? raw.dataFloor : 0,
    memberCount: typeof raw.memberCount === "number" ? raw.memberCount : 0,
    createdAt: raw.createdAt ?? "",
  };
}

function toInviteSummary(raw: RawInviteSummary): TeamInvite {
  return { ...raw, revokedAt: raw.revokedAt ?? null };
}

function teamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}`;
}

function replayPath(teamId: string, recordingId: string): string {
  return `${teamPath(teamId)}/replays/${encodeURIComponent(recordingId)}`;
}

function assertActive(lease: TeamRequestLease): void {
  if (!lease.isActive()) {
    throw new TeamLeaseExpiredError();
  }
}

async function readFailure(response: Response, fallback: string): Promise<{ message: string; code: string | null }> {
  // 문구는 개인 동기화와 같은 규칙으로 뽑고(HTML 응답·만료 문구 정리), code 는 따로 읽는다.
  const code = await readErrorCode(response.clone());
  return { message: await toApiErrorMessage(response, fallback), code };
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const parsed = JSON.parse(await response.text()) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

// 개인 동기화는 401·403 을 인증 실패로 본다. 팀 API 는 403 을 "소유자만"(team_owner_only)에도 쓰고, 서버의
// 진짜 인증 실패는 code 없는 401 이다 — team_ code 가 붙은 실패는 인증 문제가 아니다.
function isAuthFailure(response: Response, failure: { message: string; code: string | null }): boolean {
  return !failure.code?.startsWith("team_") && isLikelyAuthError(response, failure.message);
}

// 서버는 팀 오류 글을 한국어로만 보낸다. 아는 code 는 앱 언어의 문구로 바꾸고, 모르는 code(더 새 서버)는
// 서버 글을 그대로 쓴다.
const TEAM_API_ERROR_KEYS = new Map<string, string>([
  ["team_invite_invalid", "teams.api.inviteInvalid"],
  ["team_not_found", "teams.api.notFound"],
  ["team_owner_only", "teams.api.ownerOnly"],
  ["team_owner_must_transfer", "teams.api.ownerMustTransfer"],
  ["team_vault_required", "teams.api.vaultRequired"],
  ["team_client_outdated", "teams.api.clientOutdated"],
  ["team_member_not_found", "teams.api.memberNotFound"],
  ["team_already_member", "teams.api.alreadyMember"],
  ["team_exists", "teams.api.exists"],
  ["team_replay_not_found", "teams.api.replayNotFound"],
  ["team_replay_deleted", "teams.api.replayDeleted"],
]);

function toError(status: number, failure: { message: string; code: string | null }): Error {
  if (status === 409 && isVaultEpochRejectionCode(failure.code ?? "")) {
    return new SyncVaultDekMismatchError(failure.message);
  }
  const key = failure.code ? TEAM_API_ERROR_KEYS.get(failure.code) : undefined;
  return new TeamApiError(status, failure.code, key ? t(key) : failure.message);
}
