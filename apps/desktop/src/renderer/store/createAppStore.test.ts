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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createContainerTab(
  hostId: string,
  options: Partial<HostContainersTabState> = {},
): HostContainersTabState {
  return {
    hostId,
    title: `${hostId} · Containers`,
    runtime: null,
    unsupportedReason: null,
    connectionProgress: null,
    items: [],
    selectedContainerId: null,
    activePanel: "overview",
    isLoading: false,
    details: null,
    detailsLoading: false,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsFollowEnabled: false,
    logsTailWindow: 200,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    pendingAction: null,
    ...options,
  };
}

function createMockApi(): DesktopApi {
  let sessionCounter = 0;

  return {
    auth: {
      getState: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      bootstrap: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      retryOnline: vi.fn().mockResolvedValue({
        status: "authenticated",
        session: {
          user: { id: "user-1", email: "user@example.com" },
          tokens: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresInSeconds: 900,
          },
          vaultBootstrap: {
            keyBase64: "ZmFrZS12YXVsdC1rZXk=",
          },
          offlineLease: {
            token: "offline-token",
            issuedAt: "2025-01-01T00:00:00.000Z",
            expiresAt: "2025-01-04T00:00:00.000Z",
            verificationPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
          },
          syncServerTime: "2025-01-01T00:00:00.000Z",
        },
        errorMessage: null,
      }),
      beginBrowserLogin: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    },
    sync: {
      bootstrap: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      pushDirty: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      status: vi.fn().mockResolvedValue({
        status: "ready",
        lastSuccessfulSyncAt: "2025-01-01T00:00:00.000Z",
        pendingPush: false,
        errorMessage: null,
      }),
      exportDecryptedSnapshot: vi.fn().mockResolvedValue({
        groups: [],
        hosts: [],
        secrets: [],
        knownHosts: [],
        portForwards: [],
        preferences: [],
      }),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([
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
      ]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    aws: {
      listProfiles: vi.fn().mockResolvedValue([]),
      getProfileStatus: vi.fn().mockResolvedValue({
        profileName: "default",
        available: true,
        isSsoProfile: false,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: null,
        missingTools: [],
      }),
      login: vi.fn().mockResolvedValue(undefined),
      listRegions: vi.fn().mockResolvedValue([]),
      listEc2Instances: vi.fn().mockResolvedValue([]),
      inspectHostSshMetadata: vi.fn().mockResolvedValue({
        sshPort: 22,
        recommendedUsername: "ubuntu",
        usernameCandidates: ["ubuntu"],
        status: "ready",
        errorMessage: null,
      }),
      loadHostSshMetadata: vi.fn().mockImplementation(async (hostId: string) => ({
        id: hostId,
        kind: "aws-ec2",
        label: "AWS Linux",
        awsProfileName: "default",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-aws",
        awsAvailabilityZone: "ap-northeast-2a",
        awsInstanceName: "aws-linux",
        awsPlatform: "Linux/UNIX",
        awsPrivateIp: "10.0.0.20",
        awsState: "running",
        awsSshUsername: "ubuntu",
        awsSshPort: 22,
        awsSshMetadataStatus: "ready",
        awsSshMetadataError: null,
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      })),
    },
    warpgate: {
      testConnection: vi.fn().mockResolvedValue({
        baseUrl: "https://warpgate.example.com",
        sshHost: "warpgate.example.com",
        sshPort: 2222,
        username: "example.user",
      }),
      getConnectionInfo: vi.fn().mockResolvedValue({
        baseUrl: "https://warpgate.example.com",
        sshHost: "warpgate.example.com",
        sshPort: 2222,
        username: "example.user",
      }),
      listSshTargets: vi.fn().mockResolvedValue([]),
      startBrowserImport: vi.fn().mockResolvedValue({ attemptId: "attempt-1" }),
      cancelBrowserImport: vi.fn().mockResolvedValue(undefined),
      onImportEvent: vi.fn(() => () => undefined),
    },
    groups: {
      list: vi.fn().mockResolvedValue([
        {
          id: "group-1",
          name: "Servers",
          path: "Servers",
          parentPath: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ]),
      create: vi
        .fn()
        .mockImplementation(
          async (name: string, parentPath?: string | null) => ({
            id: "group-2",
            name,
            path: parentPath ? `${parentPath}/${name}` : name,
            parentPath: parentPath ?? null,
            createdAt: "2025-01-03T00:00:00.000Z",
            updatedAt: "2025-01-03T00:00:00.000Z",
          }),
        ),
      remove: vi.fn().mockResolvedValue({
        groups: [],
        hosts: [],
      }),
    },
    ssh: {
      connect: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `session-${sessionCounter}` };
      }),
      connectLocal: vi.fn().mockImplementation(async () => {
        sessionCounter += 1;
        return { sessionId: `local-session-${sessionCounter}` };
      }),
      write: vi.fn().mockResolvedValue(undefined),
      writeBinary: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      respondKeyboardInteractive: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      onData: vi.fn(),
    },
    containers: {
      list: vi.fn().mockResolvedValue({
        hostId: "host-1",
        runtime: "docker",
        containers: [],
      }),
      inspect: vi.fn().mockResolvedValue({
        id: "container-1",
        name: "app",
        runtime: "docker",
        image: "nginx:latest",
        status: "running",
        createdAt: "2025-01-01T00:00:00.000Z",
        command: "nginx -g daemon off;",
        entrypoint: "/docker-entrypoint.sh",
        mounts: [],
        networks: [],
        environment: [],
        labels: [],
      }),
      logs: vi.fn().mockResolvedValue({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [],
        cursor: null,
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue({
        runtime: "docker",
        containerId: "container-1",
        recordedAt: "2025-01-01T00:00:00.000Z",
        cpuPercent: 10,
        memoryUsedBytes: 1024,
        memoryLimitBytes: 2048,
        memoryPercent: 50,
        networkRxBytes: 100,
        networkTxBytes: 200,
        blockReadBytes: 300,
        blockWriteBytes: 400,
      }),
      searchLogs: vi.fn().mockResolvedValue({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        query: "error",
        lines: [],
        matchCount: 0,
      }),
      openShell: vi.fn().mockResolvedValue({ sessionId: "session-container-1" }),
      release: vi.fn().mockResolvedValue(undefined),
      onConnectionProgress: vi.fn().mockReturnValue(() => undefined),
    },
    sessionShares: {
      start: vi.fn().mockResolvedValue({
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      }),
      updateSnapshot: vi.fn().mockResolvedValue(undefined),
      setInputEnabled: vi.fn().mockImplementation(async ({ inputEnabled }) => ({
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled,
        viewerCount: 0,
        errorMessage: null,
      })),
      stop: vi.fn().mockResolvedValue(undefined),
      openOwnerChatWindow: vi.fn().mockResolvedValue(undefined),
      getOwnerChatSnapshot: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        title: "Host Session",
        state: {
          status: "active",
          shareUrl: "https://sync.example.com/share/share-1/token-1",
          inputEnabled: false,
          viewerCount: 0,
          errorMessage: null,
        },
        messages: [],
      }),
      onEvent: vi.fn().mockReturnValue(() => undefined),
      onChatEvent: vi.fn().mockReturnValue(() => undefined),
    },
    shell: {
      pickPrivateKey: vi.fn(),
      pickOpenSshConfig: vi.fn(),
      pickXshellSessionFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    window: {
      getState: vi.fn().mockResolvedValue({
        isMaximized: false,
      }),
      minimize: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onStateChanged: vi.fn().mockReturnValue(() => undefined),
    },
    tabs: {
      list: vi.fn().mockResolvedValue([]),
    },
    updater: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: "idle",
        currentVersion: "0.1.0",
        dismissedVersion: null,
        release: null,
        progress: null,
        checkedAt: null,
        errorMessage: null,
      }),
      check: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue(undefined),
      installAndRestart: vi.fn().mockResolvedValue(undefined),
      dismissAvailable: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    },
    settings: {
      get: vi.fn().mockResolvedValue({
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
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      update: vi.fn().mockImplementation(async (input) => ({
        theme: input.theme ?? "system",
        globalTerminalThemeId: input.globalTerminalThemeId ?? "dolssh-dark",
        terminalFontFamily: input.terminalFontFamily ?? "sf-mono",
        terminalFontSize: input.terminalFontSize ?? 13,
        terminalScrollbackLines: input.terminalScrollbackLines ?? 5000,
        terminalLineHeight: input.terminalLineHeight ?? 1,
        terminalLetterSpacing: input.terminalLetterSpacing ?? 0,
        terminalMinimumContrastRatio: input.terminalMinimumContrastRatio ?? 1,
        terminalAltIsMeta: input.terminalAltIsMeta ?? false,
        terminalWebglEnabled: input.terminalWebglEnabled ?? true,
        serverUrl:
          typeof input.serverUrlOverride === "string" &&
          input.serverUrlOverride.trim()
            ? input.serverUrlOverride.trim()
            : "https://ssh.doldolma.com",
        serverUrlOverride:
          typeof input.serverUrlOverride === "string" &&
          input.serverUrlOverride.trim()
            ? input.serverUrlOverride.trim()
            : null,
        dismissedUpdateVersion: input.dismissedUpdateVersion ?? null,
        sessionReplayRetentionCount: input.sessionReplayRetentionCount ?? 100,
        updatedAt: "2025-01-02T00:00:00.000Z",
      })),
    },
    sessionReplays: {
      open: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockRejectedValue(new Error("not implemented in test")),
    },
    portForwards: {
      list: vi.fn().mockResolvedValue({
        rules: [],
        runtimes: [],
      }),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({
        ruleId: "forward-1",
        hostId: "host-1",
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 9000,
        status: "running",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
    },
    knownHosts: {
      list: vi.fn().mockResolvedValue([]),
      probeHost: vi.fn().mockResolvedValue({
        hostId: "host-1",
        hostLabel: "Prod",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
        status: "trusted",
        existing: null,
      }),
      trust: vi.fn().mockResolvedValue({
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      replace: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    logs: {
      list: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    keychain: {
      list: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      cloneForHost: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      getHomeDirectory: vi.fn().mockResolvedValue("/Users/tester"),
      getDownloadsDirectory: vi
        .fn()
        .mockResolvedValue("/Users/tester/Downloads"),
      getParentPath: vi.fn().mockImplementation(async (targetPath: string) => {
        if (targetPath === "/Users/tester") {
          return "/Users";
        }
        return "/Users/tester";
      }),
      list: vi.fn().mockResolvedValue({
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
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    termius: {
      probeLocal: vi.fn().mockResolvedValue({
        status: "no-data",
        warnings: [],
        counts: {
          groups: 0,
          hosts: 0,
          identities: 0,
          sshConfigs: 0,
          sshConfigIdentities: 0,
        },
        termiusDataDir: null,
        exportedAt: null,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 0,
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    openssh: {
      probeDefault: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      addFileToSnapshot: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    xshell: {
      probeDefault: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        groups: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      addFolderToSnapshot: vi.fn().mockResolvedValue({
        snapshotId: "snapshot-1",
        sources: [],
        groups: [],
        hosts: [],
        warnings: [],
        skippedExistingHostCount: 0,
        skippedDuplicateHostCount: 0,
      }),
      importSelection: vi.fn().mockResolvedValue({
        createdGroupCount: 0,
        createdHostCount: 0,
        createdSecretCount: 0,
        skippedHostCount: 0,
        warnings: [],
      }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    },
    sftp: {
      connect: vi.fn().mockImplementation(async (input) => ({
        id: input.endpointId,
        kind: "remote",
        hostId: input.hostId,
        title: "Prod",
        path: "/home/ubuntu",
        connectedAt: "2025-01-01T00:00:00.000Z",
      })),
      disconnect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        path: "/home/ubuntu",
        entries: [],
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      startTransfer: vi.fn().mockResolvedValue({
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "Prod",
        itemCount: 1,
        bytesTotal: 12,
        bytesCompleted: 0,
        status: "queued",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      }),
      cancelTransfer: vi.fn().mockResolvedValue(undefined),
      onConnectionProgress: vi.fn(() => () => undefined),
      onTransferEvent: vi.fn(),
    },
  };
}

describe("upsertTransferJob", () => {
  it("keeps an existing transfer in place when progress updates arrive", () => {
    const olderJob = {
      id: "job-1",
      status: "running",
      sourceLabel: "Local",
      targetLabel: "nas",
      activeItemName: "older.bin",
      bytesCompleted: 10,
      bytesTotal: 100,
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:01.000Z",
      speedBytesPerSecond: 100,
      etaSeconds: 1,
    } as const;
    const newerJob = {
      id: "job-2",
      status: "running",
      sourceLabel: "Local",
      targetLabel: "nas",
      activeItemName: "newer.bin",
      bytesCompleted: 20,
      bytesTotal: 100,
      startedAt: "2025-01-01T00:00:10.000Z",
      updatedAt: "2025-01-01T00:00:11.000Z",
      speedBytesPerSecond: 100,
      etaSeconds: 1,
    } as const;

    const transfers = upsertTransferJob([], olderJob as never);
    const orderedTransfers = upsertTransferJob(transfers, newerJob as never);
    const updatedOlderJob = {
      ...olderJob,
      bytesCompleted: 80,
      updatedAt: "2025-01-01T00:00:20.000Z",
    };

    const nextTransfers = upsertTransferJob(
      orderedTransfers,
      updatedOlderJob as never,
    );

    expect(nextTransfers.map((job) => job.id)).toEqual(["job-2", "job-1"]);
    expect(nextTransfers[1]).toMatchObject({ id: "job-1", bytesCompleted: 80 });
  });

  it("removes a dismissed transfer card by id", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();

    store.getState().handleTransferEvent({
      job: {
        id: "job-1",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 100,
        bytesCompleted: 100,
        status: "completed",
        startedAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:10.000Z",
      },
    });
    store.getState().handleTransferEvent({
      job: {
        id: "job-2",
        sourceLabel: "Local",
        targetLabel: "nas",
        itemCount: 1,
        bytesTotal: 200,
        bytesCompleted: 100,
        status: "running",
        startedAt: "2025-01-01T00:00:20.000Z",
        updatedAt: "2025-01-01T00:00:21.000Z",
      },
    });

    store.getState().dismissTransfer("job-1");

    expect(store.getState().sftp.transfers.map((job) => job.id)).toEqual([
      "job-2",
    ]);
  });
});

describe("createAppStore", () => {
  it("bootstraps home workspace and settings from desktop api", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();

    expect(store.getState().hosts).toHaveLength(1);
    expect(store.getState().groups).toHaveLength(1);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("hosts");
    expect(store.getState().settingsSection).toBe("general");
    expect(store.getState().currentGroupPath).toBeNull();
    expect(store.getState().settings.theme).toBe("system");
    expect(store.getState().sftp.leftPane.currentPath).toBe("/Users/tester");
    expect(store.getState().sftp.rightPane.sourceKind).toBe("host");
    expect(store.getState().portForwards).toHaveLength(0);
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
          source: "server_managed",
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
        sftpBrowserColumnWidths: DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
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
        sftpBrowserColumnWidths: DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
        serverUrl: "https://ssh.doldolma.com",
        serverUrlOverride: null,
        dismissedUpdateVersion: null,
        sessionReplayRetentionCount: 100,
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

    expect(store.getState().hosts.map((host) => host.id)).toEqual(["host-2"]);
    expect(store.getState().groups.map((group) => group.id)).toEqual(["group-2"]);
    expect(store.getState().portForwards.map((rule) => rule.id)).toEqual(["forward-2"]);
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

  it("opens create and edit drawers from home", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openCreateHostDrawer();
    expect(store.getState().hostDrawer).toEqual({
      mode: "create",
      defaultGroupPath: null,
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
      return {
        ...recordBase,
        kind: "ssh",
        hostname: draft.hostname,
        port: draft.port,
        username: draft.username,
        authType: draft.authType,
        privateKeyPath: draft.privateKeyPath ?? null,
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
        privateKeyPath: "C:/keys/prod",
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

  it("opens a new session tab and moves to focus mode on connect", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
    expect(store.getState().tabs[0]?.title).toBe("Prod");
    expect(store.getState().tabStrip).toEqual([
      { kind: "session", sessionId: "session-1" },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
    expect(store.getState().hostDrawer).toEqual({ mode: "closed" });
  });

  it("prompts for a missing SSH username before opening a session", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "",
        authType: "password",
        privateKeyPath: null,
        secretRef: "host:host-1",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingMissingUsernamePrompt).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      cols: 120,
      rows: 32,
    });
    expect(store.getState().tabs).toHaveLength(0);
  });

  it("saves a prompted username and retries the SSH session connect", async () => {
    const api = createMockApi();
    const initialHost: HostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "",
      authType: "password",
      privateKeyPath: null,
      secretRef: "host:host-1",
      groupName: "Servers",
      terminalThemeId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    api.hosts.list = vi.fn().mockResolvedValue([initialHost]);
    api.hosts.update = vi.fn().mockImplementation(async (_id, draft) => ({
      ...initialHost,
      ...draft,
      kind: "ssh",
      id: initialHost.id,
      createdAt: initialHost.createdAt,
      updatedAt: "2025-01-02T00:00:00.000Z",
    }));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().submitMissingUsernamePrompt({ username: "ubuntu" });

    expect(api.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "ubuntu",
      }),
    );
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingMissingUsernamePrompt).toBeNull();
    const updatedHost = store
      .getState()
      .hosts.find((host) => host.id === "host-1");
    expect(isSshHostRecord(updatedHost as HostRecord)).toBe(true);
    expect(
      updatedHost && isSshHostRecord(updatedHost)
        ? updatedHost.username
        : null,
    ).toBe("ubuntu");
    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
  });

  it("creates a pending tab immediately before the real session id is resolved", async () => {
    const api = createMockApi();
    const connect = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const connectPromise = store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );
    expect(store.getState().tabs[0]?.status).toBe("pending");
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "connecting",
    );

    connect.resolve({ sessionId: "session-1" });
    await connectPromise;

    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
    expect(store.getState().tabs[0]?.status).toBe("connecting");
  });

  it("opens a local terminal tab immediately and replaces the pending id when connected", async () => {
    const api = createMockApi();
    const connectLocal = createDeferred<{ sessionId: string }>();
    api.ssh.connectLocal = vi
      .fn()
      .mockImplementation(() => connectLocal.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const openPromise = store.getState().openLocalTerminal(120, 32);
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.source).toBe("local");
    expect(store.getState().tabs[0]?.title).toBe("Terminal");
    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );
    expect(store.getState().tabs[0]?.connectionProgress?.message).toBe(
      "로컬 터미널을 시작하는 중입니다.",
    );

    connectLocal.resolve({ sessionId: "local-session-1" });
    await openPromise;

    expect(store.getState().tabs[0]?.sessionId).toBe("local-session-1");
    expect(store.getState().tabs[0]?.source).toBe("local");
    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-1");
  });

  it("retries a failed local session in the same tab context", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "local-session-1",
      payload: {
        message: "failed to start shell",
      },
    });

    await store.getState().retrySessionConnection("local-session-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("local-session-1");
    expect(api.ssh.connectLocal).toHaveBeenCalledTimes(2);
    expect(store.getState().tabs[0]?.source).toBe("local");
  });

  it("creates a new titled session each time the same host is connected", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().tabs.map((tab) => tab.title)).toEqual([
      "Prod",
      "Prod (1)",
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-2");
  });

  it("waits for host key trust when the server is not trusted yet", async () => {
    const api = createMockApi();
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "host-1",
      hostLabel: "Prod",
      host: "prod.example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "untrusted",
      existing: null,
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "awaiting-host-trust",
    );
    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe(
      "untrusted",
    );
    expect(api.ssh.connect).not.toHaveBeenCalled();

    await store.getState().acceptPendingHostKeyPrompt("trust");

    expect(api.knownHosts.trust).toHaveBeenCalled();
    expect(api.ssh.connect).toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  it("returns to home when the last session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().disconnectTab("session-1");

    expect(store.getState().tabs[0]?.status).toBe("disconnecting");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
  });

  it("updates theme settings through the desktop api", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ theme: "dark" });

    expect(api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    expect(store.getState().settings.theme).toBe("dark");
  });

  it("syncs the global terminal system theme mode through the desktop api", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ globalTerminalThemeId: "system" });

    expect(api.settings.update).toHaveBeenCalledWith({
      globalTerminalThemeId: "system",
    });
    expect(api.sync.pushDirty).toHaveBeenCalledTimes(1);
    expect(store.getState().settings.globalTerminalThemeId).toBe("system");
  });

  it("starts AWS SSO login and retries the session connect once when the profile is expired", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.aws.getProfileStatus = vi
      .fn()
      .mockResolvedValueOnce({
        profileName: "sso-profile",
        available: true,
        isSsoProfile: true,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: "브라우저 로그인이 필요합니다.",
        missingTools: [],
      })
      .mockResolvedValueOnce({
        profileName: "sso-profile",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
        missingTools: [],
      });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.aws.login).toHaveBeenCalledWith("sso-profile");
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs[0]?.title).toBe("AWS Prod");
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("surfaces a targeted AWS credential message for non-SSO profiles and does not open a session", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-2",
        kind: "aws-ec2",
        label: "AWS Legacy",
        awsProfileName: "legacy-profile",
        awsRegion: "us-east-1",
        awsInstanceId: "i-9999999999",
        awsInstanceName: "legacy",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.20",
        awsState: "running",
        groupName: null,
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.aws.getProfileStatus = vi.fn().mockResolvedValue({
      profileName: "legacy-profile",
      available: true,
      isSsoProfile: false,
      isAuthenticated: false,
      accountId: null,
      arn: null,
      errorMessage: "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
      missingTools: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();

    await store.getState().connectHost("aws-host-2", 120, 32);

    expect(api.aws.login).not.toHaveBeenCalled();
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toBe(
      "이 프로필은 AWS CLI 자격 증명이 필요합니다.",
    );
  });

  it("tracks aws auth progress in the pending session tab and clears it after the retried session starts", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const firstStatus =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatus"]>>
      >();
    const secondStatus =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatus"]>>
      >();
    const login = createDeferred<void>();
    const connect = createDeferred<{ sessionId: string }>();

    api.aws.getProfileStatus = vi
      .fn()
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementationOnce(() => secondStatus.promise);
    api.aws.login = vi.fn().mockImplementation(() => login.promise);
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();

    const connectPromise = store.getState().connectHost("aws-host-1", 120, 32);
    await flushMicrotasks();

    const pendingSessionId = store.getState().tabs[0]?.sessionId;
    expect(pendingSessionId?.startsWith("pending:")).toBe(true);
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "checking-profile",
    );

    firstStatus.resolve({
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      accountId: null,
      arn: null,
      errorMessage: "브라우저 로그인이 필요합니다.",
      missingTools: [],
    });
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "browser-login",
    );

    login.resolve(undefined);
    await flushMicrotasks();

    secondStatus.resolve({
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      errorMessage: null,
      missingTools: [],
    });
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "retrying-session",
    );
    expect(store.getState().tabs[0]?.connectionProgress?.message).toContain(
      "AWS Prod SSM 연결을 다시 시도하는 중입니다.",
    );

    connect.resolve({ sessionId: "session-1" });
    await connectPromise;

    expect(store.getState().pendingConnectionAttempts).toEqual([]);
    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
  });

  it("ignores duplicate aws connect attempts for the same host while auth recovery is already in progress", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const status =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatus"]>>
      >();
    api.aws.getProfileStatus = vi.fn().mockImplementation(() => status.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();

    const firstConnect = store.getState().connectHost("aws-host-1", 120, 32);
    const secondConnect = store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.aws.getProfileStatus).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "checking-profile",
    );

    status.resolve({
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      errorMessage: null,
      missingTools: [],
    });

    await Promise.all([firstConnect, secondConnect]);

    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("keeps a fixed sftp workspace with local bootstrap and host connect", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");

    expect(store.getState().activeWorkspaceTab).toBe("sftp");
    const connectInput = vi.mocked(api.sftp.connect).mock.calls[0]?.[0];
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe(
      connectInput?.endpointId,
    );
    expect(store.getState().sftp.rightPane.currentPath).toBe("/home/ubuntu");
  });

  it("prompts for a missing SSH username before starting an SFTP connection", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "",
        authType: "password",
        privateKeyPath: null,
        secretRef: "host:host-1",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");

    expect(api.sftp.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingMissingUsernamePrompt).toMatchObject({
      hostId: "host-1",
      source: "sftp",
      paneId: "right",
    });
  });

  it("disconnects a connected SFTP pane back to the host picker", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");

    const endpointId = store.getState().sftp.rightPane.endpoint?.id;
    expect(endpointId).toBeTruthy();

    await store.getState().disconnectSftpPane("right");

    expect(api.sftp.disconnect).toHaveBeenCalledWith(endpointId);
    expect(store.getState().sftp.rightPane.sourceKind).toBe("host");
    expect(store.getState().sftp.rightPane.endpoint).toBeNull();
    expect(store.getState().sftp.rightPane.currentPath).toBe("");
    expect(store.getState().sftp.rightPane.history).toEqual([]);
    expect(store.getState().sftp.rightPane.selectedHostId).toBe("host-1");
  });

  it("keeps the host picker in a connecting state until the first remote listing finishes", async () => {
    const api = createMockApi();
    const list = createDeferred<{ path: string; entries: [] }>();
    api.sftp.list = vi.fn().mockImplementation(() => list.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();

    const connectPromise = store.getState().connectSftpHost("right", "host-1");
    await flushMicrotasks();

    const connectInput = vi.mocked(api.sftp.connect).mock.calls[0]?.[0];
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe(
      connectInput?.endpointId,
    );
    expect(store.getState().sftp.rightPane.connectingHostId).toBe("host-1");
    expect(store.getState().sftp.rightPane.connectingEndpointId).toBe(
      connectInput?.endpointId,
    );
    expect(store.getState().sftp.rightPane.isLoading).toBe(true);

    list.resolve({
      path: "/home/ubuntu",
      entries: [],
    });
    await connectPromise;

    expect(store.getState().sftp.rightPane.connectingHostId).toBeNull();
    expect(store.getState().sftp.rightPane.isLoading).toBe(false);
  });

  it("surfaces known-host probe failures on the sftp host picker", async () => {
    const api = createMockApi();
    api.knownHosts.probeHost = vi
      .fn()
      .mockRejectedValue(
        new Error("Timed out waiting for SSH core response: probeHostKey"),
      );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");

    expect(store.getState().sftp.rightPane.connectingHostId).toBeNull();
    expect(store.getState().sftp.rightPane.isLoading).toBe(false);
    expect(store.getState().sftp.rightPane.errorMessage).toBe(
      "Timed out waiting for SSH core response: probeHostKey",
    );
    expect(api.sftp.connect).not.toHaveBeenCalled();
  });

  it("does not auto-load AWS SSH metadata immediately after saving a host", async () => {
    const api = createMockApi();
    api.hosts.create = vi.fn().mockResolvedValue({
      id: "aws-new",
      kind: "aws-ec2",
      label: "AWS New",
      awsProfileName: "default",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-new",
      awsAvailabilityZone: "ap-northeast-2a",
      awsInstanceName: "new-host",
      awsPlatform: "Linux/UNIX",
      awsPrivateIp: "10.0.0.25",
      awsState: "running",
      awsSshUsername: null,
      awsSshPort: null,
      awsSshMetadataStatus: "idle",
      awsSshMetadataError: null,
      groupName: "Servers",
      tags: [],
      terminalThemeId: null,
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().saveHost(null, {
      kind: "aws-ec2",
      label: "AWS New",
      groupName: "Servers",
      terminalThemeId: null,
      awsProfileName: "default",
      awsRegion: "ap-northeast-2",
      awsInstanceId: "i-new",
      awsAvailabilityZone: "ap-northeast-2a",
      awsInstanceName: "new-host",
      awsPlatform: "Linux/UNIX",
      awsPrivateIp: "10.0.0.25",
      awsState: "running",
      awsSshUsername: null,
      awsSshPort: null,
      awsSshMetadataStatus: "idle",
      awsSshMetadataError: null,
    });

    expect(api.aws.loadHostSshMetadata).not.toHaveBeenCalled();
  });

  it("connects AWS Linux hosts through the shared SFTP flow and tags probe requests with the endpoint id", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileName: "default",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-aws-prod",
        awsAvailabilityZone: "ap-northeast-2a",
        awsInstanceName: "prod-web",
        awsPlatform: "Linux/UNIX",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        awsSshUsername: "ubuntu",
        awsSshPort: 22,
        awsSshMetadataStatus: "ready",
        awsSshMetadataError: null,
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "aws-host-1",
      hostLabel: "AWS Prod",
      host: "aws-ssm:default:ap-northeast-2:i-aws-prod",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
      targetDescription: "AWS SSM · i-aws-prod",
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.getState().activateSftp();

    await store.getState().connectSftpHost("right", "aws-host-1");

    const probeInput = vi.mocked(api.knownHosts.probeHost).mock.calls[0]?.[0];
    const connectInput = vi.mocked(api.sftp.connect).mock.calls[0]?.[0];
    expect(probeInput?.hostId).toBe("aws-host-1");
    expect(probeInput?.endpointId).toBeTruthy();
    expect(connectInput?.hostId).toBe("aws-host-1");
    expect(connectInput?.endpointId).toBe(probeInput?.endpointId);
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe(
      connectInput?.endpointId,
    );
    expect(api.aws.getProfileStatus).not.toHaveBeenCalled();
    expect(api.aws.loadHostSshMetadata).not.toHaveBeenCalled();
  });

  it("does not preload AWS SSH metadata before connecting SFTP when username is missing", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-legacy",
        kind: "aws-ec2",
        label: "AWS Legacy",
        awsProfileName: "default",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-legacy",
        awsAvailabilityZone: "ap-northeast-2a",
        awsInstanceName: "legacy-web",
        awsPlatform: "Linux/UNIX",
        awsPrivateIp: "10.0.0.11",
        awsState: "running",
        awsSshUsername: null,
        awsSshPort: null,
        awsSshMetadataStatus: "idle",
        awsSshMetadataError: null,
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "aws-host-legacy",
      hostLabel: "AWS Legacy",
      host: "aws-ssm:default:ap-northeast-2:i-legacy",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
      targetDescription: "AWS SSM · i-legacy",
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.getState().activateSftp();

    await store.getState().connectSftpHost("right", "aws-host-legacy");

    expect(api.aws.getProfileStatus).not.toHaveBeenCalled();
    expect(api.aws.loadHostSshMetadata).not.toHaveBeenCalled();
    expect(api.knownHosts.probeHost).toHaveBeenCalled();
    expect(api.sftp.connect).toHaveBeenCalled();
  });

  it("updates the SFTP pane progress from endpoint-scoped AWS progress events", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.getState().activateSftp();

    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          connectingHostId: "aws-host-1",
          connectingEndpointId: "endpoint-aws",
          isLoading: true,
        },
      },
    }));

    store.getState().handleSftpConnectionProgressEvent({
      endpointId: "endpoint-aws",
      hostId: "aws-host-1",
      stage: "browser-login",
      message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
    });

    expect(store.getState().sftp.rightPane.connectionProgress).toEqual({
      endpointId: "endpoint-aws",
      hostId: "aws-host-1",
      stage: "browser-login",
      message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
    });
  });

  it("updates the containers tab progress from host-scoped connection events", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "browser-login",
      message: "브라우저에서 승인을 진행하는 중입니다.",
    });

    expect(
      store
        .getState()
        .containerTabs.find((tab) => tab.hostId === "host-1")
        ?.connectionProgress,
    ).toEqual({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "browser-login",
      message: "브라우저에서 승인을 진행하는 중입니다.",
    });
  });

  it("opens host containers inside the fixed containers section without touching the main tab strip", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();

    const beforeTabStrip = store.getState().tabStrip;

    await store.getState().openHostContainersTab("host-1");

    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");
    expect(store.getState().tabStrip).toEqual(beforeTabStrip);
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1"),
    ).toBeDefined();
  });

  it("releases the host containers endpoint and keeps focus inside the containers section when another host tab remains", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState({
      pendingInteractiveAuth: {
        source: "containers",
        endpointId: "containers:host-1",
        hostId: "host-1",
        challengeId: "challenge-1",
        name: "warpgate",
        instruction: "승인을 기다리는 중입니다.",
        prompts: [],
        provider: "warpgate",
        approvalUrl: "https://warpgate.example.com/authorize",
        authCode: "ABCD-1234",
        autoSubmitted: false,
      },
    });

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-2", {
          title: "Stage · Containers",
        }),
      ],
    }));

    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");

    await store.getState().closeHostContainersTab("host-1");

    expect(api.containers.release).toHaveBeenCalledWith("host-1");
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1"),
    ).toBeUndefined();
    expect(store.getState().pendingInteractiveAuth).toBeNull();
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-2");
  });

  it("leaves the fixed containers section active when the last host tab closes", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().closeHostContainersTab("host-1");

    expect(api.containers.release).toHaveBeenCalledWith("host-1");
    expect(store.getState().containerTabs).toEqual([]);
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBeNull();
  });

  it("reorders container subtabs independently from the dynamic tab strip", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-2", {
          title: "Stage · Containers",
          runtime: "docker",
        }),
      ],
    }));

    const beforeTabStrip = store.getState().tabStrip;

    store.getState().reorderContainerTab("host-2", "host-1", "before");

    expect(store.getState().containerTabs.map((tab) => tab.hostId)).toEqual([
      "host-2",
      "host-1",
    ]);
    expect(store.getState().tabStrip).toEqual(beforeTabStrip);
  });

  it("disconnects a container shell session through the standard ssh disconnect flow", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    expect(api.containers.openShell).toHaveBeenCalledWith(
      "host-1",
      "container-1",
    );
    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");

    await store.getState().disconnectTab("session-container-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("session-container-1");
    expect(store.getState().tabs[0]?.status).toBe("disconnecting");
  });

  it("deduplicates overlapping container log lines while following", async () => {
    const api = createMockApi();
    api.containers.logs = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [
          "2025-01-01T00:00:00.000000000Z first",
          "2025-01-01T00:00:01.000000000Z second",
        ],
        cursor: "2025-01-01T00:00:01.000000000Z",
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [
          "2025-01-01T00:00:01.000000000Z second",
          "2025-01-01T00:00:02.000000000Z third",
        ],
        cursor: "2025-01-01T00:00:02.000000000Z",
      });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsFollowEnabled: true,
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");
    await store.getState().refreshHostContainerLogs("host-1", {
      followCursor: "2025-01-01T00:00:01.000000000Z",
    });

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logs?.lines,
    ).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
      "2025-01-01T00:00:01.000000000Z second",
      "2025-01-01T00:00:02.000000000Z third",
    ]);
  });

  it("keeps existing log lines visible while a follow refresh is pending", async () => {
    const deferred = createDeferred<HostContainerLogsSnapshot>();
    const api = createMockApi();
    api.containers.logs = vi.fn().mockReturnValueOnce(deferred.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsState: "ready",
              logsLoading: false,
              logsFollowEnabled: true,
              logs: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                lines: ["2025-01-01T00:00:00.000000000Z first"],
                cursor: "2025-01-01T00:00:00.000000000Z",
              },
            }
          : tab,
      ),
    }));

    const refreshPromise = store.getState().refreshHostContainerLogs("host-1", {
      followCursor: "2025-01-01T00:00:00.000000000Z",
    });

    const inFlightTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(inFlightTab?.logsState).toBe("ready");
    expect(inFlightTab?.logsLoading).toBe(true);
    expect(inFlightTab?.logs?.lines).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
    ]);

    deferred.resolve({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker",
      lines: [
        "2025-01-01T00:00:00.000000000Z first",
        "2025-01-01T00:00:01.000000000Z second",
      ],
      cursor: "2025-01-01T00:00:01.000000000Z",
    });

    await refreshPromise;

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsState).toBe("ready");
    expect(nextTab?.logsLoading).toBe(false);
    expect(nextTab?.logs?.lines).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
      "2025-01-01T00:00:01.000000000Z second",
    ]);
  });

  it("marks empty container log responses as empty instead of ready", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logsState,
    ).toBe("empty");
  });

  it("marks malformed container log responses distinctly", async () => {
    const api = createMockApi();
    api.containers.logs = vi
      .fn()
      .mockRejectedValue(
        new Error("Invalid containersLogs response: lines must be string[]"),
      );

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsState).toBe("malformed");
    expect(nextTab?.logsError).toBe(
      "컨테이너 로그 응답을 해석하지 못했습니다. 다시 불러오기를 시도해 주세요.",
    );
  });

  it("loads older container logs by increasing the tail window", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().loadMoreHostContainerLogs("host-1");

    expect(api.containers.logs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 1200,
      followCursor: null,
    });
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logsTailWindow,
    ).toBe(1200);
  });

  it("stores remote container log search results and metrics samples", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsSearchQuery: "error",
            }
          : tab,
      ),
    }));

    await store.getState().searchHostContainerLogs("host-1");
    await store.getState().refreshHostContainerStats("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.searchLogs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 200,
      query: "error",
    });
    expect(nextTab?.logsSearchMode).toBe("remote");
    expect(nextTab?.metricsState).toBe("ready");
    expect(nextTab?.metricsSamples).toHaveLength(1);
  });

  it("tracks pending container actions and clears them after a successful refresh", async () => {
    const api = createMockApi();
    const pending = createDeferred<void>();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Exited (0) 3 hours ago",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Up 5 seconds",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      });
    api.containers.start = vi.fn().mockReturnValue(pending.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    const actionPromise = store.getState().runHostContainerAction("host-1", "start");
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.pendingAction,
    ).toBe("start");

    pending.resolve(undefined);
    await actionPromise;

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.start).toHaveBeenCalledWith("host-1", "container-1");
    expect(api.containers.list).toHaveBeenCalledTimes(2);
    expect(nextTab?.pendingAction).toBeNull();
    expect(nextTab?.actionError).toBeUndefined();
    expect(nextTab?.items[0]?.status).toBe("Up 5 seconds");
  });

  it("stores container action failures and clears pending state", async () => {
    const api = createMockApi();
    api.containers.list = vi.fn().mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [
        {
          id: "container-1",
          name: "app",
          runtime: "docker",
          image: "nginx:latest",
          status: "Up 5 seconds",
          createdAt: "2025-01-01T00:00:00.000Z",
          ports: "",
        },
      ],
    });
    api.containers.restart = vi
      .fn()
      .mockRejectedValue(new Error("restart failed"));

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().runHostContainerAction("host-1", "restart");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.pendingAction).toBeNull();
    expect(nextTab?.actionError).toBe("restart failed");
  });

  it("clears the selected container when remove succeeds and the refreshed list is empty", async () => {
    const api = createMockApi();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Exited (0) 3 hours ago",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [],
      });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().runHostContainerAction("host-1", "remove");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.remove).toHaveBeenCalledWith("host-1", "container-1");
    expect(nextTab?.items).toEqual([]);
    expect(nextTab?.selectedContainerId).toBeNull();
    expect(nextTab?.details).toBeNull();
  });

  it("trims container metrics history to the most recent 720 samples", async () => {
    const api = createMockApi();
    api.containers.list = vi.fn().mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [
        {
          id: "container-1",
          name: "app",
          runtime: "docker",
          image: "nginx:latest",
          status: "Up 5 seconds",
          createdAt: "2025-01-01T00:00:00.000Z",
          ports: "",
        },
      ],
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    const samples = Array.from({ length: 720 }, (_, index) => ({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker" as const,
      recordedAt: new Date(2025, 0, 1, 0, 0, index).toISOString(),
      cpuPercent: index,
      memoryUsedBytes: index,
      memoryLimitBytes: 1000,
      memoryPercent: index,
      networkRxBytes: index,
      networkTxBytes: index,
      blockReadBytes: index,
      blockWriteBytes: index,
    }));

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              metricsSamples: samples,
              metricsState: "ready",
            }
          : tab,
      ),
    }));

    api.containers.stats = vi.fn().mockResolvedValue({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker",
      recordedAt: "2025-01-01T00:12:00.000Z",
      cpuPercent: 999,
      memoryUsedBytes: 999,
      memoryLimitBytes: 1000,
      memoryPercent: 99,
      networkRxBytes: 999,
      networkTxBytes: 999,
      blockReadBytes: 999,
      blockWriteBytes: 999,
    });

    await store.getState().refreshHostContainerStats("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.metricsSamples).toHaveLength(720);
    expect(nextTab?.metricsSamples[0]?.recordedAt).toBe(samples[1]?.recordedAt);
    expect(nextTab?.metricsSamples.at(-1)?.recordedAt).toBe(
      "2025-01-01T00:12:00.000Z",
    );
  });

  it("does not fetch container metrics when nothing is selected", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: null,
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerStats("host-1");

    expect(api.containers.stats).not.toHaveBeenCalled();
  });

  it("switches log search back to local mode and clears remote search state", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              logsFollowEnabled: true,
              logsSearchQuery: "old",
              logsSearchMode: "remote",
              logsSearchResult: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                query: "old",
                lines: ["old result"],
                matchCount: 1,
              },
              logsSearchError: "stale",
            }
          : tab,
      ),
    }));

    store.getState().setHostContainerLogsSearchQuery("host-1", "error");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsSearchQuery).toBe("error");
    expect(nextTab?.logsSearchMode).toBe("local");
    expect(nextTab?.logsFollowEnabled).toBe(false);
    expect(nextTab?.logsSearchResult).toBeNull();
    expect(nextTab?.logsSearchError).toBeUndefined();
  });

  it("clears container log search query and results", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              logsSearchQuery: "error",
              logsSearchMode: "remote",
              logsSearchLoading: true,
              logsSearchError: "failed",
              logsSearchResult: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                query: "error",
                lines: ["error result"],
                matchCount: 1,
              },
            }
          : tab,
      ),
    }));

    store.getState().clearHostContainerLogsSearch("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsSearchQuery).toBe("");
    expect(nextTab?.logsSearchMode).toBeNull();
    expect(nextTab?.logsSearchLoading).toBe(false);
    expect(nextTab?.logsSearchError).toBeUndefined();
    expect(nextTab?.logsSearchResult).toBeNull();
  });

  it("keeps session splitting working even when containers are open in their own section", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: "tab-2",
          sessionId: "session-2",
          source: "local",
          hostId: null,
          title: "Session 2",
          status: "connected",
          sessionShare: null,
          hasReceivedOutput: true,
          lastEventAt: "2026-03-28T00:00:00.000Z",
        },
      ],
      tabStrip: [
        { kind: "session", sessionId: "session-1" },
        { kind: "session", sessionId: "session-2" },
      ],
    }));
    await store.getState().openHostContainersTab("host-1");

    const created = store.getState().splitSessionIntoWorkspace("session-1", "right");

    expect(created).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]!.id },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe(
      `workspace:${store.getState().workspaces[0]!.id}`,
    );
  });

  it("uses a caller-assigned endpoint id when connecting a Warpgate SFTP host", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "warpgate-1",
      hostLabel: "Warpgate Prod",
      host: "warpgate.example.com",
      port: 2222,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.getState().activateSftp();

    await store.getState().connectSftpHost("right", "warpgate-1");

    const connectInput = vi.mocked(api.sftp.connect).mock.calls[0]?.[0];
    expect(connectInput?.hostId).toBe("warpgate-1");
    expect(connectInput?.endpointId).toBeTruthy();
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe(
      connectInput?.endpointId,
    );
  });

  it("tracks endpoint-scoped interactive auth challenges for SFTP panes", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "warpgate-1",
      hostLabel: "Warpgate Prod",
      host: "warpgate.example.com",
      port: 2222,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "warpgate-1");

    const endpointId = vi.mocked(api.sftp.connect).mock.calls[0]?.[0]?.endpointId;
    expect(endpointId).toBeTruthy();

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: endpointId!,
      payload: {
        challengeId: "challenge-1",
        attempt: 1,
        name: "warpgate",
        instruction: "Open https://warpgate.example.com/authorize and enter code ABCD-1234",
        prompts: [
          { label: "Verification code", echo: true },
          { label: "Press Enter to continue", echo: true },
        ],
      },
    });

    expect(store.getState().pendingInteractiveAuth).toMatchObject({
      source: "sftp",
      paneId: "right",
      endpointId,
      challengeId: "challenge-1",
      provider: "warpgate",
    });
    expect(api.shell.openExternal).toHaveBeenCalledWith(
      "https://warpgate.example.com/authorize",
    );
    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledWith({
      endpointId,
      challengeId: "challenge-1",
      responses: ["ABCD-1234", ""],
    });

    store.getState().handleCoreEvent({
      type: "sftpError",
      endpointId: endpointId!,
      payload: {
        message: "approval expired",
      },
    });

    expect(store.getState().pendingInteractiveAuth).toBeNull();
  });

  it("does not reopen the same Warpgate approval URL repeatedly for a saved port forward", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.portForwards.list = vi.fn().mockResolvedValue({
      rules: [
        {
          id: "forward-warp-1",
          transport: "container",
          label: "Kafka UI",
          hostId: "warpgate-1",
          bindAddress: "127.0.0.1",
          bindPort: 0,
          containerId: "container-1",
          containerName: "kafka-ui",
          containerRuntime: "docker",
          networkName: "bridge",
          targetPort: 8080,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      runtimes: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const challengePayload = {
      attempt: 1,
      name: "warpgate",
      instruction:
        "Open https://warpgate.example.com/authorize and enter code ABCD-1234",
      prompts: [
        { label: "Verification code", echo: true },
        { label: "Press Enter to continue", echo: true },
      ],
    };

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "forward-warp-1",
      payload: {
        challengeId: "challenge-1",
        ...challengePayload,
      },
    });

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "forward-warp-1",
      payload: {
        challengeId: "challenge-2",
        ...challengePayload,
      },
    });

    expect(api.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledTimes(2);
  });

  it("treats repeated markSessionOutput calls as a no-op after the first output arrives", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().markSessionOutput("session-1");
    const tabsAfterFirstOutput = store.getState().tabs;

    store.getState().markSessionOutput("session-1");

    expect(store.getState().tabs).toBe(tabsAfterFirstOutput);
    expect(store.getState().tabs[0]?.hasReceivedOutput).toBe(true);
  });

  it("does not switch to the containers section for discovery-only container auth challenges", async () => {
    const api = createMockApi();
    api.shell.openExternal = vi.fn().mockResolvedValue(undefined);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "containers:host-1",
      payload: {
        challengeId: "challenge-container-1",
        attempt: 1,
        name: "warpgate",
        instruction:
          "Open https://warpgate.example.com/authorize and enter code WXYZ-9999",
        prompts: [
          { label: "Verification code", echo: true },
          { label: "Press Enter to continue", echo: true },
        ],
      },
    });

    expect(store.getState().activeWorkspaceTab).toBe("sftp");
    expect(store.getState().activeContainerHostId).toBeNull();
    expect(store.getState().pendingInteractiveAuth).toMatchObject({
      source: "containers",
      endpointId: "containers:host-1",
      hostId: "host-1",
      challengeId: "challenge-container-1",
      provider: "generic",
    });
    expect(api.shell.openExternal).not.toHaveBeenCalled();
    expect(api.ssh.respondKeyboardInteractive).not.toHaveBeenCalled();
  });

  it("surfaces keyboard-interactive challenges for regular SSH sessions", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      sessionId: "session-1",
      payload: {
        challengeId: "challenge-ssh-1",
        attempt: 1,
        name: "otp",
        instruction: "Enter the one-time code.",
        prompts: [{ label: "Code", echo: true }],
      },
    });

    expect(store.getState().pendingInteractiveAuth).toMatchObject({
      source: "ssh",
      sessionId: "session-1",
      challengeId: "challenge-ssh-1",
      provider: "generic",
    });
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
  });

  it("creates and expands a workspace from adjacent tabs", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    const created = store
      .getState()
      .splitSessionIntoWorkspace("session-1", "right");
    expect(created).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]?.id },
      { kind: "session", sessionId: "session-3" },
    ]);

    const expanded = store
      .getState()
      .splitSessionIntoWorkspace("session-3", "bottom", "session-2");
    expect(expanded).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]?.id },
    ]);
  });

  it("starts workspace broadcast disabled and keeps it through focus, move, and resize changes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    const created = store.getState().splitSessionIntoWorkspace("session-1", "right");
    expect(created).toBe(true);

    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(false);

    store.getState().toggleWorkspaceBroadcast(workspaceId!);
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);

    const splitId =
      store.getState().workspaces[0]?.layout.kind === "split"
        ? store.getState().workspaces[0]?.layout.id
        : null;

    store.getState().focusWorkspaceSession(workspaceId!, "session-2");
    store.getState().moveWorkspaceSession(workspaceId!, "session-1", "left", "session-2");
    expect(splitId).toBeTruthy();
    store.getState().resizeWorkspaceSplit(workspaceId!, splitId!, 0.6);

    expect(store.getState().workspaces[0]?.activeSessionId).toBe("session-1");
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);
  });

  it("moves a workspace pane around another pane in all supported directions", async () => {
    const expectations = [
      {
        direction: "left" as const,
        axis: "horizontal" as const,
        firstSessionId: "session-1",
        secondSessionId: "session-2",
      },
      {
        direction: "right" as const,
        axis: "horizontal" as const,
        firstSessionId: "session-2",
        secondSessionId: "session-1",
      },
      {
        direction: "top" as const,
        axis: "vertical" as const,
        firstSessionId: "session-1",
        secondSessionId: "session-2",
      },
      {
        direction: "bottom" as const,
        axis: "vertical" as const,
        firstSessionId: "session-2",
        secondSessionId: "session-1",
      },
    ];

    for (const expectation of expectations) {
      const store = createAppStore(createMockApi());
      await store.getState().bootstrap();
      await store.getState().connectHost("host-1", 120, 32);
      await store.getState().connectHost("host-1", 120, 32);

      const created = store
        .getState()
        .splitSessionIntoWorkspace("session-1", "right");
      expect(created).toBe(true);

      const workspace = store.getState().workspaces[0];
      expect(workspace).toBeTruthy();

      const moved = store
        .getState()
        .moveWorkspaceSession(
          workspace!.id,
          "session-1",
          expectation.direction,
          "session-2",
        );

      expect(moved).toBe(true);

      const nextWorkspace = store.getState().workspaces[0];
      expect(nextWorkspace?.activeSessionId).toBe("session-1");
      expect(store.getState().activeWorkspaceTab).toBe(
        `workspace:${workspace!.id}`,
      );
      expect(store.getState().tabStrip).toEqual([
        { kind: "workspace", workspaceId: workspace!.id },
      ]);
      expect(nextWorkspace?.layout).toMatchObject({
        kind: "split",
        axis: expectation.axis,
        first: {
          kind: "leaf",
          sessionId: expectation.firstSessionId,
        },
        second: {
          kind: "leaf",
          sessionId: expectation.secondSessionId,
        },
      });
    }
  });

  it("returns false without changing layout for invalid workspace pane moves", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspace = store.getState().workspaces[0];
    expect(workspace).toBeTruthy();

    const initialLayout = JSON.stringify(workspace!.layout);
    const initialTabStrip = store.getState().tabStrip;

    expect(
      store
        .getState()
        .moveWorkspaceSession(workspace!.id, "session-1", "left", "session-1"),
    ).toBe(false);
    expect(
      store
        .getState()
        .moveWorkspaceSession("missing-workspace", "session-1", "left", "session-2"),
    ).toBe(false);
    expect(
      store
        .getState()
        .moveWorkspaceSession(workspace!.id, "session-1", "left", "missing-session"),
    ).toBe(false);

    expect(JSON.stringify(store.getState().workspaces[0]?.layout)).toBe(
      initialLayout,
    );
    expect(store.getState().workspaces[0]?.activeSessionId).toBe("session-1");
    expect(store.getState().tabStrip).toBe(initialTabStrip);
  });

  it("detaches a workspace pane back into standalone tabs and collapses single-pane workspaces", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    store.getState().detachSessionFromWorkspace(workspaceId!, "session-1");

    expect(store.getState().workspaces).toHaveLength(0);
    expect(store.getState().tabStrip).toEqual([
      { kind: "session", sessionId: "session-2" },
      { kind: "session", sessionId: "session-1" },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
  });

  it("removes workspace broadcast state when a workspace collapses back to standalone tabs", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    store.getState().toggleWorkspaceBroadcast(workspaceId!);
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);

    store.getState().detachSessionFromWorkspace(workspaceId!, "session-1");

    expect(store.getState().workspaces).toHaveLength(0);
  });

  it("queues owner session-share chat notifications for active shares and clears them when the share stops", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 2,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "안녕하세요",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    ]);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "inactive",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();
  });

  it("dismisses individual owner session-share chat notifications", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 1,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-1",
        nickname: "맑은 여우",
        text: "첫 번째",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-2",
        nickname: "반짝이는 해달",
        text: "두 번째",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    });

    store.getState().dismissSessionShareChatNotification("session-1", "chat-1");

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-2",
        nickname: "반짝이는 해달",
        text: "두 번째",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    ]);
  });

  it("drops stale chat events after a share has already become inactive", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "inactive",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });

    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-stale",
        nickname: "맑은 여우",
        text: "늦게 도착한 메시지",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();
  });

  it("does not queue chat notifications until the share reaches active state", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "starting",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-too-early",
        nickname: "맑은 여우",
        text: "아직 이르다",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-on-time",
        nickname: "맑은 여우",
        text: "이제는 보인다",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-on-time",
        nickname: "맑은 여우",
        text: "이제는 보인다",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    ]);
  });
});
