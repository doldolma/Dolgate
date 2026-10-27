import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownHostTrustInput, ManagedAwsProfilePayload, TeamRole } from "@shared";

// 읽기 전용 멤버는 팀 레코드를 고치지 못한다(서버도 거절한다). 메인은 저장소의 쓰기 관문에서 먼저 막고, 접속하며
// 생기는 신뢰(호스트 키·RDP 인증서)와 이 기기의 키(AWS 정적 키·tailnet auth key)는 팀 레코드 밖에 둔다.

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

const sshDraft = (label: string) => ({
  kind: "ssh" as const,
  label,
  hostname: `${label}.example.com`,
  port: 22,
  username: "ubuntu",
  authType: "password" as const,
});

const rdpDraft = (label: string) => ({
  kind: "rdp" as const,
  label,
  hostname: `${label}.example.com`,
  port: 3389,
  username: "admin",
});

const KEY: Omit<KnownHostTrustInput, "hostId" | "hostLabel"> = {
  host: "shared.example.com",
  port: 22,
  algorithm: "ssh-ed25519",
  publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIA",
  fingerprintSha256: "SHA256:shared",
};

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
  const addTeam = (role: TeamRole) =>
    storage.updateState((state) => {
      state.teams[TEAM_ID] = stateStorage.createTeamState({
        name: "Acme",
        role,
        wrappedTeamDek: "wrapped",
        dataFloor: 1,
        updatedAt: "2026-10-19T00:00:00.000Z",
      });
    });
  // 역할을 바꾼다(팀 목록 읽기가 하는 것과 같다).
  const setRole = (role: TeamRole) => {
    const info = storage.getTeamState(TEAM_ID)!.info;
    storage.upsertTeamInfo(TEAM_ID, { ...info, role });
  };
  return { stateStorage, storage, database, vaultRoot, addTeam, setRole, createCatalog };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-roles-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("the write gate of a read-only team", () => {
  it("refuses record writes for a viewer, keeps reads and bookkeeping, and lets a member write", async () => {
    const { storage, database, vaultRoot, addTeam, setRole } = await load();
    addTeam("member");
    const root = vaultRoot.teamVaultRoot(TEAM_ID);
    const hosts = new database.HostRepository(root);
    hosts.create("team-host", sshDraft("shared"));
    setRole("viewer");

    expect(() => hosts.create("other", sshDraft("other"))).toThrow(vaultRoot.TeamVaultReadOnlyError);
    expect(() => hosts.update("team-host", { ...sshDraft("renamed") })).toThrow(vaultRoot.TeamVaultReadOnlyError);
    expect(() => new database.GroupRepository(root).create("g", "ops")).toThrow(vaultRoot.TeamVaultReadOnlyError);
    expect(() => new database.KnownHostRepository(root).trust({ ...KEY, hostId: "team-host", hostLabel: "shared" })).toThrow(
      vaultRoot.TeamVaultReadOnlyError,
    );
    // 읽기와 이 기기만 쓰는 동기화 장부는 된다. 개인 볼트도 그대로다.
    expect(hosts.list().map((host) => host.label)).toEqual(["shared"]);
    new database.SyncOutboxRepository(root).upsertDeletion("hosts", "gone");
    new database.HostRepository().create("personal-host", sshDraft("mine"));

    const team = storage.getState().teams[TEAM_ID];
    expect(team.data.hosts.map((host) => host.label)).toEqual(["shared"]);
    expect(team.data.groups).toEqual([]);
    expect(team.data.syncOutbox.map((entry) => entry.recordId)).toEqual(["gone"]);
    expect(storage.getState().data.hosts.map((host) => host.id)).toEqual(["personal-host"]);

    setRole("member");
    hosts.create("other", sshDraft("other"));
    expect(hosts.list().map((host) => host.id).sort()).toEqual(["other", "team-host"]);
  });

  it("refuses team secrets and copies into a read-only team", async () => {
    const { storage, vaultRoot, addTeam, setRole } = await load();
    addTeam("viewer");
    const secret = { value: Buffer.from("pw").toString("base64"), encrypted: true } as never;

    expect(() => storage.writeTeamSecret(TEAM_ID, "secret:team-1", secret)).toThrow(vaultRoot.TeamVaultReadOnlyError);
    expect(() => storage.deleteTeamSecret(TEAM_ID, "secret:team-1")).toThrow(vaultRoot.TeamVaultReadOnlyError);
    const nothing = {
      groups: [],
      hosts: [],
      knownHosts: [],
      portForwards: [],
      dnsOverrides: [],
      secretMetadata: [],
      awsProfiles: [],
      snippets: [],
      tailnets: [],
      savedWorkspaces: [],
      secrets: {},
      awsProfilePayloads: {},
      tailnetAuthKeys: {},
    } as never;
    expect(() => storage.applyVaultCopy(TEAM_ID, nothing)).toThrow(vaultRoot.TeamVaultReadOnlyError);

    setRole("member");
    storage.writeTeamSecret(TEAM_ID, "secret:team-1", secret);
    expect(storage.readTeamSecret(TEAM_ID, "secret:team-1")).not.toBeNull();
  });
});

describe("what a read-only member trusts while connecting", () => {
  it("keeps a host key a viewer trusts in my own place and finds it on the next connect", async () => {
    const { storage, database, vaultRoot, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    setRole("viewer");
    const knownHosts = createCatalog().scopeOfHost("team-host").knownHosts;

    const trusted = knownHosts.trust({ ...KEY, hostId: "team-host", hostLabel: "shared" });

    const team = storage.getState().teams[TEAM_ID];
    expect(team.data.knownHosts).toEqual([]);
    expect(team.private.hostPrefs.find((prefs) => prefs.id === "team-host")?.knownHosts).toEqual([trusted]);
    expect(team.sync.privatePendingPush).toBe(true);
    // 다음 접속은 팀 것과 함께 찾는다. 팀에 올리는 목록에는 섞이지 않는다.
    const next = createCatalog().scopeOfHost("team-host").knownHosts;
    expect(next.getByHostPortAlgorithm(KEY.host, KEY.port, KEY.algorithm)).toEqual(trusted);
    expect(next.listByHostPort(KEY.host, KEY.port)).toEqual([trusted]);
    expect(next.getByHostPort(KEY.host, KEY.port)).toEqual(trusted);
    expect(next.list()).toEqual([]);
    // 앱을 다시 켜도(상태 파일을 다시 읽어도) 남는다.
    const reloaded = await import("./state-storage");
    reloaded.resetDesktopStateStorageForTests();
    expect(reloaded.getDesktopStateStorage().getTeamState(TEAM_ID)?.private.hostPrefs[0]?.knownHosts).toEqual([trusted]);

    // 다시 신뢰하면(키가 바뀜) 같은 자리를 고친다. 지우면 내 칸에서 지운다.
    const replaced = next.trust({ ...KEY, publicKeyBase64: "AAAA-new", hostId: "team-host", hostLabel: "shared" });
    expect(replaced.id).toBe(trusted.id);
    expect(next.listByHostPort(KEY.host, KEY.port)).toEqual([replaced]);
    next.remove(trusted.id);
    expect(next.listByHostPort(KEY.host, KEY.port)).toEqual([]);
    expect(storage.getState().teams[TEAM_ID].data.knownHosts).toEqual([]);
  });

  it("puts a member's trust on the team record and prefers my own key for the same slot", async () => {
    const { storage, database, vaultRoot, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    const teamKey = createCatalog().scopeOfHost("team-host").knownHosts.trust({ ...KEY, hostId: "team-host", hostLabel: "shared" });
    expect(storage.getState().teams[TEAM_ID].data.knownHosts.map((record) => record.id)).toEqual([teamKey.id]);

    setRole("viewer");
    const knownHosts = createCatalog().scopeOfHost("team-host").knownHosts;
    const mine = knownHosts.trust({ ...KEY, publicKeyBase64: "AAAA-rotated", hostId: "team-host", hostLabel: "shared" });
    expect(knownHosts.getByHostPortAlgorithm(KEY.host, KEY.port, KEY.algorithm)?.publicKeyBase64).toBe("AAAA-rotated");
    expect(knownHosts.listByHostPort(KEY.host, KEY.port)).toEqual([mine]);
    // 팀 기록은 그대로이고, 읽기 전용은 지우지 못한다.
    expect(() => knownHosts.remove(teamKey.id)).toThrow();
    expect(storage.getState().teams[TEAM_ID].data.knownHosts.map((record) => record.publicKeyBase64)).toEqual([KEY.publicKeyBase64]);
  });

  it("pins a viewer's RDP certificate in my own place; a member's pin goes to the team and clears mine", async () => {
    const { storage, database, vaultRoot, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("rdp-host", rdpDraft("desk") as never);
    setRole("viewer");

    const pinned = createCatalog().setHostRdpCertificateFingerprint("rdp-host", "AA:BB");
    expect(pinned).toMatchObject({ id: "rdp-host", certificateFingerprint: "AA:BB" });
    expect(createCatalog().getHost("rdp-host")).toMatchObject({ certificateFingerprint: "AA:BB" });
    const team = storage.getState().teams[TEAM_ID];
    expect(team.data.hosts[0]).not.toHaveProperty("certificateFingerprint", "AA:BB");
    expect(team.private.hostPrefs.find((prefs) => prefs.id === "rdp-host")?.rdpCertificateFingerprint).toBe("AA:BB");

    setRole("member");
    createCatalog().setHostRdpCertificateFingerprint("rdp-host", "CC:DD");
    const after = storage.getState().teams[TEAM_ID];
    expect(after.data.hosts[0]).toMatchObject({ certificateFingerprint: "CC:DD" });
    expect(after.private.hostPrefs.find((prefs) => prefs.id === "rdp-host")?.rdpCertificateFingerprint).toBeNull();
    expect(createCatalog().getHost("rdp-host")).toMatchObject({ certificateFingerprint: "CC:DD" });
  });

  it("does not write a detected OS for a viewer", async () => {
    const { storage, database, vaultRoot, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    new database.HostRepository(vaultRoot.teamVaultRoot(TEAM_ID)).create("team-host", sshDraft("shared"));
    setRole("viewer");
    const before = storage.teamVaultFingerprint(TEAM_ID);

    const host = createCatalog().setHostDetectedOs("team-host", { family: "linux", distro: "ubuntu" } as never);

    expect(host).toMatchObject({ id: "team-host" });
    expect(storage.teamVaultFingerprint(TEAM_ID)).toBe(before);
    expect(createCatalog().canEditVault(TEAM_ID)).toBe(false);
    expect(createCatalog().canEditVault("personal")).toBe(true);
  });
});

describe("keys that stay on this device", () => {
  const TAILNET = { id: "tailnet-team", label: "Team tailnet", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" };

  it("lets a viewer put their own tailnet auth key without touching the team record", async () => {
    const { storage, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    createCatalog().getScope(TEAM_ID)!.tailnets.save(TAILNET);
    const recorded = storage.getState().teams[TEAM_ID].data.tailnets[0];
    setRole("viewer");
    const tailnets = createCatalog().getScope(TEAM_ID)!.tailnets;

    tailnets.save({ ...recorded, loginName: "me@example.com" }, "tskey-mine");

    expect(tailnets.readAuthKey(TAILNET.id)).toBe("tskey-mine");
    expect(tailnets.list()[0]).toMatchObject({ hasAuthKey: true, loginName: "me@example.com" });
    expect(storage.getState().teams[TEAM_ID].data.tailnets[0]).toEqual(recorded);
    // 설정을 바꾸는 것은 팀 레코드를 쓰는 일이라 막힌다.
    expect(() => tailnets.save({ ...recorded, label: "Renamed" })).toThrow();
  });

  it("keeps a team AWS profile's settings when only the keys change, for a viewer and a member alike", async () => {
    const { storage, addTeam, setRole, createCatalog } = await load();
    addTeam("member");
    const profile: ManagedAwsProfilePayload = {
      id: "aws-team",
      name: "team-prod",
      kind: "static",
      region: "ap-northeast-2",
      accessKeyId: "",
      secretAccessKey: "",
      updatedAt: "2026-10-19T00:00:00.000Z",
    } as ManagedAwsProfilePayload;
    createCatalog().getScope(TEAM_ID)!.awsProfiles.upsert(profile);
    const recorded = storage.getState().teams[TEAM_ID].data.awsProfiles[0];

    // 멤버가 키만 넣어도 팀 레코드(시각)는 그대로다 — 팀에 새 판이 생기지 않는다.
    createCatalog().getScope(TEAM_ID)!.awsProfiles.upsert({
      ...profile,
      accessKeyId: "AKIA-MEMBER",
      secretAccessKey: "s1",
      updatedAt: "2026-10-20T00:00:00.000Z",
    } as ManagedAwsProfilePayload);
    expect(storage.getState().teams[TEAM_ID].data.awsProfiles[0]).toEqual(recorded);

    setRole("viewer");
    const awsProfiles = createCatalog().getScope(TEAM_ID)!.awsProfiles;
    awsProfiles.upsert({ ...profile, accessKeyId: "AKIA-VIEWER", secretAccessKey: "s2" } as ManagedAwsProfilePayload);
    expect(awsProfiles.getPayloadById("aws-team")).toMatchObject({ accessKeyId: "AKIA-VIEWER", region: "ap-northeast-2" });
    expect(storage.getState().teams[TEAM_ID].data.awsProfiles[0]).toEqual(recorded);
    expect(() => awsProfiles.upsert({ ...profile, region: "us-east-1" } as ManagedAwsProfilePayload)).toThrow();
  });
});
