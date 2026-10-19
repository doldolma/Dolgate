import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTeamDek,
  createTeamInviteSecret,
  deriveTeamInviteJoinToken,
  formatTeamInviteLink,
  hashTeamInviteJoinToken,
  sealTeamInviteBox,
  unwrapTeamDek,
  wrapTeamDek,
} from "@shared";
import {
  createSyncedTeam as createSyncedTeamIn,
  createTeamHarness,
  host,
  open,
  OTHER_TEAM_ID,
  seal,
  PERSONAL_KEY,
  SERVER,
  sshDraft,
  T0,
  TEAM_ID,
} from "./team-sync.test-support";
import type { HostRecord } from "@shared";

// 팀 동기화를 가짜 서버(fetch 대체, team-sync.test-support.ts)로 시험한다.

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

const createHarness = () => createTeamHarness(tempDir);
const createSyncedTeam = (hosts?: HostRecord[]) => createSyncedTeamIn(tempDir, hosts);

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-sync-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("TeamSyncService", () => {
  it("pulls a team with its own key, leaving out per-member values and ids another vault already has", async () => {
    const harness = await createHarness();
    const teamDek = createTeamDek();
    const teamKey = Buffer.from(teamDek).toString("base64");
    harness.server.addTeam(TEAM_ID, "Acme", wrapTeamDek(teamDek, Buffer.from(PERSONAL_KEY, "base64"), TEAM_ID));
    harness.server.putRecord(
      TEAM_ID,
      "hosts",
      "team-host",
      host("team-host", { favorite: true, terminalThemeId: "night-owl", agentForwarding: true }),
      teamKey,
    );
    harness.server.putRecord(TEAM_ID, "hosts", "taken", host("taken", { label: "from team" }), teamKey);
    harness.server.putRecord(
      TEAM_ID,
      "secrets",
      "secret:team",
      { secretRef: "secret:team", label: "db", password: "pw", updatedAt: T0 },
      teamKey,
    );
    new harness.database.HostRepository().create("taken", sshDraft("mine"));

    await harness.service.refreshTeams();
    await harness.tickLoops();

    const state = harness.storage.getState();
    const team = state.teams[TEAM_ID];
    expect(team.info).toMatchObject({ name: "Acme", role: "owner" });
    expect(team.data.hosts).toEqual([
      expect.objectContaining({ id: "team-host", favorite: null, terminalThemeId: null, agentForwarding: null }),
    ]);
    expect(Object.keys(team.secure.managedSecretsByRef)).toEqual(["secret:team"]);
    expect(team.data.secretMetadata).toEqual([expect.objectContaining({ secretRef: "secret:team", hasPassword: true })]);
    // 개인 볼트는 그대로다.
    expect(state.data.hosts).toEqual([expect.objectContaining({ id: "taken", label: "mine" })]);
    expect(harness.onChanged).toHaveBeenCalled();
    expect(harness.server.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(harness.service.listStatuses()).toEqual({ [TEAM_ID]: { state: "ready", errorMessage: null } });
  });

  it("pushes only what changed, with the team key and data floor, and sends the team's deletions", async () => {
    const harness = await createSyncedTeam();
    const root = harness.vaultRoot.teamVaultRoot(TEAM_ID);
    // 팀 레코드에 사람마다 다른 값이 잘못 남아 있어도 올리지 않는다.
    new harness.database.HostRepository(root).update("team-a", {
      ...sshDraft("renamed"),
      agentForwarding: true,
      terminalThemeId: "night-owl",
    });
    new harness.database.HostRepository(root).remove("team-b");
    new harness.database.SyncOutboxRepository(root).upsertDeletion("hosts", "team-b");

    await harness.service.pushDirty();

    const [push] = harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`);
    expect(push.headers.get("X-Dolgate-Sync-Data-Floor")).toBe("1");
    expect(Object.keys(push.body)).toEqual(["hosts"]);
    expect(push.body.hosts.map((record) => record.id).sort()).toEqual(["team-a", "team-b"]);
    const renamed = push.body.hosts.find((record) => record.id === "team-a")!;
    expect(open(renamed.encrypted_payload, harness.teamKey)).toMatchObject({
      label: "renamed",
      favorite: null,
      terminalThemeId: null,
      agentForwarding: null,
    });
    expect(push.body.hosts.find((record) => record.id === "team-b")).toMatchObject({
      encrypted_payload: "",
      deleted_at: expect.any(String),
    });
    const team = harness.storage.getState().teams[TEAM_ID];
    expect(team.data.syncOutbox).toEqual([]);
    expect(team.data.hosts.map((record) => record.label)).toEqual(["renamed"]);

    // 바뀐 것이 없으면 아무것도 올리지 않는다(조건부 GET 만).
    harness.server.requests.length = 0;
    await harness.service.pushDirty();
    expect(harness.server.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("sends nothing when a connection only confirms a team host key", async () => {
    const harness = await createSyncedTeam();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const trusted = new harness.database.KnownHostRepository(harness.vaultRoot.teamVaultRoot(TEAM_ID)).trust({
      hostId: "team-a",
      hostLabel: "team-a",
      host: "team-a.example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIA",
      fingerprintSha256: "SHA256:team-a",
    });
    await harness.service.pushDirty();
    expect(harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`)).toHaveLength(1);

    // 한 시간 뒤 접속 경로가 신뢰된 키를 확인하고 시각을 남기려 한다.
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    harness.server.requests.length = 0;
    harness.catalog().scopeOfHost("team-a").knownHosts.touch(trusted.host, trusted.port);
    await harness.service.pushDirty();

    expect(harness.server.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(harness.storage.getState().teams[TEAM_ID].data.knownHosts[0]?.lastSeenAt).toBe(trusted.lastSeenAt);
  });

  it("keeps my member values in my own place, sealed with my personal key", async () => {
    const harness = await createSyncedTeam();
    const catalog = harness.catalog();

    catalog.setHostFavorite("team-a", true);
    await harness.service.pushDirty();

    const [put] = harness.server.requestsTo("PUT", `/teams/${TEAM_ID}/me`);
    expect(put.headers.get("X-Dolgate-Vault-Epoch")).toBe("3");
    const sealed = put.body.hostPrefs[0].encrypted_payload;
    expect(open(sealed, PERSONAL_KEY)).toMatchObject({ id: "team-a", favorite: true });
    expect(() => open(sealed, harness.teamKey)).toThrow();
    // 팀 레코드는 바뀌지 않았다 — 팀원에게 내 즐겨찾기가 가지 않는다.
    expect(harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`)).toEqual([]);
    expect(harness.storage.getState().teams[TEAM_ID].sync.privatePendingPush).toBe(false);

    // 내 다른 기기가 고친 것은 감시로 받는다.
    harness.server.putPrivate(
      TEAM_ID,
      "hostPrefs",
      "team-b",
      { id: "team-b", favorite: true, agentForwarding: true, updatedAt: "2026-10-19T05:00:00.000Z" },
      "2026-10-19T05:00:00.000Z",
    );
    await harness.tickLoops();
    expect(catalog.getHost("team-b")).toMatchObject({ favorite: true, agentForwarding: true });
    expect(catalog.getHost("team-a")).toMatchObject({ favorite: true });
  });

  it("forgets a team the server no longer lists, along with its pending join link", async () => {
    const harness = await createSyncedTeam();
    await harness.secretStore.save(harness.pendingTeamJoinAccount(TEAM_ID), "leftover");
    harness.server.teams.get(TEAM_ID)!.members.delete("user-1");

    await harness.service.refreshTeams();

    expect(harness.storage.getState().teams).toEqual({});
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(TEAM_ID))).resolves.toBeNull();
    expect(harness.activeLoops()).toBe(0);
    expect(harness.onChanged).toHaveBeenCalled();
  });

  it("wipes every team's local copy and pending links on sign-out", async () => {
    const harness = await createSyncedTeam();
    await harness.secretStore.save(harness.pendingTeamJoinAccount(TEAM_ID), "pending");
    harness.catalog().setHostFavorite("team-a", true);

    await harness.service.purgeAll();

    expect(harness.storage.getState().teams).toEqual({});
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(TEAM_ID))).resolves.toBeNull();
    expect(harness.activeLoops()).toBe(0);
    expect(harness.onChanged).toHaveBeenCalled();
    // 서버의 원본은 그대로다 — 다시 로그인하면 받는다.
    expect(harness.server.teams.get(TEAM_ID)!.records.get("hosts")!.size).toBe(2);
  });

  it("forgets a team when its watch answers 404", async () => {
    const harness = await createSyncedTeam();
    harness.server.teams.delete(TEAM_ID);

    await harness.tickLoops();

    expect(harness.storage.getState().teams).toEqual({});
    expect(harness.activeLoops()).toBe(0);
    expect(harness.service.listStatuses()).toEqual({});
  });

  it("finishes joining on the next start when the key upload did not happen", async () => {
    const harness = await createHarness();
    const teamDek = createTeamDek();
    const secret = createTeamInviteSecret();
    const team = harness.server.addTeam(TEAM_ID, "Acme", null);
    team.members.set("owner-1", harness.server.newMember("owner", "owner-wrapped"));
    harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a"), Buffer.from(teamDek).toString("base64"));
    harness.server.invites.set("invite-code-1", {
      code: "invite-code-1",
      teamId: TEAM_ID,
      box: sealTeamInviteBox({ secret, teamId: TEAM_ID, teamDek, expiresAt: "2099-01-01T00:00:00.000Z" }),
      tokenHash: hashTeamInviteJoinToken(deriveTeamInviteJoinToken(secret)),
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdBy: "owner-1",
      revokedAt: null,
      useCount: 0,
    });
    const link = formatTeamInviteLink(SERVER, "invite-code-1", secret);
    // 참여는 됐는데 사본을 올리다 실패했다(그 사이 앱이 꺼진 것과 같다).
    harness.server.failNextKeyUpload = true;
    await expect(harness.service.joinWithLink(link)).rejects.toThrow();
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(TEAM_ID))).resolves.toBe(link);
    expect(harness.server.teams.get(TEAM_ID)!.members.get("user-1")!.wrapped).toBe("");

    // 다음 팀 목록 읽기(앱을 다시 켰을 때)가 기억해 둔 링크로 마저 들어간다.
    await harness.service.refreshTeams();

    const member = harness.server.teams.get(TEAM_ID)!.members.get("user-1")!;
    expect(unwrapTeamDek(member.wrapped, Buffer.from(PERSONAL_KEY, "base64"), TEAM_ID)).toEqual(teamDek);
    const keyUploads = harness.server.requestsTo("PUT", `/teams/${TEAM_ID}/key`);
    expect(keyUploads.at(-1)?.headers.get("X-Dolgate-Vault-Epoch")).toBe("3");
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(TEAM_ID))).resolves.toBeNull();
    expect(harness.storage.getTeamState(TEAM_ID)?.info.wrappedTeamDek).toBe(member.wrapped);
    await harness.tickLoops();
    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.id)).toEqual(["team-a"]);
  });

  it("keeps teams open after the sync password changes, because the personal key itself stays", async () => {
    const harness = await createSyncedTeam();
    // 비밀번호를 바꾸면 KEK 와 세대가 바뀌고 DEK 는 그대로다. 메모리의 팀 키·감시는 새 세대로 다시 연다.
    harness.context.vaultEpoch = 4;
    harness.context.accessToken = "access-2";

    await harness.service.refreshTeams();
    await harness.tickLoops();
    harness.catalog().setHostFavorite("team-a", true);
    await harness.service.pushDirty();

    expect(harness.service.listStatuses()[TEAM_ID]).toEqual({ state: "ready", errorMessage: null });
    expect(harness.activeLoops()).toBe(1);
    expect(harness.server.requestsTo("PUT", `/teams/${TEAM_ID}/me`).at(-1)?.headers.get("X-Dolgate-Vault-Epoch")).toBe("4");
  });

  it("starts watching again after the vault is locked and unlocked", async () => {
    const harness = await createSyncedTeam();
    harness.vault.status = "locked";

    // 잠긴 동안 대기 루프는 스스로 내려놓는다.
    await harness.tickLoops();
    expect(harness.activeLoops()).toBe(0);
    await harness.service.refreshTeams();
    expect(harness.activeLoops()).toBe(0);

    // 다시 열면(첫 개인 pull 이 팀 목록을 다시 읽는다) 새 루프로 이어 받는다.
    harness.vault.status = "unlocked";
    harness.server.putRecord(TEAM_ID, "hosts", "team-c", host("team-c"), harness.teamKey);
    await harness.service.refreshTeams();
    expect(harness.activeLoops()).toBe(1);
    await harness.tickLoops();
    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.id).sort()).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
  });

  it("stops only the team whose key does not open with my personal key", async () => {
    const harness = await createHarness();
    const goodDek = createTeamDek();
    harness.server.addTeam(TEAM_ID, "Good", wrapTeamDek(goodDek, Buffer.from(PERSONAL_KEY, "base64"), TEAM_ID));
    // 초기화 전 개인 DEK 로 감싼 사본 같은 것.
    harness.server.addTeam(OTHER_TEAM_ID, "Stale", wrapTeamDek(createTeamDek(), Buffer.alloc(32, 9), OTHER_TEAM_ID));
    harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a"), Buffer.from(goodDek).toString("base64"));

    await harness.service.refreshTeams();
    await harness.tickLoops();

    expect(harness.service.listStatuses()).toEqual({
      [TEAM_ID]: { state: "ready", errorMessage: null },
      [OTHER_TEAM_ID]: { state: "needs-rejoin", errorMessage: expect.any(String) },
    });
    expect(harness.activeLoops()).toBe(1);
    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.id)).toEqual(["team-a"]);
    expect(harness.storage.getState().teams[OTHER_TEAM_ID].data.hosts).toEqual([]);
  });

  it("does not overwrite a local edit made while a pull was in flight", async () => {
    const harness = await createSyncedTeam([host("team-a")]);
    const hosts = new harness.database.HostRepository(harness.vaultRoot.teamVaultRoot(TEAM_ID));
    hosts.update("team-a", sshDraft("first"));
    // 첫 편집을 올리고 서버 사본을 받는 사이에 또 고친다.
    harness.server.beforeRecordsResponse = () => {
      hosts.update("team-a", sshDraft("second"));
    };

    await harness.service.pushDirty();
    await harness.service.pushDirty();

    const rows = harness.server.teams.get(TEAM_ID)!.records.get("hosts")!;
    expect(open(rows.get("team-a")!.encrypted_payload, harness.teamKey)).toMatchObject({ label: "second" });
    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.label)).toEqual(["second"]);
  });

  it("asks only for what the watch says changed and sends nothing when nothing did", async () => {
    const harness = await createSyncedTeam();

    await harness.tickLoops();
    expect(harness.server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /teams/${TEAM_ID}/sync/watch`,
    ]);

    harness.server.putRecord(TEAM_ID, "hosts", "team-c", host("team-c"), harness.teamKey);
    harness.server.requests.length = 0;
    await harness.tickLoops();
    expect(harness.server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /teams/${TEAM_ID}/sync/watch`,
      `GET /teams/${TEAM_ID}/sync`,
    ]);
    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.id).sort()).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
  });
});

// 위에서 빠졌던 기능 경로들. 받기·올리기의 바깥쪽 규칙(개인 pull 과 같은 규칙, 실패를 팀 하나에 가두기,
// 사람마다 다른 값 정리, 나중에 쓴 것이 이기기)을 하나씩 본다.
describe("TeamSyncService feature paths", () => {
  const LATER = "2026-10-19T01:00:00.000Z";
  const workspace = (id: string, groupName: string, updatedAt = T0) => ({
    version: 1,
    id,
    name: id,
    root: {
      id: "workspace-root",
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { id: "pane-host", kind: "leaf", target: { kind: "host", hostId: "team-a", label: "A" } },
      second: { id: "pane-local", kind: "leaf", target: { kind: "local", label: "Local shell" } },
    },
    favorite: false,
    groupName,
    lastOpenedAt: null,
    createdAt: T0,
    updatedAt,
  });

  async function addSecondTeam(harness: Awaited<ReturnType<typeof createSyncedTeam>>) {
    const otherDek = createTeamDek();
    harness.server.addTeam(OTHER_TEAM_ID, "Other", wrapTeamDek(otherDek, Buffer.from(PERSONAL_KEY, "base64"), OTHER_TEAM_ID));
    await harness.service.refreshTeams();
    await harness.tickLoops();
    return Buffer.from(otherDek).toString("base64");
  }

  it("moves a team workspace along when another member renames its group, and pushes that back", async () => {
    // 그룹·호스트·워크스페이스가 함께 올라가 있는 팀(실제 앱은 그룹 레코드를 호스트와 같이 올린다).
    const harness = await createHarness();
    const teamDek = createTeamDek();
    const teamKey = Buffer.from(teamDek).toString("base64");
    harness.server.addTeam(TEAM_ID, "Acme", wrapTeamDek(teamDek, Buffer.from(PERSONAL_KEY, "base64"), TEAM_ID));
    const group = { id: "group-ops", name: "ops", path: "ops", parentPath: null, createdAt: T0, updatedAt: T0 };
    harness.server.putRecord(TEAM_ID, "groups", group.id, group, teamKey);
    harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a", { groupName: "ops" }), teamKey);
    harness.server.putRecord(TEAM_ID, "workspaces", "ws-1", workspace("ws-1", "ops"), teamKey);
    await harness.service.refreshTeams();
    await harness.tickLoops();
    expect(harness.storage.getState().teams[TEAM_ID].data.groups.map((record) => record.id)).toEqual(["group-ops"]);

    // 다른 멤버가 그룹 이름을 바꿨다(그 그룹의 호스트도 옮겨 올렸다). 워크스페이스는 안 옮겼다.
    harness.server.putRecord(TEAM_ID, "groups", group.id, { ...group, name: "infra", path: "infra", updatedAt: LATER }, teamKey, LATER);
    harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a", { groupName: "infra", updatedAt: LATER }), teamKey, LATER);
    await harness.tickLoops();
    await harness.service.pushDirty();

    expect(harness.storage.getState().teams[TEAM_ID].data.savedWorkspaces[0]).toMatchObject({ id: "ws-1", groupName: "infra" });
    const row = harness.server.teams.get(TEAM_ID)!.records.get("workspaces")!.get("ws-1")!;
    expect(open(row.encrypted_payload, teamKey)).toMatchObject({ groupName: "infra" });
  });

  it("leaves host kinds this build does not know on the server, untouched", async () => {
    const harness = await createSyncedTeam([host("team-a")]);
    harness.server.putRecord(TEAM_ID, "hosts", "future", { id: "future", kind: "quantum", label: "q", createdAt: T0, updatedAt: T0 }, harness.teamKey);
    const before = { ...harness.server.teams.get(TEAM_ID)!.records.get("hosts")!.get("future")! };
    await harness.tickLoops();

    new harness.database.HostRepository(harness.vaultRoot.teamVaultRoot(TEAM_ID)).update("team-a", sshDraft("renamed"));
    await harness.service.pushDirty();

    expect(harness.storage.getState().teams[TEAM_ID].data.hosts.map((record) => record.id)).toEqual(["team-a"]);
    expect(harness.server.teams.get(TEAM_ID)!.records.get("hosts")!.get("future")).toEqual(before);
  });

  it("receives a team's tailnet auth key and AWS profile values into the team's own secure place", async () => {
    const harness = await createSyncedTeam([]);
    harness.server.putRecord(
      TEAM_ID,
      "tailnets",
      "tailnet-team",
      { id: "tailnet-team", label: "Team", authKey: "tskey-team", createdAt: T0, updatedAt: T0 },
      harness.teamKey,
    );
    harness.server.putRecord(
      TEAM_ID,
      "awsProfiles",
      "aws-team",
      { id: "aws-team", name: "team-prod", kind: "static", accessKeyId: "AKIA-TEAM", secretAccessKey: "team-secret", updatedAt: T0 },
      harness.teamKey,
    );

    await harness.tickLoops();

    const root = harness.vaultRoot.teamVaultRoot(TEAM_ID);
    expect(new harness.database.TailnetRepository(root).readAuthKey("tailnet-team")).toBe("tskey-team");
    expect(new harness.database.AwsProfileRepository(root).getPayloadById("aws-team")).toMatchObject({
      name: "team-prod",
      secretAccessKey: "team-secret",
    });
    const state = harness.storage.getState();
    // 키는 레코드에 남지 않고 팀의 비밀 칸에만 있다. 개인 쪽에는 아무것도 없다.
    expect(state.teams[TEAM_ID].data.tailnets).toEqual([expect.objectContaining({ id: "tailnet-team", hasAuthKey: true })]);
    expect(state.teams[TEAM_ID].data.tailnets[0]).not.toHaveProperty("authKey");
    expect(state.secure.tailnetAuthKeysById).toEqual({});
    expect(state.secure.managedAwsProfilesById).toEqual({});
  });

  it("follows a rename and a role change made by someone else, reading only the team info", async () => {
    const harness = await createSyncedTeam();
    const team = harness.server.teams.get(TEAM_ID)!;
    team.name = "Acme Ops";
    team.members.get("user-1")!.role = "member";
    team.infoRevision += 1;

    await harness.tickLoops();

    expect(harness.storage.getTeamState(TEAM_ID)?.info).toMatchObject({ name: "Acme Ops", role: "member" });
    expect(harness.onChanged).toHaveBeenCalled();
    // 팀 정보만 바뀌었으니 레코드와 개인 칸은 다시 받지 않는다.
    expect(harness.server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /teams/${TEAM_ID}/sync/watch`,
      "GET /teams",
    ]);
  });

  it("gives up a pending join whose link was revoked or whose box has expired", async () => {
    const harness = await createHarness();
    const join = (teamId: string, code: string, inviteExpiresAt: string, boxExpiresAt: string, revoked: boolean) => {
      const team = harness.server.addTeam(teamId, teamId, null);
      team.members.set("owner-1", harness.server.newMember("owner", "owner-wrapped"));
      team.members.set("user-1", harness.server.newMember("member"));
      const secret = createTeamInviteSecret();
      harness.server.invites.set(code, {
        code,
        teamId,
        box: sealTeamInviteBox({ secret, teamId, teamDek: createTeamDek(), expiresAt: boxExpiresAt }),
        tokenHash: hashTeamInviteJoinToken(deriveTeamInviteJoinToken(secret)),
        expiresAt: inviteExpiresAt,
        createdBy: "owner-1",
        revokedAt: revoked ? T0 : null,
        useCount: 0,
      });
      return harness.secretStore.save(harness.pendingTeamJoinAccount(teamId), formatTeamInviteLink(SERVER, code, secret));
    };
    // 소유자가 링크를 취소했다.
    await join(TEAM_ID, "revoked-code", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", true);
    // 서버는 아직 받아 주지만 상자 안의 기한이 지났다(앱이 거절해야 한다).
    await join(OTHER_TEAM_ID, "stale-box-code", "2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", false);

    await harness.service.refreshTeams();

    expect(harness.service.listStatuses()).toEqual({
      [TEAM_ID]: { state: "needs-rejoin", errorMessage: expect.any(String) },
      [OTHER_TEAM_ID]: { state: "needs-rejoin", errorMessage: expect.any(String) },
    });
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(TEAM_ID))).resolves.toBeNull();
    await expect(harness.secretStore.load(harness.pendingTeamJoinAccount(OTHER_TEAM_ID))).resolves.toBeNull();
    expect(harness.activeLoops()).toBe(0);
    expect(harness.server.requests.filter((request) => request.method === "PUT")).toEqual([]);
  });

  it("stops only the team whose data this build is too old for", async () => {
    const harness = await createSyncedTeam();
    await addSecondTeam(harness);
    harness.server.outdatedTeams.add(OTHER_TEAM_ID);
    harness.server.putRecord(OTHER_TEAM_ID, "hosts", "other-new", host("other-new"), Buffer.alloc(32).toString("base64"));

    await harness.tickLoops();

    expect(harness.service.listStatuses()).toEqual({
      [TEAM_ID]: { state: "ready", errorMessage: null },
      [OTHER_TEAM_ID]: { state: "outdated", errorMessage: expect.any(String) },
    });
    expect(harness.activeLoops()).toBe(1);
  });

  it("keeps the team records going when my private slot is refused for an old vault epoch", async () => {
    const harness = await createSyncedTeam();
    harness.server.rejectPrivateEpoch = true;
    harness.catalog().setHostFavorite("team-a", true);
    new harness.database.HostRepository(harness.vaultRoot.teamVaultRoot(TEAM_ID)).update("team-b", sshDraft("renamed"));

    await expect(harness.service.pushDirty()).resolves.toBeUndefined();

    expect(harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`)).toHaveLength(1);
    expect(harness.service.listStatuses()[TEAM_ID]).toEqual({ state: "error", errorMessage: expect.any(String) });
    // 내 값은 그대로 남아 있다 — 볼트를 다시 열면 올린다.
    expect(harness.storage.readTeamMemberPrefs(TEAM_ID)?.hostPrefs).toEqual([expect.objectContaining({ id: "team-a", favorite: true })]);
  });

  it("drops my values for a team host someone removed, and tells my other devices", async () => {
    const harness = await createSyncedTeam();
    harness.catalog().setHostFavorite("team-b", true);
    await harness.service.pushDirty();

    harness.server.deleteRecord(TEAM_ID, "hosts", "team-b", LATER);
    await harness.tickLoops();

    expect(harness.storage.readTeamMemberPrefs(TEAM_ID)?.hostPrefs).toEqual([]);
    const row = harness.server.teams.get(TEAM_ID)!.members.get("user-1")!.private.get("hostPrefs")!.get("team-b")!;
    expect(row).toMatchObject({ encrypted_payload: "", deleted_at: expect.any(String) });
  });

  it("settles two members' edits of the same host on whichever came later", async () => {
    const harness = await createSyncedTeam([host("team-a")]);
    const hosts = new harness.database.HostRepository(harness.vaultRoot.teamVaultRoot(TEAM_ID));
    const label = () => harness.storage.getState().teams[TEAM_ID].data.hosts[0].label;
    const serverLabel = () =>
      open(harness.server.teams.get(TEAM_ID)!.records.get("hosts")!.get("team-a")!.encrypted_payload, harness.teamKey).label;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 다른 멤버가 나보다 나중에 고쳤다 — 그쪽이 이긴다.
      vi.setSystemTime(new Date("2026-10-19T02:00:00.000Z"));
      hosts.update("team-a", sshDraft("mine"));
      harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a", { label: "theirs", updatedAt: "2026-10-19T03:00:00.000Z" }), harness.teamKey, "2026-10-19T03:00:00.000Z");
      await harness.service.pushDirty();
      expect([label(), serverLabel()]).toEqual(["theirs", "theirs"]);

      // 내가 나중에 고쳤다 — 내 것이 이긴다.
      vi.setSystemTime(new Date("2026-10-19T05:00:00.000Z"));
      hosts.update("team-a", sshDraft("mine-later"));
      harness.server.putRecord(TEAM_ID, "hosts", "team-a", host("team-a", { label: "theirs-earlier", updatedAt: "2026-10-19T04:00:00.000Z" }), harness.teamKey, "2026-10-19T04:00:00.000Z");
      await harness.service.pushDirty();
      expect([label(), serverLabel()]).toEqual(["mine-later", "mine-later"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

