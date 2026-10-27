import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord, TeamChangeSet } from "@shared";
import { createSyncedTeam as createSyncedTeamIn, host, open, seal, T0, TEAM_ID } from "./team-sync.test-support";

// 바뀐 것 목록과 복원을 가짜 서버(team-sync.test-support.ts)와 실제 팀 동기화로 시험한다.

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => (name === "userData" ? tempDir : os.tmpdir())),
    getVersion: vi.fn(() => "1.9.14-test"),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
}));

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-restore-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const at = (minute: number) => new Date(Date.parse("2026-10-20T00:00:00.000Z") + minute * 60_000).toISOString();

async function createTeam(hosts: HostRecord[]) {
  const harness = await createSyncedTeamIn(tempDir, hosts);
  const { TeamRestoreService } = await import("./team-restore-service");
  const { TeamApi } = await import("./team-api");
  const onRestored = vi.fn(() => harness.service.pushDirty());
  const restore = new TeamRestoreService({
    api: new TeamApi(harness.auth as never),
    openTeamAccess: (teamId) => harness.service.openTeamAccess(teamId),
    writeTime: (teamId, records) => harness.service.writeTimeAfterServer(teamId, records),
    onRestored,
  });
  const localHosts = () => harness.storage.getTeamState(TEAM_ID)?.data.hosts ?? [];
  const serverRecord = (kind: string, id: string) => harness.server.teams.get(TEAM_ID)!.records.get(kind)?.get(id);
  return { ...harness, restore, onRestored, localHosts, serverRecord };
}

const summary = (set: TeamChangeSet) => ({
  by: set.changedByEmail,
  items: set.items.map((item) => [item.kind, item.label, item.deleted ? "deleted" : "edited", item.currentLabel]),
  changedLater: set.changedLater,
  restored: set.restored,
});

describe("TeamRestoreService", () => {
  it("lists changes grouped by push, newest first, with what each push did", async () => {
    const team = await createTeam([host("web-1"), host("web-2"), host("bastion")]);
    team.server.pushBatch(
      TEAM_ID,
      [
        { kind: "hosts", id: "web-1", at: at(1) },
        { kind: "hosts", id: "web-2", at: at(1) },
      ],
      team.teamKey,
      "sora",
    );
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "bastion", value: host("bastion", { label: "bastion-old", updatedAt: at(2) }), at: at(2) }],
      team.teamKey,
      "hyunwoo",
    );
    await team.tickLoops();

    const page = await team.restore.listChanges(TEAM_ID);
    expect(page.nextBefore).toBeNull();
    expect(page.sets.map(summary)).toEqual([
      { by: "hyunwoo@example.com", items: [["hosts", "bastion", "edited", "bastion-old"]], changedLater: false, restored: false },
      {
        by: "sora@example.com",
        items: [
          ["hosts", "web-1", "deleted", null],
          ["hosts", "web-2", "deleted", null],
        ],
        changedLater: false,
        restored: false,
      },
    ]);
  });

  it("restores a deleted push and pushes it back, after which the push reads as restored", async () => {
    const team = await createTeam([host("web-1"), host("web-2"), host("keep")]);
    team.server.pushBatch(
      TEAM_ID,
      [
        { kind: "hosts", id: "web-1", at: at(1) },
        { kind: "hosts", id: "web-2", at: at(1) },
      ],
      team.teamKey,
      "sora",
    );
    await team.tickLoops();
    expect(team.localHosts().map((record) => record.id)).toEqual(["keep"]);

    const [set] = (await team.restore.listChanges(TEAM_ID)).sets;
    const outcome = await team.restore.restoreChange(TEAM_ID, set);
    expect(outcome).toEqual({
      status: "restored",
      restored: [
        { kind: "hosts", recordId: "web-1", label: "web-1" },
        { kind: "hosts", recordId: "web-2", label: "web-2" },
      ],
      dependencies: [],
      skipped: [],
    });
    expect(team.onRestored).toHaveBeenCalledTimes(1);
    expect(team.localHosts().map((record) => record.id).sort()).toEqual(["keep", "web-1", "web-2"]);
    // 복원은 올리기를 기다린 뒤 돌아온다 — 서버에 다시 산 레코드가 이미 있다(지움 표시를 덮었다).
    const web1 = team.serverRecord("hosts", "web-1")!;
    expect(web1.deleted_at).toBeUndefined();
    expect(open(web1.encrypted_payload, team.teamKey)).toMatchObject({ id: "web-1", label: "web-1" });

    const [after] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect(summary(after)).toMatchObject({ restored: true });
    // 지운 표시를 덮은 복원은 이전 판을 남기지 않는다(지운 표시는 판이 아니다).
    expect(team.server.teams.get(TEAM_ID)!.versions).toHaveLength(2);
    // 이미 지금과 같으니 다시 눌러도 쓸 것이 없다.
    expect(await team.restore.restoreChange(TEAM_ID, after)).toEqual({ status: "restored", restored: [], dependencies: [], skipped: [] });
    expect(team.onRestored).toHaveBeenCalledTimes(1);
  });

  it("brings back what a restored host points at when that was deleted in a later push", async () => {
    const team = await createTeam([
      host("jump", { secretRef: "secret:jump" }),
      host("tunnel"),
      host("db", { secretRef: "secret:db", jumpHostIds: ["jump"], sshTunnelHostId: "tunnel" }),
    ]);
    team.server.putRecord(TEAM_ID, "secrets", "secret:db", { secretRef: "secret:db", label: "db", password: "pw", updatedAt: T0 }, team.teamKey);
    team.server.putRecord(TEAM_ID, "secrets", "secret:jump", { secretRef: "secret:jump", label: "jump", password: "jp", updatedAt: T0 }, team.teamKey);
    // 살아 있는 터널 호스트에도 옛 판이 있다 — 딸린 것은 지워진 것만 되살리므로 그대로여야 한다.
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "tunnel", value: host("tunnel", { hostname: "tunnel-v2.example.com", updatedAt: at(0) }), at: at(0) }],
      team.teamKey,
      "sora",
    );
    await team.tickLoops();
    // 앱의 지우기처럼 호스트를 먼저, 안 쓰는 비밀번호와 점프 호스트를 다음 올리기에 지운다.
    team.server.pushBatch(TEAM_ID, [{ kind: "hosts", id: "db", at: at(1) }], team.teamKey, "sora");
    team.server.pushBatch(
      TEAM_ID,
      [
        { kind: "secrets", id: "secret:db", at: at(2) },
        { kind: "hosts", id: "jump", at: at(2) },
      ],
      team.teamKey,
      "sora",
    );
    // 점프 호스트의 비밀번호는 그 다음에 지웠다 — 딸린 것의 딸린 것이다.
    team.server.pushBatch(TEAM_ID, [{ kind: "secrets", id: "secret:jump", at: at(3) }], team.teamKey, "sora");
    await team.tickLoops();

    const sets = (await team.restore.listChanges(TEAM_ID)).sets;
    const hostSet = sets.find((set) => set.items.some((item) => item.recordId === "db"))!;
    const outcome = await team.restore.restoreChange(TEAM_ID, hostSet);
    expect(outcome).toMatchObject({ status: "restored", restored: [{ kind: "hosts", recordId: "db" }], skipped: [] });
    expect(outcome.status === "restored" ? outcome.dependencies.map((record) => record.recordId).sort() : null).toEqual([
      "jump",
      "secret:db",
      "secret:jump",
    ]);
    await team.service.pushDirty();
    expect(team.serverRecord("secrets", "secret:db")!.deleted_at).toBeUndefined();
    expect(team.serverRecord("hosts", "jump")!.deleted_at).toBeUndefined();
    expect(team.serverRecord("secrets", "secret:jump")!.deleted_at).toBeUndefined();
    expect(open(team.serverRecord("hosts", "tunnel")!.encrypted_payload, team.teamKey)).toMatchObject({ hostname: "tunnel-v2.example.com" });
    const secret = team.storage.getTeamState(TEAM_ID)!.secure.managedSecretsByRef["secret:db"];
    expect(secret).toBeDefined();
  });

  it("asks before overwriting what someone changed after that push, and overwrites only when told to", async () => {
    const team = await createTeam([host("api")]);
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "api", value: host("api", { hostname: "api-v2.example.com", updatedAt: at(1) }), at: at(1) }],
      team.teamKey,
      "sora",
    );
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "api", value: host("api", { hostname: "api-v3.example.com", updatedAt: at(2) }), at: at(2) }],
      team.teamKey,
      "hyunwoo",
    );
    await team.tickLoops();
    const [latest, older] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect([latest.changedLater, older.changedLater]).toEqual([false, true]);

    const asked = await team.restore.restoreChange(TEAM_ID, older);
    expect(asked).toEqual({
      status: "needs-confirm",
      overwrites: [
        {
          kind: "hosts",
          recordId: "api",
          label: "api",
          byEmail: "hyunwoo@example.com",
          at: expect.any(String),
        },
      ],
    });
    expect(team.onRestored).not.toHaveBeenCalled();
    expect(team.localHosts()[0]).toMatchObject({ hostname: "api-v3.example.com" });

    const forced = await team.restore.restoreChange(TEAM_ID, older, { overwrite: true });
    expect(forced.status).toBe("restored");
    expect(team.localHosts()[0]).toMatchObject({ hostname: "api.example.com" });
  });

  it("reverts the latest edit without asking and leaves the overwritten version as a new change", async () => {
    const team = await createTeam([host("bastion")]);
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "bastion", value: host("bastion", { label: "bastion-old", updatedAt: at(1) }), at: at(1) }],
      team.teamKey,
      "sora",
    );
    await team.tickLoops();
    const [rename] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect(await team.restore.restoreChange(TEAM_ID, rename)).toMatchObject({ status: "restored" });
    expect(team.localHosts()[0].label).toBe("bastion");
    await team.service.pushDirty();

    const sets = (await team.restore.listChanges(TEAM_ID)).sets;
    // 복원이 덮은 판(bastion-old)이 내 이름으로 새 묶음이 된다 — 다시 복원하면 이름이 돌아간다.
    expect(sets.map(summary)).toEqual([
      { by: "user-1@example.com", items: [["hosts", "bastion-old", "edited", "bastion"]], changedLater: false, restored: false },
      { by: "sora@example.com", items: [["hosts", "bastion", "edited", null]], changedLater: true, restored: true },
    ]);
  });

  it("stamps restored records after the server's tombstone even when this clock is behind", async () => {
    const team = await createTeam([host("web-1")]);
    // 시계가 한 시간 빠른 멤버가 지웠다.
    const ahead = new Date(Date.now() + 60 * 60_000).toISOString();
    team.server.pushBatch(TEAM_ID, [{ kind: "hosts", id: "web-1", at: ahead }], team.teamKey, "sora");
    await team.tickLoops();
    const [set] = (await team.restore.listChanges(TEAM_ID)).sets;
    await team.restore.restoreChange(TEAM_ID, set);
    expect(Date.parse(team.localHosts()[0].updatedAt)).toBeGreaterThan(Date.parse(ahead));
    await team.service.pushDirty();
    expect(team.serverRecord("hosts", "web-1")!.deleted_at).toBeUndefined();
  });

  it("skips a record whose id another vault now holds, and a version it cannot open", async () => {
    const team = await createTeam([host("web-1"), host("web-2")]);
    team.server.pushBatch(
      TEAM_ID,
      [
        { kind: "hosts", id: "web-1", at: at(1) },
        { kind: "hosts", id: "web-2", at: at(1) },
      ],
      team.teamKey,
      "sora",
    );
    await team.tickLoops();
    // 그 사이 개인 볼트에 같은 id 가 생겼다.
    team.storage.applyVaultCopy("personal", {
      groups: [],
      hosts: [host("web-1", { label: "mine" })],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      secretMetadata: [],
      awsProfiles: [],
      snippets: [],
      savedWorkspaces: [],
      tailnets: [],
      secrets: {},
      awsProfilePayloads: {},
      tailnetAuthKeys: {},
      memberHostPrefs: [],
      memberSecrets: {},
      terminalThemeByHostId: {},
    });
    // 다른 키로 잠긴 판(풀 수 없음)을 하나 섞는다.
    const versions = team.server.teams.get(TEAM_ID)!.versions;
    versions[1] = { ...versions[1], encryptedPayload: seal(host("web-2"), Buffer.alloc(32, 9).toString("base64")) };

    const [set] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect(set.items.map((item) => item.label)).toEqual(["web-1", null]);
    const outcome = await team.restore.restoreChange(TEAM_ID, set);
    expect(outcome).toEqual({
      status: "restored",
      restored: [],
      dependencies: [],
      skipped: [
        { kind: "hosts", recordId: "web-2", label: null, reason: "unreadable" },
        { kind: "hosts", recordId: "web-1", label: "web-1", reason: "other-vault" },
      ],
    });
    expect(team.onRestored).not.toHaveBeenCalled();
    expect(team.localHosts()).toEqual([]);
  });

  it("skips a host kind this build does not know, and refuses a push whose versions are gone", async () => {
    const team = await createTeam([host("web-1"), host("future", { kind: "quantum-shell" })]);
    team.server.pushBatch(
      TEAM_ID,
      [
        { kind: "hosts", id: "web-1", at: at(1) },
        { kind: "hosts", id: "future", at: at(1) },
      ],
      team.teamKey,
      "sora",
    );
    await team.tickLoops();
    const [set] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect(await team.restore.restoreChange(TEAM_ID, set)).toMatchObject({
      restored: [{ recordId: "web-1" }],
      skipped: [{ recordId: "future", reason: "unreadable" }],
    });

    // 보존 기간이 지나 서버가 판을 지웠다.
    team.server.teams.get(TEAM_ID)!.versions.length = 0;
    await expect(team.restore.restoreChange(TEAM_ID, set)).rejects.toThrow();
  });

  it("pages through versions without splitting a push across pages", async () => {
    const team = await createTeam([]);
    const versions = team.server.teams.get(TEAM_ID)!.versions;
    const push = (from: number, to: number, changedAt: string, by: string) => {
      for (let seq = from; seq <= to; seq += 1) {
        versions.push({
          seq,
          kind: "hosts",
          recordId: `h${seq}`,
          encryptedPayload: seal(host(`h${seq}`), team.teamKey),
          updatedAt: T0,
          updatedBy: by,
          changedBy: by,
          changedAt,
          deleted: true,
        });
      }
    };
    // 오래된 큰 올리기 하나(300) 위에 작은 올리기 40개(10씩) — 첫 쪽(500)은 큰 올리기의 중간에서 끊긴다.
    push(1, 300, at(0), "sora");
    for (let index = 0; index < 40; index += 1) {
      push(301 + index * 10, 310 + index * 10, at(index + 1), "hyunwoo");
    }
    const first = await team.restore.listChanges(TEAM_ID);
    expect(first.sets).toHaveLength(40);
    expect(first.sets.every((set) => set.items.length === 10)).toBe(true);
    expect(first.nextBefore).toBe(301);
    const second = await team.restore.listChanges(TEAM_ID, { before: first.nextBefore! });
    expect(second.sets).toHaveLength(1);
    expect(second.sets[0].items).toHaveLength(300);
    expect([second.sets[0].firstSeq, second.sets[0].lastSeq]).toEqual([1, 300]);
    expect(second.nextBefore).toBeNull();
  });

  it("asks before overwriting a record that was deleted by that push and made again since", async () => {
    const team = await createTeam([host("web-1")]);
    team.server.pushBatch(TEAM_ID, [{ kind: "hosts", id: "web-1", at: at(1) }], team.teamKey, "sora");
    // 같은 id 로 다시 만들어졌다(내용이 다르다) — 지운 표시 위에 쓴 것이라 이전 판은 없다.
    team.server.pushBatch(
      TEAM_ID,
      [{ kind: "hosts", id: "web-1", value: host("web-1", { hostname: "new.example.com", updatedAt: at(2) }), at: at(2) }],
      team.teamKey,
      "hyunwoo",
    );
    await team.tickLoops();
    const [set] = (await team.restore.listChanges(TEAM_ID)).sets;
    expect(summary(set)).toMatchObject({ changedLater: true, restored: false });
    expect(await team.restore.restoreChange(TEAM_ID, set)).toEqual({
      status: "needs-confirm",
      overwrites: [{ kind: "hosts", recordId: "web-1", label: "web-1", byEmail: null, at: null }],
    });
  });

  it("refuses members below admin before asking the server", async () => {
    const team = await createTeam([host("web-1")]);
    team.storage.upsertTeamInfo(TEAM_ID, { ...team.storage.getTeamState(TEAM_ID)!.info, role: "member" });
    const requests = team.server.requests.length;
    await expect(team.restore.listChanges(TEAM_ID)).rejects.toThrow();
    expect(team.server.requests).toHaveLength(requests);
  });
});

describe("team record helpers", () => {
  it("follows what a record points at, by the kind that holds it", async () => {
    const { teamRecordReferences } = await import("./team-restore-service");
    expect(
      teamRecordReferences("hosts", {
        id: "h",
        kind: "ssh",
        jumpHostIds: ["j1", " "],
        sshTunnelHostId: "tunnel",
        tailnetId: "tn",
        awsProfileId: "aws",
        startupCommand: { type: "snippet", snippetId: "sn" },
        secretRef: "secret:h",
      }),
    ).toEqual([
      { kind: "hosts", id: "j1" },
      { kind: "hosts", id: "tunnel" },
      { kind: "tailnets", id: "tn" },
      { kind: "awsProfiles", id: "aws" },
      { kind: "snippets", id: "sn" },
      { kind: "secrets", id: "secret:h" },
    ]);
    expect(teamRecordReferences("portForwards", { id: "pf", hostId: "h" })).toEqual([{ kind: "hosts", id: "h" }]);
    expect(teamRecordReferences("dnsOverrides", { id: "d", type: "linked", portForwardRuleId: "pf" })).toEqual([
      { kind: "portForwards", id: "pf" },
    ]);
    expect(teamRecordReferences("dnsOverrides", { id: "d", type: "static", address: "10.0.0.1" })).toEqual([]);
    expect(
      teamRecordReferences("workspaces", {
        id: "w",
        root: {
          id: "s",
          kind: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: { id: "a", kind: "leaf", target: { kind: "host", hostId: "h1", label: "h1" } },
          second: { id: "b", kind: "leaf", target: { kind: "local", label: "local" } },
        },
      }),
    ).toEqual([{ kind: "hosts", id: "h1" }]);
  });

  it("compares content without write times or emptied fields", async () => {
    const { sameTeamRecordContent } = await import("./team-restore-service");
    const base = { id: "h", label: "web", port: 22, updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(sameTeamRecordContent(base, { ...base, updatedAt: "2026-02-01T00:00:00.000Z", favorite: null })).toBe(true);
    expect(sameTeamRecordContent({ ...base, lastSeenAt: "a" }, { ...base, lastSeenAt: "b" })).toBe(true);
    expect(sameTeamRecordContent(base, { ...base, port: 2222 })).toBe(false);
    expect(sameTeamRecordContent(base, { ...base, extra: { nested: 1 } })).toBe(false);
  });
});
