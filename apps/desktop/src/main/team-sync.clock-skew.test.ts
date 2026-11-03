import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncedTeam as createSyncedTeamIn, host, open, sshDraft, TEAM_ID } from "./team-sync.test-support";

// 다른 팀원 기기의 시계가 빠르면 그 사람이 막 고친 레코드의 시각이 내 '지금'보다 뒤다. 예전에는 그 레코드를 내가 고쳐도
// 올라가지 않고(서버 사본보다 옛것) 다음 받기에서 그 사람 것으로 덮였고, 지운 것은 서버가 무시해 바로 되살아났다(2026-11-02
// 리뷰). 지금은 팀 볼트에 쓰는 시각을 내가 본 시각보다 뒤로 적는다(team-write-times.ts).

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
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-clock-skew-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(tempDir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

/** 그 팀원 기기의 시계로 본 지금. */
const theirNow = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const plus1ms = (time: string) => new Date(Date.parse(time) + 1).toISOString();

/** 다른 팀원(user-2)이 올린 레코드를 받은 상태. 앱은 레코드 안의 시각과 서버 줄의 시각을 늘 같게 올린다. */
async function teamWithTheirRecord(kind: string, id: string, value: object, theirTime: string) {
  const harness = await createSyncedTeamIn(tempDir, []);
  harness.server.putRecord(TEAM_ID, kind, id, { ...value, updatedAt: theirTime }, harness.teamKey, theirTime, "user-2");
  await harness.tickLoops();
  harness.server.requests.length = 0;
  const root = harness.vaultRoot.teamVaultRoot(TEAM_ID);
  const serverRow = () => harness.server.teams.get(TEAM_ID)!.records.get(kind)!.get(id)!;
  const pushed = () =>
    harness.server
      .requestsTo("POST", `/teams/${TEAM_ID}/sync`)
      .flatMap((request) => (request.body[kind] ?? []) as Array<{ id: string; updated_at: string; encrypted_payload: string }>)
      .filter((record) => record.id === id);
  /** 다른 팀원이 나중에 상관없는 호스트를 하나 더 올린다 — 이 기기가 서버 사본을 통째로 다시 받게. */
  const someoneElsePushesLater = async () => {
    const later = plus1ms(theirTime);
    harness.server.putRecord(TEAM_ID, "hosts", "team-z", host("team-z", { updatedAt: later }), harness.teamKey, later, "user-2");
    await harness.tickLoops();
  };
  return { ...harness, root, serverRow, pushed, someoneElsePushesLater };
}

describe("team records written after a teammate whose clock runs ahead", () => {
  it("pushes my edit with my own time when clocks agree", async () => {
    const theirTime = theirNow(-1000);
    const team = await teamWithTheirRecord("hosts", "team-a", host("team-a", { label: "theirs" }), theirTime);

    const record = new team.database.HostRepository(team.root).update("team-a", sshDraft("mine"));
    await team.service.pushDirty();

    expect(Date.parse(record.updatedAt)).toBeGreaterThan(Date.parse(theirTime));
    expect(team.pushed()).toEqual([expect.objectContaining({ updated_at: record.updatedAt })]);
    expect(open<{ label: string }>(team.serverRow().encrypted_payload, team.teamKey).label).toBe("mine");
  });

  it("pushes my edit just after their time and keeps it after the next pull", async () => {
    const theirTime = theirNow(HOUR);
    const team = await teamWithTheirRecord("hosts", "team-a", host("team-a", { label: "theirs" }), theirTime);
    // 받은 것은 다시 올리지 않는다.
    await team.service.pushDirty();
    expect(team.server.requests).toEqual([]);

    new team.database.HostRepository(team.root).update("team-a", sshDraft("mine"));
    await team.service.pushDirty();
    await team.someoneElsePushesLater();

    expect(team.pushed()).toEqual([expect.objectContaining({ updated_at: plus1ms(theirTime) })]);
    expect(team.serverRow().updated_at).toBe(plus1ms(theirTime));
    const stored = open<{ label: string; updatedAt: string }>(team.serverRow().encrypted_payload, team.teamKey);
    expect(stored).toMatchObject({ label: "mine", updatedAt: plus1ms(theirTime) });
    expect(team.storage.getState().teams[TEAM_ID]!.data.hosts.map((record) => `${record.id}:${record.label}`)).toEqual([
      "team-a:mine",
      "team-z:team-z",
    ]);
  });

  it("deletes a host they just changed, and it stays deleted", async () => {
    const theirTime = theirNow(HOUR);
    const team = await teamWithTheirRecord("hosts", "team-a", host("team-a", { label: "theirs" }), theirTime);

    new team.database.HostRepository(team.root).remove("team-a");
    new team.database.SyncOutboxRepository(team.root).upsertDeletion("hosts", "team-a");
    await team.service.pushDirty();
    await team.someoneElsePushesLater();

    expect(team.pushed()).toEqual([expect.objectContaining({ encrypted_payload: "", deleted_at: plus1ms(theirTime) })]);
    expect(team.serverRow()).toMatchObject({ encrypted_payload: "", deleted_at: plus1ms(theirTime) });
    expect(team.storage.getState().teams[TEAM_ID]!.data.hosts.map((record) => record.id)).toEqual(["team-z"]);
  });

  it("pushes my change to a secret they just changed, with the time inside the secret", async () => {
    const theirTime = theirNow(HOUR);
    const ref = "secret:team-db";
    const theirs = { secretRef: ref, label: "db", password: "theirs" };
    const team = await teamWithTheirRecord("secrets", ref, theirs, theirTime);

    await team
      .catalog()
      .getScope(TEAM_ID)!
      .secrets.save(ref, JSON.stringify({ ...theirs, password: "mine", updatedAt: new Date().toISOString() }));
    await team.service.pushDirty();

    expect(team.pushed()).toEqual([expect.objectContaining({ updated_at: plus1ms(theirTime) })]);
    expect(open(team.serverRow().encrypted_payload, team.teamKey)).toMatchObject({
      password: "mine",
      updatedAt: plus1ms(theirTime),
    });
  });

  it("pushes my change to an AWS profile they just changed", async () => {
    const theirTime = theirNow(HOUR);
    const profile = { id: "aws-team", name: "team-prod", kind: "static", accessKeyId: "", secretAccessKey: "" };
    const team = await teamWithTheirRecord("awsProfiles", "aws-team", profile, theirTime);

    new team.database.AwsProfileRepository(team.root).upsert({
      ...profile,
      name: "team-prod-2",
      updatedAt: new Date().toISOString(),
    } as never);
    await team.service.pushDirty();

    expect(team.pushed()).toEqual([expect.objectContaining({ updated_at: plus1ms(theirTime) })]);
    expect(open(team.serverRow().encrypted_payload, team.teamKey)).toMatchObject({
      name: "team-prod-2",
      updatedAt: plus1ms(theirTime),
    });
  });
});
