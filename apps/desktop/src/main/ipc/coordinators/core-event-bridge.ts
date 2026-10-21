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
import type { AwsConnectionProgressEmitter, PendingHopSecret } from "../context";
import { t } from '../../i18n';

export interface CoreEventBridge {
  pendingSessionSecrets: Map<
    string,
    {
      hostId: string;
      label: string;
      secrets: HostSecretInput;
      /** 요청 창에서 넣은 사용자 이름. 붙으면 그 자리(개인=호스트, 팀=내 칸)에 저장한다. */
      username?: string | null;
      /** 요청 창에서 넣은 점프 호스트의 값. 붙으면 홉마다 그 자리에 저장한다. */
      jumps?: PendingHopSecret[];
    }
  >;
  emitSftpConnectionProgress: AwsConnectionProgressEmitter;
  emitContainersConnectionProgress: AwsConnectionProgressEmitter;
  resolveWindowFromSender: (sender: Electron.WebContents) => BrowserWindow;
  buildWindowState: (window: BrowserWindow) => {
    isMaximized: boolean;
    isFullScreen: boolean;
  };
  emitWorkspaceChanged: (sender?: Electron.WebContents) => void;
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
      username?: string | null;
      jumps?: PendingHopSecret[];
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
    if (
      typeof coreManager.sendSftpConnectionProgressToOwner === "function" &&
      coreManager.sendSftpConnectionProgressToOwner(event.endpointId, event)
    ) {
      return;
    }
    sendToAllWindows(ipcChannels.sftp.connectionProgress, event);
  };

  const emitContainersConnectionProgress: AwsConnectionProgressEmitter = (event) => {
    if (
      typeof coreManager.sendContainersConnectionProgressToSubscribers ===
        "function" &&
      coreManager.sendContainersConnectionProgressToSubscribers(
        event.endpointId,
        event,
      )
    ) {
      return;
    }
    sendToAllWindows(ipcChannels.containers.connectionProgress, event);
  };

  const resolveWindowFromSender = (
    sender: Electron.WebContents,
  ): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) {
      throw new Error(t('misc.windowNotFound'));
    }
    return window;
  };

  const buildWindowState = (window: BrowserWindow) => ({
    isFullScreen: window.isFullScreen(),
    isMaximized: window.isMaximized(),
  });

  const emitWorkspaceChanged = (sender?: Electron.WebContents) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents !== sender) {
        window.webContents.send(ipcChannels.bootstrap.workspaceChanged);
      }
    }
  };

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
        pending.username,
      );
      // 요청 창에 넣은 점프 호스트의 값도 그 홉 제자리에(팀 호스트는 내 자격 증명).
      for (const hop of pending.jumps ?? []) {
        await secretCoordinator.persistHostSpecificSecret(hop.hostId, hop.label, hop.secrets, hop.username);
      }
      if (pending.username || pending.jumps?.some((hop) => hop.username)) {
        // 개인 호스트면 레코드의 사용자 이름이 바뀌었다 — 화면이 호스트 목록을 다시 읽게 한다.
        emitWorkspaceChanged();
      }
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
    emitWorkspaceChanged,
  };
}
