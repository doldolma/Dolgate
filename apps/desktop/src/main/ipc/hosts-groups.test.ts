import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { registerHostsGroupsIpcHandlers } from "./hosts-groups";
import { withVaults } from "../vault-catalog.test-support";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

function getRegisteredHandler(channel: string) {
  const calls = vi.mocked(ipcMain.handle).mock.calls;
  const match = calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!match) {
    throw new Error(`Handler not registered for channel: ${channel}`);
  }
  return match[1] as (...args: unknown[]) => Promise<unknown>;
}

function createContext() {
  return withVaults({
    hosts: {
      list: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    groups: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      move: vi.fn(),
      rename: vi.fn(),
    },
    persistSecret: vi.fn(),
    resolveManagedPrivateKeyPem: vi.fn(),
    resolveManagedCertificateText: vi.fn(),
    describeHostLabel: vi.fn(() => "Test Host"),
    describeHostTarget: vi.fn(() => "test.example.com:22"),
    activityLogs: {
      append: vi.fn(),
    },
    syncOutbox: {
      upsertDeletion: vi.fn(),
    },
    queueSync: vi.fn(),
  }) as any;
}

describe("registerHostsGroupsIpcHandlers", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
  });

  // 팀 호스트의 비밀값은 그 팀 볼트에 둔다. 개인에 두면 팀원은 못 쓰고 내 개인 동기화로 올라간다.
  // 사용자 이름이 없을 때 묻는 창: 어디에 둘지는 카탈로그가 정한다(개인=레코드, 팀=내 자격 증명).
  it("sets a login username through the catalog and lets sync and the windows know", async () => {
    const ctx = createContext();
    ctx.vaults = { ...ctx.vaults, setHostLoginUsername: vi.fn(() => ({ id: "host-1", username: "bob" })) };
    ctx.emitWorkspaceChanged = vi.fn();
    registerHostsGroupsIpcHandlers(ctx);

    const result = await getRegisteredHandler(ipcChannels.hosts.setLoginUsername)({ sender: "window" }, "host-1", "bob");

    expect(ctx.vaults.setHostLoginUsername).toHaveBeenCalledWith("host-1", "bob");
    expect(result).toEqual({ id: "host-1", username: "bob" });
    expect(ctx.queueSync).toHaveBeenCalled();
    expect(ctx.emitWorkspaceChanged).toHaveBeenCalledWith("window");
    expect(ctx.hosts.update).not.toHaveBeenCalled();
  });

  it("creates a host in a team vault and keeps its password in that team", async () => {
    const ctx = createContext();
    const teamScope = {
      id: "team-1",
      secrets: {},
      secretMetadata: { getBySecretRef: vi.fn(() => null) },
    };
    ctx.vaults = {
      ...ctx.vaults,
      getScope: vi.fn((vaultId: string) => (vaultId === "team-1" ? teamScope : null)),
      createHost: vi.fn((vaultId: string, id: string, draft: object) => ({ id, ...draft, vaultId })),
    };
    ctx.persistSecret.mockResolvedValue("secret:team-pw");
    ctx.resolveManagedPrivateKeyPem.mockResolvedValue(undefined);
    ctx.resolveManagedCertificateText.mockResolvedValue(undefined);
    registerHostsGroupsIpcHandlers(ctx);
    const create = getRegisteredHandler(ipcChannels.hosts.create);
    const draft = { kind: "ssh", label: "Prod", hostname: "prod.example.com", port: 22, username: "ubuntu", authType: "password" };

    await create({}, draft, { password: "pw" }, "team-1");

    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", expect.objectContaining({ password: "pw" }), teamScope);
    expect(ctx.vaults.createHost).toHaveBeenCalledWith(
      "team-1",
      expect.any(String),
      expect.objectContaining({ label: "Prod", secretRef: "secret:team-pw" }),
      "secret:team-pw",
    );
    expect(ctx.hosts.create).not.toHaveBeenCalled();

    // 저장해 둔 내 자격 증명은 팀 호스트에 걸 수 없다.
    await expect(create({}, { ...draft, secretRef: "secret:mine" }, undefined, "team-1")).rejects.toThrow(
      /같은 볼트의 것만|must be in the same vault/,
    );
    await expect(create({}, draft, undefined, "missing-team")).rejects.toThrow(/Vault not found/);
  });

  // 호스트는 다른 볼트의 레코드를 가리킬 수 없다 — 팀원에게는 없는 것을 가리키거나, 팀에서 빠진 뒤 깨진다.
  it("refuses to save a host that points into another vault", async () => {
    const records = (ids: { host: string; tailnet: string; secret: string }) => ({
      hosts: { list: vi.fn(() => []), getById: vi.fn((id: string) => (id === ids.host ? { id } : null)) },
      tailnets: { list: vi.fn(() => [{ id: ids.tailnet }]) },
      awsProfiles: { getMetadataById: vi.fn(() => null) },
      snippets: { getById: vi.fn(() => null) },
      secretMetadata: { getBySecretRef: vi.fn((ref: string) => (ref === ids.secret ? { secretRef: ref } : null)) },
    });
    const personal = records({ host: "my-jump", tailnet: "my-tailnet", secret: "secret:mine" });
    const team = records({ host: "team-jump", tailnet: "team-tailnet", secret: "secret:team" });
    const base = createContext();
    delete base.vaults;
    const ctx = withVaults({ ...base, ...personal }, { "team-1": team }) as any;
    const created: unknown[] = [];
    const catalog = ctx.vaults;
    const myHost = { id: "my-host", kind: "ssh", label: "Mine", hostname: "h", port: 22, username: "u", authType: "password", tailnetId: "team-tailnet" };
    ctx.vaults = {
      ...catalog,
      createHost: vi.fn((vaultId: string, id: string, draft: object) => {
        created.push(vaultId);
        return { id, ...draft };
      }),
      // 고칠 호스트(my-host)만 따로 두고, 나머지는 진짜 카탈로그로 찾는다.
      getHost: vi.fn((id: string) => (id === "my-host" ? myHost : catalog.getHost(id))),
      scopeOfHost: vi.fn((id: string) => (id === "my-host" ? catalog.personal : catalog.scopeOfHost(id))),
      updateHost: vi.fn((id: string, draft: object) => ({ id, ...draft })),
    };
    ctx.persistSecret.mockResolvedValue(null);
    ctx.resolveManagedPrivateKeyPem.mockResolvedValue(undefined);
    ctx.resolveManagedCertificateText.mockResolvedValue(undefined);
    registerHostsGroupsIpcHandlers(ctx);
    const create = getRegisteredHandler(ipcChannels.hosts.create);
    const update = getRegisteredHandler(ipcChannels.hosts.update);
    const draft = { kind: "ssh", label: "Prod", hostname: "prod", port: 22, username: "ubuntu", authType: "password" };
    const refused = /같은 볼트의|must be in the same vault/;

    // 팀 호스트가 개인 점프 호스트·tailnet 을, 개인 호스트가 팀 자격 증명을 가리키면 저장하지 않는다.
    await expect(create({}, { ...draft, jumpHostIds: ["my-jump"] }, undefined, "team-1")).rejects.toThrow(refused);
    await expect(create({}, { ...draft, tailnetId: "my-tailnet" }, undefined, "team-1")).rejects.toThrow(refused);
    await expect(create({}, { ...draft, secretRef: "secret:team" })).rejects.toThrow(refused);
    expect(created).toEqual([]);

    // 같은 볼트 것·어디에도 없는 것은 된다.
    await create({}, { ...draft, jumpHostIds: ["team-jump"], tailnetId: "team-tailnet" }, undefined, "team-1");
    await create({}, { ...draft, tailnetId: "gone" });
    expect(created).toEqual(["team-1", "personal"]);

    // 고치기 전부터 가리키던 것은 그대로 두고(옛 레코드), 새로 바꾸면 막는다.
    await update({}, "my-host", { ...draft, tailnetId: "team-tailnet", label: "Renamed" });
    expect(ctx.vaults.updateHost).toHaveBeenCalledTimes(1);
    await expect(update({}, "my-host", { ...draft, tailnetId: "team-tailnet", jumpHostIds: ["team-jump"] })).rejects.toThrow(refused);
    expect(ctx.vaults.updateHost).toHaveBeenCalledTimes(1);
  });

  it("edits and removes a team host in its own vault", async () => {
    const ctx = createContext();
    const current = { id: "team-host", kind: "ssh", label: "Prod", hostname: "prod", port: 22, username: "ubuntu", authType: "password", secretRef: "secret:team" };
    const teamScope = { id: "team-1", secretMetadata: { getBySecretRef: vi.fn(() => null) } };
    ctx.vaults = {
      ...ctx.vaults,
      getHost: vi.fn(() => current),
      scopeOfHost: vi.fn(() => teamScope),
      updateHost: vi.fn((id: string, draft: object) => ({ id, ...draft })),
      removeHost: vi.fn(),
    };
    ctx.persistSecret.mockResolvedValue("secret:team-new");
    ctx.resolveManagedPrivateKeyPem.mockResolvedValue(undefined);
    ctx.resolveManagedCertificateText.mockResolvedValue(undefined);
    registerHostsGroupsIpcHandlers(ctx);
    const draft = { kind: "ssh", label: "Prod", hostname: "prod", port: 22, username: "ubuntu", authType: "password" };

    await getRegisteredHandler(ipcChannels.hosts.update)({}, "team-host", draft, { password: "new" });
    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", expect.objectContaining({ password: "new" }), teamScope);
    expect(ctx.vaults.updateHost).toHaveBeenCalledWith("team-host", expect.any(Object), "secret:team-new");

    // 저장해 둔 내 자격 증명으로는 바꿀 수 없다.
    await expect(
      getRegisteredHandler(ipcChannels.hosts.update)({}, "team-host", { ...draft, secretRef: "secret:mine" }),
    ).rejects.toThrow(/같은 볼트의 것만|must be in the same vault/);

    await getRegisteredHandler(ipcChannels.hosts.remove)({}, "team-host");
    expect(ctx.vaults.removeHost).toHaveBeenCalledWith("team-host");
    expect(ctx.hosts.remove).not.toHaveBeenCalled();
    expect(ctx.syncOutbox.upsertDeletion).not.toHaveBeenCalled();
  });

  it("keeps an explicitly selected saved secret when creating a host", async () => {
    const ctx = createContext();
    const draft = {
      kind: "ssh",
      label: "Prod",
      tags: [],
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "privateKey",
      privateKeyPath: "",
      certificatePath: "",
      secretRef: "secret:existing",
      groupName: "",
      terminalThemeId: null,
    } as const;
    const createdRecord = {
      id: "host-1",
      ...draft,
      privateKeyPath: null,
      certificatePath: null,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    };

    ctx.resolveManagedPrivateKeyPem.mockResolvedValue(undefined);
    ctx.resolveManagedCertificateText.mockResolvedValue(undefined);
    ctx.persistSecret.mockResolvedValue(null);
    ctx.hosts.create.mockReturnValue(createdRecord);

    registerHostsGroupsIpcHandlers(ctx);
    const createHandler = getRegisteredHandler(ipcChannels.hosts.create);

    const result = await createHandler({}, draft);

    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", {
      privateKeyPem: undefined,
      certificateText: undefined,
    });
    expect(ctx.hosts.create).toHaveBeenCalledWith(
      expect.any(String),
      {
        ...draft,
        privateKeyPath: null,
        certificatePath: null,
      },
      "secret:existing",
    );
    expect(result).toEqual(createdRecord);
  });

  it("stores the whole RDP credential — account, kind and password", async () => {
    // 여기서 필드를 하나라도 빠뜨리면 저장은 되는데 목록에 안 나온다(kind 가 없으면 RDP 목록
    // 필터에 안 걸린다). 실제로 그렇게 깨졌고, 이 테스트가 password 하나만 확인해서 통과했다.
    const ctx = createContext();
    const draft = {
      kind: "rdp",
      label: "Win Box",
      tags: [],
      hostname: "192.168.200.27",
      port: 3389,
      secretRef: null,
      groupName: "",
      terminalThemeId: null,
    } as const;

    ctx.persistSecret.mockResolvedValue("secret:rdp");
    ctx.hosts.create.mockReturnValue({ id: "rdp-1", ...draft });

    registerHostsGroupsIpcHandlers(ctx);
    const createHandler = getRegisteredHandler(ipcChannels.hosts.create);

    await createHandler({}, draft, {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "hunter2",
    });

    // 비밀번호는 시크릿 저장소로 가고, 호스트 레코드에는 ref 만 남는다. 계정도 같이 간다.
    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "hunter2",
    });
    expect(ctx.hosts.create).toHaveBeenCalledWith(
      expect.any(String),
      draft,
      "secret:rdp",
    );
  });

  // VNC 도 비밀번호를 자격증명으로 저장한다. 생성 경로가 RDP 만 보고 있어서 VNC 비밀번호는 조용히
  // 사라졌다 — 종류가 늘 때 이 자리를 같이 고쳐야 한다는 것을 두 번째로 보여 준 사례다.
  it("VNC 비밀번호도 자격증명으로 저장한다", async () => {
    const ctx = createContext();
    const draft = {
      kind: "vnc",
      label: "Lab VNC",
      tags: [],
      hostname: "192.168.0.10",
      port: 5900,
      secretRef: null,
      groupName: "",
      terminalThemeId: null,
    } as const;

    ctx.persistSecret.mockResolvedValue("secret:vnc");
    ctx.hosts.create.mockReturnValue({ id: "vnc-1", ...draft });

    registerHostsGroupsIpcHandlers(ctx);
    const createHandler = getRegisteredHandler(ipcChannels.hosts.create);

    await createHandler({}, draft, { kind: "vnc", password: "secret12" });

    // kind 가 'rdp' 로 굳어 있으면 VNC 자격증명이 RDP 목록에 섞인다.
    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", {
      kind: "vnc",
      username: undefined,
      domain: undefined,
      password: "secret12",
    });
    expect(ctx.hosts.create).toHaveBeenCalledWith(
      expect.any(String),
      draft,
      "secret:vnc",
    );
  });

  it("stores the whole RDP credential when the password is replaced", async () => {
    const ctx = createContext();
    const draft = {
      kind: "rdp",
      label: "Win Box",
      tags: [],
      hostname: "192.168.200.27",
      port: 3389,
      secretRef: "secret:old",
      groupName: "",
      terminalThemeId: null,
    } as const;

    ctx.persistSecret.mockResolvedValue("secret:new");
    ctx.hosts.getById.mockReturnValue({ id: "rdp-1", ...draft });
    ctx.hosts.update.mockReturnValue({ id: "rdp-1", ...draft });

    registerHostsGroupsIpcHandlers(ctx);
    const updateHandler = getRegisteredHandler(ipcChannels.hosts.update);

    await updateHandler({}, "rdp-1", draft, {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "next",
    });

    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", {
      kind: "rdp",
      username: "Administrator",
      domain: "CORP",
      password: "next",
    });
  });

  it("keeps the existing RDP secret when the password field was left blank", async () => {
    const ctx = createContext();
    const draft = {
      kind: "rdp",
      label: "Win Box",
      tags: [],
      hostname: "192.168.200.27",
      port: 3389,
      secretRef: "secret:rdp",
      groupName: "",
      terminalThemeId: null,
    } as const;

    ctx.hosts.getById.mockReturnValue({ id: "rdp-1", ...draft });
    ctx.hosts.update.mockReturnValue({ id: "rdp-1", ...draft });

    registerHostsGroupsIpcHandlers(ctx);
    const updateHandler = getRegisteredHandler(ipcChannels.hosts.update);

    await updateHandler({}, "rdp-1", draft, {});

    // 빈 비밀번호로 덮어써서 로그인을 깨뜨리면 안 된다.
    expect(ctx.persistSecret).not.toHaveBeenCalled();
    expect(ctx.hosts.update).toHaveBeenCalledWith(
      "rdp-1",
      draft,
      "secret:rdp",
    );
  });

  it("persists certificate secrets when certificate auth material is resolved", async () => {
    const ctx = createContext();
    const draft = {
      kind: "ssh",
      label: "Cert Host",
      tags: [],
      hostname: "cert.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      privateKeyPath: "/tmp/id_ed25519",
      certificatePath: "/tmp/id_ed25519-cert.pub",
      secretRef: null,
      groupName: "",
      terminalThemeId: null,
    } as const;
    const createdRecord = {
      id: "host-2",
      ...draft,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    };

    ctx.resolveManagedPrivateKeyPem.mockResolvedValue("PRIVATE KEY");
    ctx.resolveManagedCertificateText.mockResolvedValue("ssh-ed25519-cert-v01@openssh.com AAAA");
    ctx.persistSecret.mockResolvedValue("secret:generated");
    ctx.hosts.create.mockReturnValue(createdRecord);

    registerHostsGroupsIpcHandlers(ctx);
    const createHandler = getRegisteredHandler(ipcChannels.hosts.create);

    await createHandler({}, draft);

    expect(ctx.persistSecret).toHaveBeenCalledWith("Test Host", {
      privateKeyPem: "PRIVATE KEY",
      certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
    });
    expect(ctx.hosts.create).toHaveBeenCalledWith(
      expect.any(String),
      {
        ...draft,
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret:generated",
      },
      "secret:generated",
    );
  });

  it("clears persisted key paths when updating a host that uses an existing saved secret", async () => {
    const ctx = createContext();
    const currentHost = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      privateKeyPath: "/tmp/id_ed25519",
      certificatePath: "/tmp/id_ed25519-cert.pub",
      secretRef: "secret:existing",
      groupName: "",
      terminalThemeId: null,
      tags: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    } as const;
    const draft = {
      kind: "ssh",
      label: "Prod",
      tags: [],
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      privateKeyPath: "/tmp/id_ed25519",
      certificatePath: "/tmp/id_ed25519-cert.pub",
      secretRef: "secret:existing",
      groupName: "",
      terminalThemeId: null,
    } as const;
    ctx.hosts.getById.mockReturnValue(currentHost);
    ctx.resolveManagedPrivateKeyPem.mockResolvedValue(undefined);
    ctx.resolveManagedCertificateText.mockResolvedValue(undefined);
    ctx.hosts.update.mockReturnValue({
      ...currentHost,
      privateKeyPath: null,
      certificatePath: null,
    });

    registerHostsGroupsIpcHandlers(ctx);
    const updateHandler = getRegisteredHandler(ipcChannels.hosts.update);

    await updateHandler({}, "host-1", draft);

    expect(ctx.hosts.update).toHaveBeenCalledWith(
      "host-1",
      {
        ...draft,
        privateKeyPath: null,
        certificatePath: null,
      },
      "secret:existing",
    );
  });

  // 팀 그룹은 그 팀 볼트의 저장소와 삭제 대기열로 간다 — 개인 그룹·개인 대기열은 건드리지 않는다.
  it("writes a team's groups in that team, tombstones and all", async () => {
    const ctx = createContext();
    const mutation = { groups: [], hosts: [], savedWorkspaces: [] };
    const teamGroups = {
      create: vi.fn((id: string, name: string, parentPath?: string | null) => ({ id, name, path: name, parentPath: parentPath ?? null })),
      rename: vi.fn(() => ({ ...mutation, nextPath: "Prod2" })),
      move: vi.fn(() => ({ ...mutation, nextPath: "Ops/Prod2" })),
      setSortRanks: vi.fn(() => []),
      remove: vi.fn(() => ({
        ...mutation,
        removedGroupIds: ["group-t"],
        removedHostIds: ["host-t"],
        removedWorkspaceIds: ["workspace-t"],
      })),
    };
    const teamOutbox = { upsertDeletion: vi.fn() };
    ctx.vaults = {
      ...ctx.vaults,
      getScope: vi.fn((vaultId: string) => (vaultId === "team-1" ? { id: "team-1", groups: teamGroups, syncOutbox: teamOutbox } : null)),
    };
    registerHostsGroupsIpcHandlers(ctx);

    await getRegisteredHandler(ipcChannels.groups.create)({}, "Prod", null, "team-1");
    await getRegisteredHandler(ipcChannels.groups.rename)({}, "Prod", "Prod2", "team-1");
    await getRegisteredHandler(ipcChannels.groups.move)({}, "Prod2", "Ops", "team-1");
    await getRegisteredHandler(ipcChannels.groups.setOrder)({}, [{ id: "group-t", sortRank: 1 }], "team-1");
    await getRegisteredHandler(ipcChannels.groups.remove)({}, "Ops/Prod2", "delete-subtree", "team-1");

    expect(teamGroups.create).toHaveBeenCalledWith(expect.any(String), "Prod", null);
    expect(teamGroups.rename).toHaveBeenCalledWith("Prod", "Prod2");
    expect(teamGroups.move).toHaveBeenCalledWith("Prod2", "Ops");
    expect(teamGroups.setSortRanks).toHaveBeenCalledWith([{ id: "group-t", sortRank: 1 }]);
    expect(teamGroups.remove).toHaveBeenCalledWith("Ops/Prod2", "delete-subtree");
    expect(teamOutbox.upsertDeletion.mock.calls).toEqual([
      ["groups", "group-t"],
      ["hosts", "host-t"],
      ["workspaces", "workspace-t"],
    ]);
    expect(ctx.groups.create).not.toHaveBeenCalled();
    expect(ctx.groups.remove).not.toHaveBeenCalled();
    expect(ctx.syncOutbox.upsertDeletion).not.toHaveBeenCalled();
    expect(ctx.queueSync).toHaveBeenCalledTimes(5);

    // 이 기기에 없는 팀이면 아무것도 쓰지 않고 던진다.
    await expect(getRegisteredHandler(ipcChannels.groups.create)({}, "X", null, "missing-team")).rejects.toThrow(
      /이 기기에 없는 팀입니다|isn't on this device/,
    );
    // 볼트를 안 주면 지금처럼 개인이다.
    ctx.groups.create.mockReturnValue({ id: "group-p", name: "Home", path: "Home", parentPath: null });
    await getRegisteredHandler(ipcChannels.groups.create)({}, "Home", null);
    expect(ctx.groups.create).toHaveBeenCalledWith(expect.any(String), "Home", null);
  });

  it("writes Workspace tombstones when deleting a group subtree", async () => {
    const ctx = createContext();
    const savedWorkspaces = [{ id: "workspace-kept", groupName: null }];
    ctx.groups.remove.mockReturnValue({
      groups: [],
      hosts: [],
      savedWorkspaces,
      removedGroupIds: ["group-1"],
      removedHostIds: ["host-1"],
      removedWorkspaceIds: ["workspace-1"],
    });

    registerHostsGroupsIpcHandlers(ctx);
    const removeHandler = getRegisteredHandler(ipcChannels.groups.remove);
    const result = await removeHandler(
      { sender: "renderer" },
      "Servers",
      "delete-subtree",
    );

    expect(ctx.syncOutbox.upsertDeletion).toHaveBeenCalledWith(
      "workspaces",
      "workspace-1",
    );
    expect(result).toEqual({ groups: [], hosts: [], savedWorkspaces });
    expect(ctx.queueSync).toHaveBeenCalledOnce();
  });
});
