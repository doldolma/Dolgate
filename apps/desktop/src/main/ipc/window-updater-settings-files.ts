import type { AppSettings } from "@shared";
import path from "node:path";
import { app, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerWindowUpdaterSettingsFilesIpcHandlers(
  ctx: MainIpcContext,
): void {
  ipcMain.handle(ipcChannels.window.getState, async (event) =>
    ctx.buildWindowState(ctx.resolveWindowFromSender(event.sender)),
  );

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

  ipcMain.handle(ipcChannels.tabs.list, async () => ctx.coreManager.listTabs());

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
    async (_event, input: Partial<AppSettings>) => {
      const nextSettings = ctx.settings.update(input);
      if (
        Object.prototype.hasOwnProperty.call(
          input,
          "sessionReplayRetentionCount",
        )
      ) {
        ctx.sessionReplayService.prune();
      }
      return nextSettings;
    },
  );

  ipcMain.handle(ipcChannels.shell.pickPrivateKey, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Private keys", extensions: ["pem", "key", "ppk"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
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
}
