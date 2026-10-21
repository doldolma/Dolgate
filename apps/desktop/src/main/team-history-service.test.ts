import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  createTeamDek,
  openTeamEventBody,
  sealTeamEventBody,
  type ActivityLogRecord,
  type TeamActivityBody,
} from "@shared";
import { deriveTeamEventId, resolveLogTeamId, TeamHistoryService } from "./team-history-service";
import { TeamApiError, type RawTeamEvent, type RawTeamReplay } from "./team-api";

const TEAM = "6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e01";
const OTHER_TEAM = "1d3b6c3a-7f0c-4c43-8a55-2c9b9a2f1e02";
const teamDek = createTeamDek();
const teamKeyBase64 = bytesToBase64(teamDek);
const HISTORY = { replayMaxCount: 10, replayMaxBytes: 1 << 20, replayMaxBytesPerRecording: 1 << 18, segmentMaxBytes: 1 << 20 };

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempScope(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "team-history-"));
  directories.push(directory);
  return directory;
}

interface FakeServer {
  events: Map<string, Array<{ id: string; createdAt: string; payload: string }>>;
  fail: Error | null;
  history: typeof HISTORY | null;
}

function createHarness(options: { open?: (teamId: string) => boolean } = {}) {
  const server: FakeServer = { events: new Map(), fail: null, history: HISTORY };
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const lease = { serverUrl: "https://sync.example.com", accessToken: "t", vaultEpoch: 1, signal: new AbortController().signal, isActive: () => true };
  const api = {
    getServerInfo: vi.fn(async () => ({ capabilities: { teams: { enabled: true, ...(server.history ? { history: server.history } : {}) } } }) as never),
    appendTeamEvents: vi.fn(async (_lease: unknown, teamId: string, events: Array<{ id: string; createdAt: string; payload: string }>) => {
      if (server.fail) {
        throw server.fail;
      }
      const stored = server.events.get(teamId) ?? [];
      let accepted = 0;
      for (const event of events) {
        if (!stored.some((existing) => existing.id === event.id)) {
          stored.push(event);
          accepted += 1;
        }
      }
      server.events.set(teamId, stored);
      return accepted;
    }),
    listTeamEvents: vi.fn(async (): Promise<RawTeamEvent[]> => []),
    listTeamReplays: vi.fn(async (): Promise<RawTeamReplay[]> => []),
  };
  const service = new TeamHistoryService({
    api: api as never,
    openTeamAccess: (teamId) => ((options.open ?? (() => true))(teamId) ? { lease, teamKeyBase64 } : null),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
  });
  service.setTeamResolver((metadata) =>
    metadata?.hostId === "team-host" ? TEAM : metadata?.hostId === "other-team-host" ? OTHER_TEAM : null,
  );
  /** 걸린 타이머를 모두 돌린다(보내기). */
  const runTimers = async () => {
    for (const timer of timers.splice(0)) {
      if (!timer.cancelled) {
        timer.callback();
      }
    }
    await service.flush();
  };
  const sentBodies = (teamId = TEAM) =>
    (server.events.get(teamId) ?? []).map((event) => openTeamEventBody<TeamActivityBody>(teamDek, teamId, event.id, event.payload));
  return { service, server, api, timers, runTimers, sentBodies };
}

function sessionRecord(status: string, overrides: Partial<ActivityLogRecord> = {}): ActivityLogRecord {
  return {
    id: "session-log-1",
    level: "info",
    category: "session",
    kind: "session-lifecycle",
    message: "SSH session",
    messageKey: "core.sessionLog",
    messageParams: null,
    metadata: { sessionId: "s1", hostId: "team-host", hostLabel: "web-1", status, recordingId: "rec-1", hasReplay: true },
    createdAt: "2026-10-21T01:00:00.000Z",
    updatedAt: "2026-10-21T01:00:00.000Z",
    ...overrides,
  };
}

function auditRecord(id: string, metadata: Record<string, unknown> | null, messageKey = "hostsIpc.hostUpdated"): ActivityLogRecord {
  return {
    id,
    level: "info",
    category: "audit",
    kind: "generic",
    message: "Host updated",
    messageKey,
    messageParams: null,
    metadata,
    createdAt: "2026-10-21T01:00:00.000Z",
    updatedAt: "2026-10-21T01:00:00.000Z",
  };
}

describe("TeamHistoryService mirroring", () => {
  it("sends the start and the end of a team host session once each, sealed with the team key", async () => {
    const { service, runTimers, sentBodies, server } = createHarness();
    service.activate(tempScope());
    service.mirror(sessionRecord("connected"));
    // 붙은 뒤 녹화 표시만 고친 갱신은 다시 올리지 않는다.
    service.mirror(sessionRecord("connected", { updatedAt: "2026-10-21T01:00:05.000Z" }));
    await runTimers();
    service.mirror(sessionRecord("closed", { updatedAt: "2026-10-21T01:10:00.000Z" }));
    service.mirror(sessionRecord("closed", { metadata: { hostId: "team-host", status: "closed", hasReplay: false } }));
    await runTimers();

    const bodies = sentBodies();
    expect(bodies.map((body) => body.phase)).toEqual(["start", "end"]);
    expect(bodies.every((body) => body.record.id === "session-log-1" && body.v === 1)).toBe(true);
    expect(server.events.get(TEAM)?.map((event) => event.id)).toEqual([
      deriveTeamEventId("session-log-1|start"),
      deriveTeamEventId("session-log-1|end"),
    ]);
  });

  // 접속 줄은 붙자마자 쓰이고, 녹화 ID 는 곧이어 붙는다 — 팀 쪽 진행 중인 접속에서도 Replay 를 열 수 있어야 한다.
  it("lets a start line still waiting to be sent pick up the recording attached right after it", async () => {
    const { service, runTimers, sentBodies } = createHarness();
    service.activate(tempScope());
    service.mirror(
      sessionRecord("connected", {
        metadata: { sessionId: "s1", hostId: "team-host", hostLabel: "web-1", status: "connected", recordingId: null, hasReplay: false },
      }),
    );
    service.mirror(sessionRecord("connected", { updatedAt: "2026-10-21T01:00:00.050Z" }));
    await runTimers();
    // 이미 보낸 줄은 다시 보내지 않는다.
    service.mirror(sessionRecord("connected", { updatedAt: "2026-10-21T01:00:09.000Z" }));
    await runTimers();

    const bodies = sentBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.record.metadata).toMatchObject({ status: "connected", recordingId: "rec-1", hasReplay: true });
  });

  it("leaves personal hosts, account events and my-credentials changes on this device only", async () => {
    const { service, runTimers, server } = createHarness();
    service.activate(tempScope());
    service.mirror(sessionRecord("connected", { metadata: { hostId: "personal-host", status: "connected" } }));
    service.mirror(auditRecord("8e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", null, "auth.signedIn"));
    service.mirror(auditRecord("9e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }, "teams.myCredentialsSaved"));
    // 붙는 중인 수명 줄은 아직 올리지 않는다.
    service.mirror(sessionRecord("connecting", { kind: "sftp-lifecycle" }));
    await runTimers();
    expect(server.events.size).toBe(0);
  });

  it("does nothing until an account history scope is open", async () => {
    const { service, runTimers, server } = createHarness();
    service.mirror(sessionRecord("connected"));
    await runTimers();
    expect(server.events.size).toBe(0);
  });

  it("keeps the queue across restarts and sends it once the team opens", async () => {
    let open = false;
    const scope = tempScope();
    const first = createHarness({ open: () => open });
    first.service.activate(scope);
    first.service.mirror(auditRecord("7e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    await first.runTimers();
    expect(first.server.events.size).toBe(0);

    // 앱을 다시 켰다 — 같은 기록 자리에서 대기열을 읽는다.
    const second = createHarness({ open: () => open });
    second.service.activate(scope);
    open = true;
    second.service.kick();
    await second.runTimers();
    expect(second.sentBodies().map((body) => body.record.id)).toEqual(["7e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b"]);

    // 보낸 것은 대기열에서 빠진다 — 다시 켜도 다시 보내지 않는다.
    const third = createHarness();
    third.service.activate(scope);
    await third.runTimers();
    expect(third.server.events.size).toBe(0);
  });

  it("wipes this account's team history folder when the account is deleted", async () => {
    const scope = tempScope();
    const first = createHarness({ open: () => false });
    first.service.activate(scope);
    first.service.mirror(auditRecord("7e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    const folder = first.service.stateDirectoryPath!;
    expect(existsSync(folder)).toBe(true);

    first.service.purgeLocalData();
    expect(existsSync(folder)).toBe(false);
    expect(first.service.stateDirectoryPath).toBeNull();
    const second = createHarness();
    second.service.activate(scope);
    await second.runTimers();
    expect(second.server.events.size).toBe(0);
  });

  it("retries after a network failure and sends a resent event only once", async () => {
    const { service, server, runTimers, timers, sentBodies } = createHarness();
    service.activate(tempScope());
    server.fail = new TypeError("fetch failed");
    service.mirror(auditRecord("6e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    await runTimers();
    expect(server.events.size).toBe(0);
    expect(timers.some((timer) => timer.delayMs > 1000)).toBe(true);
    server.fail = null;
    await runTimers();
    await service.flush();
    expect(sentBodies()).toHaveLength(1);
  });

  it("drops the queue when the server no longer has the member or does not know team history", async () => {
    const removed = createHarness();
    removed.service.activate(tempScope());
    removed.server.fail = new TeamApiError(404, "team_not_found", "gone");
    removed.service.mirror(auditRecord("5e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    await removed.runTimers();
    removed.server.fail = null;
    await removed.service.flush();
    expect(removed.server.events.size).toBe(0);

    const oldServer = createHarness();
    oldServer.server.history = null;
    oldServer.service.activate(tempScope());
    oldServer.service.mirror(auditRecord("4e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    await oldServer.runTimers();
    expect(oldServer.api.appendTeamEvents).not.toHaveBeenCalled();
  });

  it("drops a forgotten team's queue and sends what is left before quitting", async () => {
    const { service, runTimers, sentBodies, timers } = createHarness();
    service.activate(tempScope());
    service.mirror(auditRecord("3e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "other-team-host" }));
    service.forgetTeam(OTHER_TEAM);
    service.mirror(auditRecord("2e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host" }));
    timers.splice(0);
    await service.flushBeforeQuit(3000);
    expect(sentBodies()).toHaveLength(1);
    expect(sentBodies(OTHER_TEAM)).toHaveLength(0);
    await runTimers();
  });

  it("shrinks a body that would not fit the server limit", async () => {
    const { service, runTimers, sentBodies } = createHarness();
    service.activate(tempScope());
    service.mirror(auditRecord("1e0a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b", { hostId: "team-host", message: "x".repeat(40_000) }));
    await runTimers();
    const [body] = sentBodies();
    expect(String(body.record.metadata?.message).length).toBeLessThan(400);
    expect(body.record.metadata?.hostId).toBe("team-host");
  });
});

describe("TeamHistoryService reading", () => {
  it("opens app activity with the team key and passes member changes through", async () => {
    const { service, api } = createHarness();
    const body: TeamActivityBody = { v: 1, phase: "start", record: sessionRecord("connected") };
    const events: RawTeamEvent[] = [
      { seq: 3, id: "e3", source: "app", authorUserId: "u2", authorEmail: "b@example.com", createdAt: "", receivedAt: "", payload: sealTeamEventBody(teamDek, TEAM, "e3", body) },
      { seq: 2, id: "e2", source: "app", authorUserId: "u2", authorEmail: "b@example.com", createdAt: "", receivedAt: "", payload: sealTeamEventBody(teamDek, TEAM, "e2", { v: 99 }) },
      { seq: 1, id: "e1", source: "server", authorUserId: "u2", authorEmail: "b@example.com", createdAt: "", receivedAt: "", payload: JSON.stringify({ type: "member_joined", userId: "u2", email: "b@example.com" }) },
      // 다른 줄의 암호문을 옮겨 놓으면 풀리지 않는다.
      { seq: 4, id: "e4", source: "app", authorUserId: "u2", authorEmail: "b@example.com", createdAt: "", receivedAt: "", payload: sealTeamEventBody(teamDek, TEAM, "e3", body) },
    ];
    api.listTeamEvents.mockResolvedValue(events);
    const items = await service.listActivity(TEAM, { limit: 10 });
    expect(items[0].activity).toEqual(body);
    expect(items[1]).toMatchObject({ activity: null, unreadable: "unsupported-version" });
    expect(items[2].memberChange).toEqual({ type: "member_joined", userId: "u2", email: "b@example.com" });
    expect(items[3]).toMatchObject({ activity: null, unreadable: "broken" });
  });

  it("asks the server about the recordings shown on screen", async () => {
    const { service, api } = createHarness();
    api.listTeamReplays.mockResolvedValue([
      { recordingId: "6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e09", state: "deleted", authorEmail: "a@example.com" } as RawTeamReplay,
    ]);
    const statuses = await service.getReplayStatuses(TEAM, ["6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e09", "not-a-uuid"]);
    expect(api.listTeamReplays).toHaveBeenCalledWith(expect.anything(), TEAM, { ids: ["6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e09"] });
    expect(statuses).toEqual([{ recordingId: "6f0b6a6e-6b0c-4f43-9a55-2c9b9a2f1e09", state: "deleted", authorEmail: "a@example.com" }]);
  });

  it("refuses to read a team that is not open on this device", async () => {
    const { service } = createHarness({ open: () => false });
    await expect(service.listActivity(TEAM)).rejects.toThrow();
  });
});

describe("resolveLogTeamId", () => {
  const scope = (id: string) => ({ id });
  const vaults = {
    getScope: (id: string) => (id === TEAM || id === "personal" ? scope(id) : null),
    scopeOfHost: (id: string) => scope(id === "team-host" ? TEAM : "personal"),
    scopeOfPortForward: (id: string) => scope(id === "team-rule" ? TEAM : "personal"),
    scopeOfDnsOverride: (id: string) => scope(id === "team-dns" ? TEAM : "personal"),
    scopeOfSnippet: (id: string) => scope(id === "team-snippet" ? TEAM : "personal"),
    scopeOfSecret: (id: string) => scope(id === "team-secret" ? TEAM : "personal"),
  } as never;

  it("finds the team from the vault in the log or the record it points at", () => {
    expect(resolveLogTeamId(vaults, { vaultId: TEAM, path: "Prod" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { sourceVaultId: "personal", targetVaultId: TEAM })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { sourceVaultId: TEAM, targetVaultId: "personal" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { hostId: "team-host" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { ruleId: "team-rule" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { portForwardRuleId: "team-rule" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { dnsOverrideId: "team-dns" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { snippetId: "team-snippet" })).toBe(TEAM);
    expect(resolveLogTeamId(vaults, { secretRef: "team-secret" })).toBe(TEAM);
  });

  it("leaves personal records, unknown teams and logs without a record alone", () => {
    expect(resolveLogTeamId(vaults, { hostId: "personal-host" })).toBeNull();
    expect(resolveLogTeamId(vaults, { vaultId: "personal" })).toBeNull();
    expect(resolveLogTeamId(vaults, { vaultId: OTHER_TEAM })).toBeNull();
    expect(resolveLogTeamId(vaults, { email: "a@example.com" })).toBeNull();
    expect(resolveLogTeamId(vaults, null)).toBeNull();
  });
});
