import { BrowserWindow } from "electron";
import { ipcChannels } from "../../../common/ipc-channels";
import type { HostSecretInput } from "@shared";
import type { CoreManager } from "../../core-manager";
import type { PortForwardLifecycleLogger } from "../../port-forward-lifecycle-logger";
import type { SessionReplayService } from "../../session-replay-service";
import type { SessionShareService } from "../../session-share-service";
import type { AwsSftpCoordinator } from "./aws-sftp-coordinator";
import type { SecretCoordinator } from "./secret-coordinator";
import type { TunnelRegistry } from "./tunnel-registry";
import type { AwsConnectionProgressEmitter } from "../context";

export interface CoreEventBridge {
  pendingSessionSecrets: Map<
    string,
    {
      hostId: string;
      label: string;
      secrets: HostSecretInput;
    }
  >;
  emitSftpConnectionProgress: AwsConnectionProgressEmitter;
  emitContainersConnectionProgress: AwsConnectionProgressEmitter;
  resolveWindowFromSender: (sender: Electron.WebContents) => BrowserWindow;
  buildWindowState: (window: BrowserWindow) => {
    isMaximized: boolean;
  };
}

export function createCoreEventBridge(deps: {
  coreManager: CoreManager;
  sessionShareService: SessionShareService;
  sessionReplayService: SessionReplayService;
  portForwardLifecycleLogger: PortForwardLifecycleLogger;
  secretCoordinator: SecretCoordinator;
  tunnelRegistry: TunnelRegistry;
  awsSftpCoordinator: AwsSftpCoordinator;
}): CoreEventBridge {
  const {
    coreManager,
    sessionShareService,
    sessionReplayService,
    portForwardLifecycleLogger,
    secretCoordinator,
    tunnelRegistry,
    awsSftpCoordinator,
  } = deps;

  const pendingSessionSecrets = new Map<
    string,
    {
      hostId: string;
      label: string;
      secrets: HostSecretInput;
    }
  >();

  const sendToAllWindows = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };

  const emitSftpConnectionProgress: AwsConnectionProgressEmitter = (event) => {
    sendToAllWindows(ipcChannels.sftp.connectionProgress, event);
  };

  const emitContainersConnectionProgress: AwsConnectionProgressEmitter = (event) => {
    sendToAllWindows(ipcChannels.containers.connectionProgress, event);
  };

  const resolveWindowFromSender = (
    sender: Electron.WebContents,
  ): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) {
      throw new Error("호출한 브라우저 윈도우를 찾을 수 없습니다.");
    }
    return window;
  };

  const buildWindowState = (window: BrowserWindow) => ({
    isMaximized: window.isMaximized(),
  });

  coreManager.setTerminalEventHandler(async (event) => {
    sessionShareService.handleTerminalEvent(event);
    // tmux 세션은 녹화하지 않는다(control 세션 "connected" → 빈 리플레이 파일 방지).
    if (!coreManager.isTmuxSession(event.sessionId)) {
      sessionReplayService.handleTerminalEvent(event);
    }
    if (event.endpointId) {
      if (event.type === "sftpDisconnected" || event.type === "sftpError") {
        awsSftpCoordinator.clearPreflight(event.endpointId);
        await tunnelRegistry.stopSftpTunnelForEndpoint(event.endpointId);
      }
      if (
        event.type === "containersDisconnected" ||
        event.type === "containersError"
      ) {
        awsSftpCoordinator.clearPreflight(event.endpointId);
        await tunnelRegistry.stopContainersTunnelForEndpoint(event.endpointId);
      }
      return;
    }
    if (!event.sessionId) {
      return;
    }

    if (event.type === "connected") {
      const pending = pendingSessionSecrets.get(event.sessionId);
      if (!pending) {
        return;
      }
      pendingSessionSecrets.delete(event.sessionId);
      await secretCoordinator.persistHostSpecificSecret(
        pending.hostId,
        pending.label,
        pending.secrets,
      );
      return;
    }

    if (event.type === "closed" || event.type === "error") {
      pendingSessionSecrets.delete(event.sessionId);
      await tunnelRegistry.stopContainerShellTunnelForSession(event.sessionId);
    }
    if (
      event.type === "status" &&
      String(event.payload.status ?? "") === "stopped"
    ) {
      await tunnelRegistry.stopAll();
    }
  });

  coreManager.setPortForwardEventHandler(async (event) => {
    portForwardLifecycleLogger.handleEvent(event);
    if (
      event.runtime.status === "stopped" ||
      event.runtime.status === "error"
    ) {
      await tunnelRegistry.stopContainersTunnelForEndpoint(event.runtime.ruleId);
    }
  });

  coreManager.setTerminalStreamHandler((sessionId, chunk) => {
    sessionShareService.handleTerminalStream(sessionId, chunk);
    // tmux 세션(control/pane)은 세션 녹화에서 제외한다(공유는 위에서 유지). pane 출력은
    // tmux: sessionId 라 control 녹화에 안 잡히고, control 세션 녹화는 빈 파일만 남는다.
    if (!coreManager.isTmuxSession(sessionId)) {
      sessionReplayService.handleTerminalStream(sessionId, chunk);
    }
  });

  return {
    pendingSessionSecrets,
    emitSftpConnectionProgress,
    emitContainersConnectionProgress,
    resolveWindowFromSender,
    buildWindowState,
  };
}
