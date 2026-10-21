import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTeamInviteBox, parseTeamInviteLink, unwrapTeamDek } from "@shared";
import { createTeamHarness, PERSONAL_KEY, SERVER, sshDraft, T0 } from "./team-sync.test-support";

// 팀 관리(만들기·초대 링크·참여·멤버·나가기)를 가짜 서버로 시험한다. 같은 서버의 두 계정은 서버의
// userId 와 앱의 로그인 컨텍스트를 함께 바꿔 흉내 낸다(로그아웃 → 다른 계정으로 로그인).

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

const OTHER_PERSONAL_KEY = Buffer.alloc(32, 9).toString("base64");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-team-service-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

/** 다른 계정으로 로그인한 것처럼 바꾼다 — 서버의 사용자와 앱의 동기화 컨텍스트(개인 DEK 포함). */
function signInAs(
  harness: Awaited<ReturnType<typeof createTeamHarness>>,
  userId: string,
  personalKey: string,
): void {
  harness.server.userId = userId;
  harness.context.userId = userId;
  harness.context.vaultKeyBase64 = personalKey;
  harness.context.accessToken = `access-${userId}`;
}

describe("TeamService", () => {
  it("creates a team, shares a host through an invite link, and the second account receives it", async () => {
    const harness = await createTeamHarness(tempDir);

    const created = await harness.teams.create("  Acme  ");

    const [post] = harness.server.requestsTo("POST", "/teams");
    expect(post.body.id).toMatch(UUID_V4);
    expect(post.body.name).toBe("Acme");
    expect(post.headers.get("X-Dolgate-Vault-Epoch")).toBe("3");
    // 팀 키는 이 기기에서 만들고 내 개인 DEK 로 감싼 사본만 올린다.
    const teamDek = unwrapTeamDek(String(post.body.wrappedTeamDek), Buffer.from(PERSONAL_KEY, "base64"), created.id);
    expect(created).toEqual({ id: post.body.id, name: "Acme", role: "owner", syncState: "ready", syncError: null });
    expect(harness.teams.list()).toEqual([created]);
    expect(harness.onChanged).toHaveBeenCalled();

    // 팀에 비밀번호가 든 호스트를 둔다(호스트를 만드는 IPC 가 하는 일과 같다).
    const owner = harness.catalog();
    const scope = owner.getScope(created.id)!;
    await scope.secrets.save(
      "secret:team-pw",
      JSON.stringify({ secretRef: "secret:team-pw", label: "prod", password: "hunter2", updatedAt: T0 }),
    );
    scope.secretMetadata.upsert({ secretRef: "secret:team-pw", label: "prod", hasPassword: true, hasPassphrase: false });
    owner.createHost(created.id, "team-host", { ...sshDraft("prod"), agentForwarding: true }, "secret:team-pw");
    await harness.service.pushDirty();

    const { link, invite } = await harness.teams.createInvite(created.id);
    expect(link.startsWith(`${SERVER}/invite/${invite.code}#v1.`)).toBe(true);
    const days = (Date.parse(invite.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    // 상자는 링크의 비밀값으로만 열리고, 그 안에 팀 키가 있다.
    const stored = harness.server.invites.get(invite.code)!;
    const opened = openTeamInviteBox({ secret: parseTeamInviteLink(link).secret, teamId: created.id, box: stored.box });
    expect(opened.teamDek).toEqual(teamDek);

    // 로그아웃하고 같은 서버의 다른 계정으로 들어간다.
    await harness.service.purgeAll();
    signInAs(harness, "user-2", OTHER_PERSONAL_KEY);

    const info = await harness.teams.getInviteInfo(link);
    expect(info).toEqual({
      teamId: created.id,
      teamName: "Acme",
      inviterEmail: "user-1@example.com",
      memberCount: 1,
      expiresAt: invite.expiresAt,
      alreadyJoined: false,
    });
    const joined = await harness.teams.join(link);
    expect(joined).toMatchObject({ id: created.id, name: "Acme", role: "member", syncState: "ready" });
    await harness.tickLoops();

    const member = harness.catalog();
    // agent forwarding 은 만든 사람의 값이라 따라오지 않는다.
    expect(member.getHost("team-host")).toMatchObject({ label: "prod", agentForwarding: null });
    await expect(member.loadSecret("secret:team-pw")).resolves.toContain("hunter2");
    const wrappedForB = harness.server.teams.get(created.id)!.members.get("user-2")!.wrapped;
    expect(unwrapTeamDek(wrappedForB, Buffer.from(OTHER_PERSONAL_KEY, "base64"), created.id)).toEqual(teamDek);
    await expect(harness.teams.getInviteInfo(link)).resolves.toMatchObject({ alreadyJoined: true, memberCount: 2 });
  });

  it("keeps a created team on this device even when reading the team list fails right after", async () => {
    const harness = await createTeamHarness(tempDir);
    harness.server.failNextList = true;

    const created = await harness.teams.create("Acme");

    // 서버에는 만들어졌다. 다음 목록 읽기가 키를 풀고 동기화를 시작한다.
    expect(created).toMatchObject({ name: "Acme", role: "owner", syncState: "idle" });
    await harness.teams.refresh();
    expect(harness.teams.list()).toEqual([{ ...created, syncState: "ready" }]);
  });

  it("renames, hands over ownership, and leaves, keeping the local list in step", async () => {
    const harness = await createTeamHarness(tempDir);
    const created = await harness.teams.create("Acme");
    harness.server.teams.get(created.id)!.members.set("user-2", harness.server.newMember("member", "wrapped-2"));

    await harness.teams.rename(created.id, "Acme Ops");
    expect(harness.server.teams.get(created.id)!.name).toBe("Acme Ops");
    expect(harness.teams.list()[0]).toMatchObject({ name: "Acme Ops", role: "owner" });

    // 다른 멤버가 남은 소유자는 넘기기 전에 나갈 수 없다(서버가 거절한다).
    await expect(harness.teams.leave(created.id)).rejects.toThrow(/소유권/);
    expect(harness.teams.list()).toHaveLength(1);

    await harness.teams.transferOwnership(created.id, "user-2");
    expect(harness.server.teams.get(created.id)!.members.get("user-2")!.role).toBe("owner");
    expect(harness.teams.list()[0]).toMatchObject({ role: "member" });

    harness.onChanged.mockClear();
    await harness.teams.leave(created.id);
    expect(harness.server.teams.get(created.id)!.members.has("user-1")).toBe(false);
    expect(harness.teams.list()).toEqual([]);
    expect(harness.storage.listTeamIds()).toEqual([]);
    expect(harness.onChanged).toHaveBeenCalled();
  });

  it("lists and removes members and revokes links", async () => {
    const harness = await createTeamHarness(tempDir);
    const created = await harness.teams.create("Acme");
    harness.server.teams.get(created.id)!.members.set("user-2", harness.server.newMember("member", "wrapped-2"));
    const { invite } = await harness.teams.createInvite(created.id, { expiresInHours: 24 });

    expect((await harness.teams.listMembers(created.id)).map((member) => [member.userId, member.role])).toEqual([
      ["user-1", "owner"],
      ["user-2", "member"],
    ]);
    expect(await harness.teams.listInvites(created.id)).toEqual([
      expect.objectContaining({ code: invite.code, active: true, revokedAt: null }),
    ]);

    await harness.teams.revokeInvite(created.id, invite.code);
    expect(await harness.teams.listInvites(created.id)).toEqual([
      expect.objectContaining({ code: invite.code, active: false, revokedAt: expect.any(String) }),
    ]);

    await harness.teams.removeMember(created.id, "user-2");
    expect((await harness.teams.listMembers(created.id)).map((member) => member.userId)).toEqual(["user-1"]);
  });

  it("deletes a team and it leaves this device at once", async () => {
    const harness = await createTeamHarness(tempDir);
    const created = await harness.teams.create("Acme");

    await harness.teams.remove(created.id);

    expect(harness.server.teams.has(created.id)).toBe(false);
    expect(harness.teams.list()).toEqual([]);
    expect(harness.activeLoops()).toBe(0);
  });

  it("previews a link for the join card and says why one cannot be opened", async () => {
    const harness = await createTeamHarness(tempDir);
    const created = await harness.teams.create("Acme");
    const { link, invite } = await harness.teams.createInvite(created.id, { expiresInHours: 1 });
    const hours = (Date.parse(invite.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.98);
    expect(hours).toBeLessThanOrEqual(1);
    const revoked = await harness.teams.createInvite(created.id);
    await harness.teams.revokeInvite(created.id, revoked.invite.code);

    await harness.service.purgeAll();
    signInAs(harness, "user-2", OTHER_PERSONAL_KEY);
    await expect(harness.teams.previewInvite(link)).resolves.toEqual({
      status: "ok",
      teamId: created.id,
      teamName: "Acme",
      inviterEmail: "user-1@example.com",
      memberCount: 1,
      expiresAt: invite.expiresAt,
      alreadyJoined: false,
    });
    // 미리 보기는 팀 키 상자를 받지 않는다 — 참여할 때만 받는다.
    expect(harness.server.requestsTo("POST", `/invite/${invite.code}/join`)).toHaveLength(0);
    await harness.teams.join(link);
    await expect(harness.teams.previewInvite(link)).resolves.toMatchObject({ status: "ok", alreadyJoined: true });

    await expect(harness.teams.previewInvite(revoked.link)).resolves.toEqual({ status: "expired" });
    await expect(harness.teams.previewInvite(link.replace(SERVER, "https://other.example.com:8443"))).resolves.toEqual({
      status: "other-server",
      serverHost: "other.example.com:8443",
    });
    await expect(harness.teams.previewInvite(link.slice(0, link.indexOf("#")))).resolves.toEqual({ status: "invalid" });
    await expect(harness.teams.previewInvite(link.replace("#v1.", "#v2."))).resolves.toEqual({ status: "update-required" });
  });

  it("refuses what it cannot do: a locked vault, odd link lifetimes, another server's link", async () => {
    const harness = await createTeamHarness(tempDir);
    const created = await harness.teams.create("Acme");

    for (const expiresInHours of [30 * 24 + 1, 0, 1.5]) {
      await expect(harness.teams.createInvite(created.id, { expiresInHours })).rejects.toThrow("초대 링크 기한은 1시간~30일로 정할 수 있습니다.");
    }
    const { link } = await harness.teams.createInvite(created.id);
    const foreign = link.replace(SERVER, "https://other.example.com");
    await expect(harness.teams.getInviteInfo(foreign)).rejects.toThrow("다른 동기화 서버의 초대 링크입니다.");
    await expect(harness.teams.create("   ")).rejects.toThrow("팀 이름을 입력해 주세요.");

    harness.vault.status = "locked";
    await expect(harness.teams.create("Second")).rejects.toThrow("로그인하고 동기화 암호를 입력한 뒤에 팀을 쓸 수 있습니다.");
    expect(harness.server.requestsTo("POST", "/teams")).toHaveLength(1);
  });
});
