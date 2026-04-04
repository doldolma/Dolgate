import type { IpcRenderer } from "electron";
import type { DesktopApi } from "@shared";
import {
  buildAuthBridge,
  buildBootstrapBridge,
  buildSyncBridge,
} from "./bridges/auth-sync";
import {
  buildAwsBridge,
  buildGroupsBridge,
  buildHostsBridge,
  buildOpenSshBridge,
  buildTermiusBridge,
  buildWarpgateBridge,
  buildXshellBridge,
} from "./bridges/catalog";
import {
  buildContainersBridge,
  buildSessionSharesBridge,
  buildSftpBridge,
  buildSshBridge,
} from "./bridges/session";
import {
  buildDnsOverridesBridge,
  buildFilesBridge,
  buildKeychainBridge,
  buildKnownHostsBridge,
  buildLogsBridge,
  buildPortForwardsBridge,
  buildSessionReplaysBridge,
  buildSettingsBridge,
  buildShellBridge,
  buildTabsBridge,
  buildUpdaterBridge,
  buildWindowBridge,
} from "./bridges/system";

export function createDesktopApi(ipcRenderer: IpcRenderer): DesktopApi {
  return {
    auth: buildAuthBridge(ipcRenderer),
    sync: buildSyncBridge(ipcRenderer),
    bootstrap: buildBootstrapBridge(ipcRenderer),
    hosts: buildHostsBridge(ipcRenderer),
    groups: buildGroupsBridge(ipcRenderer),
    aws: buildAwsBridge(ipcRenderer),
    warpgate: buildWarpgateBridge(ipcRenderer),
    termius: buildTermiusBridge(ipcRenderer),
    openssh: buildOpenSshBridge(ipcRenderer),
    xshell: buildXshellBridge(ipcRenderer),
    ssh: buildSshBridge(ipcRenderer),
    sessionShares: buildSessionSharesBridge(ipcRenderer),
    shell: buildShellBridge(ipcRenderer),
    window: buildWindowBridge(ipcRenderer),
    tabs: buildTabsBridge(ipcRenderer),
    updater: buildUpdaterBridge(ipcRenderer),
    settings: buildSettingsBridge(ipcRenderer),
    portForwards: buildPortForwardsBridge(ipcRenderer),
    dnsOverrides: buildDnsOverridesBridge(ipcRenderer),
    knownHosts: buildKnownHostsBridge(ipcRenderer),
    logs: buildLogsBridge(ipcRenderer),
    sessionReplays: buildSessionReplaysBridge(ipcRenderer),
    keychain: buildKeychainBridge(ipcRenderer),
    files: buildFilesBridge(ipcRenderer),
    containers: buildContainersBridge(ipcRenderer),
    sftp: buildSftpBridge(ipcRenderer),
  };
}
