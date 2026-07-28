import type { IpcRenderer } from "electron";
import type {
  AiChatEvent,
  AuthState,
  ContainerConnectionProgressEvent,
  CoreEvent,
  DesktopWindowState,
  PortForwardRuntimeEvent,
  SessionShareChatEvent,
  SessionShareEvent,
  SftpConnectionProgressEvent,
  TailnetStatus,
  TransferJobEvent,
  UpdateEvent,
  WarpgateImportEvent,
} from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import {
  emitAiChatEvent,
  emitAiTerminalOutputRequest,
  emitAuthEvent,
  emitActivityLogsChanged,
  emitContainerConnectionProgress,
  emitTailnetStatus,
  emitCoreEvent,
  emitPortForwardEvent,
  emitSessionShareChatEvent,
  emitSessionShareEvent,
  emitCloseActiveTab,
  emitTabCommand,
  emitSftpConnectionProgress,
  emitSshData,
  emitSystemResume,
  emitTransferEvent,
  emitUpdateEvent,
  emitWarpgateImportEvent,
  emitWindowState,
  emitWorkspaceChanged,
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
    ipcChannels.tailnet.status,
    (_event, payload: TailnetStatus) => {
      emitTailnetStatus(payload);
    },
  );

  ipcRenderer.on(ipcChannels.logs.changed, () => {
    emitActivityLogsChanged();
  });

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

  ipcRenderer.on(ipcChannels.ai.chatEvent, (_event, payload: AiChatEvent) => {
    emitAiChatEvent(payload);
  });

  ipcRenderer.on(ipcChannels.ai.terminalOutputRequest, (_event, payload) => {
    emitAiTerminalOutputRequest(payload);
  });

  ipcRenderer.on(ipcChannels.auth.event, (_event, payload: AuthState) => {
    emitAuthEvent(payload);
  });

  ipcRenderer.on(ipcChannels.bootstrap.workspaceChanged, () => {
    emitWorkspaceChanged();
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

  ipcRenderer.on(ipcChannels.system.resume, () => {
    emitSystemResume();
  });
  ipcRenderer.on(ipcChannels.window.closeActiveTab, () => {
    emitCloseActiveTab();
  });
  ipcRenderer.on(ipcChannels.window.tabCommand, (_event, payload) => {
    emitTabCommand(payload as import('@shared').TabCommandPayload);
  });
}
