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
  buildHostTransferBridge,
  buildHostsBridge,
  buildOpenSshBridge,
  buildTermiusBridge,
  buildWarpgateBridge,
  buildXshellBridge,
} from "./bridges/catalog";
import {
  buildContainersBridge,
  buildSerialBridge,
  buildSessionSharesBridge,
  buildSftpBridge,
  buildSshBridge,
} from "./bridges/session";
import {
  buildDnsOverridesBridge,
  buildFilesBridge,
  buildKeychainBridge,
  buildKnownHostsBridge,
  buildTailnetBridge,
  buildLogsBridge,
  buildNotificationsBridge,
  buildPortForwardsBridge,
  buildSessionReplaysBridge,
  buildSettingsBridge,
  buildShellBridge,
  buildSnippetsBridge,
  buildSshKeysBridge,
  buildSystemBridge,
  buildTabsBridge,
  buildUpdaterBridge,
  buildWindowBridge,
} from "./bridges/system";
import { buildAiBridge } from "./bridges/ai";
import { buildRdpBridge } from "./bridges/rdp";

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
    hostTransfer: buildHostTransferBridge(ipcRenderer),
    xshell: buildXshellBridge(ipcRenderer),
    ssh: buildSshBridge(ipcRenderer),
    rdp: buildRdpBridge(ipcRenderer),
    serial: buildSerialBridge(ipcRenderer),
    sessionShares: buildSessionSharesBridge(ipcRenderer),
    shell: buildShellBridge(ipcRenderer),
    window: buildWindowBridge(ipcRenderer),
    system: buildSystemBridge(ipcRenderer),
    tabs: buildTabsBridge(ipcRenderer),
    updater: buildUpdaterBridge(ipcRenderer),
    settings: buildSettingsBridge(ipcRenderer),
    ai: buildAiBridge(ipcRenderer),
    portForwards: buildPortForwardsBridge(ipcRenderer),
    dnsOverrides: buildDnsOverridesBridge(ipcRenderer),
    snippets: buildSnippetsBridge(ipcRenderer),
    notifications: buildNotificationsBridge(ipcRenderer),
    knownHosts: buildKnownHostsBridge(ipcRenderer),
    tailnet: buildTailnetBridge(ipcRenderer),
    logs: buildLogsBridge(ipcRenderer),
    sessionReplays: buildSessionReplaysBridge(ipcRenderer),
    keychain: buildKeychainBridge(ipcRenderer),
    sshKeys: buildSshKeysBridge(ipcRenderer),
    files: buildFilesBridge(ipcRenderer),
    containers: buildContainersBridge(ipcRenderer),
    sftp: buildSftpBridge(ipcRenderer),
  };
}
