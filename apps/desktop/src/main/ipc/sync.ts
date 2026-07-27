import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import { isSyncAuthenticationError } from "../sync-service";
import type { MainIpcContext } from "./context";
import { t } from '../i18n';

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
          t('auth.sessionExpired'),
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
          t('auth.sessionExpired'),
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
    async (event) => ctx.getInitialBootstrapSnapshot(event.sender.id),
  );
  ipcMain.handle(
    ipcChannels.bootstrap.getSyncedWorkspaceSnapshot,
    async () => ctx.getSyncedWorkspaceSnapshot(),
  );
}
