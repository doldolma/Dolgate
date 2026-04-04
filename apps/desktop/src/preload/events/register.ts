import type { IpcRenderer } from "electron";
import type {
  AuthState,
  ContainerConnectionProgressEvent,
  CoreEvent,
  DesktopWindowState,
  PortForwardRuntimeEvent,
  SessionShareChatEvent,
  SessionShareEvent,
  SftpConnectionProgressEvent,
  TransferJobEvent,
  UpdateEvent,
  WarpgateImportEvent,
} from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import {
  emitAuthEvent,
  emitContainerConnectionProgress,
  emitCoreEvent,
  emitPortForwardEvent,
  emitSessionShareChatEvent,
  emitSessionShareEvent,
  emitSftpConnectionProgress,
  emitSshData,
  emitTransferEvent,
  emitUpdateEvent,
  emitWarpgateImportEvent,
  emitWindowState,
} from "./state";

let bindingsRegistered = false;

export function registerPreloadEventBindings(ipcRenderer: IpcRenderer): void {
  if (bindingsRegistered) {
    return;
  }
  bindingsRegistered = true;

  ipcRenderer.on(ipcChannels.ssh.event, (_event, payload: CoreEvent) => {
    emitCoreEvent(payload);
  });

  ipcRenderer.on(
    ipcChannels.ssh.data,
    (_event, payload: { sessionId: string; chunk: Uint8Array }) => {
      emitSshData(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.sftp.connectionProgress,
    (_event, payload: SftpConnectionProgressEvent) => {
      emitSftpConnectionProgress(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.containers.connectionProgress,
    (_event, payload: ContainerConnectionProgressEvent) => {
      emitContainerConnectionProgress(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.sftp.transferEvent,
    (_event, payload: TransferJobEvent) => {
      emitTransferEvent(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.portForwards.event,
    (_event, payload: PortForwardRuntimeEvent) => {
      emitPortForwardEvent(payload);
    },
  );

  ipcRenderer.on(ipcChannels.updater.event, (_event, payload: UpdateEvent) => {
    emitUpdateEvent(payload);
  });

  ipcRenderer.on(ipcChannels.auth.event, (_event, payload: AuthState) => {
    emitAuthEvent(payload);
  });

  ipcRenderer.on(
    ipcChannels.warpgate.event,
    (_event, payload: WarpgateImportEvent) => {
      emitWarpgateImportEvent(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.window.stateChanged,
    (_event, payload: DesktopWindowState) => {
      emitWindowState(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.sessionShares.event,
    (_event, payload: SessionShareEvent) => {
      emitSessionShareEvent(payload);
    },
  );

  ipcRenderer.on(
    ipcChannels.sessionShares.chatEvent,
    (_event, payload: SessionShareChatEvent) => {
      emitSessionShareChatEvent(payload);
    },
  );
}
