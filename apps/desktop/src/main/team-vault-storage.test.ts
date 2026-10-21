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

describe("finding the vault of settings records", () => {
  // 설정의 볼트별 묶음(4-7)에서 고치고 지우는 것은 그 레코드가 든 볼트로 간다. id 가 겹치면 개인이 이긴다.
  it("finds the vault that holds a saved credential, a tailnet and a host key", async () => {
    const { database, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const catalog = createCatalog();
    const scope = catalog.getScope(TEAM_ID)!;
    const credential = (secretRef: string) => ({ secretRef, label: secretRef, hasPassword: true, hasPassphrase: false });
    scope.secretMetadata.upsert(credential("secret:team"));
    scope.secretMetadata.upsert(credential("secret:both"));
    new database.SecretMetadataRepository().upsert(credential("secret:both"));
    scope.tailnets.save(TEAM_TAILNET);
    const teamKey = scope.knownHosts.trust({
      hostId: "",
      hostLabel: "acme-web-1",
      host: "10.20.0.11",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAA",
      fingerprintSha256: "SHA256:team",
    });

    expect(catalog.scopeOfSecret("secret:team").id).toBe(TEAM_ID);
    expect(catalog.scopeOfSecret("secret:both").id).toBe("personal");
    expect(catalog.scopeOfSecret("secret:unknown").id).toBe("personal");
    expect(catalog.scopeOfTailnet(TEAM_TAILNET.id).id).toBe(TEAM_ID);
    expect(catalog.scopeOfTailnet("tailnet-unknown").id).toBe("personal");
    expect(catalog.scopeOfKnownHost(teamKey.id).id).toBe(TEAM_ID);
    expect(catalog.scopeOfKnownHost("known-unknown").id).toBe("personal");
  });

  it("tests and connects a team tailnet with my own auth key, never the team's", async () => {
    const { addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;
    scope.tailnets.save(TEAM_TAILNET);
    expect(scope.tailnets.readAuthKey(TEAM_TAILNET.id)).toBeNull();

    scope.memberPrefs!.writeTailnetCredentials(TEAM_TAILNET.id, { authKey: "tskey-mine" });

    expect(scope.tailnets.readAuthKey(TEAM_TAILNET.id)).toBe("tskey-mine");
    // 팀에 올리는 것에는 여전히 키가 없다.
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("authKey");
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
      hostCredentials: [],
      awsProfileCredentials: [],
      tailnetCredentials: [],
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

  // 팀 tailnet 에 붙는 auth key 는 내 것이다 — 팀 쪽에 키가 남아 있어도(옛 데이터) 코어에 넘기지 않는다.
  it("hands the core every vault's tailnet, a team one with my own auth key", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.TailnetRepository().save({ ...TEAM_TAILNET, id: "tailnet-mine", label: "Mine" }, "tskey-mine");
    new database.TailnetRepository(vaultRoot.teamVaultRoot(TEAM_ID)).save(TEAM_TAILNET, "tskey-left-in-team");
    expect(createCatalog().listTailnetPayloads().map((tailnet) => [tailnet.id, tailnet.authKey])).toEqual([
      ["tailnet-mine", "tskey-mine"],
      ["tailnet-team", undefined],
    ]);

    createCatalog().getScope(TEAM_ID)!.tailnets.save(TEAM_TAILNET, "tskey-team-mine");

    expect(createCatalog().listTailnetPayloads().map((tailnet) => [tailnet.id, tailnet.authKey])).toEqual([
      ["tailnet-mine", "tskey-mine"],
      ["tailnet-team", "tskey-team-mine"],
    ]);
    expect(storage.getState().teams[TEAM_ID].secure.tailnetAuthKeysById).toEqual({});
  });

  it("keeps my credentials for a team host in my own place, locked on this device", async () => {
    const { stateStorage, storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    new database.HostRepository().create("personal-host", sshDraft("mine"));
    const catalog = createCatalog();
    const mine = { username: "alice", authType: "privateKey" as const, privateKeyPem: "PEM-OF-ALICE", privateKeyPath: "/Users/alice/.ssh/id" };

    catalog.setMyHostCredentials("team-host", mine);

    const team = storage.getState().teams[TEAM_ID];
    expect(team.private.hostCredentials).toEqual([
      expect.objectContaining({ id: "team-host", value: expect.objectContaining({ encrypted: true }) }),
    ]);
    expect(JSON.stringify(team.private)).not.toContain("PEM-OF-ALICE");
    expect(team.sync.privatePendingPush).toBe(true);
    expect(catalog.getMyHostCredentials("team-host")).toEqual(mine);
    // 팀 레코드와 팀 비밀값에는 아무것도 들어가지 않는다.
    expect(JSON.stringify([team.data, team.secure])).not.toContain("alice");
    // 개인 호스트에는 둘 곳이 없다 — 호스트의 비밀값을 쓴다.
    expect(catalog.getMyHostCredentials("personal-host")).toBeNull();
    expect(() => catalog.setMyHostCredentials("personal-host", mine)).toThrow("내 자격 증명은 팀 호스트에만 둘 수 있습니다.");

    // 다시 읽어도 남는다.
    stateStorage.resetDesktopStateStorageForTests();
    expect(createCatalog().getMyHostCredentials("team-host")).toEqual(mine);

    // 지우면 내 다른 기기에도 지움 표시가 간다.
    createCatalog().setMyHostCredentials("team-host", null);
    const cleared = stateStorage.getDesktopStateStorage().getState().teams[TEAM_ID];
    expect(cleared.private.hostCredentials).toEqual([]);
    expect(cleared.private.syncOutbox).toEqual([expect.objectContaining({ kind: "hostCredentials", recordId: "team-host" })]);

    // 팀 호스트가 사라지면 내 자격 증명도 정리한다.
    createCatalog().setMyHostCredentials("team-host", mine);
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).remove("team-host");
    expect(stateStorage.getDesktopStateStorage().pruneTeamMemberPrefs(TEAM_ID)).toBe(true);
    const pruned = stateStorage.getDesktopStateStorage().getState().teams[TEAM_ID];
    expect(pruned.private.hostCredentials).toEqual([]);
    // 내 다른 기기에서도 지우도록 지움 표시를 남긴다.
    expect(pruned.private.syncOutbox).toContainEqual(
      expect.objectContaining({ kind: "hostCredentials", recordId: "team-host" }),
    );
  });

  it("tells the screen which team owns each record, with the team's groups and my own username", async () => {
    const { database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    new database.GroupRepository(root).create("group-t", "ops");
    new database.HostRepository(root).create("team-host", sshDraft("shared", "ops"));
    new database.HostRepository(root).create("team-other", sshDraft("other"));
    const teamSnippet = new database.SnippetRepository(root).create({ label: "deploy", command: "make deploy" });
    new database.GroupRepository().create("group-p", "ops");
    new database.HostRepository().create("personal-host", sshDraft("mine", "ops"));
    new database.SnippetRepository().create({ label: "mine", command: "ls" });
    createCatalog().setMyHostCredentials("team-host", { username: "bob", password: "pw" });

    const layout = createCatalog().describeTeamVaults();

    expect(layout.groupsByTeamId).toEqual({ [TEAM_ID]: [expect.objectContaining({ id: "group-t", path: "ops" })] });
    expect(layout.teamIdByHostId).toEqual({ "team-host": TEAM_ID, "team-other": TEAM_ID });
    expect(layout.teamIdBySnippetId).toEqual({ [teamSnippet.id]: TEAM_ID });
    // 내 사용자 이름만 — 비밀값은 표에 실리지 않는다.
    expect(layout.myUsernameByHostId).toEqual({ "team-host": "bob" });
    expect(JSON.stringify(layout)).not.toContain("pw");
  });

  it("shows on a team tailnet whether I have my own auth key, whatever the team record carries", async () => {
    const { storage, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;
    scope.tailnets.save(TEAM_TAILNET);
    // 옛 데이터: 팀 레코드에 키가 있다고 남아 있다. 키는 늘 각자라 이 값은 쓰지 않는다.
    storage.updateState((state) => {
      state.teams[TEAM_ID].data.tailnets = state.teams[TEAM_ID].data.tailnets.map((tailnet) => ({
        ...tailnet,
        hasAuthKey: true,
      }));
    });
    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);

    scope.memberPrefs!.writeTailnetCredentials(TEAM_TAILNET.id, { authKey: "tskey-mine" });

    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: true })]);
    // 팀에 올리는 것은 그대로 키 없음이다.
    expect(scope.tailnets.listPayloads()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("authKey");
  });

  it("keeps my AWS keys and tailnet auth key for team records in my own slot, used here but never sent to the team", async () => {
    const { stateStorage, storage, database, vaultRoot, teamVaultScope, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;
    // 키 없이 공유된 팀 정적 프로필과 tailnet(팀에는 설정만 있다).
    scope.awsProfiles.upsert({
      id: "aws-team",
      kind: "static",
      name: "team",
      region: null,
      accessKeyId: "",
      secretAccessKey: "",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });
    scope.tailnets.save(TEAM_TAILNET);

    scope.memberPrefs!.writeAwsProfileCredentials("aws-team", { accessKeyId: "AKIAMINE", secretAccessKey: "mine-secret" });
    scope.memberPrefs!.writeTailnetCredentials(TEAM_TAILNET.id, { authKey: "tskey-mine" });

    // 이 기기에서 펼치고 코어에 넘길 때는 내 것이 먼저다.
    expect(teamVaultScope.listStoredTeamAwsProfiles()).toEqual([
      {
        teamId: TEAM_ID,
        payloads: [expect.objectContaining({ id: "aws-team", accessKeyId: "AKIAMINE", secretAccessKey: "mine-secret" })],
      },
    ]);
    expect(createCatalog().listTailnetPayloads()).toEqual([
      expect.objectContaining({ id: TEAM_TAILNET.id, authKey: "tskey-mine" }),
    ]);
    // 팀에 올리는 것(팀 저장소의 listPayloads)과 팀 레코드에는 없다.
    expect(scope.awsProfiles.listPayloads()).toEqual([expect.objectContaining({ accessKeyId: "", secretAccessKey: "" })]);
    expect(scope.tailnets.listPayloads()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("authKey");
    const team = storage.getState().teams[TEAM_ID];
    expect(team.private.awsProfileCredentials).toEqual([
      expect.objectContaining({ id: "aws-team", value: expect.objectContaining({ encrypted: true }) }),
    ]);
    expect(team.private.tailnetCredentials).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id })]);
    expect(JSON.stringify([team.data, team.secure])).not.toMatch(/AKIAMINE|tskey-mine/);
    expect(team.sync.privatePendingPush).toBe(true);
    // 다시 읽어도 남는다.
    stateStorage.resetDesktopStateStorageForTests();
    expect(createCatalog().getScope(TEAM_ID)!.memberPrefs!.readTailnetCredentials(TEAM_TAILNET.id)).toEqual({
      authKey: "tskey-mine",
    });
    // 지운 표시도 올리기 전에 앱을 다시 켜도 남는다 — 남지 않으면 내 다른 기기에 지운 것이 안 간다.
    createCatalog().getScope(TEAM_ID)!.memberPrefs!.writeAwsProfileCredentials("aws-team", null);
    stateStorage.resetDesktopStateStorageForTests();
    expect(stateStorage.getDesktopStateStorage().listTeamPrivateDeletions(TEAM_ID)).toEqual([
      expect.objectContaining({ kind: "awsProfileCredentials", recordId: "aws-team" }),
    ]);

    // 팀 프로필·tailnet 이 사라지면(다른 멤버가 지워 동기화로 빠짐) 내 키도 지우고, 내 다른 기기도 지우게 지움
    // 표시를 남긴다.
    const again = createCatalog().getScope(TEAM_ID)!;
    again.memberPrefs!.writeAwsProfileCredentials("aws-team", { accessKeyId: "AKIAMINE", secretAccessKey: "mine-secret" });
    const teamRoot = vaultRoot.teamVaultRoot(TEAM_ID);
    new database.AwsProfileRepository(teamRoot).remove("aws-team");
    new database.TailnetRepository(teamRoot).remove(TEAM_TAILNET.id);
    expect(stateStorage.getDesktopStateStorage().pruneTeamMemberPrefs(TEAM_ID)).toBe(true);
    const pruned = stateStorage.getDesktopStateStorage().getState().teams[TEAM_ID];
    expect(pruned.private.awsProfileCredentials).toEqual([]);
    expect(pruned.private.tailnetCredentials).toEqual([]);
    expect(pruned.private.syncOutbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "awsProfileCredentials", recordId: "aws-team" }),
        expect.objectContaining({ kind: "tailnetCredentials", recordId: TEAM_TAILNET.id }),
      ]),
    );
  });

  // 화면이 팀 볼트에 직접 쓸 때(작업 4)도 같은 규칙 — 팀 저장소가 키를 받으면 팀 쪽에 두지 않고 내 칸에 둔다.
  it("keeps AWS static keys and a tailnet auth key written straight into a team in my own slot", async () => {
    const { stateStorage, storage, database, vaultRoot, teamVaultScope, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;
    const team = () => storage.getState().teams[TEAM_ID];

    // 팀 쪽에 키가 남아 있어도(옛 데이터) 팀 저장소는 키를 빼고 읽는다 — 올리지도, 펼치지도 않는다.
    new database.AwsProfileRepository(vaultRoot.teamVaultRoot(TEAM_ID)).upsert({
      id: "aws-old",
      kind: "static",
      name: "old",
      region: null,
      accessKeyId: "AKIAOLDTEAM",
      secretAccessKey: "old-team-secret",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });
    expect(scope.awsProfiles.listPayloads()).toEqual([
      expect.objectContaining({ id: "aws-old", accessKeyId: "", secretAccessKey: "" }),
    ]);
    expect(teamVaultScope.listStoredTeamAwsProfiles()[0].payloads).toEqual([
      expect.objectContaining({ id: "aws-old", accessKeyId: "", secretAccessKey: "" }),
    ]);

    scope.awsProfiles.upsert({
      id: "aws-team",
      kind: "static",
      name: "team",
      region: "ap-northeast-2",
      accessKeyId: "AKIAWRITER",
      secretAccessKey: "writer-secret",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });
    scope.tailnets.save(TEAM_TAILNET, "tskey-writer");

    // 팀 쪽에는 설정만 있다 — 저장된 원본(키를 빼지 않는 기본 저장소로 읽은 것)에도 키가 없다.
    expect(scope.awsProfiles.getPayloadById("aws-team")).toMatchObject({ name: "team", accessKeyId: "", secretAccessKey: "" });
    expect(new database.AwsProfileRepository(vaultRoot.teamVaultRoot(TEAM_ID)).getPayloadById("aws-team")).toMatchObject({
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(team().data.tailnets).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);
    expect(team().secure.tailnetAuthKeysById).toEqual({});
    expect(JSON.stringify([team().data, team().secure])).not.toMatch(/AKIAWRITER|writer-secret|tskey-writer/);
    // 키는 쓴 사람의 내 칸에 있다.
    expect(scope.memberPrefs!.readAwsProfileCredentials("aws-team")).toEqual({
      accessKeyId: "AKIAWRITER",
      secretAccessKey: "writer-secret",
    });
    expect(scope.memberPrefs!.readTailnetCredentials(TEAM_TAILNET.id)).toEqual({ authKey: "tskey-writer" });

    // 키 없이 다시 저장하면 내 것은 그대로, 빈 키를 주면 내 칸에서 지운다(개인 저장소와 같은 뜻).
    scope.tailnets.save({ ...TEAM_TAILNET, label: "renamed" });
    expect(scope.memberPrefs!.readTailnetCredentials(TEAM_TAILNET.id)).toEqual({ authKey: "tskey-writer" });
    scope.tailnets.save(TEAM_TAILNET, "");
    expect(scope.memberPrefs!.readTailnetCredentials(TEAM_TAILNET.id)).toBeNull();

    // 팀 tailnet 을 지우면 내 auth key 도 지운다.
    scope.tailnets.save(TEAM_TAILNET, "tskey-writer");
    scope.tailnets.remove(TEAM_TAILNET.id);
    expect(scope.memberPrefs!.readTailnetCredentials(TEAM_TAILNET.id)).toBeNull();

    // 팀 것을 지우면 내 키도 지우고, 내 다른 기기도 지우게 지움 표시를 남긴다.
    scope.awsProfiles.remove("aws-team");
    expect(scope.memberPrefs!.readAwsProfileCredentials("aws-team")).toBeNull();
    expect(stateStorage.getDesktopStateStorage().listTeamPrivateDeletions(TEAM_ID)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "awsProfileCredentials", recordId: "aws-team" })]),
    );
  });

  // 요청 창·이름 묻는 창에서 넣은 사용자 이름. 팀 레코드에 쓰면 팀 모두의 사용자 이름이 바뀐다(3-6 의 F4).
  it("puts a login username where it belongs: the record for a personal host, my own slot for a team host", async () => {
    const { storage, database, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const catalog = createCatalog();
    new database.HostRepository().create("personal-host", sshDraft("mine"));
    catalog.createHost(TEAM_ID, "team-host", sshDraft("shared"));
    catalog.createHost(TEAM_ID, "team-blank", { ...sshDraft("blank"), username: "" });
    const teamRecord = (id: string) =>
      storage.getState().teams[TEAM_ID].data.hosts.find((host) => host.id === id) as unknown as Record<string, unknown>;

    // 개인 호스트는 레코드에.
    expect(catalog.setHostLoginUsername("personal-host", "alice")).toMatchObject({ username: "alice" });
    const personalRecord = () => storage.getState().data.hosts.find((host) => host.id === "personal-host");
    expect(personalRecord()).toMatchObject({ username: "alice" });
    // 같은 이름이면 다시 쓰지 않는다 — 쓰면 동기화가 괜히 깨어난다.
    const savedAt = personalRecord()?.updatedAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    catalog.setHostLoginUsername("personal-host", "alice");
    expect(personalRecord()?.updatedAt).toBe(savedAt);
    vi.useRealTimers();

    // 팀 호스트는 내 칸에 — 팀 레코드는 그대로다. 팀 것과 같은 이름이면 내 칸에서 뺀다.
    catalog.setHostLoginUsername("team-host", "bob");
    expect(teamRecord("team-host")).toMatchObject({ username: "ubuntu" });
    expect(catalog.getMyHostCredentials("team-host")).toEqual({ username: "bob" });
    catalog.setHostLoginUsername("team-host", "ubuntu");
    expect(catalog.getMyHostCredentials("team-host")).toBeNull();

    // 팀 레코드에 이름이 없으면 화면에 내 이름을 채워 보낸다 — 화면은 레코드의 이름을 보고 묻는 창을 띄운다.
    expect(catalog.setHostLoginUsername("team-blank", "carol")).toMatchObject({ username: "carol" });
    expect(catalog.getHost("team-blank")).toMatchObject({ username: "carol" });
    expect(catalog.listHosts().find((host) => host.id === "team-blank")).toMatchObject({ username: "carol" });
    expect(teamRecord("team-blank")).toMatchObject({ username: "" });
    // 편집 창이 채워 받은 이름을 그대로 돌려보내도 팀 레코드에 쓰지 않는다.
    catalog.updateHost("team-blank", { ...sshDraft("blank renamed"), username: "carol" });
    expect(teamRecord("team-blank")).toMatchObject({ label: "blank renamed", username: "" });
    // 다른 이름으로 고치면 팀 호스트를 고친 것이다.
    catalog.updateHost("team-blank", { ...sshDraft("blank renamed"), username: "deploy" });
    expect(teamRecord("team-blank")).toMatchObject({ username: "deploy" });
  });

  it("keeps a team tailnet's signed-in account on this device only", async () => {
    const { stateStorage, storage, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;

    scope.tailnets.save({ ...TEAM_TAILNET, loginName: "me@example.com" }, "tskey-team");

    // 팀 레코드에는 없고 이 기기 칸에만 있다. 이 기기의 목록에는 얹혀 보인다.
    const team = storage.getState().teams[TEAM_ID];
    expect(team.data.tailnets[0]).not.toHaveProperty("loginName");
    expect(team.local.tailnetLoginNameById).toEqual({ [TEAM_TAILNET.id]: "me@example.com" });
    expect(scope.tailnets.list()[0]).toMatchObject({ id: TEAM_TAILNET.id, loginName: "me@example.com" });
    // 올리는 것과 코어에 넘기는 것에는 싣지 않는다. auth key 는 팀에 올리지 않고 내 칸에 있다가 코어에만 간다.
    expect(scope.tailnets.listPayloads()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id })]);
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("loginName");
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("authKey");
    expect(createCatalog().listTailnetPayloads()[0]).not.toHaveProperty("loginName");
    expect(createCatalog().listTailnetPayloads()[0]).toMatchObject({ authKey: "tskey-team" });

    // 다시 읽어도 남고, tailnet 을 지우면 함께 지워진다.
    stateStorage.resetDesktopStateStorageForTests();
    expect(stateStorage.getDesktopStateStorage().readTeamTailnetLoginNames(TEAM_ID)).toEqual({
      [TEAM_TAILNET.id]: "me@example.com",
    });
    createCatalog().getScope(TEAM_ID)!.tailnets.remove(TEAM_TAILNET.id);
    expect(stateStorage.getDesktopStateStorage().readTeamTailnetLoginNames(TEAM_ID)).toEqual({});
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
