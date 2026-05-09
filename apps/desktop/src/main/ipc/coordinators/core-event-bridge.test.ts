import { describe, expect, it, vi } from "vitest";
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
    );
    expect(bridge.pendingSessionSecrets.has("session-1")).toBe(false);
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
