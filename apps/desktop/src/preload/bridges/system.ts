import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import {
  subscribePortForwardEvent,
  subscribeUpdateEvent,
  subscribeWindowState,
} from "../events/state";

export function buildShellBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["shell"] {
  return {
    pickPrivateKey: () => ipcRenderer.invoke(ipcChannels.shell.pickPrivateKey),
    pickOpenSshConfig: () =>
      ipcRenderer.invoke(ipcChannels.shell.pickOpenSshConfig),
    pickXshellSessionFolder: () =>
      ipcRenderer.invoke(ipcChannels.shell.pickXshellSessionFolder),
    openExternal: (url: string) =>
      ipcRenderer.invoke(ipcChannels.shell.openExternal, url),
  };
}

export function buildWindowBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["window"] {
  return {
    getState: () => ipcRenderer.invoke(ipcChannels.window.getState),
    minimize: () => ipcRenderer.invoke(ipcChannels.window.minimize),
    maximize: () => ipcRenderer.invoke(ipcChannels.window.maximize),
    restore: () => ipcRenderer.invoke(ipcChannels.window.restore),
    close: () => ipcRenderer.invoke(ipcChannels.window.close),
    onStateChanged: (listener) => subscribeWindowState(listener),
  };
}

export function buildTabsBridge(ipcRenderer: IpcRenderer): DesktopApi["tabs"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.tabs.list),
  };
}

export function buildUpdaterBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["updater"] {
  return {
    getState: () => ipcRenderer.invoke(ipcChannels.updater.getState),
    check: () => ipcRenderer.invoke(ipcChannels.updater.check),
    download: () => ipcRenderer.invoke(ipcChannels.updater.download),
    installAndRestart: () =>
      ipcRenderer.invoke(ipcChannels.updater.installAndRestart),
    dismissAvailable: (version: string) =>
      ipcRenderer.invoke(ipcChannels.updater.dismissAvailable, version),
    onEvent: (listener) => subscribeUpdateEvent(listener),
  };
}

export function buildSettingsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["settings"] {
  return {
    get: () => ipcRenderer.invoke(ipcChannels.settings.get),
    update: (input) => ipcRenderer.invoke(ipcChannels.settings.update, input),
  };
}

export function buildPortForwardsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["portForwards"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.portForwards.list),
    create: (draft) =>
      ipcRenderer.invoke(ipcChannels.portForwards.create, draft),
    update: (id: string, draft) =>
      ipcRenderer.invoke(ipcChannels.portForwards.update, id, draft),
    remove: (id: string) =>
      ipcRenderer.invoke(ipcChannels.portForwards.remove, id),
    start: (ruleId: string) =>
      ipcRenderer.invoke(ipcChannels.portForwards.start, ruleId),
    stop: (ruleId: string) =>
      ipcRenderer.invoke(ipcChannels.portForwards.stop, ruleId),
    onEvent: (listener) => subscribePortForwardEvent(listener),
  };
}

export function buildDnsOverridesBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["dnsOverrides"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.dnsOverrides.list),
    create: (draft) =>
      ipcRenderer.invoke(ipcChannels.dnsOverrides.create, draft),
    update: (id: string, draft) =>
      ipcRenderer.invoke(ipcChannels.dnsOverrides.update, id, draft),
    setStaticActive: (id: string, active: boolean) =>
      ipcRenderer.invoke(ipcChannels.dnsOverrides.setStaticActive, id, active),
    remove: (id: string) =>
      ipcRenderer.invoke(ipcChannels.dnsOverrides.remove, id),
  };
}

export function buildKnownHostsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["knownHosts"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.knownHosts.list),
    probeHost: (input) =>
      ipcRenderer.invoke(ipcChannels.knownHosts.probeHost, input),
    trust: (input) => ipcRenderer.invoke(ipcChannels.knownHosts.trust, input),
    replace: (input) =>
      ipcRenderer.invoke(ipcChannels.knownHosts.replace, input),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.knownHosts.remove, id),
  };
}

export function buildLogsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["logs"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.logs.list),
    clear: () => ipcRenderer.invoke(ipcChannels.logs.clear),
  };
}

export function buildSessionReplaysBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["sessionReplays"] {
  return {
    open: (recordingId: string) =>
      ipcRenderer.invoke(ipcChannels.sessionReplays.open, recordingId),
    get: (recordingId: string) =>
      ipcRenderer.invoke(ipcChannels.sessionReplays.get, recordingId),
  };
}

export function buildKeychainBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["keychain"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.keychain.list),
    load: (secretRef: string) =>
      ipcRenderer.invoke(ipcChannels.keychain.load, secretRef),
    remove: (secretRef: string) =>
      ipcRenderer.invoke(ipcChannels.keychain.remove, secretRef),
    update: (input) => ipcRenderer.invoke(ipcChannels.keychain.update, input),
    cloneForHost: (input) =>
      ipcRenderer.invoke(ipcChannels.keychain.cloneForHost, input),
  };
}

export function buildFilesBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["files"] {
  return {
    getHomeDirectory: () =>
      ipcRenderer.invoke(ipcChannels.files.getHomeDirectory),
    getDownloadsDirectory: () =>
      ipcRenderer.invoke(ipcChannels.files.getDownloadsDirectory),
    listRoots: () => ipcRenderer.invoke(ipcChannels.files.listRoots),
    getParentPath: (targetPath: string) =>
      ipcRenderer.invoke(ipcChannels.files.getParentPath, targetPath),
    list: (path: string) => ipcRenderer.invoke(ipcChannels.files.list, path),
    mkdir: (path: string, name: string) =>
      ipcRenderer.invoke(ipcChannels.files.mkdir, path, name),
    rename: (path: string, nextName: string) =>
      ipcRenderer.invoke(ipcChannels.files.rename, path, nextName),
    chmod: (path: string, mode: number) =>
      ipcRenderer.invoke(ipcChannels.files.chmod, path, mode),
    delete: (paths: string[]) =>
      ipcRenderer.invoke(ipcChannels.files.delete, paths),
  };
}
