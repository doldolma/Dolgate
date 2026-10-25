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

  // 팀 tailnet 의 auth key 도 개인 것과 똑같이 그 볼트에 둔다 — 팀에 올리지 않는 것은 팀 동기화가 한다(동기화
  // 시험이 본다). 그래서 이 기기에서는 개인 것처럼 시험하고 붙는다.
  it("keeps a team tailnet's auth key in that vault on this device, like a personal one", async () => {
    const { storage, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;

    scope.tailnets.save(TEAM_TAILNET, "tskey-typed");

    expect(scope.tailnets.readAuthKey(TEAM_TAILNET.id)).toBe("tskey-typed");
    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: true })]);
    expect(Object.keys(storage.getState().teams[TEAM_ID].secure.tailnetAuthKeysById)).toEqual([TEAM_TAILNET.id]);
    expect(storage.getState().secure.tailnetAuthKeysById).toEqual({});
    // 비우면 지우고(브라우저 로그인), 생략하면 그대로 둔다 — 개인 것과 같은 뜻.
    scope.tailnets.save({ ...TEAM_TAILNET, label: "renamed" });
    expect(scope.tailnets.readAuthKey(TEAM_TAILNET.id)).toBe("tskey-typed");
    scope.tailnets.save(TEAM_TAILNET, "");
    expect(scope.tailnets.readAuthKey(TEAM_TAILNET.id)).toBeNull();
    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);
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

    catalog.removeHosts(["team-host"]);
    const state = storage.getState();
    expect(state.teams[TEAM_ID].data.hosts.map((host) => host.id)).toEqual(["team-bastion"]);
    expect(state.teams[TEAM_ID].data.syncOutbox).toEqual([expect.objectContaining({ kind: "hosts", recordId: "team-host" })]);
    expect(state.data.hosts.map((host) => host.id)).toEqual(["personal-bastion"]);
    expect(state.data.syncOutbox).toEqual([]);
  });

  // 여러 개를 지울 때 하나씩 지우면 지우는 수만큼 상태 파일을 다시 쓴다(쓸 때마다 fsync·백업 복사).
  it("removes many hosts across vaults at once, writing each vault once", async () => {
    const { storage, database, vaultRoot, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    const personal = new database.HostRepository();
    personal.create("bastion", sshDraft("bastion"));
    personal.create("web", { ...sshDraft("web"), jumpHostId: "bastion", jumpHostIds: ["bastion"] } as never);
    personal.create("db", sshDraft("db"));
    new database.HostRepository(root).create("team-host", sshDraft("shared"));
    new database.HostRepository(root).create("team-keep", sshDraft("keep"));
    const catalog = createCatalog();
    const writes = vi.spyOn(storage, "updateState");

    const removed = catalog.removeHosts(["bastion", "db", "team-host", "gone"]);

    expect(removed.map(({ host, vaultId }) => [host.id, vaultId])).toEqual([
      ["bastion", "personal"],
      ["db", "personal"],
      ["team-host", TEAM_ID],
    ]);
    // 볼트마다 지움 표시 한 번, 호스트 한 번.
    expect(writes).toHaveBeenCalledTimes(4);
    const state = storage.getState();
    expect(state.data.hosts.map((host) => host.id)).toEqual(["web"]);
    // 지운 점프 호스트를 가리키던 것은 풀린다.
    expect(state.data.hosts[0]).toMatchObject({ jumpHostId: null, jumpHostIds: null });
    expect(state.data.syncOutbox.map((entry) => entry.recordId).sort()).toEqual(["bastion", "db", "gone"]);
    expect(state.teams[TEAM_ID].data.hosts.map((host) => host.id)).toEqual(["team-keep"]);
    expect(state.teams[TEAM_ID].data.syncOutbox).toEqual([expect.objectContaining({ kind: "hosts", recordId: "team-host" })]);
  });

  // 코어에는 모든 볼트의 tailnet 을 이 기기에 둔 auth key 와 함께 넘긴다. 키가 없는 팀 것은 브라우저 로그인이다.
  it("hands the core every vault's tailnet with the auth key kept on this device", async () => {
    const { database, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    new database.TailnetRepository().save({ ...TEAM_TAILNET, id: "tailnet-mine", label: "Mine" }, "tskey-mine");
    createCatalog().getScope(TEAM_ID)!.tailnets.save(TEAM_TAILNET);
    expect(createCatalog().listTailnetPayloads().map((tailnet) => [tailnet.id, tailnet.authKey])).toEqual([
      ["tailnet-mine", "tskey-mine"],
      ["tailnet-team", undefined],
    ]);

    createCatalog().getScope(TEAM_ID)!.tailnets.save(TEAM_TAILNET, "tskey-team-here");

    expect(createCatalog().listTailnetPayloads().map((tailnet) => [tailnet.id, tailnet.authKey])).toEqual([
      ["tailnet-mine", "tskey-mine"],
      ["tailnet-team", "tskey-team-here"],
    ]);
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

  // 키가 있는지는 이 기기 것이다. 팀 레코드에 적힌 값(남이 올린 것·옛 데이터)을 믿으면 키 없는 기기에서 "auth key" 로
  // 보이고 저장된 키가 없는데도 비워 두면 그대로라고 안내한다.
  it("shows whether this device has a team tailnet's key, whatever the team record carries", async () => {
    const { storage, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;
    scope.tailnets.save(TEAM_TAILNET);
    storage.updateState((state) => {
      state.teams[TEAM_ID].data.tailnets = state.teams[TEAM_ID].data.tailnets.map((tailnet) => ({
        ...tailnet,
        hasAuthKey: true,
      }));
    });
    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: false })]);

    scope.tailnets.save(TEAM_TAILNET, "tskey-here");
    storage.updateState((state) => {
      state.teams[TEAM_ID].data.tailnets = state.teams[TEAM_ID].data.tailnets.map((tailnet) => ({
        ...tailnet,
        hasAuthKey: false,
      }));
    });
    expect(scope.tailnets.list()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id, hasAuthKey: true })]);
  });

  // 팀 정적 프로필의 키도 개인 것과 똑같이 그 볼트에 둔다 — 이 기기에서 펼치고 붙는 데 쓰고, 팀에 올리지 않는 것은 팀
  // 동기화가 한다. 내 개인 칸으로 가지 않으니 내 다른 기기에도 따라가지 않는다.
  it("keeps AWS keys for a team profile in that vault on this device, used here and not in my private slot", async () => {
    const { stateStorage, storage, teamVaultScope, addTeam, createCatalog } = await load();
    addTeam(TEAM_ID);
    const scope = createCatalog().getScope(TEAM_ID)!;

    scope.awsProfiles.upsert({
      id: "aws-team",
      kind: "static",
      name: "team",
      region: null,
      accessKeyId: "AKIAHERE",
      secretAccessKey: "here-secret",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });

    expect(scope.awsProfiles.getPayloadById("aws-team")).toMatchObject({ accessKeyId: "AKIAHERE", secretAccessKey: "here-secret" });
    expect(teamVaultScope.listStoredTeamAwsProfiles()).toEqual([
      {
        teamId: TEAM_ID,
        payloads: [expect.objectContaining({ id: "aws-team", accessKeyId: "AKIAHERE", secretAccessKey: "here-secret" })],
      },
    ]);
    const team = storage.getState().teams[TEAM_ID];
    expect(Object.keys(team.secure.managedAwsProfilesById)).toEqual(["aws-team"]);
    expect(team.private).not.toHaveProperty("awsProfileCredentials");
    expect(team.sync.privatePendingPush).toBe(false);
    expect(storage.getState().secure.managedAwsProfilesById).toEqual({});
    // 다시 읽어도 남는다.
    stateStorage.resetDesktopStateStorageForTests();
    expect(createCatalog().getScope(TEAM_ID)!.awsProfiles.getPayloadById("aws-team")).toMatchObject({
      accessKeyId: "AKIAHERE",
      secretAccessKey: "here-secret",
    });
    // 프로필을 지우면 키도 함께 지워진다.
    createCatalog().getScope(TEAM_ID)!.awsProfiles.remove("aws-team");
    expect(stateStorage.getDesktopStateStorage().getState().teams[TEAM_ID].secure.managedAwsProfilesById).toEqual({});
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
    // 코어에 넘기는 것에는 싣지 않는다(auth key 는 이 기기에 둔 것이 간다).
    expect(scope.tailnets.listPayloads()).toEqual([expect.objectContaining({ id: TEAM_TAILNET.id })]);
    expect(scope.tailnets.listPayloads()[0]).not.toHaveProperty("loginName");
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
