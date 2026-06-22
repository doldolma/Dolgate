import { describe, expect, it, vi } from "vitest";
import { createMainIpcContext } from "./ipc-context-factory";
import type { RegisterIpcDependencies } from "./ipc-context-factory";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
}));

function createDependencies(): RegisterIpcDependencies {
  return {
    hosts: {
      list: vi.fn(() => []),
      updateSecretRef: vi.fn(),
    } as any,
    groups: {
      list: vi.fn(() => []),
    } as any,
    settings: {
      get: vi.fn(() => ({ theme: "system" })),
    } as any,
    portForwards: {
      list: vi.fn(() => []),
    } as any,
    dnsOverrides: {
      list: vi.fn(() => []),
    } as any,
    snippets: {
      list: vi.fn(() => []),
    } as any,
    knownHosts: {
      list: vi.fn(() => []),
    } as any,
    activityLogs: {
      list: vi.fn(() => []),
      append: vi.fn(),
    } as any,
    secretMetadata: {
      list: vi.fn(() => []),
      upsert: vi.fn(),
    } as any,
    syncOutbox: {} as any,
    secretStore: {
      save: vi.fn(),
      load: vi.fn(),
    } as any,
    awsService: {} as any,
    awsSsmTunnelService: {
      stop: vi.fn().mockResolvedValue(undefined),
    } as any,
    warpgateService: {} as any,
    coreManager: {
      listTabs: vi.fn(() => []),
      listPortForwardRuntimes: vi.fn(() => []),
      setTerminalEventHandler: vi.fn(),
      setPortForwardEventHandler: vi.fn(),
      setTerminalStreamHandler: vi.fn(),
      isTmuxSession: vi.fn(() => false),
    } as any,
    hostsOverrideManager: {
      pruneStaticOverrideStates: vi.fn(),
      getActiveStaticOverrideIds: vi.fn(() => new Set<string>()),
    } as any,
    updater: {} as any,
    authService: {} as any,
    syncService: {
      pushDirty: vi.fn().mockResolvedValue(undefined),
    } as any,
    termiusImportService: {} as any,
    opensshImportService: {} as any,
    xshellImportService: {} as any,
    sessionShareService: {
      handleTerminalEvent: vi.fn(),
      handleTerminalStream: vi.fn(),
    } as any,
    sessionReplayService: {
      handleTerminalEvent: vi.fn(),
      handleTerminalStream: vi.fn(),
    } as any,
  };
}

describe("createMainIpcContext", () => {
  it("builds synced workspace snapshots through the coordinator context", async () => {
    const deps = createDependencies();
    vi.mocked(deps.hosts.list).mockReturnValueOnce([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        secretRef: null,
        groupName: null,
        terminalThemeId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as any);
    vi.mocked(deps.groups.list).mockReturnValueOnce([
      {
        id: "group-1",
        path: "Servers",
        name: "Servers",
        parentPath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as any);

    const ctx = createMainIpcContext(deps);
    const snapshot = await ctx.getSyncedWorkspaceSnapshot();

    expect(snapshot.hosts).toHaveLength(1);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.portForwardSnapshot).toEqual({ rules: [], runtimes: [] });
    expect(snapshot.dnsOverrides).toEqual([]);
    expect(deps.hostsOverrideManager.pruneStaticOverrideStates).toHaveBeenCalled();
  });

  it("persists pending session secrets after the core connection event", async () => {
    const deps = createDependencies();
    const ctx = createMainIpcContext(deps);
    const handler = vi.mocked(deps.coreManager.setTerminalEventHandler).mock
      .calls[0]?.[0] as (event: any) => Promise<void>;

    ctx.pendingSessionSecrets.set("session-1", {
      hostId: "host-1",
      label: "Prod",
      secrets: { password: "secret" },
    });
    await handler({ type: "connected", sessionId: "session-1" });

    expect(deps.secretStore.save).toHaveBeenCalledTimes(1);
    expect(deps.hosts.updateSecretRef).toHaveBeenCalledWith(
      "host-1",
      expect.stringMatching(/^secret:/),
    );
    expect(ctx.pendingSessionSecrets.has("session-1")).toBe(false);
  });

  it("stops endpoint-scoped AWS SFTP tunnels when the core endpoint closes", async () => {
    const deps = createDependencies();
    const ctx = createMainIpcContext(deps);
    const handler = vi.mocked(deps.coreManager.setTerminalEventHandler).mock
      .calls[0]?.[0] as (event: any) => Promise<void>;

    ctx.trackAwsSftpTunnelRuntime("endpoint-1", "runtime-1");
    await handler({ type: "sftpDisconnected", endpointId: "endpoint-1" });

    expect(deps.awsSsmTunnelService.stop).toHaveBeenCalledWith("runtime-1");
  });
});
