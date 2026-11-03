import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 팀 볼트에 쓰는 시각은 "지금, 단 내가 본 그 레코드의 시각보다 뒤"다. 다른 팀원 기기의 시계가 빠르면 그 사람이 막 고친
// 레코드의 시각이 내 '지금'보다 뒤라, 그대로 적으면 내 수정·지움이 서버에 가지 않고 다음 받기에서 덮였다(2026-11-02 리뷰).

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => tempDir),
    getVersion: vi.fn(() => "1.9.14-test"),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
  },
}));

const TEAM_ID = "0f8e4c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
/** 시계가 빠른 팀원이 막 고친 레코드의 시각 — 이 기기의 '지금'보다 한참 뒤다. */
const AHEAD = "2099-01-01T00:00:00.000Z";
const AFTER_AHEAD = "2099-01-01T00:00:00.001Z";
const PAST = "2026-01-01T00:00:00.000Z";

/** 팀 볼트의 레코드 칸과 그 동기화 종류. */
const TEAM_FIELDS = [
  ["groups", "groups"],
  ["hosts", "hosts"],
  ["knownHosts", "knownHosts"],
  ["portForwards", "portForwards"],
  ["dnsOverrides", "dnsOverrides"],
  ["snippets", "snippets"],
  ["savedWorkspaces", "workspaces"],
  ["tailnets", "tailnets"],
  ["awsProfiles", "awsProfiles"],
] as const;

type Field = (typeof TEAM_FIELDS)[number][0];
type Timed = { id: string; updatedAt: string; label?: string };

async function load() {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorage = await import("./state-storage");
  stateStorage.resetDesktopStateStorageForTests();
  const vaultRoot = await import("./vault-root");
  const database = await import("./database");
  const times = await import("./team-write-times");
  const teamScope = await import("./team-vault-scope");
  const secretStore = await import("./secret-store");
  const storage = stateStorage.getDesktopStateStorage();
  storage.updateState((state) => {
    state.teams[TEAM_ID] = stateStorage.createTeamState({
      name: "Acme",
      role: "member",
      wrappedTeamDek: "wrapped",
      dataFloor: 0,
      updatedAt: PAST,
    });
  });
  const root = vaultRoot.teamVaultRoot(TEAM_ID);
  /** 받은 것처럼 둔다(뿌리의 edit 를 거치지 않는다 — 받은 팀 데이터를 담는 길과 같다). */
  const receive = (field: Field, record: Timed) =>
    storage.updateState((state) => {
      (state.teams[TEAM_ID]!.data[field] as Timed[]).push(record);
    });
  /** 이 기기에서 고친다(뿌리의 edit 를 거친다 — 저장소 클래스의 쓰기와 같다). */
  const editTeam = (write: (data: Record<Field, Timed[]>) => void) =>
    storage.updateState((state) => {
      write(root.edit(state) as unknown as Record<Field, Timed[]>);
    });
  const teamRecord = (field: Field, id: string) =>
    (storage.getState().teams[TEAM_ID]!.data[field] as Timed[]).find((record) => record.id === id);
  return { stateStorage, storage, vaultRoot, database, times, teamScope, secretStore, root, receive, editTeam, teamRecord };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-write-times-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DOLSSH_USER_DATA_DIR;
});

describe("writeTimeAfter", () => {
  it("keeps a later time and moves an earlier or equal one just after the last", async () => {
    const { times } = await load();
    expect(times.writeTimeAfter("2026-06-01T00:00:00.000Z", PAST)).toBe("2026-06-01T00:00:00.000Z");
    expect(times.writeTimeAfter(PAST, AHEAD)).toBe(AFTER_AHEAD);
    expect(times.writeTimeAfter(AHEAD, AHEAD)).toBe(AFTER_AHEAD);
    expect(times.writeTimeAfter(PAST, null)).toBe(PAST);
    expect(times.writeTimeAfter(PAST, "not a time")).toBe(PAST);
    expect(times.writeTimeAfter("not a time", AHEAD)).toBe(AFTER_AHEAD);
  });
});

describe("team vault write times", () => {
  it("writes every kind of team record after the time it had, when my clock is behind", async () => {
    const { receive, editTeam, teamRecord } = await load();
    for (const [field] of TEAM_FIELDS) {
      receive(field, { id: `${field}-1`, updatedAt: AHEAD, label: "theirs" });
    }

    const now = new Date().toISOString();
    editTeam((data) => {
      for (const [field] of TEAM_FIELDS) {
        data[field] = data[field].map((record) => ({ ...record, label: "mine", updatedAt: now }));
      }
    });

    for (const [field] of TEAM_FIELDS) {
      expect(teamRecord(field, `${field}-1`), field).toMatchObject({ label: "mine", updatedAt: AFTER_AHEAD });
    }
  });

  it("keeps my own time when it is already later, and leaves new records and time-keeping writes alone", async () => {
    const { receive, editTeam, teamRecord } = await load();
    receive("hosts", { id: "old", updatedAt: PAST });
    receive("hosts", { id: "same", updatedAt: AHEAD });

    const now = new Date().toISOString();
    editTeam((data) => {
      data.hosts = [
        ...data.hosts.map((record) =>
          record.id === "old" ? { ...record, updatedAt: now } : { ...record, label: "decoration only" },
        ),
        { id: "new", updatedAt: now },
      ];
    });

    expect(teamRecord("hosts", "old")?.updatedAt).toBe(now);
    // 시각을 그대로 둔 쓰기는 올릴 뜻이 없다.
    expect(teamRecord("hosts", "same")).toMatchObject({ label: "decoration only", updatedAt: AHEAD });
    expect(teamRecord("hosts", "new")?.updatedAt).toBe(now);
  });

  it("returns the moved time on the record the repository hands back", async () => {
    const { database, receive, root, teamRecord } = await load();
    receive("hosts", {
      id: "team-a",
      kind: "ssh",
      label: "theirs",
      hostname: "a.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      createdAt: PAST,
      updatedAt: AHEAD,
    } as never);

    const updated = new database.HostRepository(root).update("team-a", {
      kind: "ssh",
      label: "mine",
      hostname: "a.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
    } as never);

    expect(updated.updatedAt).toBe(AFTER_AHEAD);
    expect(teamRecord("hosts", "team-a")).toMatchObject({ label: "mine", updatedAt: AFTER_AHEAD });
  });

  it("does not touch the personal vault", async () => {
    const { storage, vaultRoot } = await load();
    storage.updateState((state) => {
      (state.data.hosts as unknown as Timed[]).push({ id: "mine", updatedAt: AHEAD });
    });

    const now = new Date().toISOString();
    storage.updateState((state) => {
      const data = vaultRoot.PERSONAL_VAULT_ROOT.edit(state) as unknown as { hosts: Timed[] };
      data.hosts = data.hosts.map((record) => ({ ...record, updatedAt: now }));
    });

    expect((storage.getState().data.hosts as unknown as Timed[])[0]?.updatedAt).toBe(now);
  });

  it("does not move times of received team data", async () => {
    const { storage, receive, teamRecord } = await load();
    receive("hosts", { id: "team-a", updatedAt: AHEAD });
    const team = storage.getState().teams[TEAM_ID]!;

    // 받은 것을 담는 길(빠진 역할로 되돌리기처럼 옛 시각일 수도 있다)은 그대로 담는다.
    storage.replaceTeamVault(
      TEAM_ID,
      { ...team.data, hosts: [{ id: "team-a", updatedAt: PAST }] as never },
      team.secure,
    );

    expect(teamRecord("hosts", "team-a")?.updatedAt).toBe(PAST);
  });

  it("moves writes made before and after a nested update, and settles once at the end", async () => {
    const { receive, editTeam, teamRecord } = await load();
    receive("groups", { id: "g", updatedAt: AHEAD });
    receive("snippets", { id: "s", updatedAt: AHEAD });
    receive("hosts", { id: "h", updatedAt: AHEAD });
    const now = new Date().toISOString();

    editTeam((data) => {
      data.groups = data.groups.map((record) => ({ ...record, updatedAt: now }));
      editTeam((inner) => {
        inner.snippets = inner.snippets.map((record) => ({ ...record, updatedAt: now }));
      });
      // 안쪽 쓰기가 끝난 뒤에 고친 것도 바깥 쓰기가 끝날 때 맞춘다.
      data.hosts = data.hosts.map((record) => ({ ...record, updatedAt: now }));
    });

    expect(teamRecord("groups", "g")?.updatedAt).toBe(AFTER_AHEAD);
    expect(teamRecord("snippets", "s")?.updatedAt).toBe(AFTER_AHEAD);
    expect(teamRecord("hosts", "h")?.updatedAt).toBe(AFTER_AHEAD);
  });

  it("keeps the times it first saw when one write touches the team again", async () => {
    const { storage, receive, root, teamRecord } = await load();
    receive("hosts", { id: "h", updatedAt: AHEAD });
    receive("groups", { id: "g", updatedAt: AHEAD });
    const now = new Date().toISOString();

    storage.updateState((state) => {
      const first = root.edit(state) as unknown as Record<Field, Timed[]>;
      first.hosts = first.hosts.map((record) => ({ ...record, updatedAt: now }));
      // 같은 쓰기에서 뿌리를 다시 불러도 처음 본 시각과 견준다.
      const again = root.edit(state) as unknown as Record<Field, Timed[]>;
      again.groups = again.groups.map((record) => ({ ...record, updatedAt: now }));
    });

    expect(teamRecord("hosts", "h")?.updatedAt).toBe(AFTER_AHEAD);
    expect(teamRecord("groups", "g")?.updatedAt).toBe(AFTER_AHEAD);
  });

  it("forgets a write that threw, and keeps working after it", async () => {
    const { storage, receive, editTeam, teamRecord } = await load();
    receive("hosts", { id: "h", updatedAt: AHEAD });
    expect(() =>
      editTeam(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // 던진 쓰기의 기록이 남아 있으면 다음 쓰기가 받은 데이터까지 옮긴다.
    storage.updateState((state) => {
      (state.teams[TEAM_ID]!.data.hosts as unknown as Timed[])[0]!.updatedAt = PAST;
    });
    expect(teamRecord("hosts", "h")?.updatedAt).toBe(PAST);

    // 던진 뒤에도 내 쓰기는 그대로 맞춘다.
    receive("snippets", { id: "s", updatedAt: AHEAD });
    const now = new Date().toISOString();
    editTeam((data) => {
      data.snippets = data.snippets.map((record) => ({ ...record, updatedAt: now }));
    });
    expect(teamRecord("snippets", "s")?.updatedAt).toBe(AFTER_AHEAD);
  });
});

describe("team vault deletions", () => {
  async function withHost() {
    const loaded = await load();
    loaded.receive("hosts", { id: "team-a", updatedAt: AHEAD });
    return { ...loaded, outbox: new loaded.database.SyncOutboxRepository(loaded.root) };
  }
  const deletion = (storage: { getState(): { teams: Record<string, { data: { syncOutbox: unknown[] } }> } }) =>
    storage.getState().teams[TEAM_ID]!.data.syncOutbox;

  it("records the deletion after the record's time when it is recorded before removing", async () => {
    const { storage, outbox, editTeam } = await withHost();
    outbox.upsertDeletion("hosts", "team-a");
    editTeam((data) => {
      data.hosts = data.hosts.filter((record) => record.id !== "team-a");
    });
    expect(deletion(storage)).toEqual([{ kind: "hosts", recordId: "team-a", deletedAt: AFTER_AHEAD }]);
  });

  it("records the deletion after the record's time when it is recorded after removing", async () => {
    const { storage, outbox, editTeam } = await withHost();
    editTeam((data) => {
      data.hosts = data.hosts.filter((record) => record.id !== "team-a");
    });
    outbox.upsertDeletion("hosts", "team-a");
    expect(deletion(storage)).toEqual([{ kind: "hosts", recordId: "team-a", deletedAt: AFTER_AHEAD }]);
  });

  it("never moves a recorded deletion earlier, and leaves unknown records and the personal vault alone", async () => {
    const { storage, outbox, editTeam, database } = await withHost();
    editTeam((data) => {
      data.hosts = data.hosts.filter((record) => record.id !== "team-a");
    });
    outbox.upsertDeletion("hosts", "team-a");
    // 같은 지움을 다시 남겨도(이제 기억한 시각이 없다) 앞당기지 않는다.
    outbox.upsertDeletion("hosts", "team-a", PAST);
    outbox.upsertDeletion("snippets", "never-here", PAST);
    // 개인 볼트는 레코드의 시각이 뒤라도 준 시각 그대로다(지금까지와 같다).
    storage.updateState((state) => {
      (state.data.hosts as unknown as Timed[]).push({ id: "personal-host", updatedAt: AHEAD });
    });
    new database.SyncOutboxRepository().upsertDeletion("hosts", "personal-host", PAST);

    expect(deletion(storage)).toEqual([
      { kind: "hosts", recordId: "team-a", deletedAt: AFTER_AHEAD },
      { kind: "snippets", recordId: "never-here", deletedAt: PAST },
    ]);
    expect(storage.getState().data.syncOutbox).toEqual([{ kind: "hosts", recordId: "personal-host", deletedAt: PAST }]);
  });
});

describe("team secrets and AWS profiles", () => {
  it("saves a team secret after the time inside the stored one", async () => {
    const { storage, teamScope, secretStore, database, root } = await load();
    const ref = "secret:team-1";
    const stored = { secretRef: ref, label: "db", password: "theirs", updatedAt: AHEAD };
    storage.writeTeamSecret(TEAM_ID, ref, secretStore.encodeSecretForStorage(JSON.stringify(stored)));
    const secrets = teamScope.createTeamVaultScope(TEAM_ID).secrets;
    const read = async () => JSON.parse((await secrets.load(ref))!) as { password: string; updatedAt: string };

    await secrets.save(ref, JSON.stringify({ ...stored, password: "mine", updatedAt: new Date().toISOString() }));
    expect(await read()).toMatchObject({ password: "mine", updatedAt: AFTER_AHEAD });

    // 시각을 그대로 둔 저장, JSON 이 아닌 값은 그대로다.
    await secrets.save(ref, JSON.stringify({ ...stored, password: "again", updatedAt: AFTER_AHEAD }));
    expect(await read()).toMatchObject({ password: "again", updatedAt: AFTER_AHEAD });
    await secrets.save("secret:raw", "not json");
    expect(await secrets.load("secret:raw")).toBe("not json");

    // 지움도 비밀값 안의 시각보다 뒤다(지움 기록을 먼저 남기는 길).
    new database.SyncOutboxRepository(root).upsertDeletions("secrets", [ref], PAST);
    expect(storage.getState().teams[TEAM_ID]!.data.syncOutbox).toEqual([
      { kind: "secrets", recordId: ref, deletedAt: "2099-01-01T00:00:00.002Z" },
    ]);
  });

  it("upserts a team AWS profile after the time it had, payload and metadata alike", async () => {
    const { database, root, receive, storage, secretStore } = await load();
    const payload = { id: "aws-1", name: "prod", kind: "static", accessKeyId: "", secretAccessKey: "", updatedAt: AHEAD };
    receive("awsProfiles", { id: "aws-1", name: "prod", kind: "static", updatedAt: AHEAD } as never);
    storage.writeManagedAwsProfileValue("aws-1", secretStore.encodeSecretForStorage(JSON.stringify(payload)), TEAM_ID);
    const profiles = new database.AwsProfileRepository(root);

    const saved = profiles.upsert({ ...payload, name: "prod-renamed", updatedAt: new Date().toISOString() } as never);

    expect(saved.updatedAt).toBe(AFTER_AHEAD);
    expect(profiles.getPayloadById("aws-1")).toMatchObject({ name: "prod-renamed", updatedAt: AFTER_AHEAD });
    expect(profiles.getMetadataById("aws-1")).toMatchObject({ updatedAt: AFTER_AHEAD });
    // 시각을 그대로 둔 저장은 그대로다.
    expect(profiles.upsert({ ...payload, name: "again", updatedAt: AFTER_AHEAD } as never).updatedAt).toBe(AFTER_AHEAD);

    // 개인 프로필은 그대로다.
    const personal = new database.AwsProfileRepository();
    personal.upsert({ ...payload, id: "aws-mine", updatedAt: AHEAD } as never);
    const now = new Date().toISOString();
    expect(personal.upsert({ ...payload, id: "aws-mine", updatedAt: now } as never).updatedAt).toBe(now);
  });
});
