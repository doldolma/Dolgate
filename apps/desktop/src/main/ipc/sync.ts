import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { isSyncAuthenticationError } from "../sync-service";
import type { MainIpcContext } from "./context";

export function registerSyncIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.sync.bootstrap, async () => {
    try {
      return await ctx.syncService.bootstrap();
    } catch (error) {
      if (
        isSyncAuthenticationError(error) &&
        ctx.authService.getState().status === "authenticated"
      ) {
        await ctx.authService.forceUnauthenticated(
          "세션이 만료되었습니다. 다시 로그인해 주세요.",
        );
      }
      throw error;
    }
  });

  ipcMain.handle(ipcChannels.sync.pushDirty, async () => {
    try {
      return await ctx.syncService.pushDirty();
    } catch (error) {
      if (
        isSyncAuthenticationError(error) &&
        ctx.authService.getState().status === "authenticated"
      ) {
        await ctx.authService.forceUnauthenticated(
          "세션이 만료되었습니다. 다시 로그인해 주세요.",
        );
      }
      throw error;
    }
  });

  ipcMain.handle(ipcChannels.sync.status, async () => ctx.syncService.getState());
  ipcMain.handle(ipcChannels.sync.exportDecryptedSnapshot, async () =>
    ctx.syncService.exportDecryptedSnapshot(),
  );
  ipcMain.handle(
    ipcChannels.bootstrap.getInitialSnapshot,
    async () => ctx.getInitialBootstrapSnapshot(),
  );
  ipcMain.handle(
    ipcChannels.bootstrap.getSyncedWorkspaceSnapshot,
    async () => ctx.getSyncedWorkspaceSnapshot(),
  );
}

