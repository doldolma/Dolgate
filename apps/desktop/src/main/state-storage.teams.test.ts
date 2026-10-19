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
      team.private.hostPrefs.push({ id: "team-host", favorite: true, agentForwarding: null, updatedAt: "2026-10-19T00:00:00.000Z" });
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
    expect(team?.private.hostPrefs).toEqual([{ id: "team-host", favorite: true, agentForwarding: null, updatedAt: "2026-10-19T00:00:00.000Z" }]);
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
            info: { name: "Acme", role: "admin", dataFloor: -2 },
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
    expect(team?.info).toMatchObject({ name: "Acme", role: "member", wrappedTeamDek: null, dataFloor: 0 });
    expect(Object.keys(team?.secure.managedSecretsByRef ?? {})).toEqual(["secret:a"]);
    expect(team?.private.hostPrefs).toEqual([{ id: "h1", favorite: null, agentForwarding: null, updatedAt: "2026-10-19T00:00:00.000Z" }]);
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
});
