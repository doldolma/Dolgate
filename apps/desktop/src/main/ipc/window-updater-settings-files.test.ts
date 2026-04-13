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
});
