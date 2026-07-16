import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerAuthIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(ipcChannels.auth.getState, async () =>
    ctx.authService.getState(),
  );
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
  ipcMain.handle(ipcChannels.auth.deleteAccount, async () => {
    await ctx.authService.deleteAccount();
  });
  // E2EE 볼트 — 설정/잠금해제가 끝나면 곧바로 동기화를 시작한다(볼트 게이트로 멈춰 있던 sync).
  // 볼트 이벤트는 DEK 시대의 경계이므로 sync 의 복구 상태(ETag·디코드 가드)를 함께 리셋한다:
  // 이전 시대의 ETag 로 304 를 받아 새 스냅샷을 놓치거나, 이전 시대의 디코드 실패 이력이
  // 새 시대의 첫 실패를 '데이터 손상'으로 오판하지 않게 한다.
  ipcMain.handle(
    ipcChannels.auth.setupVault,
    async (_event, passphrase: string) => {
      await ctx.authService.setupVault(passphrase);
      ctx.syncService.resetVaultRecoveryState();
      void ctx.syncService.bootstrap().catch(() => undefined);
    },
  );
  ipcMain.handle(
    ipcChannels.auth.unlockVault,
    async (_event, passphrase: string) => {
      await ctx.authService.unlockVault(passphrase);
      ctx.syncService.resetVaultRecoveryState();
      void ctx.syncService.bootstrap().catch(() => undefined);
    },
  );
  ipcMain.handle(ipcChannels.auth.resetVault, async () => {
    await ctx.authService.resetVault();
    ctx.syncService.resetVaultRecoveryState();
  });
  ipcMain.handle(
    ipcChannels.auth.migrateVault,
    async (_event, passphrase: string) => {
      await ctx.authService.migrateVault(passphrase);
      ctx.syncService.resetVaultRecoveryState();
      void ctx.syncService.bootstrap().catch(() => undefined);
    },
  );
  ipcMain.handle(
    ipcChannels.auth.changeVaultPassphrase,
    async (_event, currentPassphrase: string, nextPassphrase: string) => {
      await ctx.authService.changeVaultPassphrase(
        currentPassphrase,
        nextPassphrase,
      );
    },
  );
}
