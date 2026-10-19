import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord, ManagedAwsProfilePayload } from "@shared";
import type { AuthSyncContext } from "./auth-service";

// 팀 볼트는 개인 볼트와 같은 저장소 클래스를 뿌리만 바꿔 쓴다. 개인 동기화는 개인 data·secure 를
// 통째로 갈아 끼우므로, 팀 것이 거기로 새거나 개인 pull 에 지워지면 안 된다.

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

const TEAM_ID = "0f8e4c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";

const TEAM_TAILNET = {
  id: "tailnet-team",
  label: "Team tailnet",
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

const sshDraft = (label: string, groupName?: string) => ({
  kind: "ssh" as const,
  label,
  hostname: `${label}.example.com`,
  port: 22,
  username: "ubuntu",
  authType: "password" as const,
  groupName,
});

async function load() {
  process.env.DOLSSH_USER_DATA_DIR = tempDir;
  vi.resetModules();
  const stateStorage = await import("./state-storage");
  stateStorage.resetDesktopStateStorageForTests();
  const database = await import("./database");
  const vaultRoot = await import("./vault-root");
  const teamVaultScope = await import("./team-vault-scope");
  const secretStore = await import("./secret-store");
  const vaultCatalog = await import("./vault-catalog");
  const storage = stateStorage.getDesktopStateStorage();
  // main 이 만드는 것과 같은 카탈로그 — 개인 저장소들과 상태 파일의 팀들.
  const createCatalog = () =>
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
        new secretStore.SecretStore(),
      ),
      teamVaultScope.createStoredTeamVaults(),
    );
  const addTeam = (teamId: string) =>
    storage.updateState((state) => {
      state.teams[teamId] = stateStorage.createTeamState({
        name: "Acme",
        role: "owner",
        wrappedTeamDek: "wrapped",
        dataFloor: 1,
        updatedAt: "2026-10-19T00:00:00.000Z",
      });
    });
  return { stateStorage, storage, database, vaultRoot, teamVaultScope, secretStore, addTeam, createCatalog };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-vault-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("repositories on a team vault root", () => {
  it("keeps hosts, groups and deletions inside the vault they were written to", async () => {
    const { storage, database, vaultRoot, addTeam } = await load();
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    const teamHosts = new database.HostRepository(root);
    const teamGroups = new database.GroupRepository(root);
    const personalHosts = new database.HostRepository();
    const personalGroups = new database.GroupRepository();

    personalGroups.create("group-p", "ops");
    personalHosts.create("personal-host", sshDraft("mine", "ops"));
    teamGroups.create("group-t", "ops");
    teamHosts.create("team-host", sshDraft("shared", "ops"));
    new database.SyncOutboxRepository(root).upsertDeletion("hosts", "gone-from-team");

    // 같은 이름의 그룹이 개인과 팀에 따로 있다. 팀 쪽 이름을 바꾸면 팀 호스트만 따라간다.
    teamGroups.rename("ops", "infra");

    expect(teamHosts.list().map((host) => [host.id, host.groupName])).toEqual([["team-host", "infra"]]);
    expect(personalHosts.list().map((host) => [host.id, host.groupName])).toEqual([["personal-host", "ops"]]);
    expect(teamGroups.list().map((group) => group.path)).toEqual(["infra"]);
    expect(personalGroups.list().map((group) => group.path)).toEqual(["ops"]);

    const state = storage.getState();
    expect(state.data.hosts.map((host) => host.id)).toEqual(["personal-host"]);
    expect(state.data.syncOutbox).toEqual([]);
    expect(state.teams[TEAM_ID].data.hosts.map((host) => host.id)).toEqual(["team-host"]);
    expect(state.teams[TEAM_ID].data.syncOutbox.map((entry) => entry.recordId)).toEqual(["gone-from-team"]);
  });

  it("stores tailnet auth keys and AWS profile values in the team's own secure maps", async () => {
    const { storage, database, vaultRoot, addTeam } = await load();
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    const tailnets = new database.TailnetRepository(root);
    const awsProfiles = new database.AwsProfileRepository(root);
    const profile: ManagedAwsProfilePayload = {
      id: "aws-team",
      name: "team-prod",
      kind: "static",
      accessKeyId: "AKIA-TEAM",
      secretAccessKey: "team-secret",
      updatedAt: "2026-10-19T00:00:00.000Z",
    };

    tailnets.save(TEAM_TAILNET, "tskey-team");
    awsProfiles.upsert(profile);

    expect(tailnets.readAuthKey("tailnet-team")).toBe("tskey-team");
    expect(new database.TailnetRepository().readAuthKey("tailnet-team")).toBeNull();
    expect(awsProfiles.getPayloadById("aws-team")).toMatchObject({ accessKeyId: "AKIA-TEAM" });
    expect(new database.AwsProfileRepository().getPayloadById("aws-team")).toBeNull();

    const state = storage.getState();
    expect(Object.keys(state.teams[TEAM_ID].secure.tailnetAuthKeysById)).toEqual(["tailnet-team"]);
    expect(Object.keys(state.teams[TEAM_ID].secure.managedAwsProfilesById)).toEqual(["aws-team"]);
    expect(state.secure.tailnetAuthKeysById).toEqual({});
    expect(state.secure.managedAwsProfilesById).toEqual({});
    expect(state.data.awsProfiles).toEqual([]);

    awsProfiles.remove("aws-team");
    expect(storage.getState().teams[TEAM_ID].secure.managedAwsProfilesById).toEqual({});
  });

  it("refuses to read or write a team that is not on this device", async () => {
    const { database, vaultRoot, storage } = await load();
    const hosts = new database.HostRepository(vaultRoot.teamVaultRoot("gone"));

    expect(() => hosts.list()).toThrow(vaultRoot.TeamVaultNotFoundError);
    expect(() => hosts.create("host-1", sshDraft("orphan"))).toThrow(vaultRoot.TeamVaultNotFoundError);
    expect(() => new database.AwsProfileRepository(vaultRoot.teamVaultRoot("gone")).remove("x")).toThrow(
      vaultRoot.TeamVaultNotFoundError,
    );
    expect(storage.getState().data.hosts).toEqual([]);
    expect(storage.getState().teams).toEqual({});
  });
});

describe("team vault secrets", () => {
  it("keeps a team's secrets in that team and out of the personal secret store", async () => {
    const { storage, teamVaultScope, secretStore, addTeam } = await load();
    addTeam(TEAM_ID);
    const scope = teamVaultScope.createTeamVaultScope(TEAM_ID);
    const personal = new secretStore.SecretStore();

    await scope.secrets.save("secret:team", '{"password":"team-pw"}');
    await personal.save("secret:mine", '{"password":"my-pw"}');

    await expect(scope.secrets.load("secret:team")).resolves.toBe('{"password":"team-pw"}');
    await expect(scope.secrets.load("secret:mine")).resolves.toBeNull();
    await expect(personal.load("secret:team")).resolves.toBeNull();
    expect(Object.keys(storage.getState().secure.managedSecretsByRef)).toEqual(["secret:mine"]);
    expect(Object.keys(storage.getState().teams[TEAM_ID].secure.managedSecretsByRef)).toEqual(["secret:team"]);

    // 팀 칸에는 동기화되는 비밀값만 둔다.
    await expect(scope.secrets.save("auth:refresh-token", "nope")).rejects.toThrow(/secret:\*/);

    await scope.secrets.remove("secret:team");
    expect(storage.getState().teams[TEAM_ID].secure.managedSecretsByRef).toEqual({});
  });
});

describe("values that differ per member", () => {
  // 팀 레코드에 실리면 팀원 모두에게 간다. 즐겨찾기·agent forwarding 은 내 개인 칸(내 기기끼리),
  // 테마는 이 기기에만 둔다.
  it("keeps my favorite, agent forwarding and theme for a team host out of the team record", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    new database.HostRepository().create("personal-host", sshDraft("mine"));
    const catalog = createCatalog();

    catalog.setHostFavorite("team-host", true);
    catalog.updateHost("team-host", { ...sshDraft("renamed"), agentForwarding: true, terminalThemeId: "kanagawa-wave" });
    catalog.setHostFavorite("personal-host", true);

    const state = storage.getState();
    const team = state.teams[TEAM_ID];
    expect(team.data.hosts).toEqual([
      expect.objectContaining({
        id: "team-host",
        label: "renamed",
        favorite: null,
        terminalThemeId: null,
        agentForwarding: null,
      }),
    ]);
    expect(team.private.hostPrefs).toEqual([
      { id: "team-host", favorite: true, agentForwarding: true, updatedAt: expect.any(String) },
    ]);
    expect(team.sync.privatePendingPush).toBe(true);
    // 테마는 개인 칸에도 없다 — 이 기기에만 있다.
    expect(team.local.terminalThemeByHostId).toEqual({ "team-host": "kanagawa-wave" });
    // 개인 호스트는 지금처럼 자기 레코드에 둔다.
    expect(state.data.hosts).toEqual([expect.objectContaining({ id: "personal-host", favorite: true })]);

    const expected = { label: "renamed", favorite: true, agentForwarding: true, terminalThemeId: "kanagawa-wave" };
    expect(catalog.getHost("team-host")).toMatchObject(expected);
    expect(catalog.listHosts()).toEqual([
      expect.objectContaining({ id: "personal-host", favorite: true }),
      expect.objectContaining({ id: "team-host", ...expected }),
    ]);

    // 앱을 다시 켜도 그대로다.
    const again = await load();
    expect(again.storage.readTeamMemberPrefs(TEAM_ID)).toEqual({
      hostPrefs: team.private.hostPrefs,
      workspacePrefs: [],
      terminalThemeByHostId: { "team-host": "kanagawa-wave" },
    });
  });

  it("does not rewrite my values when they did not change", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    const catalog = createCatalog();
    catalog.setHostFavorite("team-host", true);
    catalog.setHostTerminalTheme("team-host", "night-owl");
    const before = storage.getState().teams[TEAM_ID];
    storage.updateState((state) => {
      state.teams[TEAM_ID].sync.privatePendingPush = false;
    });

    catalog.setHostFavorite("team-host", true);
    catalog.setHostTerminalTheme("team-host", "night-owl");
    // 끈 상태를 처음 끄는 것도 바뀐 게 아니다.
    catalog.updateHost("team-host", { ...sshDraft("shared"), agentForwarding: false, terminalThemeId: "night-owl" });

    const after = storage.getState().teams[TEAM_ID];
    expect(after.private.hostPrefs).toEqual(before.private.hostPrefs);
    expect(after.sync.privatePendingPush).toBe(false);
  });

  it("keeps a team workspace's favorite and last opened time in my own place", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const workspace = new database.SavedWorkspaceRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create({
      name: "Team ops",
      root: {
        id: "workspace-root",
        kind: "split",
        axis: "horizontal",
        ratio: 0.6,
        first: { id: "workspace-host", kind: "leaf", target: { kind: "host", hostId: "team-host", label: "Prod" } },
        second: { id: "workspace-local", kind: "leaf", target: { kind: "local", label: "Local shell" } },
      },
    });
    const catalog = createCatalog();

    catalog.setWorkspaceFavorite(workspace.id, true);
    const opened = catalog.touchWorkspaceOpened(workspace.id);

    const team = storage.getState().teams[TEAM_ID];
    expect(team.data.savedWorkspaces).toEqual([
      expect.objectContaining({ id: workspace.id, favorite: false, lastOpenedAt: null, updatedAt: workspace.updatedAt }),
    ]);
    expect(team.private.workspacePrefs).toEqual([
      { id: workspace.id, favorite: true, lastOpenedAt: opened.lastOpenedAt, updatedAt: expect.any(String) },
    ]);
    expect(opened.lastOpenedAt).toEqual(expect.any(String));
    expect(catalog.listWorkspaces()).toEqual([
      expect.objectContaining({ id: workspace.id, favorite: true, lastOpenedAt: opened.lastOpenedAt }),
    ]);
  });

  it("refuses to write member values for a team that is not on this device", async () => {
    const { storage, vaultRoot } = await load();

    expect(() => storage.updateTeamHostPrefs("gone", "host-1", { favorite: true })).toThrow(vaultRoot.TeamVaultNotFoundError);
    expect(() => storage.setTeamHostTerminalTheme("gone", "host-1", "night-owl")).toThrow(vaultRoot.TeamVaultNotFoundError);
    expect(storage.readTeamMemberPrefs("gone")).toBeNull();
  });
});

describe("writes that follow the host's vault", () => {
  it("removes, rewrites and looks up hosts inside the vault that holds them", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    new database.HostRepository(root).create("team-host", sshDraft("shared"));
    new database.HostRepository(root).create("team-bastion", sshDraft("team-jump"));
    new database.HostRepository().create("personal-bastion", sshDraft("my-jump"));
    const catalog = createCatalog();
    catalog.setHostFavorite("team-host", true);

    // 내 값을 얹어 돌려준다(쓴 것은 팀 레코드).
    expect(catalog.writeHost("team-host", (hosts) => hosts.setDetectedOs("team-host", "ubuntu" as never))).toMatchObject({
      id: "team-host",
      favorite: true,
    });
    expect(storage.getState().teams[TEAM_ID].data.hosts.find((host) => host.id === "team-host")).toMatchObject({
      favorite: null,
    });

    // 점프 호스트는 같은 볼트 안에서만 찾는다.
    expect(catalog.getHostInSameVault("team-host", "team-bastion")?.id).toBe("team-bastion");
    expect(catalog.getHostInSameVault("team-host", "personal-bastion")).toBeNull();
    expect(catalog.getHostInSameVault("personal-bastion", "team-bastion")).toBeNull();

    catalog.removeHost("team-host");
    const state = storage.getState();
    expect(state.teams[TEAM_ID].data.hosts.map((host) => host.id)).toEqual(["team-bastion"]);
    expect(state.teams[TEAM_ID].data.syncOutbox).toEqual([expect.objectContaining({ kind: "hosts", recordId: "team-host" })]);
    expect(state.data.hosts.map((host) => host.id)).toEqual(["personal-bastion"]);
    expect(state.data.syncOutbox).toEqual([]);
  });

  it("hands the core every vault's tailnet, team ones included", async () => {
    const { database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.TailnetRepository().save({ ...TEAM_TAILNET, id: "tailnet-mine", label: "Mine" }, "tskey-mine");
    new database.TailnetRepository(vaultRoot.teamVaultRoot(TEAM_ID)).save(TEAM_TAILNET, "tskey-team");

    expect(createCatalog().listTailnetPayloads().map((tailnet) => [tailnet.id, tailnet.authKey])).toEqual([
      ["tailnet-mine", "tskey-mine"],
      ["tailnet-team", "tskey-team"],
    ]);
  });

  it("does not rewrite a team host key when a connection only confirms it", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const teamRoot = vaultRoot.teamVaultRoot(TEAM_ID);
    new database.HostRepository(teamRoot).create("team-host", sshDraft("shared"));
    new database.HostRepository().create("personal-host", sshDraft("shared"));
    const key = {
      host: "shared.example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIA",
      fingerprintSha256: "SHA256:shared",
    };
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-19T00:00:00.000Z") });
    new database.KnownHostRepository().trust({ ...key, hostId: "personal-host", hostLabel: "shared" });
    new database.KnownHostRepository(teamRoot).trust({ ...key, hostId: "team-host", hostLabel: "shared" });
    const teamBefore = storage.teamVaultFingerprint(TEAM_ID);
    vi.setSystemTime(new Date("2026-10-19T01:00:00.000Z"));

    // 접속 경로처럼 호스트가 든 볼트를 찾아 확인 시각을 남긴다.
    const catalog = createCatalog();
    catalog.scopeOfHost("personal-host").knownHosts.touch(key.host, key.port);
    catalog.scopeOfHost("team-host").knownHosts.touch(key.host, key.port);

    const state = storage.getState();
    expect(state.data.knownHosts[0]?.lastSeenAt).toBe("2026-10-19T01:00:00.000Z");
    expect(state.teams[TEAM_ID].data.knownHosts[0]?.lastSeenAt).toBe("2026-10-19T00:00:00.000Z");
    expect(storage.teamVaultFingerprint(TEAM_ID)).toBe(teamBefore);
  });
});

describe("personal pull", () => {
  function encryptRecord(id: string, value: unknown, keyBase64: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      id,
      encrypted_payload: JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      updated_at: "2026-10-19T00:00:00.000Z",
    };
  }

  it("replaces the personal vault and leaves every team's records and secrets alone", async () => {
    const { storage, database, vaultRoot, teamVaultScope, addTeam } = await load();
    const context: AuthSyncContext = {
      userId: "user-1",
      serverUrl: "https://sync.example.com/",
      accessToken: "access-1",
      vaultKeyBase64: Buffer.alloc(32, 1).toString("base64"),
      vaultEpoch: 1,
    };
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    new database.HostRepository(root).create("team-host", sshDraft("shared"), "secret:team");
    new database.TailnetRepository(root).save(TEAM_TAILNET, "tskey-team");
    await teamVaultScope.createTeamVaultScope(TEAM_ID).secrets.save("secret:team", '{"password":"team-pw"}');
    new database.HostRepository().create("stale-personal", sshDraft("stale"));
    const teamBefore = storage.getState().teams[TEAM_ID];

    const pulledHost = {
      ...sshDraft("pulled"),
      id: "pulled-host",
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    } as unknown as HostRecord;
    const payload = {
      groups: [],
      hosts: [encryptRecord(pulledHost.id, pulledHost, context.vaultKeyBase64)],
      secrets: [
        encryptRecord(
          "secret:pulled",
          { secretRef: "secret:pulled", label: "pulled", password: "pw", updatedAt: "2026-10-19T00:00:00.000Z" },
          context.vaultKeyBase64,
        ),
      ],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      snippets: [],
      workspaces: [],
      preferences: [],
      awsProfiles: [],
      tailnets: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (new URL(String(url)).pathname === "/api/info") {
          return new Response(
            JSON.stringify({ capabilities: { sync: { awsProfiles: true }, vault: { e2ee: true } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"2"' },
        });
      }),
    );

    const { SyncService } = await import("./sync-service");
    const authService = {
      captureSyncContext: vi.fn(() => ({ ...context })),
      isSyncContextCurrent: vi.fn(() => true),
      getState: vi.fn(() => ({ status: "authenticated" })),
      isVaultReadyForSync: vi.fn(() => true),
      getClientIdentificationHeaders: vi.fn(() => ({})),
      getAccessToken: vi.fn(() => context.accessToken),
      refreshSession: vi.fn(),
      handleVaultDekRejected: vi.fn(),
      getVaultStatus: vi.fn(() => "unlocked"),
      noteServerVaultSupport: vi.fn(),
    };
    // pull 은 상태 파일에 바로 쓴다. 나머지는 push 쪽에서만 쓰여 빈 목으로 둔다.
    const emptyRepository = { list: vi.fn(() => []), listPayloads: vi.fn(() => []), replaceAll: vi.fn() };
    const service = new SyncService(
      authService as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      { list: vi.fn(() => []), remove: vi.fn() } as never,
      { listPayloads: vi.fn(() => []), replaceAll: vi.fn() } as never,
      {
        getSyncedTerminalPreferences: vi.fn(() => ({
          id: "global-terminal",
          globalTerminalThemeId: "dolssh-dark",
          updatedAt: "2026-10-19T00:00:00.000Z",
        })),
        clearSyncedTerminalPreferences: vi.fn(),
      } as never,
      { load: vi.fn(), remove: vi.fn() } as never,
      { list: vi.fn(() => []), clearMany: vi.fn(), clearAll: vi.fn() } as never,
      emptyRepository as never,
      emptyRepository as never,
    );

    await service.bootstrap();

    const state = storage.getState();
    expect(state.data.hosts.map((host) => host.id)).toEqual(["pulled-host"]);
    expect(Object.keys(state.secure.managedSecretsByRef)).toEqual(["secret:pulled"]);
    expect(state.teams[TEAM_ID]).toEqual(teamBefore);
    expect(state.teams[TEAM_ID].data.hosts.map((host) => host.id)).toEqual(["team-host"]);
    expect(Object.keys(state.teams[TEAM_ID].secure.managedSecretsByRef)).toEqual(["secret:team"]);
    expect(Object.keys(state.teams[TEAM_ID].secure.tailnetAuthKeysById)).toEqual(["tailnet-team"]);
  });
});
