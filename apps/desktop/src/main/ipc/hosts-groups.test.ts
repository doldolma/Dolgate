import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { registerHostsGroupsIpcHandlers } from "./hosts-groups";

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
  return {
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
  } as any;
}

describe("registerHostsGroupsIpcHandlers", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
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
});
