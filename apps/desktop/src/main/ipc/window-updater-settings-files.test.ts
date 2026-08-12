import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { app, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { registerWindowUpdaterSettingsFilesIpcHandlers } from "./window-updater-settings-files";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/Users/tester"),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
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
    buildWindowState: vi.fn(),
    resolveWindowFromSender: vi.fn(),
    coreManager: {
      listTabs: vi.fn(),
    },
    hosts: {
      getById: vi.fn(),
    },
    updater: {
      getState: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      installAndRestart: vi.fn(),
      dismissAvailable: vi.fn(),
    },
    settings: {
      get: vi.fn(),
      update: vi.fn(),
    },
    authService: {
      resetServerVaultSupport: vi.fn(),
      resetServerWebauthnSupport: vi.fn(),
    },
    sessionReplayService: {
      prune: vi.fn(),
    },
    xshellImportService: {
      getPickerDefaultPath: vi.fn(),
    },
    localFiles: {
      getHomeDirectory: vi.fn(),
      getDownloadsDirectory: vi.fn(),
      listRoots: vi.fn(),
      getParentPath: vi.fn(),
      list: vi.fn(),
      mkdir: vi.fn(),
      rename: vi.fn(),
      chmod: vi.fn(),
      delete: vi.fn(),
    },
  } as any;
}

describe("registerWindowUpdaterSettingsFilesIpcHandlers", () => {
  const expectedSshDirectory = path.join("/Users/tester", ".ssh");

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
    vi.mocked(dialog.showOpenDialog).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it("opens the private key picker in ~/.ssh without restrictive extension filters", async () => {
    const ctx = createContext();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/tester/.ssh/id_ed25519"],
    } as any);
    vi.mocked(readFile).mockResolvedValue("PRIVATE KEY");

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const handler = getRegisteredHandler(ipcChannels.shell.pickPrivateKey);

    await expect(handler()).resolves.toEqual({
      path: "/Users/tester/.ssh/id_ed25519",
      name: "id_ed25519",
      content: "PRIVATE KEY",
    });

    expect(app.getPath).toHaveBeenCalledWith("home");
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expectedSshDirectory,
        properties: ["openFile"],
      }),
    );
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.not.objectContaining({
        filters: expect.anything(),
      }),
    );
  });

  it("opens the SSH certificate picker in ~/.ssh without restrictive extension filters", async () => {
    const ctx = createContext();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/Users/tester/.ssh/id_ed25519-cert.pub"],
    } as any);
    vi.mocked(readFile).mockResolvedValue("ssh-ed25519-cert-v01@openssh.com AAAA");

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const handler = getRegisteredHandler(ipcChannels.shell.pickSshCertificate);

    await expect(handler()).resolves.toEqual({
      path: "/Users/tester/.ssh/id_ed25519-cert.pub",
      name: "id_ed25519-cert.pub",
      content: "ssh-ed25519-cert-v01@openssh.com AAAA",
    });

    expect(app.getPath).toHaveBeenCalledWith("home");
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expectedSshDirectory,
        properties: ["openFile"],
      }),
    );
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.not.objectContaining({
        filters: expect.anything(),
      }),
    );
  });

  it("resets cached vault capability only when the effective server URL changes", async () => {
    const ctx = createContext();
    ctx.settings.get.mockReturnValue({ serverUrl: "https://old.example.com" });
    ctx.settings.update.mockReturnValue({
      serverUrl: "https://new.example.com",
    });

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const handler = getRegisteredHandler(ipcChannels.settings.update);

    await handler({}, { serverUrlOverride: "https://new.example.com" });

    expect(ctx.authService.resetServerVaultSupport).toHaveBeenCalledOnce();

    ctx.authService.resetServerVaultSupport.mockClear();
    ctx.settings.update.mockReturnValue({
      serverUrl: "https://old.example.com",
    });

    await handler({}, { theme: "dark" });

    expect(ctx.authService.resetServerVaultSupport).not.toHaveBeenCalled();
  });

  it("opens a validated host in a new window and consumes its launch intent once", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({ id: "host-1" });
    const runtime = {
      openWindow: vi.fn().mockResolvedValue(undefined),
      consumeLaunchIntent: vi
        .fn()
        .mockReturnValueOnce({ type: "connect-host", hostId: "host-1" })
        .mockReturnValueOnce(null),
    };
    ctx.resolveWindowFromSender.mockReturnValue({ id: 77 });

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx, runtime);
    const openHost = getRegisteredHandler(ipcChannels.window.openHost);
    const consumeIntent = getRegisteredHandler(
      ipcChannels.window.consumeLaunchIntent,
    );

    await openHost({}, "host-1");
    await expect(consumeIntent({ sender: {} })).resolves.toEqual({
      type: "connect-host",
      hostId: "host-1",
    });
    await expect(consumeIntent({ sender: {} })).resolves.toBeNull();

    expect(runtime.openWindow).toHaveBeenCalledWith({
      type: "connect-host",
      hostId: "host-1",
    });
  });

  function createFullScreenWindow(state: { full: boolean; max: boolean }) {
    return {
      isFullScreen: vi.fn(() => state.full),
      isMaximized: vi.fn(() => state.max),
      unmaximize: vi.fn(() => {
        state.max = false;
      }),
      setFullScreen: vi.fn((next: boolean) => {
        state.full = next;
      }),
    };
  }

  // 최대화된 창을 곧바로 전체화면으로 넘기면 안 된다. 실측(Windows 11, Electron 42, frame:false):
  // 화면은 그대로인데 isFullScreen() 만 true 가 되고 enter-full-screen 이 오지 않아서, 상단바는
  // 탭을 계속 보여주다가 창을 되돌리는 순간 작은 창에서 탭이 사라졌다. 최대화를 먼저 푸는 것이
  // 그 어긋남을 없앤 수정이므로, 지워지면 같은 증상이 돌아온다.
  it("drops the maximized state before entering full screen", async () => {
    const ctx = createContext();
    const window = createFullScreenWindow({ full: false, max: true });
    ctx.resolveWindowFromSender.mockReturnValue(window);

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const toggle = getRegisteredHandler(ipcChannels.window.toggleFullScreen);

    await toggle({ sender: {} });

    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
    expect(window.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(
      window.setFullScreen.mock.invocationCallOrder[0],
    );
  });

  it("does not touch the maximized state when leaving full screen", async () => {
    const ctx = createContext();
    const window = createFullScreenWindow({ full: true, max: true });
    ctx.resolveWindowFromSender.mockReturnValue(window);

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const toggle = getRegisteredHandler(ipcChannels.window.toggleFullScreen);

    await toggle({ sender: {} });

    expect(window.unmaximize).not.toHaveBeenCalled();
    expect(window.setFullScreen).toHaveBeenCalledWith(false);
  });

  // 방향은 메인이 정한다. 렌더러가 방향을 실어 보내면 F11 로 방금 바뀐 뒤의 낡은 값으로 같은
  // 상태를 다시 세팅해, 버튼이 안 먹는 것처럼 보인다.
  it("toggles against the live window state on each call", async () => {
    const ctx = createContext();
    const window = createFullScreenWindow({ full: false, max: false });
    ctx.resolveWindowFromSender.mockReturnValue(window);

    registerWindowUpdaterSettingsFilesIpcHandlers(ctx);
    const toggle = getRegisteredHandler(ipcChannels.window.toggleFullScreen);

    await toggle({ sender: {} });
    await toggle({ sender: {} });

    expect(window.setFullScreen.mock.calls.map(([next]) => next)).toEqual([
      true,
      false,
    ]);
  });
});
