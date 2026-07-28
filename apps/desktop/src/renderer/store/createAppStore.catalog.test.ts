import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
} from "@shared";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, isSshHostRecord } from "@shared";
import type { HostContainersTabState } from "./createAppStore";
import { createAppStore, upsertTransferJob } from "./createAppStore";
import {
  createAwsEc2Host,
  createContainerDetails,
  createContainerSummary,
  createContainerTab,
  createDeferred,
  createEcsHost,
  createMockApi,
  createUntrustedHostProbe,
  flushMicrotasks,
} from "./createAppStore.test-support";

describe("createAppStore catalog and settings", () => {
  it("bootstraps home workspace and settings from desktop api", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();

    expect(api.bootstrap.getInitialSnapshot).toHaveBeenCalledTimes(1);
    expect(store.getState().hosts).toHaveLength(1);
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("hosts");
    expect(store.getState().settingsSection).toBe("general");
    expect(store.getState().savedCredentialsSearchQuery).toBe("");
    expect(store.getState().currentGroupPath).toBeNull();
    expect(store.getState().settings.theme).toBe("system");
    expect(store.getState().sftp.leftPane.currentPath).toBe("/Users/tester");
    expect(store.getState().sftp.rightPane.sourceKind).toBe("host");
    expect(store.getState().portForwards).toHaveLength(0);
    expect(store.getState().dnsOverrides).toHaveLength(0);
    expect(store.getState().knownHosts).toHaveLength(0);
  });

  it("refreshes synced workspace data without resetting tabs or sftp state", async () => {
    const api = createMockApi();
    vi.mocked(api.hosts.list)
      .mockResolvedValueOnce([
        {
          id: "host-1",
          kind: "ssh",
          label: "Prod",
          hostname: "prod.example.com",
          port: 22,
          username: "ubuntu",
          authType: "password",
          privateKeyPath: null,
          secretRef: "host:host-1",
          groupName: "Servers",
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "host-2",
          kind: "ssh",
          label: "Next",
          hostname: "next.example.com",
          port: 2202,
          username: "dol",
          authType: "password",
          privateKeyPath: null,
          secretRef: "host:host-2",
          groupName: "Synced",
          terminalThemeId: null,
          createdAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ]);
    vi.mocked(api.groups.list)
      .mockResolvedValueOnce([
        {
          id: "group-1",
          name: "Servers",
          path: "Servers",
          parentPath: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "group-2",
          name: "Synced",
          path: "Synced",
          parentPath: null,
          createdAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ]);
    vi.mocked(api.portForwards.list)
      .mockResolvedValueOnce({
        rules: [],
        runtimes: [],
      })
      .mockResolvedValueOnce({
        rules: [
          {
            id: "forward-2",
            label: "Synced forward",
            transport: "ssh",
            mode: "local",
            hostId: "host-2",
            bindAddress: "127.0.0.1",
            bindPort: 8080,
            targetHost: "127.0.0.1",
            targetPort: 80,
            createdAt: "2025-01-02T00:00:00.000Z",
            updatedAt: "2025-01-02T00:00:00.000Z",
          },
        ],
        runtimes: [],
      });
    vi.mocked(api.dnsOverrides.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "dns-2",
          type: "static",
          hostname: "basket",
          address: "10.0.1.15",
          status: "inactive",
          createdAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ]);
    vi.mocked(api.knownHosts.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "known-2",
          host: "next.example.com",
          port: 2202,
          algorithm: "ssh-ed25519",
          publicKeyBase64: "AAAATESTNEXT",
          fingerprintSha256: "SHA256:next",
          createdAt: "2025-01-02T00:00:00.000Z",
          lastSeenAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ]);
    vi.mocked(api.keychain.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          secretRef: "secret:host-2",
          label: "Next Secret",
          hasPassword: true,
          hasPassphrase: false,
          hasManagedPrivateKey: false,
          hasCertificate: false,
          linkedHostCount: 1,
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ]);
    vi.mocked(api.settings.get)
      .mockResolvedValueOnce({
        theme: "system",
        globalTerminalThemeId: "dolssh-dark",
        terminalFontFamily: "sf-mono",
        terminalFontSize: 13,
        terminalScrollbackLines: 5000,
        terminalLineHeight: 1,
        terminalLetterSpacing: 0,
        terminalMinimumContrastRatio: 1,
        terminalAltIsMeta: false,
        terminalWebglEnabled: true,
        terminalAutocompleteEnabled: false,
        sftpBrowserColumnWidths: DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
        commandNotificationsEnabled: true,
        commandNotificationThresholdSeconds: 30,
        commandNotificationOnlyWhenUnfocused: true,
        commandNotificationOnFailure: true,
        commandNotificationSound: false,
        hostMetricsEnabled: false,
        autoReconnectEnabled: true,
        autoReconnectMaxAttempts: 10,
        autoReconnectBaseDelayMs: 1000,
        autoReconnectMaxDelayMs: 30000,
        updatedAt: "2025-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        theme: "dark",
        globalTerminalThemeId: "dolssh-dark",
        terminalFontFamily: "sf-mono",
        terminalFontSize: 13,
        terminalScrollbackLines: 5000,
        terminalLineHeight: 1,
        terminalLetterSpacing: 0,
        terminalMinimumContrastRatio: 1,
        terminalAltIsMeta: false,
        terminalWebglEnabled: true,
        terminalAutocompleteEnabled: false,
        sftpBrowserColumnWidths: DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
        commandNotificationsEnabled: true,
        commandNotificationThresholdSeconds: 30,
        commandNotificationOnlyWhenUnfocused: true,
        commandNotificationOnFailure: true,
        commandNotificationSound: false,
        hostMetricsEnabled: false,
        autoReconnectEnabled: true,
        autoReconnectMaxAttempts: 10,
        autoReconnectBaseDelayMs: 1000,
        autoReconnectMaxDelayMs: 30000,
        updatedAt: "2025-01-02T00:00:00.000Z",
      });

    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState({
      activeWorkspaceTab: "session:session-1",
      sftp: {
        ...store.getState().sftp,
        leftPane: {
          ...store.getState().sftp.leftPane,
          currentPath: "/Users/tester/Documents",
        },
      },
    });

    await store.getState().refreshSyncedWorkspaceData();

    expect(api.bootstrap.getSyncedWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(store.getState().hosts.map((host) => host.id)).toEqual(["host-2"]);
    expect(store.getState().groups.map((group) => group.id)).toEqual(["group-2"]);
    expect(store.getState().portForwards.map((rule) => rule.id)).toEqual(["forward-2"]);
    expect(store.getState().dnsOverrides.map((override) => override.id)).toEqual(["dns-2"]);
    expect(store.getState().knownHosts.map((record) => record.id)).toEqual(["known-2"]);
    expect(store.getState().keychainEntries.map((entry) => entry.secretRef)).toEqual([
      "secret:host-2",
    ]);
    expect(store.getState().settings.theme).toBe("dark");
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
    expect(store.getState().sftp.leftPane.currentPath).toBe(
      "/Users/tester/Documents",
    );
  });

  it("clears synced workspace slices without touching local workspace state", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.setState({
      activeWorkspaceTab: "session:session-1",
      activityLogs: [
        {
          id: "log-1",
          level: "info",
          category: "audit",
          message: "local account log",
          metadata: null,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      dnsOverrides: [
        {
          id: "dns-1",
          type: "static",
          hostname: "basket",
          address: "10.0.1.15",
          status: "active",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });

    store.getState().clearSyncedWorkspaceData();

    expect(store.getState().hosts).toEqual([]);
    expect(store.getState().groups).toEqual([]);
    expect(store.getState().dnsOverrides).toEqual([]);
    expect(store.getState().activityLogs).toEqual([]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
  });

  it("opens create and edit drawers from home", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openCreateHostDrawer();
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: null,
      kind: "ssh",
    });

    store.getState().openCreateSerialDrawer();
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: null,
      kind: "serial",
    });

    store.getState().openEditHostDrawer("host-1");
    expect(store.getState().hostDrawer).toEqual({
      mode: "edit",
      hostId: "host-1",
    });
  });

  it("normalizes legacy known hosts and keychain sections into settings subsections", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();

    store.getState().openHomeSection("knownHosts" as never);
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("security");

    store.getState().openHomeSection("keychain" as never);
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("secrets");

    store.getState().openSettingsSection("general");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("general");
  });

  // 호스트를 편집하다 TAILNET·SAVED CREDENTIALS 옆 "Manage" 로 설정을 다녀오는 것이 정상
  // 흐름이다. 드로어를 닫아 버리면 돌아왔을 때 편집하던 호스트를 다시 찾아 들어가야 한다.
  //
  // 열어 둬도 설정 화면을 가리지 않는다 — 드로어는 HostBrowser 안에 렌더되고 그건
  // homeSection === "hosts" 일 때만 마운트된다.
  it("keeps the host editor open while visiting settings", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openEditHostDrawer("host-1");
    expect(store.getState().hostDrawer).toEqual({ mode: "edit", hostId: "host-1" });

    store.getState().openSettingsSection("tailnet");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("tailnet");
    // 편집 중이던 호스트가 그대로 남아야 한다.
    expect(store.getState().hostDrawer).toEqual({ mode: "edit", hostId: "host-1" });

    store.getState().openHomeSection("hosts");
    expect(store.getState().hostDrawer).toEqual({ mode: "edit", hostId: "host-1" });
  });

  it("preserves saved credentials search while navigating settings", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    expect(store.getState().savedCredentialsSearchQuery).toBe("");

    store.getState().setSavedCredentialsSearchQuery("backup");
    store.getState().openHomeSection("hosts");
    expect(store.getState().savedCredentialsSearchQuery).toBe("backup");

    store.getState().openSettingsSection("general");
    expect(store.getState().savedCredentialsSearchQuery).toBe("backup");

    store.getState().openSettingsSection("secrets");
    expect(store.getState().savedCredentialsSearchQuery).toBe("backup");
  });

  it("clears the SFTP filter only when the pane path changes", async () => {
    const api = createMockApi();
    api.files.list = vi.fn().mockImplementation(async (targetPath: string) => {
      if (targetPath === "/Users/tester/Desktop") {
        return {
          path: "/Users/tester/Desktop",
          entries: [
            {
              name: "notes.txt",
              path: "/Users/tester/Desktop/notes.txt",
              isDirectory: false,
              size: 12,
              mtime: "2025-01-01T00:00:00.000Z",
              kind: "file",
              permissions: "rw-r--r--",
            },
          ],
        };
      }
      return {
        path: "/Users/tester",
        entries: [
          {
            name: "Desktop",
            path: "/Users/tester/Desktop",
            isDirectory: true,
            size: 0,
            mtime: "2025-01-01T00:00:00.000Z",
            kind: "folder",
            permissions: "rwxr-xr-x",
          },
        ],
      };
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().setSftpPaneFilter("left", "desk");
    expect(store.getState().sftp.leftPane.filterQuery).toBe("desk");

    await store.getState().refreshSftpPane("left");
    expect(store.getState().sftp.leftPane.filterQuery).toBe("desk");

    await store.getState().openSftpEntry("left", "/Users/tester/Desktop");
    expect(store.getState().sftp.leftPane.currentPath).toBe(
      "/Users/tester/Desktop",
    );
    expect(store.getState().sftp.leftPane.filterQuery).toBe("");
  });

  it("navigates groups and creates a group at the current location", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().navigateGroup("Servers");
    store.getState().openCreateHostDrawer();

    expect(store.getState().currentGroupPath).toBe("Servers");
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: "Servers",
      kind: "ssh",
    });

    await store.getState().createGroup("Production");

    expect(api.groups.create).toHaveBeenCalledWith("Production", "Servers");
    expect(
      store
        .getState()
        .groups.some((group) => group.path === "Servers/Production"),
    ).toBe(true);
  });

  it("replaces hosts and groups after removing a group subtree", async () => {
    const api = createMockApi();
    api.groups.remove = vi.fn().mockResolvedValue({
      groups: [],
      hosts: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().navigateGroup("Servers");
    await store.getState().removeGroup("Servers", "delete-subtree");

    expect(api.groups.remove).toHaveBeenCalledWith("Servers", "delete-subtree");
    expect(store.getState().groups).toEqual([]);
    expect(store.getState().hosts).toEqual([]);
    expect(store.getState().currentGroupPath).toBeNull();
  });

  it("rebases the current group path and create drawer default path when moving a group", async () => {
    const api = createMockApi();
    api.groups.move = vi.fn().mockResolvedValue({
      groups: [
        {
          id: "group-1",
          name: "Nested",
          path: "Clients/Nested",
          parentPath: "Clients",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-04T00:00:00.000Z",
        },
      ],
      hosts: [
        {
          id: "host-1",
          kind: "ssh",
          label: "Prod",
          hostname: "prod.example.com",
          port: 22,
          username: "ubuntu",
          authType: "password",
          privateKeyPath: null,
          secretRef: "host:host-1",
          groupName: "Clients/Nested",
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-04T00:00:00.000Z",
        },
      ],
      nextPath: "Clients/Nested",
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().navigateGroup("Servers/Nested");
    store.setState({
      hostDrawer: {
        mode: "create",
        defaultGroupPath: "Servers/Nested",
        kind: "ssh",
      },
    });

    await store.getState().moveGroup("Servers/Nested", "Clients");

    expect(api.groups.move).toHaveBeenCalledWith("Servers/Nested", "Clients");
    expect(store.getState().currentGroupPath).toBe("Clients/Nested");
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: "Clients/Nested",
      kind: "ssh",
    });
    expect(store.getState().hosts[0]?.groupName).toBe("Clients/Nested");
  });

  it("rebases the current group path and create drawer default path when renaming a group", async () => {
    const api = createMockApi();
    api.groups.rename = vi.fn().mockResolvedValue({
      groups: [
        {
          id: "group-1",
          name: "API",
          path: "Servers/API",
          parentPath: "Servers",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-04T00:00:00.000Z",
        },
      ],
      hosts: [
        {
          id: "host-1",
          kind: "ssh",
          label: "Prod",
          hostname: "prod.example.com",
          port: 22,
          username: "ubuntu",
          authType: "password",
          privateKeyPath: null,
          secretRef: "host:host-1",
          groupName: "Servers/API",
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-04T00:00:00.000Z",
        },
      ],
      nextPath: "Servers/API",
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().navigateGroup("Servers");
    store.setState({
      hostDrawer: {
        mode: "create",
        defaultGroupPath: "Servers/Nested",
        kind: "ssh",
      },
    });

    await store.getState().renameGroup("Servers/Nested", "API");

    expect(api.groups.rename).toHaveBeenCalledWith("Servers/Nested", "API");
    expect(store.getState().currentGroupPath).toBe("Servers");
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: "Servers/API",
      kind: "ssh",
    });
    expect(store.getState().hosts[0]?.groupName).toBe("Servers/API");
  });

  it("duplicates hosts with copy suffixes and reuses existing auth references", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "privateKey",
        privateKeyPath: "C:/keys/prod",
        secretRef: "host:shared",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "host-2",
        kind: "ssh",
        label: "Prod Copy",
        hostname: "prod-copy.example.com",
        port: 22,
        username: "ubuntu",
        authType: "privateKey",
        privateKeyPath: "C:/keys/prod",
        secretRef: "host:shared",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "host-3",
        kind: "aws-ec2",
        label: "Bastion",
        groupName: null,
        tags: ["ops"],
        terminalThemeId: null,
        awsProfileName: "default",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234",
        awsInstanceName: "bastion",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "host-4",
        kind: "warpgate-ssh",
        label: "Gateway",
        groupName: null,
        tags: [],
        terminalThemeId: null,
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "db-admin",
        warpgateUsername: "alice",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    vi.mocked(api.hosts.create).mockImplementation(async (draft: HostDraft) => {
      const createdAt = "2025-01-05T00:00:00.000Z";
      const recordBase = {
        id: `copy-${vi.mocked(api.hosts.create).mock.calls.length}`,
        label: draft.label,
        groupName: draft.groupName ?? null,
        tags: draft.tags ?? [],
        terminalThemeId: draft.terminalThemeId ?? null,
        createdAt,
        updatedAt: createdAt,
      };

      if (draft.kind === "aws-ec2") {
        return {
          ...recordBase,
          kind: "aws-ec2",
          awsProfileName: draft.awsProfileName,
          awsRegion: draft.awsRegion,
          awsInstanceId: draft.awsInstanceId,
          awsInstanceName: draft.awsInstanceName ?? null,
          awsPlatform: draft.awsPlatform ?? null,
          awsPrivateIp: draft.awsPrivateIp ?? null,
          awsState: draft.awsState ?? null,
        } satisfies HostRecord;
      }
      if (draft.kind === "warpgate-ssh") {
        return {
          ...recordBase,
          kind: "warpgate-ssh",
          warpgateBaseUrl: draft.warpgateBaseUrl,
          warpgateSshHost: draft.warpgateSshHost,
          warpgateSshPort: draft.warpgateSshPort,
          warpgateTargetId: draft.warpgateTargetId,
          warpgateTargetName: draft.warpgateTargetName,
          warpgateUsername: draft.warpgateUsername,
        } satisfies HostRecord;
      }
      if (draft.kind === "aws-ecs") {
        return {
          ...recordBase,
          kind: "aws-ecs",
          awsProfileName: draft.awsProfileName,
          awsRegion: draft.awsRegion,
          awsEcsClusterArn: draft.awsEcsClusterArn,
          awsEcsClusterName: draft.awsEcsClusterName,
        } satisfies HostRecord;
      }
      if (draft.kind === "serial") {
        return {
          ...recordBase,
          kind: "serial",
          transport: draft.transport,
          devicePath: draft.devicePath ?? null,
          host: draft.host ?? null,
          port: draft.port ?? null,
          baudRate: draft.baudRate,
          dataBits: draft.dataBits,
          parity: draft.parity,
          stopBits: draft.stopBits,
          flowControl: draft.flowControl,
          transmitLineEnding: draft.transmitLineEnding,
          localEcho: draft.localEcho,
          localLineEditing: draft.localLineEditing,
        } satisfies HostRecord;
      }
      return {
        ...recordBase,
        kind: "ssh",
        hostname: draft.hostname,
        port: draft.port ?? 22,
        username: draft.username,
        authType: draft.authType,
        privateKeyPath: draft.privateKeyPath ?? null,
        certificatePath: draft.certificatePath ?? null,
        secretRef: draft.secretRef ?? null,
      } satisfies HostRecord;
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().duplicateHosts(["host-1", "host-3", "host-4"]);

    expect(api.hosts.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "ssh",
        label: "Prod Copy 2",
        secretRef: "host:shared",
        privateKeyPath: null,
      }),
    );
    expect(api.hosts.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "aws-ec2",
        label: "Bastion Copy",
        awsInstanceId: "i-1234",
      }),
    );
    expect(api.hosts.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        kind: "warpgate-ssh",
        label: "Gateway Copy",
        warpgateTargetId: "target-1",
        warpgateUsername: "alice",
      }),
    );
  });
});
