import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  canChangeTeamRole,
  canEditTeamVault,
  canManageTeam,
  canRemoveTeamMember,
  createTeamDek,
  hashTeamInviteJoinToken,
  wrapTeamDek,
  type HostRecord,
  type SyncWatchLoopOptions,
  type TeamAssignableRole,
  type TeamInviteRole,
  type TeamRole,
} from "@shared";

/*
 * 시험용: 팀 API 를 흉내 내는 가짜 서버와, 그것에 붙인 팀 동기화·팀 관리 묶음.
 *
 * 서버는 services/sync-api 의 팀 경로와 같은 모양으로 답한다 — 레코드는 나중에 쓴 쪽이 이기고, ETag 는
 * 리비전이며, 멤버가 아니면 404 다. 역할 규칙(읽기 전용 올리기 거절, 관리자 이상의 초대·빼기·역할 바꾸기·이전
 * 판)도 서버와 같다. 사용자는 `userId` 를 바꿔 갈아 끼운다(같은 서버의 다른 계정).
 *
 * electron 목과 임시 폴더는 시험 파일이 세운다(vi.mock 은 시험 파일에서만 끌어올려진다).
 */

export const SERVER = "https://sync.example.com";
export const TEAM_ID = "0f8e4c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
export const OTHER_TEAM_ID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
export const PERSONAL_KEY = Buffer.alloc(32, 7).toString("base64");
export const T0 = "2026-10-19T00:00:00.000Z";

export function seal(value: unknown, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export function open<T = Record<string, unknown>>(payload: string, keyBase64: string): T {
  const envelope = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"),
  ) as T;
}

export function host(id: string, extra: Record<string, unknown> = {}): HostRecord {
  return {
    id,
    kind: "ssh",
    label: id,
    hostname: `${id}.example.com`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  } as unknown as HostRecord;
}

export const sshDraft = (label: string) => ({
  kind: "ssh" as const,
  label,
  hostname: `${label}.example.com`,
  port: 22,
  username: "ubuntu",
  authType: "password" as const,
});

type Row = { id: string; encrypted_payload: string; updated_at: string; deleted_at?: string };
type Rows = Map<string, Map<string, Row>>;

export interface FakeMember {
  role: TeamRole;
  wrapped: string;
  addedAt: string;
  privateRevision: number;
  private: Rows;
}

export interface FakeTeam {
  id: string;
  name: string;
  revision: number;
  infoRevision: number;
  records: Rows;
  members: Map<string, FakeMember>;
  /** 레코드마다 지금 판을 쓴 사람(`종류:id`). */
  updatedBy: Map<string, string>;
  /** 덮어쓰이거나 지워진 판(내용이 있던 것만) — 서버의 team_record_history. */
  versions: FakeVersion[];
}

export interface FakeVersion {
  seq: number;
  kind: string;
  recordId: string;
  encryptedPayload: string;
  updatedAt: string;
  deletedAt?: string;
  updatedBy: string;
  changedBy: string;
  changedAt: string;
  /** 밀어낸 올리기가 지운 것인지. */
  deleted: boolean;
}

interface FakeInvite {
  code: string;
  teamId: string;
  box: string;
  /** 팀 키로 잠근 링크 비밀값. 취소되면 상자처럼 지운다. */
  sealedSecret: string | null;
  tokenHash: string;
  expiresAt: string;
  createdBy: string;
  role: TeamInviteRole;
  revokedAt: string | null;
  useCount: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, Row[]> & Record<string, unknown>;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function upsert(
  rows: Rows,
  payload: Record<string, Row[]>,
  onReplace?: (kind: string, current: Row, next: Row) => void,
): number {
  let written = 0;
  for (const [kind, records] of Object.entries(payload)) {
    const byId = rows.get(kind) ?? new Map<string, Row>();
    rows.set(kind, byId);
    for (const record of records) {
      const current = byId.get(record.id);
      if (current && Date.parse(current.updated_at) > Date.parse(record.updated_at)) {
        continue;
      }
      if (
        current &&
        current.updated_at === record.updated_at &&
        current.encrypted_payload === record.encrypted_payload &&
        (current.deleted_at ?? null) === (record.deleted_at ?? null)
      ) {
        continue;
      }
      if (current) {
        onReplace?.(kind, current, record);
      }
      byId.set(record.id, { ...record });
      written += 1;
    }
  }
  return written;
}

function snapshot(rows: Rows): Record<string, Row[]> {
  return Object.fromEntries([...rows].map(([kind, byId]) => [kind, [...byId.values()]]));
}

const OWNER_ONLY = { error: "팀 소유자만 할 수 있습니다.", code: "team_owner_only" };
const ADMIN_ONLY = { error: "팀 관리자만 할 수 있습니다.", code: "team_admin_only" };
const READ_ONLY = { error: "읽기 전용 멤버는 팀 데이터를 바꿀 수 없습니다.", code: "team_read_only" };
const ROLE_INVALID = { error: "줄 수 없는 역할입니다.", code: "team_role_invalid" };
const MEMBER_NOT_FOUND = { error: "이 팀의 멤버가 아닙니다.", code: "team_member_not_found" };
const MUST_TRANSFER = { error: "소유권을 먼저 넘기세요.", code: "team_owner_must_transfer" };

export class FakeTeamServer {
  readonly teams = new Map<string, FakeTeam>();
  readonly invites = new Map<string, FakeInvite>();
  readonly requests: RecordedRequest[] = [];
  userId = "user-1";
  /** 팀 레코드를 200 으로 답하기 직전에 한 번 부른다 — 시험이 그 사이 로컬 편집을 끼워 넣는다. */
  beforeRecordsResponse: (() => void) | null = null;
  /** 내 개인 칸을 200 으로 답하기 직전에 한 번 부른다(위와 같은 쓰임). */
  beforePrivateResponse: (() => void) | null = null;
  /** 링크로 들어오기를 처리하기 직전에 한 번 부른다 — 참여 카드와 참여 사이에 바뀐 것을 끼워 넣는다. */
  beforeJoin: (() => void) | null = null;
  failNextKeyUpload = false;
  failNextList = false;
  /** 이 팀들의 데이터 경로는 "앱을 업데이트하세요"(426)로 답한다 — 팀 데이터 수준을 못 따라오는 앱. */
  readonly outdatedTeams = new Set<string>();
  /** 개인 칸 올리기를 볼트 세대 거절(409)로 답한다 — 다른 기기가 볼트를 초기화한 뒤의 옛 DEK. */
  rejectPrivateEpoch = false;
  /** 앞단(nginx) 본문 한도. 넘으면 서버에 닿기 전에 413(HTML) — 그런 요청은 tooLarge 에 적는다(④). */
  bodyLimit = Number.POSITIVE_INFINITY;
  readonly tooLarge: Array<{ method: string; path: string; bytes: number }> = [];
  private lastChangedAtMs = 0;

  addTeam(id: string, name: string, wrapped: string | null): FakeTeam {
    const team: FakeTeam = {
      id,
      name,
      revision: 0,
      infoRevision: 1,
      records: new Map(),
      members: new Map(),
      updatedBy: new Map(),
      versions: [],
    };
    if (wrapped !== null) {
      team.members.set(this.userId, this.newMember("owner", wrapped));
    }
    this.teams.set(id, team);
    return team;
  }

  newMember(role: TeamRole, wrapped = ""): FakeMember {
    return { role, wrapped, addedAt: T0, privateRevision: 0, private: new Map() };
  }

  /** 다른 멤버(또는 내 다른 기기)가 올린 것처럼 레코드를 둔다. */
  putRecord(
    teamId: string,
    kind: string,
    id: string,
    value: unknown,
    keyBase64: string,
    updatedAt = T0,
    by = this.userId,
  ): void {
    this.pushRows(this.teams.get(teamId)!, { [kind]: [{ id, encrypted_payload: seal(value, keyBase64), updated_at: updatedAt }] }, by);
  }

  /**
   * 다른 멤버가 한 번에 올린 것처럼 여러 레코드를 쓴다 — value 가 없으면 지움이다. 한 올리기라 밀려난 판들의 시각이
   * 같다(서버에서 한 묶음).
   */
  pushBatch(
    teamId: string,
    records: Array<{ kind: string; id: string; value?: unknown; at: string }>,
    keyBase64: string,
    by = this.userId,
  ): void {
    const payload: Record<string, Row[]> = {};
    for (const record of records) {
      (payload[record.kind] ??= []).push(
        record.value === undefined
          ? { id: record.id, encrypted_payload: "", updated_at: record.at, deleted_at: record.at }
          : { id: record.id, encrypted_payload: seal(record.value, keyBase64), updated_at: record.at },
      );
    }
    this.pushRows(this.teams.get(teamId)!, payload, by);
  }

  /** 다른 멤버가 지운 것처럼 지움 표시를 둔다. */
  deleteRecord(teamId: string, kind: string, id: string, deletedAt: string, by = this.userId): void {
    this.pushRows(this.teams.get(teamId)!, { [kind]: [{ id, encrypted_payload: "", updated_at: deletedAt, deleted_at: deletedAt }] }, by);
  }

  /** 팀 레코드 올리기(서버의 ApplyTeamPushRecords) — 밀려난 판 가운데 내용이 있던 것은 이전 판으로 남긴다. */
  private pushRows(team: FakeTeam, payload: Record<string, Row[]>, by: string): number {
    // 올리기마다 다른 시각 — 서버는 마이크로초까지 남겨 한 올리기의 판만 같은 시각이다. 같은 밀리초에 두 번 올리면
    // 한 묶음으로 보이지 않게 1ms 씩 민다.
    this.lastChangedAtMs = Math.max(Date.now(), this.lastChangedAtMs + 1);
    const changedAt = new Date(this.lastChangedAtMs).toISOString();
    const written = upsert(team.records, payload, (kind, current, next) => {
      if (current.encrypted_payload) {
        team.versions.push({
          seq: team.versions.length + 1,
          kind,
          recordId: current.id,
          encryptedPayload: current.encrypted_payload,
          updatedAt: current.updated_at,
          ...(current.deleted_at ? { deletedAt: current.deleted_at } : {}),
          updatedBy: team.updatedBy.get(`${kind}:${current.id}`) ?? by,
          changedBy: by,
          changedAt,
          deleted: Boolean(next.deleted_at),
        });
      }
    });
    for (const [kind, records] of Object.entries(payload)) {
      for (const record of records) {
        team.updatedBy.set(`${kind}:${record.id}`, by);
      }
    }
    if (written > 0) {
      team.revision += 1;
    }
    return written;
  }

  putPrivate(teamId: string, kind: string, id: string, value: unknown, updatedAt: string): void {
    const member = this.teams.get(teamId)!.members.get(this.userId)!;
    upsert(member.private, { [kind]: [{ id, encrypted_payload: seal(value, PERSONAL_KEY), updated_at: updatedAt }] });
    member.privateRevision += 1;
  }

  requestsTo(method: string, pathname: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && request.path === pathname);
  }

  async handle(input: URL | string, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (typeof init?.body === "string" && Buffer.byteLength(init.body) > this.bodyLimit) {
      this.tooLarge.push({ method, path: url.pathname, bytes: Buffer.byteLength(init.body) });
      return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
        status: 413,
        headers: { "content-type": "text/html" },
      });
    }
    const headers = new Headers(init?.headers ?? {});
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, headers, body });
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/api/info") {
      return json({ capabilities: { teams: { enabled: true } } });
    }
    if (url.pathname === "/teams") {
      return method === "POST" ? this.createTeam(headers, body) : this.listTeams();
    }
    if (parts[0] === "invite") {
      return this.handleInvite(parts[1], parts[2], method, headers);
    }
    if (parts[0] === "teams" && parts.length >= 2) {
      const team = this.teams.get(parts[1]);
      const member = team?.members.get(this.userId);
      if (!team || !member) {
        return json({ error: "팀을 찾을 수 없습니다.", code: "team_not_found" }, 404);
      }
      const dataRoute = ["sync", "me"].includes(parts[2] ?? "");
      if (dataRoute && this.outdatedTeams.has(team.id)) {
        return json(
          { error: "이 팀에는 최신 버전에서 추가한 항목이 있습니다.", code: "team_client_outdated" },
          426,
        );
      }
      return this.handleTeam(team, member, `${method} ${parts.slice(2).join("/")}`, headers, body, url.searchParams);
    }
    return json({ error: "not found" }, 404);
  }

  private createTeam(headers: Headers, body: Record<string, unknown>): Response {
    if (!headers.get("X-Dolgate-Vault-Epoch")) {
      return json({ error: "epoch", code: "vault_dek_mismatch" }, 409);
    }
    const id = String(body.id);
    if (this.teams.has(id)) {
      return json({ error: "이미 있는 팀입니다.", code: "team_exists" }, 409);
    }
    this.addTeam(id, String(body.name), String(body.wrappedTeamDek));
    return json(this.summary(this.teams.get(id)!), 201);
  }

  private listTeams(): Response {
    if (this.failNextList) {
      this.failNextList = false;
      return json({ error: "서버 오류가 발생했습니다." }, 500);
    }
    return json({
      teams: [...this.teams.values()].filter((team) => team.members.has(this.userId)).map((team) => this.summary(team)),
    });
  }

  private summary(team: FakeTeam) {
    const member = team.members.get(this.userId)!;
    return {
      id: team.id,
      name: team.name,
      role: member.role,
      wrappedTeamDek: member.wrapped,
      dataFloor: 0,
      memberCount: team.members.size,
      createdAt: T0,
    };
  }

  private handleInvite(code: string, action: string, method: string, headers: Headers): Response {
    const invite = this.invites.get(code);
    const token = headers.get("X-Dolgate-Invite-Token") ?? "";
    if (
      !invite ||
      invite.revokedAt ||
      Date.parse(invite.expiresAt) <= Date.now() ||
      hashTeamInviteJoinToken(token) !== invite.tokenHash
    ) {
      return json({ error: "초대 링크가 만료되었거나 올바르지 않습니다.", code: "team_invite_invalid" }, 404);
    }
    const team = this.teams.get(invite.teamId)!;
    if (action === "info" && method === "GET") {
      return json({
        teamId: team.id,
        teamName: team.name,
        inviterEmail: `${invite.createdBy}@example.com`,
        memberCount: team.members.size,
        role: invite.role,
        expiresAt: invite.expiresAt,
      });
    }
    if (action === "join" && method === "POST") {
      const hook = this.beforeJoin;
      this.beforeJoin = null;
      hook?.();
      const existing = team.members.get(this.userId);
      if (!existing) {
        team.members.set(this.userId, this.newMember(invite.role));
        team.infoRevision += 1;
        invite.useCount += 1;
      }
      return json({
        teamId: team.id,
        teamName: team.name,
        inviteBox: invite.box,
        rejoined: Boolean(existing),
        role: team.members.get(this.userId)!.role,
      });
    }
    return json({ error: "not found" }, 404);
  }

  private handleTeam(
    team: FakeTeam,
    member: FakeMember,
    route: string,
    headers: Headers,
    body: Record<string, unknown> & Record<string, Row[]>,
    query: URLSearchParams = new URLSearchParams(),
  ): Response {
    const ifNoneMatch = headers.get("If-None-Match");
    const isOwner = member.role === "owner";
    const isAdmin = canManageTeam(member.role);
    const [verb, ...rest] = route.split(" ");
    const path = rest.join(" ");
    if (verb === "PUT" && path.startsWith("members/") && path.endsWith("/role")) {
      if (!isAdmin) {
        return json(ADMIN_ONLY, 403);
      }
      const role = String(body.role ?? "") as TeamAssignableRole;
      if (role !== "admin" && role !== "member" && role !== "viewer") {
        return json(ROLE_INVALID, 400);
      }
      const target = team.members.get(path.split("/")[1]);
      if (!target) {
        return json(MEMBER_NOT_FOUND, 404);
      }
      if (target.role === "owner") {
        return json(ROLE_INVALID, 400);
      }
      if (!canChangeTeamRole(member.role, target.role, role)) {
        return json(OWNER_ONLY, 403);
      }
      if (target.role !== role) {
        target.role = role;
        team.infoRevision += 1;
      }
      return noContent();
    }
    if (verb === "POST" && path.startsWith("members/") && path.endsWith("/remove")) {
      if (!isAdmin) {
        return json(ADMIN_ONLY, 403);
      }
      const targetId = path.split("/")[1];
      const target = team.members.get(targetId);
      if (!target) {
        return json(MEMBER_NOT_FOUND, 404);
      }
      if (targetId === this.userId && isOwner) {
        return json(MUST_TRANSFER, 409);
      }
      if (!canRemoveTeamMember(member.role, target.role)) {
        return json(OWNER_ONLY, 403);
      }
      team.members.delete(targetId);
      for (const invite of this.invites.values()) {
        if (invite.teamId === team.id) {
          invite.revokedAt ??= new Date().toISOString();
          invite.sealedSecret = null;
        }
      }
      team.infoRevision += 1;
      return noContent();
    }
    if (verb === "DELETE" && path.startsWith("invites/")) {
      if (!isAdmin) {
        return json(ADMIN_ONLY, 403);
      }
      const invite = this.invites.get(path.split("/")[1]);
      if (invite?.teamId === team.id) {
        invite.revokedAt ??= new Date().toISOString();
        invite.sealedSecret = null;
      }
      team.infoRevision += 1;
      return noContent();
    }
    if (verb === "GET" && path === "versions") {
      if (!isAdmin) {
        return json(ADMIN_ONLY, 403);
      }
      // 서버와 같이 최신부터, before 앞을 limit 만큼, kind·recordId 를 주면 그 레코드만.
      const before = Number(query.get("before") ?? 0);
      const limit = Number(query.get("limit") ?? 100);
      const kind = query.get("kind");
      const recordId = query.get("recordId");
      return json({
        versions: [...team.versions]
          .reverse()
          .filter((version) => !before || version.seq < before)
          .filter((version) => !kind || (version.kind === kind && version.recordId === recordId))
          .slice(0, limit)
          .map((version) => ({ ...version, updatedByEmail: `${version.updatedBy}@example.com`, changedByEmail: `${version.changedBy}@example.com` })),
      });
    }
    switch (route) {
      case "PATCH ":
        if (!isOwner) {
          return json(OWNER_ONLY, 403);
        }
        team.name = String(body.name);
        team.infoRevision += 1;
        return noContent();
      case "DELETE ":
        if (!isOwner) {
          return json(OWNER_ONLY, 403);
        }
        this.teams.delete(team.id);
        return noContent();
      case "POST owner": {
        const target = team.members.get(String(body.userId));
        if (!isOwner || !target) {
          return json(OWNER_ONLY, 403);
        }
        // 옛 소유자는 관리자가 된다.
        member.role = "admin";
        target.role = "owner";
        team.infoRevision += 1;
        return noContent();
      }
      case "GET members":
        return json({
          members: [...team.members].map(([userId, entry]) => ({
            userId,
            email: `${userId}@example.com`,
            role: entry.role,
            hasKey: entry.wrapped !== "",
            addedBy: "user-1",
            addedByEmail: "user-1@example.com",
            addedAt: entry.addedAt,
          })),
        });
      case "POST leave":
        if (isOwner && team.members.size > 1) {
          return json({ error: "소유권을 먼저 넘기세요.", code: "team_owner_must_transfer" }, 409);
        }
        team.members.delete(this.userId);
        if (team.members.size === 0) {
          this.teams.delete(team.id);
        }
        return json({ teamDeleted: team.members.size === 0 });
      case "POST invites": {
        if (!isAdmin) {
          return json(ADMIN_ONLY, 403);
        }
        const role = String(body.role ?? "member") as TeamInviteRole;
        if (role !== "member" && role !== "viewer") {
          return json(ROLE_INVALID, 400);
        }
        const code = `code-${randomUUID().slice(0, 8)}`;
        this.invites.set(code, {
          code,
          teamId: team.id,
          box: String(body.inviteBox),
          sealedSecret: typeof body.sealedSecret === "string" && body.sealedSecret ? body.sealedSecret : null,
          tokenHash: String(body.joinTokenHash),
          expiresAt: String(body.expiresAt),
          createdBy: this.userId,
          role,
          revokedAt: null,
          useCount: 0,
        });
        team.infoRevision += 1;
        return json(this.inviteJson(this.invites.get(code)!), 201);
      }
      case "GET invites":
        if (!isAdmin) {
          return json(ADMIN_ONLY, 403);
        }
        return json({
          invites: [...this.invites.values()]
            .filter((invite) => invite.teamId === team.id)
            .map((invite) => this.inviteJson(invite)),
        });
      case "GET sync": {
        const etag = `"${team.revision}"`;
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        const hook = this.beforeRecordsResponse;
        this.beforeRecordsResponse = null;
        hook?.();
        return json(snapshot(team.records), 200, { etag });
      }
      case "POST sync":
        if (!canEditTeamVault(member.role)) {
          return json(READ_ONLY, 403);
        }
        this.pushRows(team, body, this.userId);
        return json({ revision: team.revision }, 202);
      case "GET me": {
        const etag = `"${member.privateRevision}"`;
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        const hook = this.beforePrivateResponse;
        this.beforePrivateResponse = null;
        hook?.();
        return json(snapshot(member.private), 200, { etag });
      }
      case "PUT me":
        if (!headers.get("X-Dolgate-Vault-Epoch") || this.rejectPrivateEpoch) {
          return json({ error: "epoch", code: "vault_dek_mismatch" }, 409);
        }
        if (upsert(member.private, body) > 0) {
          member.privateRevision += 1;
        }
        return json({ revision: member.privateRevision }, 202);
      case "PUT key":
        if (!headers.get("X-Dolgate-Vault-Epoch")) {
          return json({ error: "epoch", code: "vault_dek_mismatch" }, 409);
        }
        if (this.failNextKeyUpload) {
          this.failNextKeyUpload = false;
          return json({ error: "서버 오류가 발생했습니다." }, 500);
        }
        member.wrapped = String(body.wrappedTeamDek);
        team.infoRevision += 1;
        return noContent();
      case "GET sync/watch": {
        const etag = `"t${team.revision}.i${team.infoRevision}.p${member.privateRevision}"`;
        if (ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return json(
          { revision: team.revision, infoRevision: team.infoRevision, privateRevision: member.privateRevision },
          200,
          { etag },
        );
      }
    }
    return json({ error: "not found" }, 404);
  }

  private inviteJson(invite: FakeInvite) {
    const active = invite.revokedAt === null && Date.parse(invite.expiresAt) > Date.now();
    return {
      code: invite.code,
      createdBy: invite.createdBy,
      createdByEmail: `${invite.createdBy}@example.com`,
      role: invite.role,
      expiresAt: invite.expiresAt,
      useCount: invite.useCount,
      createdAt: T0,
      active,
      ...(invite.revokedAt ? { revokedAt: invite.revokedAt } : {}),
      // 서버처럼 살아 있는 링크에만 싣는다.
      ...(active && invite.sealedSecret ? { sealedSecret: invite.sealedSecret } : {}),
    };
  }
}

/** 실제 상태 파일(dataDir)·가짜 서버 위에 팀 동기화와 팀 관리를 세운다. 감시 루프는 시험이 돌린다. */
export async function createTeamHarness(dataDir: string) {
  process.env.DOLSSH_USER_DATA_DIR = dataDir;
  vi.resetModules();
  const stateStorage = await import("./state-storage");
  stateStorage.resetDesktopStateStorageForTests();
  const database = await import("./database");
  const vaultRoot = await import("./vault-root");
  const vaultCatalog = await import("./vault-catalog");
  const teamVaultScope = await import("./team-vault-scope");
  const { TeamSyncService, pendingTeamJoinAccount } = await import("./team-sync-service");
  const { TeamService } = await import("./team-service");
  const { SecretStore } = await import("./secret-store");

  const server = new FakeTeamServer();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL | string, init?: RequestInit) => server.handle(input, init)),
  );
  const context = {
    userId: "user-1",
    serverUrl: SERVER,
    accessToken: "access-1",
    vaultKeyBase64: PERSONAL_KEY,
    vaultEpoch: 3 as number | null,
  };
  const vault = { status: "unlocked" };
  const auth = {
    getState: () => ({ status: "authenticated" }),
    getVaultStatus: () => vault.status,
    captureSyncContext: () => ({ ...context }),
    isSyncContextCurrent: (candidate: typeof context) =>
      candidate.userId === context.userId &&
      candidate.serverUrl === context.serverUrl &&
      candidate.vaultKeyBase64 === context.vaultKeyBase64 &&
      candidate.vaultEpoch === context.vaultEpoch,
    refreshSession: vi.fn(async () => ({ status: "authenticated" })),
    getAccessToken: () => context.accessToken,
    getClientIdentificationHeaders: () => ({ "X-Dolgate-Client": "desktop" }),
  };
  const loops: Array<{ options: SyncWatchLoopOptions; stopped: boolean }> = [];
  const onChanged = vi.fn();
  /** 팀을 잊을 때마다 — 받은 그 팀 호스트의 id 와, 그때 팀 볼트가 아직 있었는지(지우기 직전이어야 한다). */
  const forgotten: Array<{ teamId: string; hostIds: string[]; stillStored: boolean }> = [];
  const secretStore = new SecretStore();
  const service = new TeamSyncService({
    auth,
    secretStore,
    onChanged,
    onTeamForgotten: (teamId, hostIds) => {
      forgotten.push({
        teamId,
        hostIds: [...hostIds].sort(),
        stillStored: stateStorage.getDesktopStateStorage().getTeamState(teamId) !== null,
      });
    },
    startWatchLoop: (options) => {
      const entry = { options, stopped: false };
      loops.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
        },
        retryNow: () => undefined,
      };
    },
  });
  const teams = new TeamService({ auth, teamSync: service });
  /** 살아 있는 감시 루프를 한 바퀴씩 돌린다. */
  const tickLoops = async () => {
    for (const entry of loops.filter((candidate) => !candidate.stopped)) {
      const outcome = await entry.options.watch(new AbortController().signal);
      if (outcome === "changed" && !entry.stopped) {
        await entry.options.onChange();
      }
    }
  };
  const activeLoops = () => loops.filter((entry) => !entry.stopped).length;
  /** main 이 만드는 것과 같은 카탈로그 — 개인 저장소들과 상태 파일의 팀들. */
  const catalog = () =>
    vaultCatalog.createVaultCatalog(
      vaultCatalog.pickVaultRepositories(
        {
          hosts: new database.HostRepository(),
          groups: new database.GroupRepository(),
          tailnets: new database.TailnetRepository(),
          portForwards: new database.PortForwardRepository(),
          dnsOverrides: new database.DnsOverrideRepository(),
          snippets: new database.SnippetRepository(),
          savedWorkspaces: new database.SavedWorkspaceRepository(),
          knownHosts: new database.KnownHostRepository(),
          secretMetadata: new database.SecretMetadataRepository(),
          awsProfiles: new database.AwsProfileRepository(),
          syncOutbox: new database.SyncOutboxRepository(),
        },
        secretStore,
      ),
      teamVaultScope.createStoredTeamVaults(),
    );
  return {
    storage: stateStorage.getDesktopStateStorage(),
    database,
    vaultRoot,
    service,
    teams,
    server,
    auth,
    context,
    vault,
    loops,
    tickLoops,
    activeLoops,
    onChanged,
    forgotten,
    secretStore,
    pendingTeamJoinAccount,
    catalog,
  };
}

/** 팀 하나(TEAM_ID)를 서버에 두고 처음 받기까지 마친 상태. */
export async function createSyncedTeam(dataDir: string, hosts: HostRecord[] = [host("team-a"), host("team-b")]) {
  const harness = await createTeamHarness(dataDir);
  const teamDek = createTeamDek();
  const teamKey = Buffer.from(teamDek).toString("base64");
  harness.server.addTeam(TEAM_ID, "Acme", wrapTeamDek(teamDek, Buffer.from(PERSONAL_KEY, "base64"), TEAM_ID));
  for (const record of hosts) {
    harness.server.putRecord(TEAM_ID, "hosts", record.id, record, teamKey);
  }
  await harness.service.refreshTeams();
  await harness.tickLoops();
  harness.server.requests.length = 0;
  harness.onChanged.mockClear();
  return { ...harness, teamDek, teamKey };
}
