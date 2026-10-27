import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 팀 볼트의 로컬 사본(state.teams)은 개인 data·secure 와 따로 저장된다. 상태 파일은 아는 키만 남기는
// 화이트리스트라, 여기서 빠진 필드는 앱을 다시 켜는 순간 사라진다.

let tempDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => tempDir),
    getVersion: vi.fn(() => "1.9.14-test"),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

async function loadStorage() {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const module = await import("./state-storage");
  module.resetDesktopStateStorageForTests();
  return module;
}

const SECRET = { encrypted: true, value: "c2VjcmV0" };

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-teams-state-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DOLSSH_USER_DATA_DIR;
});

describe("team vault local state", () => {
  it("survives a reload with data, secrets, private prefs and device-local themes", async () => {
    const first = await loadStorage();
    const storage = first.getDesktopStateStorage();
    storage.updateState((state) => {
      const team = first.createTeamState({
        name: "Acme",
        role: "owner",
        wrappedTeamDek: "wrapped",
        dataFloor: 1,
        updatedAt: "2026-10-19T00:00:00.000Z",
      });
      team.data.hosts.push({
        id: "team-host",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        secretRef: "secret:team-1",
        createdAt: "2026-10-19T00:00:00.000Z",
        updatedAt: "2026-10-19T00:00:00.000Z",
      } as never);
      team.secure.managedSecretsByRef["secret:team-1"] = SECRET;
      team.secure.tailnetAuthKeysById["tailnet-1"] = SECRET;
      team.private.hostPrefs.push({
        id: "team-host",
        favorite: true,
        agentForwarding: null,
        rdpCertificateFingerprint: null,
        knownHosts: [],
        updatedAt: "2026-10-19T00:00:00.000Z",
      });
      team.private.workspacePrefs.push({ id: "ws-1", favorite: false, lastOpenedAt: "2026-10-19T01:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" });
      team.local.terminalThemeByHostId["team-host"] = "dolssh-dark";
      team.sync.pendingPush = true;
      state.teams["team-1"] = team;
    });

    const second = await loadStorage();
    const reloaded = second.getDesktopStateStorage();
    const team = reloaded.getTeamState("team-1");
    expect(reloaded.listTeamIds()).toEqual(["team-1"]);
    expect(team?.info).toMatchObject({ name: "Acme", role: "owner", wrappedTeamDek: "wrapped", dataFloor: 1 });
    expect(team?.data.hosts.map((host) => host.id)).toEqual(["team-host"]);
    expect(team?.secure.managedSecretsByRef["secret:team-1"]).toEqual(SECRET);
    expect(team?.secure.tailnetAuthKeysById["tailnet-1"]).toEqual(SECRET);
    expect(team?.private.hostPrefs).toEqual([
      {
        id: "team-host",
        favorite: true,
        agentForwarding: null,
        rdpCertificateFingerprint: null,
        knownHosts: [],
        updatedAt: "2026-10-19T00:00:00.000Z",
      },
    ]);
    expect(team?.private.workspacePrefs[0]?.lastOpenedAt).toBe("2026-10-19T01:00:00.000Z");
    expect(team?.local.terminalThemeByHostId).toEqual({ "team-host": "dolssh-dark" });
    expect(team?.sync.pendingPush).toBe(true);
    // 팀 것은 개인 쪽에 섞이지 않는다.
    expect(reloaded.getState().data.hosts).toEqual([]);
    expect(reloaded.getState().secure.managedSecretsByRef).toEqual({});
  });

  it("drops what it cannot read and keeps old state files working", async () => {
    mkdirSync(path.join(tempDir, "storage"), { recursive: true });
    writeFileSync(
      path.join(tempDir, "storage", "state.json"),
      JSON.stringify({
        data: { hosts: [] },
        secure: {},
        teams: {
          "": { info: { name: "no id" } },
          broken: { info: {} },
          "team-1": {
            info: { name: "Acme", role: "superuser", dataFloor: -2 },
            secure: { managedSecretsByRef: { "secret:a": SECRET, "auth:refresh-token": SECRET, "secret:b": { value: 1 } } },
            private: {
              hostPrefs: [{ id: "h1", favorite: "yes", updatedAt: "2026-10-19T00:00:00.000Z" }, { favorite: true }],
              syncOutbox: [{ kind: "hostPrefs", recordId: "h2", deletedAt: "2026-10-19T00:00:00.000Z" }, { kind: "hosts", recordId: "x", deletedAt: "y" }],
            },
            local: { terminalThemeByHostId: { h1: "not-a-theme" } },
          },
        },
      }),
    );
    const module = await loadStorage();
    const storage = module.getDesktopStateStorage();
    expect(storage.listTeamIds()).toEqual(["team-1"]);
    const team = storage.getTeamState("team-1");
    // 모르는 역할은 가장 좁은 읽기 전용으로 읽는다 — 서버가 거절할 편집 길을 열지 않게.
    expect(team?.info).toMatchObject({ name: "Acme", role: "viewer", wrappedTeamDek: null, dataFloor: 0 });
    expect(Object.keys(team?.secure.managedSecretsByRef ?? {})).toEqual(["secret:a"]);
    expect(team?.private.hostPrefs).toEqual([
      { id: "h1", favorite: null, agentForwarding: null, rdpCertificateFingerprint: null, knownHosts: [], updatedAt: "2026-10-19T00:00:00.000Z" },
    ]);
    expect(team?.private.syncOutbox).toEqual([{ kind: "hostPrefs", recordId: "h2", deletedAt: "2026-10-19T00:00:00.000Z" }]);
    expect(team?.local.terminalThemeByHostId).toEqual({});
    expect(team?.data.hosts).toEqual([]);
  });

  it("starts with no teams when the file predates them", async () => {
    mkdirSync(path.join(tempDir, "storage"), { recursive: true });
    writeFileSync(path.join(tempDir, "storage", "state.json"), JSON.stringify({ data: { hosts: [] } }));
    const module = await loadStorage();
    expect(module.getDesktopStateStorage().getState().teams).toEqual({});
  });

  it("puts restored records back by id, clears their pending deletions and refuses read-only teams", async () => {
    const module = await loadStorage();
    const storage = module.getDesktopStateStorage();
    const T = "2026-10-19T00:00:00.000Z";
    const record = (id: string, label: string) =>
      ({ id, kind: "ssh", label, hostname: `${id}.example.com`, port: 22, username: "u", authType: "password", createdAt: T, updatedAt: T }) as never;
    storage.updateState((state) => {
      const team = module.createTeamState({ name: "Acme", role: "admin", wrappedTeamDek: "w", dataFloor: 1, updatedAt: T });
      team.data.hosts.push(record("keep", "keep"), record("renamed", "renamed-later"));
      team.data.syncOutbox.push(
        { kind: "hosts", recordId: "gone", deletedAt: T },
        { kind: "hosts", recordId: "other", deletedAt: T },
      );
      state.teams["team-1"] = team;
      state.teams["team-ro"] = module.createTeamState({ name: "RO", role: "viewer", wrappedTeamDek: "w", dataFloor: 1, updatedAt: T });
    });
    const empty = { groups: [], hosts: [], knownHosts: [], portForwards: [], dnsOverrides: [], snippets: [], savedWorkspaces: [], tailnets: [], awsProfiles: [], secretMetadata: [] };
    storage.restoreTeamRecords(
      "team-1",
      {
        records: { ...empty, hosts: [record("renamed", "renamed"), record("gone", "gone")], secretMetadata: [{ secretRef: "secret:gone", label: "gone" } as never] },
        secure: { managedSecretsByRef: { "secret:gone": SECRET }, managedAwsProfilesById: {}, tailnetAuthKeysById: {} },
      },
      [
        { kind: "hosts", recordId: "renamed" },
        { kind: "hosts", recordId: "gone" },
        { kind: "secrets", recordId: "secret:gone" },
      ],
    );
    const team = storage.getTeamState("team-1")!;
    expect(team.data.hosts.map((host) => [host.id, host.label])).toEqual([
      ["keep", "keep"],
      ["renamed", "renamed"],
      ["gone", "gone"],
    ]);
    // 아직 올리지 못한 지움이 남아 있으면 다음 올리기가 되살린 것을 다시 지운다 — 그것만 치운다.
    expect(team.data.syncOutbox.map((entry) => entry.recordId)).toEqual(["other"]);
    expect(team.data.secretMetadata.map((entry) => entry.secretRef)).toEqual(["secret:gone"]);
    expect(team.secure.managedSecretsByRef["secret:gone"]).toEqual(SECRET);
    expect(() =>
      storage.restoreTeamRecords(
        "team-ro",
        { records: { ...empty, hosts: [record("x", "x")] }, secure: { managedSecretsByRef: {}, managedAwsProfilesById: {}, tailnetAuthKeysById: {} } },
        [{ kind: "hosts", recordId: "x" }],
      ),
    ).toThrow();
    expect(storage.getTeamState("team-ro")!.data.hosts).toEqual([]);
  });
});
