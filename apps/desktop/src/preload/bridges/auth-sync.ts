import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeAuthEvent } from "../events/state";

export function buildAuthBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["auth"] {
  return {
    getState: () => ipcRenderer.invoke(ipcChannels.auth.getState),
    bootstrap: () => ipcRenderer.invoke(ipcChannels.auth.bootstrap),
    retryOnline: () => ipcRenderer.invoke(ipcChannels.auth.retryOnline),
    beginBrowserLogin: () =>
      ipcRenderer.invoke(ipcChannels.auth.beginBrowserLogin),
    logout: () => ipcRenderer.invoke(ipcChannels.auth.logout),
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
  };
}
