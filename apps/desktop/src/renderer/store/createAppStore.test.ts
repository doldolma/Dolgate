import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, HostDraft, HostRecord } from "@shared";
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
        updatedAt: "2025-01-02T00:00:00.000Z",
      })),
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
});
