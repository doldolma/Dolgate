import type { IpcRenderer } from "electron";
import type {
  CoreEvent,
  DesktopApi,
  DesktopConnectInput,
  DesktopLocalConnectInput,
  DesktopSerialControlInput,
  DesktopSerialConnectInput,
  DesktopSftpConnectInput,
  KeyboardInteractiveRespondInput,
} from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import {
  subscribeContainerConnectionProgress,
  subscribeCoreEvent,
  subscribeSessionShareChatEvent,
  subscribeSessionShareEvent,
  subscribeSftpConnectionProgress,
  subscribeSshData,
  subscribeTransferEvent,
} from "../events/state";

export function buildSshBridge(ipcRenderer: IpcRenderer): DesktopApi["ssh"] {
  return {
    connect: (input: DesktopConnectInput) =>
      ipcRenderer.invoke(ipcChannels.ssh.connect, input),
    connectLocal: (input: DesktopLocalConnectInput) =>
      ipcRenderer.invoke(ipcChannels.ssh.connectLocal, input),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke(ipcChannels.ssh.write, sessionId, data),
    writeBinary: (sessionId: string, data: Uint8Array) =>
      ipcRenderer.invoke(ipcChannels.ssh.writeBinary, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(ipcChannels.ssh.resize, sessionId, cols, rows),
    disconnect: (sessionId: string) =>
      ipcRenderer.invoke(ipcChannels.ssh.disconnect, sessionId),
    respondKeyboardInteractive: (input: KeyboardInteractiveRespondInput) =>
      ipcRenderer.invoke(ipcChannels.ssh.respondKeyboardInteractive, input),
    onEvent: (listener: (event: CoreEvent) => void) =>
      subscribeCoreEvent(listener),
    onData: (sessionId: string, listener: (chunk: Uint8Array) => void) =>
      subscribeSshData(sessionId, listener),
  };
}

export function buildSerialBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["serial"] {
  return {
    connect: (input: DesktopSerialConnectInput) =>
      ipcRenderer.invoke(ipcChannels.serial.connect, input),
    listPorts: () => ipcRenderer.invoke(ipcChannels.serial.listPorts),
    control: (input: DesktopSerialControlInput) =>
      ipcRenderer.invoke(ipcChannels.serial.control, input),
  };
}

export function buildSessionSharesBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["sessionShares"] {
  return {
    start: (input) =>
      ipcRenderer.invoke(ipcChannels.sessionShares.start, input),
    updateSnapshot: (input) =>
      ipcRenderer.invoke(ipcChannels.sessionShares.updateSnapshot, input),
    setInputEnabled: (input) =>
      ipcRenderer.invoke(ipcChannels.sessionShares.setInputEnabled, input),
    stop: (sessionId: string) =>
      ipcRenderer.invoke(ipcChannels.sessionShares.stop, sessionId),
    openOwnerChatWindow: (sessionId: string) =>
      ipcRenderer.invoke(ipcChannels.sessionShares.openOwnerChatWindow, sessionId),
    sendOwnerChatMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke(
        ipcChannels.sessionShares.sendOwnerChatMessage,
        sessionId,
        text,
      ),
    getOwnerChatSnapshot: (sessionId: string) =>
      ipcRenderer.invoke(
        ipcChannels.sessionShares.getOwnerChatSnapshot,
        sessionId,
      ),
    onEvent: (listener) => subscribeSessionShareEvent(listener),
    onChatEvent: (listener) => subscribeSessionShareChatEvent(listener),
  };
}

export function buildContainersBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["containers"] {
  return {
    list: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.list, hostId),
    inspect: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.inspect, hostId, containerId),
    logs: (input) => ipcRenderer.invoke(ipcChannels.containers.logs, input),
    startTunnel: (input) =>
      ipcRenderer.invoke(ipcChannels.containers.startTunnel, input),
    stopTunnel: (runtimeId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.stopTunnel, runtimeId),
    start: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.start, hostId, containerId),
    stop: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.stop, hostId, containerId),
    restart: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.restart, hostId, containerId),
    remove: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.remove, hostId, containerId),
    stats: (input) => ipcRenderer.invoke(ipcChannels.containers.stats, input),
    searchLogs: (input) =>
      ipcRenderer.invoke(ipcChannels.containers.searchLogs, input),
    openShell: (hostId: string, containerId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.openShell, hostId, containerId),
    release: (hostId: string) =>
      ipcRenderer.invoke(ipcChannels.containers.release, hostId),
    onConnectionProgress: (listener) =>
      subscribeContainerConnectionProgress(listener),
  };
}

export function buildSftpBridge(
  ipcRenderer: IpcRenderer,
): DesktopApi["sftp"] {
  return {
    connect: (input: DesktopSftpConnectInput) =>
      ipcRenderer.invoke(ipcChannels.sftp.connect, input),
    disconnect: (endpointId: string) =>
      ipcRenderer.invoke(ipcChannels.sftp.disconnect, endpointId),
    list: (input) => ipcRenderer.invoke(ipcChannels.sftp.list, input),
    mkdir: (input) => ipcRenderer.invoke(ipcChannels.sftp.mkdir, input),
    rename: (input) => ipcRenderer.invoke(ipcChannels.sftp.rename, input),
    chmod: (input) => ipcRenderer.invoke(ipcChannels.sftp.chmod, input),
    delete: (input) => ipcRenderer.invoke(ipcChannels.sftp.delete, input),
    startTransfer: (input) =>
      ipcRenderer.invoke(ipcChannels.sftp.startTransfer, input),
    cancelTransfer: (jobId: string) =>
      ipcRenderer.invoke(ipcChannels.sftp.cancelTransfer, jobId),
    onConnectionProgress: (listener) =>
      subscribeSftpConnectionProgress(listener),
    onTransferEvent: (listener) => subscribeTransferEvent(listener),
  };
}
