import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createDesktopApi", () => {
  beforeEach(() => {
    vi.resetModules();
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
    await api.groups.move("Servers/Nested", "Clients");
    await api.groups.rename("Servers/Nested", "API");

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
      ipcChannels.groups.move,
      "Servers/Nested",
      "Clients",
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      7,
      ipcChannels.groups.rename,
      "Servers/Nested",
      "API",
    );
  });

  it("fans preload events out to bridge subscribers and unsubscribes cleanly", async () => {
    const { createDesktopApi } = await import("./api");
    const { registerPreloadEventBindings } = await import("./events/register");
    const { ipcChannels } = await import("../common/ipc-channels");

    const handlers = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => void) => {
        handlers.set(channel, handler);
      }),
    } as any;

    registerPreloadEventBindings(ipcRenderer);
    const api = createDesktopApi(ipcRenderer);

    const authListener = vi.fn();
    const transferListener = vi.fn();
    const authOff = api.auth.onEvent(authListener);
    const transferOff = api.sftp.onTransferEvent(transferListener);

    const authState = {
      status: "authenticated",
      session: { user: { id: "user-1" } },
      offline: null,
      errorMessage: null,
    } as any;
    const transferEvent = { jobId: "job-1", type: "progress" } as any;

    handlers.get(ipcChannels.auth.event)?.({}, authState);
    handlers.get(ipcChannels.sftp.transferEvent)?.({}, transferEvent);

    expect(authListener).toHaveBeenCalledWith(authState);
    expect(transferListener).toHaveBeenCalledWith(transferEvent);

    authOff();
    transferOff();

    handlers.get(ipcChannels.auth.event)?.({}, authState);
    handlers.get(ipcChannels.sftp.transferEvent)?.({}, transferEvent);

    expect(authListener).toHaveBeenCalledTimes(1);
    expect(transferListener).toHaveBeenCalledTimes(1);
  });
});
