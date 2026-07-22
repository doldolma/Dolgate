import type { AppSettings, DesktopWindowLaunchIntent } from "@shared";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { app, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export interface DesktopWindowIpcRuntime {
  openWindow: (intent?: DesktopWindowLaunchIntent) => Promise<void>;
  consumeLaunchIntent: (windowId: number) => DesktopWindowLaunchIntent | null;
}

export function registerWindowUpdaterSettingsFilesIpcHandlers(
  ctx: MainIpcContext,
  windowRuntime?: DesktopWindowIpcRuntime,
): void {
  ipcMain.handle(ipcChannels.window.getState, async (event) =>
    ctx.buildWindowState(ctx.resolveWindowFromSender(event.sender)),
  );

  ipcMain.handle(ipcChannels.window.openNew, async () => {
    await windowRuntime?.openWindow();
  });

  ipcMain.handle(
    ipcChannels.window.openHost,
    async (_event, hostId: string) => {
      if (typeof hostId !== "string" || !ctx.hosts.getById(hostId)) {
        throw new Error("Host not found");
      }
      await windowRuntime?.openWindow({ type: "connect-host", hostId });
    },
  );

  ipcMain.handle(ipcChannels.window.consumeLaunchIntent, async (event) => {
    const window = ctx.resolveWindowFromSender(event.sender);
    return windowRuntime?.consumeLaunchIntent(window.id) ?? null;
  });

  ipcMain.handle(ipcChannels.window.minimize, async (event) => {
    ctx.resolveWindowFromSender(event.sender).minimize();
  });

  ipcMain.handle(ipcChannels.window.maximize, async (event) => {
    ctx.resolveWindowFromSender(event.sender).maximize();
  });

  ipcMain.handle(ipcChannels.window.restore, async (event) => {
    ctx.resolveWindowFromSender(event.sender).restore();
  });

  ipcMain.handle(ipcChannels.window.close, async (event) => {
    ctx.resolveWindowFromSender(event.sender).close();
  });

  ipcMain.handle(ipcChannels.tabs.list, async (event) =>
    ctx.coreManager.listTabs(event.sender.id),
  );

  ipcMain.handle(ipcChannels.updater.getState, async () => ctx.updater.getState());

  ipcMain.handle(ipcChannels.updater.check, async () => {
    await ctx.updater.check();
  });

  ipcMain.handle(ipcChannels.updater.download, async () => {
    await ctx.updater.download();
  });

  ipcMain.handle(ipcChannels.updater.installAndRestart, async () => {
    await ctx.updater.installAndRestart();
  });

  ipcMain.handle(
    ipcChannels.updater.dismissAvailable,
    async (_event, version: string) => {
      await ctx.updater.dismissAvailable(version);
    },
  );

  ipcMain.handle(ipcChannels.settings.get, async () => ctx.settings.get());

  ipcMain.handle(
    ipcChannels.settings.update,
    async (event, input: Partial<AppSettings>) => {
      const previousServerUrl = ctx.settings.get().serverUrl;
      const nextSettings = ctx.settings.update(input);
      if (nextSettings.serverUrl !== previousServerUrl) {
        ctx.authService.resetServerVaultSupport();
      }
      if (
        Object.prototype.hasOwnProperty.call(
          input,
          "sessionReplayRetentionCount",
        )
      ) {
        ctx.sessionReplayService.prune();
      }
      ctx.emitWorkspaceChanged?.(event?.sender);
      return nextSettings;
    },
  );

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      content: await readFile(filePath, "utf8"),
    };
  });

  ipcMain.handle(ipcChannels.shell.pickSshCertificate, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      content: await readFile(filePath, "utf8"),
    };
  });

  ipcMain.handle(ipcChannels.shell.pickOpenSshConfig, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
      filters: [
        { name: "OpenSSH config", extensions: ["config", "conf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.shell.pickXshellSessionFolder, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: await ctx.xshellImportService.getPickerDefaultPath(),
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.files.getHomeDirectory, async () =>
    ctx.localFiles.getHomeDirectory(),
  );
  ipcMain.handle(ipcChannels.files.getDownloadsDirectory, async () =>
    ctx.localFiles.getDownloadsDirectory(),
  );
  ipcMain.handle(ipcChannels.files.listRoots, async () =>
    ctx.localFiles.listRoots(),
  );
  ipcMain.handle(
    ipcChannels.files.getParentPath,
    async (_event, targetPath: string) => ctx.localFiles.getParentPath(targetPath),
  );

  ipcMain.handle(ipcChannels.files.list, async (_event, targetPath: string) =>
    ctx.localFiles.list(targetPath),
  );

  ipcMain.handle(
    ipcChannels.files.mkdir,
    async (_event, targetPath: string, name: string) => {
      await ctx.localFiles.mkdir(targetPath, name);
    },
  );

  ipcMain.handle(
    ipcChannels.files.rename,
    async (_event, targetPath: string, nextName: string) => {
      await ctx.localFiles.rename(targetPath, nextName);
    },
  );

  ipcMain.handle(
    ipcChannels.files.chmod,
    async (_event, targetPath: string, mode: number) => {
      await ctx.localFiles.chmod(targetPath, mode);
    },
  );

  ipcMain.handle(ipcChannels.files.delete, async (_event, paths: string[]) => {
    await ctx.localFiles.delete(paths);
  });

  ipcMain.handle(
    ipcChannels.files.saveZmodemDownload,
    async (_event, input: { name: string; bytes: Uint8Array }) => {
      const savedPath = await ctx.localFiles.saveToDownloads(
        input.name,
        input.bytes,
      );
      return { savedPath };
    },
  );

  ipcMain.handle(
    ipcChannels.files.reveal,
    async (_event, targetPath: string) => {
      shell.showItemInFolder(targetPath);
    },
  );
}
