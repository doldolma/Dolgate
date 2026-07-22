import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeAuthEvent, subscribeWorkspaceChanged } from "../events/state";

export function buildAuthBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["auth"] {
  return {
    getState: () => ipcRenderer.invoke(ipcChannels.auth.getState),
    bootstrap: () => ipcRenderer.invoke(ipcChannels.auth.bootstrap),
    retryOnline: () => ipcRenderer.invoke(ipcChannels.auth.retryOnline),
    beginBrowserLogin: () =>
      ipcRenderer.invoke(ipcChannels.auth.beginBrowserLogin),
    reopenBrowserLogin: () =>
      ipcRenderer.invoke(ipcChannels.auth.reopenBrowserLogin),
    cancelBrowserLogin: () =>
      ipcRenderer.invoke(ipcChannels.auth.cancelBrowserLogin),
    logout: () => ipcRenderer.invoke(ipcChannels.auth.logout),
    deleteAccount: () => ipcRenderer.invoke(ipcChannels.auth.deleteAccount),
    changeAccountPassword: (currentPassword, newPassword) =>
      ipcRenderer.invoke(
        ipcChannels.auth.changeAccountPassword,
        currentPassword,
        newPassword,
      ),
    setupVault: (passphrase) =>
      ipcRenderer.invoke(ipcChannels.auth.setupVault, passphrase),
    unlockVault: (passphrase) =>
      ipcRenderer.invoke(ipcChannels.auth.unlockVault, passphrase),
    resetVault: () => ipcRenderer.invoke(ipcChannels.auth.resetVault),
    migrateVault: (passphrase) =>
      ipcRenderer.invoke(ipcChannels.auth.migrateVault, passphrase),
    changeVaultPassphrase: (currentPassphrase, nextPassphrase) =>
      ipcRenderer.invoke(
        ipcChannels.auth.changeVaultPassphrase,
        currentPassphrase,
        nextPassphrase,
      ),
    onEvent: (listener) => subscribeAuthEvent(listener),
  };
}

export function buildSyncBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["sync"] {
  return {
    bootstrap: () => ipcRenderer.invoke(ipcChannels.sync.bootstrap),
    pushDirty: () => ipcRenderer.invoke(ipcChannels.sync.pushDirty),
    status: () => ipcRenderer.invoke(ipcChannels.sync.status),
    exportDecryptedSnapshot: () =>
      ipcRenderer.invoke(ipcChannels.sync.exportDecryptedSnapshot),
  };
}

export function buildBootstrapBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["bootstrap"] {
  return {
    getInitialSnapshot: () =>
      ipcRenderer.invoke(ipcChannels.bootstrap.getInitialSnapshot),
    getSyncedWorkspaceSnapshot: () =>
      ipcRenderer.invoke(ipcChannels.bootstrap.getSyncedWorkspaceSnapshot),
    onWorkspaceChanged: (listener) => subscribeWorkspaceChanged(listener),
  };
}
