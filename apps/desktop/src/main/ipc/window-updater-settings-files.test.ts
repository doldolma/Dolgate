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
});
