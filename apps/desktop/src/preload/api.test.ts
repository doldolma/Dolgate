import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
}));

vi.mock("electron", () => ({
  webUtils: {
    getPathForFile: electronMocks.getPathForFile,
  },
}));

describe("createDesktopApi", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMocks.getPathForFile.mockReset();
  });

  it("maps the teams bridge to its IPC channels and passes teams:changed on to listeners", async () => {
    const { createDesktopApi } = await import("./api");
    const { registerPreloadEventBindings } = await import("./events/register");
    const { ipcChannels } = await import("../common/ipc-channels");
    const listeners = new Map<string, () => void>();
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((channel: string, listener: () => void) => {
        listeners.set(channel, listener);
      }),
    } as any;
    registerPreloadEventBindings(ipcRenderer);
    const api = createDesktopApi(ipcRenderer);

    await api.teams.list();
    await api.teams.createInvite("t1", { expiresInHours: 72 });
    await api.teams.join("https://sync.example.com/invite/c#v1.x");
    await api.hosts.create({ kind: "ssh" } as never, undefined, "t1");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.teams.list);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.teams.createInvite, "t1", { expiresInHours: 72 });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.teams.join, "https://sync.example.com/invite/c#v1.x");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.hosts.create, { kind: "ssh" }, undefined, "t1");

    await api.teams.previewInvite("https://sync.example.com/invite/c#v1.x");
    await api.teams.takePendingInviteLink();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.teams.previewInvite, "https://sync.example.com/invite/c#v1.x");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(ipcChannels.teams.takePendingInviteLink);
    // 링크 페이지가 초대 링크를 넘기면 메인이 teams:invite-link 를 보낸다.
    const inviteListener = vi.fn();
    const offInvite = api.teams.onInviteLink(inviteListener);
    listeners.get(ipcChannels.teams.inviteLink)?.();
    offInvite();
    listeners.get(ipcChannels.teams.inviteLink)?.();
    expect(inviteListener).toHaveBeenCalledTimes(1);

    // 메인이 teams:changed 를 보내면 구독한 화면이 듣는다.
    const listener = vi.fn();
    const unsubscribe = api.teams.onChanged(listener);
    listeners.get(ipcChannels.teams.changed)?.();
    unsubscribe();
    listeners.get(ipcChannels.teams.changed)?.();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("asks for the vault index and team availability, and passes a picked vault to the settings lists", async () => {
    const { createDesktopApi } = await import("./api");
    const { ipcChannels } = await import("../common/ipc-channels");
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue([]), on: vi.fn() } as any;
    const api = createDesktopApi(ipcRenderer);

    await api.teams.getVaultIndex();
    await api.teams.getAvailability();
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.teams.getVaultIndex);
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.teams.getAvailability);

    // 볼트를 고르지 않으면(개인) 지금까지처럼 인자 없이 보낸다.
    const lists = [
      [() => api.aws.listProfiles(), (vaultId: string) => api.aws.listProfiles(vaultId), ipcChannels.aws.listProfiles],
      [() => api.tailnet.list(), (vaultId: string) => api.tailnet.list(vaultId), ipcChannels.tailnet.list],
      [() => api.knownHosts.list(), (vaultId: string) => api.knownHosts.list(vaultId), ipcChannels.knownHosts.list],
      [() => api.keychain.list(), (vaultId: string) => api.keychain.list(vaultId), ipcChannels.keychain.list],
    ] as const;
    for (const [personal, picked, channel] of lists) {
      ipcRenderer.invoke.mockClear();
      await personal();
      await picked("team-1");
      expect(ipcRenderer.invoke.mock.calls).toEqual([[channel], [channel, "team-1"]]);
    }
  });

  // 그룹 쓰기는 볼트를 줄 때만 싣는다 — 개인 쓰기는 지금과 같은 인자로 간다.
  it("adds the vault to group writes only when one is picked", async () => {
    const { createDesktopApi } = await import("./api");
    const { ipcChannels } = await import("../common/ipc-channels");
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue({}), on: vi.fn() } as any;
    const api = createDesktopApi(ipcRenderer);

    await api.groups.create("Prod", null);
    await api.groups.create("Prod", null, "team-1");
    await api.groups.remove("Prod", "delete-subtree");
    await api.groups.remove("Prod", "delete-subtree", "team-1");
    await api.groups.move("Prod", "Ops");
    await api.groups.move("Prod", "Ops", "team-1");
    await api.groups.rename("Prod", "Live");
    await api.groups.rename("Prod", "Live", "team-1");
    await api.groups.setOrder([{ id: "g", sortRank: 1 }]);
    await api.groups.setOrder([{ id: "g", sortRank: 1 }], "team-1");

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [ipcChannels.groups.create, "Prod", null],
      [ipcChannels.groups.create, "Prod", null, "team-1"],
      [ipcChannels.groups.remove, "Prod", "delete-subtree"],
      [ipcChannels.groups.remove, "Prod", "delete-subtree", "team-1"],
      [ipcChannels.groups.move, "Prod", "Ops"],
      [ipcChannels.groups.move, "Prod", "Ops", "team-1"],
      [ipcChannels.groups.rename, "Prod", "Live"],
      [ipcChannels.groups.rename, "Prod", "Live", "team-1"],
      [ipcChannels.groups.setOrder, [{ id: "g", sortRank: 1 }]],
      [ipcChannels.groups.setOrder, [{ id: "g", sortRank: 1 }], "team-1"],
    ]);
  });

  // 설정의 팀 묶음에서 다루는 AWS 프로필(4-7) — 개인 프로필은 지금과 같은 인자로 간다.
  it("adds the vault to AWS profile lookups and writes by name only when one is given", async () => {
    const { createDesktopApi } = await import("./api");
    const { ipcChannels } = await import("../common/ipc-channels");
    const ipcRenderer = { invoke: vi.fn().mockResolvedValue({}), on: vi.fn() } as any;
    const api = createDesktopApi(ipcRenderer);

    await api.aws.getProfileDetails("prod");
    await api.aws.getProfileDetails("prod", "team-1");
    await api.aws.getProfileStatus("prod");
    await api.aws.getProfileStatus("prod", "team-1");
    await api.aws.login("corp");
    await api.aws.login("corp", "team-1");
    await api.aws.deleteProfile("prod");
    await api.aws.deleteProfile("prod", "team-1");

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [ipcChannels.aws.getProfileDetails, "prod"],
      [ipcChannels.aws.getProfileDetails, "prod", "team-1"],
      [ipcChannels.aws.getProfileStatus, "prod"],
      [ipcChannels.aws.getProfileStatus, "prod", "team-1"],
      [ipcChannels.aws.login, "corp"],
      [ipcChannels.aws.login, "corp", "team-1"],
      [ipcChannels.aws.deleteProfile, "prod"],
      [ipcChannels.aws.deleteProfile, "prod", "team-1"],
    ]);
  });

  it("maps DesktopApi invoke calls to the expected IPC channels", async () => {
    const { createDesktopApi } = await import("./api");
    const { ipcChannels } = await import("../common/ipc-channels");
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    } as any;

    const api = createDesktopApi(ipcRenderer);

    await api.auth.bootstrap();
    await api.sync.bootstrap();
    await api.sessionShares.openOwnerChatWindow("session-1");
    await api.containers.openShell("host-1", "container-1");
    await api.sftp.startTransfer({} as any);
    await api.serial.listPorts();
    await api.serial.control({ sessionId: "session-1", action: "break" });
    api.files.getPathForDroppedFile({ name: "upload.txt" } as File);
    await api.keychain.copyPassword("secret-1");
    await api.groups.move("Servers/Nested", "Clients");
    await api.groups.rename("Servers/Nested", "API");
    await api.aws.updateProfileRegion({
      profileName: "corp-sso",
      region: null,
    });
    await api.containers.beginLifecycle("host-1");
    await api.containers.reportLifecycleError({
      lifecycleId: "lifecycle-1",
      message: "failed",
    });
    await api.containers.release("host-1", "lifecycle-1");
    await api.ssh.prepareAutocomplete("session-1");
    await api.ssh.refreshAutocomplete("session-1");
    await api.ssh.stopAutocomplete("session-1");
    await api.sshKeys.copyPublicKey("secret-key");
    await api.hostTransfer.previewExport(["host-1"]);
    await api.savedWorkspaces.list();
    await api.savedWorkspaces.create({ name: "Ops", root: {} as never });
    await api.savedWorkspaces.moveToGroup("workspace-1", "Clients");
    await api.savedWorkspaces.remove("workspace-1");

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      ipcChannels.auth.bootstrap,
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      ipcChannels.sync.bootstrap,
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      ipcChannels.sessionShares.openOwnerChatWindow,
      "session-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      4,
      ipcChannels.containers.openShell,
      "host-1",
      "container-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      5,
      ipcChannels.sftp.startTransfer,
      {},
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      6,
      ipcChannels.serial.listPorts,
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      7,
      ipcChannels.serial.control,
      { sessionId: "session-1", action: "break" },
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      8,
      ipcChannels.keychain.copyPassword,
      "secret-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      9,
      ipcChannels.groups.move,
      "Servers/Nested",
      "Clients",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      10,
      ipcChannels.groups.rename,
      "Servers/Nested",
      "API",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      11,
      ipcChannels.aws.updateProfileRegion,
      {
        profileName: "corp-sso",
        region: null,
      },
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      12,
      ipcChannels.containers.beginLifecycle,
      "host-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      13,
      ipcChannels.containers.reportLifecycleError,
      { lifecycleId: "lifecycle-1", message: "failed" },
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      14,
      ipcChannels.containers.release,
      "host-1",
      "lifecycle-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.ssh.prepareAutocomplete,
      "session-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.ssh.refreshAutocomplete,
      "session-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.ssh.stopAutocomplete,
      "session-1",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.sshKeys.copyPublicKey,
      "secret-key",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.hostTransfer.previewExport,
      ["host-1"],
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.savedWorkspaces.list,
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.savedWorkspaces.create,
      { name: "Ops", root: {} },
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.savedWorkspaces.moveToGroup,
      "workspace-1",
      "Clients",
    );
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      ipcChannels.savedWorkspaces.remove,
      "workspace-1",
    );
  });

  it("resolves dropped file paths through Electron webUtils without IPC", async () => {
    const { createDesktopApi } = await import("./api");
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    } as any;
    electronMocks.getPathForFile.mockReturnValue("/Users/tester/upload.txt");

    const api = createDesktopApi(ipcRenderer);
    const file = { name: "upload.txt" } as File;

    expect(api.files.getPathForDroppedFile(file)).toBe(
      "/Users/tester/upload.txt",
    );
    expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it("fans preload events out to bridge subscribers and unsubscribes cleanly", async () => {
    const { createDesktopApi } = await import("./api");
    const { registerPreloadEventBindings } = await import("./events/register");
    const { ipcChannels } = await import("../common/ipc-channels");

    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => void
    >();
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(
        (
          channel: string,
          handler: (event: unknown, payload: unknown) => void,
        ) => {
          handlers.set(channel, handler);
        },
      ),
    } as any;

    registerPreloadEventBindings(ipcRenderer);
    const api = createDesktopApi(ipcRenderer);

    const authListener = vi.fn();
    const transferListener = vi.fn();
    const logsChangedListener = vi.fn();
    const authOff = api.auth.onEvent(authListener);
    const transferOff = api.sftp.onTransferEvent(transferListener);
    const logsChangedOff = api.logs.onChanged(logsChangedListener);

    const authState = {
      status: "authenticated",
      session: { user: { id: "user-1" } },
      offline: null,
      errorMessage: null,
    } as any;
    const transferEvent = { jobId: "job-1", type: "progress" } as any;

    handlers.get(ipcChannels.auth.event)?.({}, authState);
    handlers.get(ipcChannels.sftp.transferEvent)?.({}, transferEvent);
    handlers.get(ipcChannels.logs.changed)?.({}, undefined);

    expect(authListener).toHaveBeenCalledWith(authState);
    expect(transferListener).toHaveBeenCalledWith(transferEvent);
    expect(logsChangedListener).toHaveBeenCalledTimes(1);

    authOff();
    transferOff();
    logsChangedOff();

    handlers.get(ipcChannels.auth.event)?.({}, authState);
    handlers.get(ipcChannels.sftp.transferEvent)?.({}, transferEvent);
    handlers.get(ipcChannels.logs.changed)?.({}, undefined);

    expect(authListener).toHaveBeenCalledTimes(1);
    expect(transferListener).toHaveBeenCalledTimes(1);
    expect(logsChangedListener).toHaveBeenCalledTimes(1);
  });
});
