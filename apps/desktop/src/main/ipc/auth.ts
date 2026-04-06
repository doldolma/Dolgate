import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerAuthIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.auth.getState, async () => ctx.authService.getState());
  ipcMain.handle(ipcChannels.auth.bootstrap, async () =>
    ctx.authService.bootstrap(),
  );
  ipcMain.handle(ipcChannels.auth.retryOnline, async () =>
    ctx.authService.retryOnline(),
  );
  ipcMain.handle(ipcChannels.auth.beginBrowserLogin, async () => {
    await ctx.authService.beginBrowserLogin();
  });
  ipcMain.handle(ipcChannels.auth.reopenBrowserLogin, async () => {
    await ctx.authService.reopenBrowserLogin();
  });
  ipcMain.handle(ipcChannels.auth.cancelBrowserLogin, async () => {
    await ctx.authService.cancelBrowserLogin();
  });
  ipcMain.handle(ipcChannels.auth.logout, async () => {
    await ctx.authService.logout();
  });
}
