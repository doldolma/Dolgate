import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSyncedTeam as createSyncedTeamIn,
  open,
  PERSONAL_KEY,
  sshDraft,
  TEAM_ID,
  T0,
} from "./team-sync.test-support";

// 볼트 사이 복사를 실제 상태 파일과 가짜 팀 서버 위에서 본다 — 쓰기, 팀 동기화가 올리기, 실패하면 남지 않기.

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

const createSyncedTeam = () => createSyncedTeamIn(tempDir);

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "dolgate-vault-copy-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

/** 개인 볼트에 점프 호스트(bastion)를 거치는 web 을 둔다. 둘이 비밀값 하나를 함께 쓴다. */
async function addPersonalHosts(harness: Awaited<ReturnType<typeof createSyncedTeam>>) {
  await harness.secretStore.save(
    "secret:mine",
    JSON.stringify({ secretRef: "secret:mine", label: "mine", password: "hunter2", updatedAt: T0 }),
  );
  const hosts = new harness.database.HostRepository();
  hosts.create("bastion", sshDraft("bastion"), "secret:mine");
  hosts.create("web", { ...sshDraft("web"), jumpHostIds: ["bastion"] }, "secret:mine");
  hosts.setFavorite("web", true);
}

async function createService(onCopied = vi.fn()) {
  const { VaultCopyService } = await import("./vault-copy-service");
  return { service: (vaults: unknown) => new VaultCopyService({ vaults: vaults as never, onCopied }), onCopied };
}

describe("VaultCopyService", () => {
  it("copies a personal host and its jump host into a team, sealed so any member can open the secret", async () => {
    const harness = await createSyncedTeam();
    await addPersonalHosts(harness);
    const personalBefore = harness.storage.readVaultContents("personal");
    const { service, onCopied } = await createService();

    const result = service(harness.catalog()).copy({
      sourceVaultId: "personal",
      targetVaultId: TEAM_ID,
      selection: { kind: "hosts", hostIds: ["web"] },
      targetGroupPath: null,
    });

    // 개인 원본은 그대로다.
    expect(harness.storage.readVaultContents("personal")).toEqual(personalBefore);
    const team = harness.storage.getState().teams[TEAM_ID];
    const webCopy = team.data.hosts.find((host) => host.id === result.hostIds.web) as unknown as Record<string, unknown>;
    expect(team.data.hosts.map((host) => host.id).sort()).toEqual(
      ["team-a", "team-b", result.hostIds.web, result.hostIds.bastion].sort(),
    );
    expect(webCopy).toMatchObject({ jumpHostIds: [result.hostIds.bastion], favorite: null });
    const secretRef = webCopy.secretRef as string;
    expect(secretRef).not.toBe("secret:mine");
    expect(Object.keys(team.secure.managedSecretsByRef)).toEqual([secretRef]);
    expect(Object.keys(harness.storage.getState().secure.managedSecretsByRef)).toEqual(["secret:mine"]);
    await expect(harness.catalog().loadSecret(secretRef)).resolves.toContain("hunter2");

    // 즐겨찾기는 복사한 사람의 개인 칸으로 간다.
    expect(team.private.hostPrefs).toEqual([
      expect.objectContaining({ id: result.hostIds.web, favorite: true }),
    ]);
    expect(team.sync.privatePendingPush).toBe(true);
    expect(onCopied).toHaveBeenCalledWith(
      expect.objectContaining({ counts: expect.objectContaining({ hosts: 2, dependencyHosts: 1, secrets: 1 }) }),
    );

    // 팀 동기화가 팀 키로 잠가 올린다 — 팀 키를 가진 멤버 누구나 연다.
    await harness.service.pushDirty();
    const [push] = harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`);
    expect(push.body.hosts.map((record) => record.id).sort()).toEqual([result.hostIds.bastion, result.hostIds.web].sort());
    const [sealedSecret] = push.body.secrets;
    expect(sealedSecret.id).toBe(secretRef);
    expect(open(sealedSecret.encrypted_payload, harness.teamKey)).toMatchObject({ password: "hunter2" });
  });

  it("shares a host without its password: the team gets none, and it goes up only in my own slot", async () => {
    const harness = await createSyncedTeam();
    await addPersonalHosts(harness);
    const { service, onCopied } = await createService();

    const result = service(harness.catalog()).copy({
      sourceVaultId: "personal",
      targetVaultId: TEAM_ID,
      selection: { kind: "hosts", hostIds: ["web"] },
      shareSecrets: false,
    });

    // 팀 쪽에는 비밀값이 없고, 나는 내 자격 증명으로 그대로 붙는다.
    const team = harness.storage.getState().teams[TEAM_ID];
    for (const id of [result.hostIds.web, result.hostIds.bastion]) {
      expect(team.data.hosts.find((host) => host.id === id)).toMatchObject({ secretRef: null });
      expect(harness.catalog().getMyHostCredentials(id)).toEqual({ password: "hunter2" });
    }
    expect(team.secure.managedSecretsByRef).toEqual({});
    expect(JSON.stringify([team.data, team.secure])).not.toContain("hunter2");
    expect(onCopied).toHaveBeenCalledWith(expect.objectContaining({ counts: expect.objectContaining({ secrets: 0 }) }));

    // 팀에는 호스트만 올라가고, 비밀번호는 내 개인 칸에 내 개인 키로 잠겨 올라간다.
    await harness.service.pushDirty();
    const [push] = harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`);
    expect(push.body.hosts.map((record) => record.id).sort()).toEqual([result.hostIds.bastion, result.hostIds.web].sort());
    expect(push.body.secrets ?? []).toEqual([]);
    const [mine] = harness.server.requestsTo("PUT", `/teams/${TEAM_ID}/me`);
    expect(
      mine.body.hostCredentials.map((record) => open(record.encrypted_payload, PERSONAL_KEY)).sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      ),
    ).toEqual(
      [result.hostIds.bastion, result.hostIds.web]
        .sort()
        .map((id) => expect.objectContaining({ id, credentials: { password: "hunter2" } })),
    );
    expect(() => open(mine.body.hostCredentials[0].encrypted_payload, harness.teamKey)).toThrow();
  });

  // 4-6: 워크스페이스를 팀으로 — 창의 호스트까지 팀 볼트에 들어가고, 팀 동기화가 워크스페이스도 올린다.
  it("copies a personal workspace into a team with its panes' hosts and uploads both", async () => {
    const harness = await createSyncedTeam();
    await addPersonalHosts(harness);
    const workspace = new harness.database.SavedWorkspaceRepository().create({
      name: "Web",
      // 저장된 워크스페이스는 창이 둘 이상이다.
      root: {
        id: "split",
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { id: "leaf-web", kind: "leaf", target: { kind: "host", hostId: "web", label: "web" } },
        second: { id: "leaf-local", kind: "leaf", target: { kind: "local", label: "Local" } },
      },
      favorite: true,
    });
    const { service } = await createService();

    const result = service(harness.catalog()).copy({
      sourceVaultId: "personal",
      targetVaultId: TEAM_ID,
      selection: { kind: "workspaces", workspaceIds: [workspace.id] },
    });

    const team = harness.storage.getState().teams[TEAM_ID];
    const copy = team.data.savedWorkspaces.find((record) => record.id === result.workspaceIds[workspace.id]);
    expect(copy).toMatchObject({ name: "Web", favorite: false, root: { first: { target: { hostId: result.hostIds.web } } } });
    expect(result.counts).toMatchObject({ workspaces: 1, hosts: 2 });
    // 개인 원본은 그대로다.
    expect(harness.storage.getState().data.savedWorkspaces.map((record) => record.id)).toEqual([workspace.id]);

    await harness.service.pushDirty();
    const [push] = harness.server.requestsTo("POST", `/teams/${TEAM_ID}/sync`);
    expect(push.body.workspaces.map((record) => record.id)).toEqual([copy?.id]);
  });

  it("previews what would come without writing anything", async () => {
    const harness = await createSyncedTeam();
    await addPersonalHosts(harness);
    const before = JSON.stringify(harness.storage.getState());
    const { service, onCopied } = await createService();

    const counts = service(harness.catalog()).preview({
      sourceVaultId: "personal",
      targetVaultId: TEAM_ID,
      selection: { kind: "hosts", hostIds: ["web"] },
    });

    expect(counts).toMatchObject({ hosts: 2, dependencyHosts: 1, secrets: 1 });
    expect(JSON.stringify(harness.storage.getState())).toBe(before);
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("copies a team host into my personal vault with my own favorite and credentials on it", async () => {
    const harness = await createSyncedTeam();
    harness.catalog().setHostFavorite("team-a", true);
    harness.catalog().setMyHostCredentials("team-a", { username: "alice", password: "alice-pw" });
    const teamBefore = harness.storage.readVaultContents(TEAM_ID);
    const { service } = await createService();

    const result = service(harness.catalog()).copy({
      sourceVaultId: TEAM_ID,
      targetVaultId: "personal",
      selection: { kind: "hosts", hostIds: ["team-a"] },
    });

    const [copy] = harness.storage.getState().data.hosts as unknown as Array<Record<string, unknown>>;
    expect(copy).toMatchObject({ id: result.hostIds["team-a"], favorite: true, username: "alice" });
    await expect(harness.secretStore.load(String(copy.secretRef))).resolves.toContain("alice-pw");
    expect(harness.storage.readVaultContents(TEAM_ID)).toEqual(teamBefore);
  });

  it("writes nothing when the copy cannot finish", async () => {
    const harness = await createSyncedTeam();
    await addPersonalHosts(harness);
    const before = JSON.stringify(harness.storage.getState());
    const { service, onCopied } = await createService();
    const copies = service(harness.catalog());

    // 이 기기에 없는 팀.
    expect(() =>
      copies.copy({ sourceVaultId: "personal", targetVaultId: "team-gone", selection: { kind: "hosts", hostIds: ["web"] } }),
    ).toThrow("이 기기에 없는 팀입니다.");
    // 비밀값을 잠그다 실패(키체인이 잠김 등).
    const { safeStorage } = await import("electron");
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => {
      throw new Error("keychain locked");
    });
    expect(() =>
      copies.copy({ sourceVaultId: "personal", targetVaultId: TEAM_ID, selection: { kind: "hosts", hostIds: ["web"] } }),
    ).toThrow("keychain locked");

    expect(JSON.stringify(harness.storage.getState())).toBe(before);
    expect(onCopied).not.toHaveBeenCalled();
  });
});
