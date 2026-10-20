import { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../../common/ipc-channels";
import { createCoreEventBridge } from "./core-event-bridge";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
}));

function createBridge() {
  const deps = {
    coreManager: {
      setTerminalEventHandler: vi.fn(),
      setPortForwardEventHandler: vi.fn(),
      setTerminalStreamHandler: vi.fn(),
      isTmuxSession: vi.fn(() => false),
    },
    sessionShareService: {
      handleTerminalEvent: vi.fn(),
      handleTerminalStream: vi.fn(),
    },
    sessionReplayService: {
      handleTerminalEvent: vi.fn(),
      handleTerminalStream: vi.fn(),
    },
    portForwardLifecycleLogger: {
      handleEvent: vi.fn(),
    },
    secretCoordinator: {
      persistHostSpecificSecret: vi.fn().mockResolvedValue("secret-1"),
    },
    tunnelRegistry: {
      stopSftpTunnelForEndpoint: vi.fn().mockResolvedValue(undefined),
      stopContainersTunnelForEndpoint: vi.fn().mockResolvedValue(undefined),
      stopContainerShellTunnelForSession: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    },
    awsSftpCoordinator: {
      clearPreflight: vi.fn(),
    },
  } as any;

  return {
    deps,
    bridge: createCoreEventBridge(deps),
    terminalHandler: () =>
      vi.mocked(deps.coreManager.setTerminalEventHandler).mock.calls[0][0] as (
        event: any,
      ) => Promise<void>,
  };
}

describe("core event bridge", () => {
  it("routes SFTP connection progress through the endpoint owner", () => {
    const { deps, bridge } = createBridge();
    deps.coreManager.sendSftpConnectionProgressToOwner = vi.fn(() => true);
    const event = {
      endpointId: "sftp-owned",
      hostId: "host-1",
      stage: "connecting-sftp" as const,
      message: "connecting",
    };

    bridge.emitSftpConnectionProgress(event);

    expect(
      deps.coreManager.sendSftpConnectionProgressToOwner,
    ).toHaveBeenCalledWith("sftp-owned", event);
  });

  it("routes Container connection progress through endpoint subscribers", () => {
    const { deps, bridge } = createBridge();
    deps.coreManager.sendContainersConnectionProgressToSubscribers = vi.fn(
      () => true,
    );
    const event = {
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "connecting-containers" as const,
      message: "connecting",
    };

    bridge.emitContainersConnectionProgress(event);

    expect(
      deps.coreManager.sendContainersConnectionProgressToSubscribers,
    ).toHaveBeenCalledWith("containers:host-1", event);
  });

  it("persists pending secrets on connected events", async () => {
    const { deps, bridge, terminalHandler } = createBridge();
    bridge.pendingSessionSecrets.set("session-1", {
      hostId: "host-1",
      label: "Prod",
      secrets: { password: "secret" },
    });

    await terminalHandler()({ type: "connected", sessionId: "session-1" });

    expect(deps.secretCoordinator.persistHostSpecificSecret).toHaveBeenCalledWith(
      "host-1",
      "Prod",
      { password: "secret" },
      undefined,
    );
    expect(bridge.pendingSessionSecrets.has("session-1")).toBe(false);
  });

  // 요청 창에서 바꾼 사용자 이름은 붙은 뒤에 저장되고(개인 호스트는 레코드, 팀 호스트는 내 칸), 화면이 호스트
  // 목록을 다시 읽는다.
  it("saves the username typed into the prompt once connected and has the windows reload hosts", async () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([
      { isDestroyed: () => false, webContents: { send } },
    ] as never);
    const { deps, bridge, terminalHandler } = createBridge();
    bridge.pendingSessionSecrets.set("session-1", {
      hostId: "host-1",
      label: "Prod",
      secrets: { password: "secret" },
      username: "bob",
    });

    await terminalHandler()({ type: "connected", sessionId: "session-1" });

    expect(deps.secretCoordinator.persistHostSpecificSecret).toHaveBeenCalledWith(
      "host-1",
      "Prod",
      { password: "secret" },
      "bob",
    );
    expect(send).toHaveBeenCalledWith(ipcChannels.bootstrap.workspaceChanged);
  });

  it("clears pending secrets and shell tunnels on closed events", async () => {
    const { deps, bridge, terminalHandler } = createBridge();
    bridge.pendingSessionSecrets.set("session-1", {
      hostId: "host-1",
      label: "Prod",
      secrets: { password: "secret" },
    });

    await terminalHandler()({ type: "closed", sessionId: "session-1" });

    expect(bridge.pendingSessionSecrets.has("session-1")).toBe(false);
    expect(
      deps.tunnelRegistry.stopContainerShellTunnelForSession,
    ).toHaveBeenCalledWith("session-1");
  });

  it("cleans endpoint-scoped resources on SFTP and container endpoint events", async () => {
    const { deps, terminalHandler } = createBridge();

    await terminalHandler()({
      type: "sftpDisconnected",
      endpointId: "sftp-1",
    });
    await terminalHandler()({
      type: "containersError",
      endpointId: "containers-1",
    });

    expect(deps.awsSftpCoordinator.clearPreflight).toHaveBeenCalledWith("sftp-1");
    expect(deps.tunnelRegistry.stopSftpTunnelForEndpoint).toHaveBeenCalledWith(
      "sftp-1",
    );
    expect(deps.awsSftpCoordinator.clearPreflight).toHaveBeenCalledWith(
      "containers-1",
    );
    expect(deps.tunnelRegistry.stopContainersTunnelForEndpoint).toHaveBeenCalledWith(
      "containers-1",
    );
  });
});
