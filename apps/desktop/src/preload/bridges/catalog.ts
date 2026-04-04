import type { IpcRenderer } from "electron";
import type { DesktopApi, GroupRemoveMode, HostDraft, HostSecretInput } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeWarpgateImportEvent } from "../events/state";

export function buildHostsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["hosts"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.hosts.list),
    create: (draft: HostDraft, secrets?: HostSecretInput) =>
      ipcRenderer.invoke(ipcChannels.hosts.create, draft, secrets),
    update: (id: string, draft: HostDraft, secrets?: HostSecretInput) =>
      ipcRenderer.invoke(ipcChannels.hosts.update, id, draft, secrets),
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.hosts.remove, id),
  };
}

export function buildGroupsBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["groups"] {
  return {
    list: () => ipcRenderer.invoke(ipcChannels.groups.list),
    create: (name: string, parentPath?: string | null) =>
      ipcRenderer.invoke(ipcChannels.groups.create, name, parentPath),
    remove: (path: string, mode: GroupRemoveMode) =>
      ipcRenderer.invoke(ipcChannels.groups.remove, path, mode),
  };
}

export function buildAwsBridge(ipcRenderer: IpcRenderer): DesktopApi["aws"] {
  return {
    listProfiles: () => ipcRenderer.invoke(ipcChannels.aws.listProfiles),
    getProfileStatus: (profileName: string) =>
      ipcRenderer.invoke(ipcChannels.aws.getProfileStatus, profileName),
    login: (profileName: string) =>
      ipcRenderer.invoke(ipcChannels.aws.login, profileName),
    listRegions: (profileName: string) =>
      ipcRenderer.invoke(ipcChannels.aws.listRegions, profileName),
    listEc2Instances: (profileName: string, region: string) =>
      ipcRenderer.invoke(ipcChannels.aws.listEc2Instances, profileName, region),
    listEcsClusters: (profileName: string, region: string) =>
      ipcRenderer.invoke(ipcChannels.aws.listEcsClusters, profileName, region),
    loadEcsClusterSnapshot: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.aws.loadEcsClusterSnapshot, hostId),
    loadEcsClusterUtilization: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.aws.loadEcsClusterUtilization, hostId),
    loadEcsServiceActionContext: (hostId: string, serviceName: string) =>
      ipcRenderer.invoke(
        ipcChannels.aws.loadEcsServiceActionContext,
        hostId,
        serviceName,
      ),
    loadEcsServiceLogs: (input) =>
      ipcRenderer.invoke(ipcChannels.aws.loadEcsServiceLogs, input),
    openEcsExecShell: (input) =>
      ipcRenderer.invoke(ipcChannels.aws.openEcsExecShell, input),
    startEcsServiceTunnel: (input) =>
      ipcRenderer.invoke(ipcChannels.aws.startEcsServiceTunnel, input),
    stopEcsServiceTunnel: (runtimeId: string) =>
      ipcRenderer.invoke(ipcChannels.aws.stopEcsServiceTunnel, runtimeId),
    listEcsTaskTunnelServices: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.aws.listEcsTaskTunnelServices, hostId),
    loadEcsTaskTunnelService: (hostId: string, serviceName: string) =>
      ipcRenderer.invoke(
        ipcChannels.aws.loadEcsTaskTunnelService,
        hostId,
        serviceName,
      ),
    inspectHostSshMetadata: (input) =>
      ipcRenderer.invoke(ipcChannels.aws.inspectHostSshMetadata, input),
    loadHostSshMetadata: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.aws.loadHostSshMetadata, hostId),
  };
}

export function buildWarpgateBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["warpgate"] {
  return {
    testConnection: (baseUrl: string, token: string) =>
      ipcRenderer.invoke(ipcChannels.warpgate.testConnection, baseUrl, token),
    getConnectionInfo: (baseUrl: string, token: string) =>
      ipcRenderer.invoke(
        ipcChannels.warpgate.getConnectionInfo,
        baseUrl,
        token,
      ),
    listSshTargets: (baseUrl: string, token: string) =>
      ipcRenderer.invoke(ipcChannels.warpgate.listSshTargets, baseUrl, token),
    startBrowserImport: (baseUrl: string) =>
      ipcRenderer.invoke(ipcChannels.warpgate.startBrowserImport, baseUrl),
    cancelBrowserImport: (attemptId: string) =>
      ipcRenderer.invoke(ipcChannels.warpgate.cancelBrowserImport, attemptId),
    onImportEvent: (listener) => subscribeWarpgateImportEvent(listener),
  };
}

export function buildTermiusBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["termius"] {
  return {
    probeLocal: () => ipcRenderer.invoke(ipcChannels.termius.probeLocal),
    importSelection: (input) =>
      ipcRenderer.invoke(ipcChannels.termius.importSelection, input),
    discardSnapshot: (snapshotId: string) =>
      ipcRenderer.invoke(ipcChannels.termius.discardSnapshot, snapshotId),
  };
}

export function buildOpenSshBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["openssh"] {
  return {
    probeDefault: () => ipcRenderer.invoke(ipcChannels.openssh.probeDefault),
    addFileToSnapshot: (input) =>
      ipcRenderer.invoke(ipcChannels.openssh.addFileToSnapshot, input),
    importSelection: (input) =>
      ipcRenderer.invoke(ipcChannels.openssh.importSelection, input),
    discardSnapshot: (snapshotId: string) =>
      ipcRenderer.invoke(ipcChannels.openssh.discardSnapshot, snapshotId),
  };
}

export function buildXshellBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["xshell"] {
  return {
    probeDefault: () => ipcRenderer.invoke(ipcChannels.xshell.probeDefault),
    addFolderToSnapshot: (input) =>
      ipcRenderer.invoke(ipcChannels.xshell.addFolderToSnapshot, input),
    importSelection: (input) =>
      ipcRenderer.invoke(ipcChannels.xshell.importSelection, input),
    discardSnapshot: (snapshotId: string) =>
      ipcRenderer.invoke(ipcChannels.xshell.discardSnapshot, snapshotId),
  };
}
