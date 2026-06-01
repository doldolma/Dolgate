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

describe("createAppStore sftp", () => {
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

  it("downloads selected remote folders and files into Downloads", async () => {
    const api = createMockApi();
    api.sftp.list = vi.fn().mockResolvedValue({
      path: "/home/ubuntu",
      entries: [
        {
          name: "logs",
          path: "/home/ubuntu/logs",
          isDirectory: true,
          size: 0,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
        {
          name: "report.txt",
          path: "/home/ubuntu/report.txt",
          isDirectory: false,
          size: 42,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
        },
      ],
    });
    api.files.list = vi.fn().mockResolvedValue({
      path: "/Users/tester/Downloads",
      entries: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          selectedPaths: ["/home/ubuntu/logs", "/home/ubuntu/report.txt"],
          selectionAnchorPath: "/home/ubuntu/logs",
        },
      },
    }));

    await store.getState().downloadSftpSelection("right");

    expect(api.files.getDownloadsDirectory).toHaveBeenCalled();
    expect(api.files.list).toHaveBeenCalledWith("/Users/tester/Downloads");
    expect(api.sftp.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "remote",
          path: "/home/ubuntu",
        }),
        target: {
          kind: "local",
          path: "/Users/tester/Downloads",
        },
        items: [
          expect.objectContaining({
            name: "logs",
            path: "/home/ubuntu/logs",
            isDirectory: true,
          }),
          expect.objectContaining({
            name: "report.txt",
            path: "/home/ubuntu/report.txt",
            isDirectory: false,
          }),
        ],
      }),
    );
  });

  it("opens the existing conflict dialog when a folder download collides in Downloads", async () => {
    const api = createMockApi();
    api.sftp.list = vi.fn().mockResolvedValue({
      path: "/home/ubuntu",
      entries: [
        {
          name: "logs",
          path: "/home/ubuntu/logs",
          isDirectory: true,
          size: 0,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
      ],
    });
    api.files.list = vi.fn().mockResolvedValue({
      path: "/Users/tester/Downloads",
      entries: [
        {
          name: "logs",
          path: "/Users/tester/Downloads/logs",
          isDirectory: true,
          size: 0,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
      ],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          selectedPaths: ["/home/ubuntu/logs"],
          selectionAnchorPath: "/home/ubuntu/logs",
        },
      },
    }));

    await store.getState().downloadSftpSelection("right");

    expect(api.sftp.startTransfer).not.toHaveBeenCalled();
    expect(store.getState().sftp.pendingConflictDialog).toMatchObject({
      names: ["logs"],
      input: {
        target: {
          kind: "local",
          path: "/Users/tester/Downloads",
        },
      },
    });
  });

  it("uses the saved SFTP conflict policy without opening the conflict dialog", async () => {
    const api = createMockApi();
    api.sftp.list = vi.fn().mockResolvedValue({
      path: "/home/ubuntu",
      entries: [
        {
          name: "logs",
          path: "/home/ubuntu/logs",
          isDirectory: true,
          size: 0,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
      ],
    });
    api.files.list = vi.fn().mockResolvedValue({
      path: "/Users/tester/Downloads",
      entries: [
        {
          name: "logs",
          path: "/Users/tester/Downloads/logs",
          isDirectory: true,
          size: 0,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
      ],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      settings: {
        ...state.settings,
        sftpConflictPolicy: "keepBoth",
      },
    }));
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "host-1");
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          selectedPaths: ["/home/ubuntu/logs"],
          selectionAnchorPath: "/home/ubuntu/logs",
        },
      },
    }));

    await store.getState().downloadSftpSelection("right");

    expect(store.getState().sftp.pendingConflictDialog).toBeNull();
    expect(api.sftp.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictResolution: "keepBoth",
        preserveMetadata: {
          mtime: true,
          permissions: false,
        },
      }),
    );
  });

  it("matches dropped local files when macOS normalizes Korean filenames differently", async () => {
    const api = createMockApi();
    const fileName =
      "[붙임2] 전력시장운영규칙전문(260318)_PDF.pdf";
    const listedPath = `/Users/tester/Drop/${fileName}`;
    const droppedPath = `/Users/tester/Drop/${fileName.normalize("NFD")}`;
    api.files.getParentPath = vi
      .fn()
      .mockResolvedValue("/Users/tester/Drop");
    api.files.list = vi.fn().mockResolvedValue({
      path: "/Users/tester/Drop",
      entries: [
        {
          name: fileName,
          path: listedPath,
          isDirectory: false,
          size: 42,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
        },
      ],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/remote",
            connectedAt: "2025-01-01T00:00:00.000Z",
          },
          currentPath: "/remote",
          history: ["/remote"],
          historyIndex: 0,
        },
      },
    }));

    await store
      .getState()
      .prepareSftpExternalTransfer("right", "/remote", [droppedPath]);

    expect(api.sftp.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            name: fileName,
            path: listedPath,
          }),
        ],
      }),
    );
  });

  it("keeps dropped local file paths exact when resolving external SFTP transfers", async () => {
    const api = createMockApi();
    const fileName = " leading space .txt ";
    const droppedPath = `/Users/tester/Drop/${fileName}`;
    api.files.getParentPath = vi.fn().mockImplementation(async (targetPath: string) => {
      expect(targetPath).toBe(droppedPath);
      return "/Users/tester/Drop";
    });
    api.files.list = vi.fn().mockResolvedValue({
      path: "/Users/tester/Drop",
      entries: [
        {
          name: fileName,
          path: droppedPath,
          isDirectory: false,
          size: 42,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
        },
      ],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/remote",
            connectedAt: "2025-01-01T00:00:00.000Z",
          },
          currentPath: "/remote",
          history: ["/remote"],
          historyIndex: 0,
        },
      },
    }));

    await store
      .getState()
      .prepareSftpExternalTransfer("right", "/remote", [droppedPath]);

    expect(api.sftp.startTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            name: fileName,
            path: droppedPath,
          }),
        ],
      }),
    );
  });

  it("does not persist sudo password from SFTP owner changes into store state", async () => {
    const api = createMockApi();
    api.sftp.list = vi.fn().mockResolvedValue({
      path: "/home/ubuntu",
      entries: [
        {
          name: "app.txt",
          path: "/home/ubuntu/app.txt",
          isDirectory: false,
          size: 42,
          mtime: "2025-01-01T00:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
          owner: "ubuntu",
          group: "ubuntu",
        },
      ],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/home/ubuntu",
            connectedAt: "2025-01-01T00:00:00.000Z",
            sudoStatus: "passwordRequired",
          },
          currentPath: "/home/ubuntu",
          entries: [
            {
              name: "app.txt",
              path: "/home/ubuntu/app.txt",
              isDirectory: false,
              size: 42,
              mtime: "2025-01-01T00:00:00.000Z",
              kind: "file",
              permissions: "rw-r--r--",
              owner: "ubuntu",
              group: "ubuntu",
            },
          ],
          selectedPaths: ["/home/ubuntu/app.txt"],
          selectionAnchorPath: "/home/ubuntu/app.txt",
        },
      },
    }));

    await store.getState().changeSftpSelectionOwner("right", {
      owner: "root",
      group: "root",
      sudoPassword: "sudo-secret",
    });

    expect(api.sftp.chown).toHaveBeenCalledWith({
      endpointId: "endpoint-1",
      path: "/home/ubuntu/app.txt",
      owner: "root",
      group: "root",
      sudoPassword: "sudo-secret",
    });
    expect(JSON.stringify(store.getState())).not.toContain("sudo-secret");
  });

  it("applies permission changes to every selected local SFTP path", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        leftPane: {
          ...state.sftp.leftPane,
          sourceKind: "local",
          selectedPaths: [
            "/Users/tester/app.log",
            "/Users/tester/scripts/deploy.sh",
          ],
          selectionAnchorPath: "/Users/tester/app.log",
        },
      },
    }));

    await store.getState().changeSftpSelectionPermissions("left", 0o744);

    expect(api.files.chmod).toHaveBeenNthCalledWith(
      1,
      "/Users/tester/app.log",
      0o744,
    );
    expect(api.files.chmod).toHaveBeenNthCalledWith(
      2,
      "/Users/tester/scripts/deploy.sh",
      0o744,
    );
  });

  it("applies permission changes to every selected remote SFTP path", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/home/ubuntu",
            connectedAt: "2025-01-01T00:00:00.000Z",
          },
          selectedPaths: [
            "/home/ubuntu/app.log",
            "/home/ubuntu/scripts/deploy.sh",
          ],
          selectionAnchorPath: "/home/ubuntu/app.log",
        },
      },
    }));

    await store.getState().changeSftpSelectionPermissions("right", 0o640);

    expect(api.sftp.chmod).toHaveBeenNthCalledWith(1, {
      endpointId: "endpoint-1",
      path: "/home/ubuntu/app.log",
      mode: 0o640,
    });
    expect(api.sftp.chmod).toHaveBeenNthCalledWith(2, {
      endpointId: "endpoint-1",
      path: "/home/ubuntu/scripts/deploy.sh",
      mode: 0o640,
    });
  });

  it("applies owner changes to every selected remote SFTP path without storing sudo password", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/home/ubuntu",
            connectedAt: "2025-01-01T00:00:00.000Z",
            sudoStatus: "passwordRequired",
          },
          selectedPaths: ["/home/ubuntu/app.log", "/home/ubuntu/logs"],
          selectionAnchorPath: "/home/ubuntu/app.log",
        },
      },
    }));

    await store.getState().changeSftpSelectionOwner("right", {
      owner: "root",
      group: "adm",
      recursive: true,
      sudoPassword: "sudo-secret",
    });

    expect(api.sftp.chown).toHaveBeenNthCalledWith(1, {
      endpointId: "endpoint-1",
      path: "/home/ubuntu/app.log",
      owner: "root",
      group: "adm",
      recursive: true,
      sudoPassword: "sudo-secret",
    });
    expect(api.sftp.chown).toHaveBeenNthCalledWith(2, {
      endpointId: "endpoint-1",
      path: "/home/ubuntu/logs",
      owner: "root",
      group: "adm",
      recursive: true,
      sudoPassword: "sudo-secret",
    });
    expect(JSON.stringify(store.getState())).not.toContain("sudo-secret");
  });

  it("stops multi-owner changes on the first failure and skips refresh", async () => {
    const api = createMockApi();
    api.sftp.chown = vi.fn().mockRejectedValueOnce(new Error("denied"));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      sftp: {
        ...state.sftp,
        rightPane: {
          ...state.sftp.rightPane,
          sourceKind: "host",
          endpoint: {
            id: "endpoint-1",
            kind: "remote",
            hostId: "host-1",
            title: "Prod",
            path: "/home/ubuntu",
            connectedAt: "2025-01-01T00:00:00.000Z",
            sudoStatus: "passwordRequired",
          },
          selectedPaths: ["/home/ubuntu/app.log", "/home/ubuntu/logs"],
          selectionAnchorPath: "/home/ubuntu/app.log",
        },
      },
    }));
    const listCallsBefore = vi.mocked(api.sftp.list).mock.calls.length;

    await expect(
      store.getState().changeSftpSelectionOwner("right", {
        owner: "root",
        group: "adm",
        sudoPassword: "sudo-secret",
      }),
    ).rejects.toThrow("denied");

    expect(api.sftp.chown).toHaveBeenCalledTimes(1);
    expect(api.sftp.chown).toHaveBeenCalledWith({
      endpointId: "endpoint-1",
      path: "/home/ubuntu/app.log",
      owner: "root",
      group: "adm",
      sudoPassword: "sudo-secret",
    });
    expect(api.sftp.list).toHaveBeenCalledTimes(listCallsBefore);
    expect(JSON.stringify(store.getState())).not.toContain("sudo-secret");
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
      targetDescription: "AWS SSM 쨌 i-aws-prod",
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

  it("skips the extra AWS host-key probe when the SSM target is already trusted", async () => {
    const api = createMockApi();
    const awsHost = createAwsEc2Host();
    api.hosts.list = vi.fn().mockResolvedValue([awsHost]);
    api.knownHosts.list = vi.fn().mockResolvedValue([
      {
        id: "known-aws",
        host: "aws-ssm:default:ap-northeast-2:i-aws",
        port: 22,
        algorithm: "ecdsa-sha2-nistp256",
        publicKeyBase64: "AAAATEST",
        fingerprintSha256: "SHA256:test",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi
      .fn()
      .mockRejectedValue(new Error("probe should not run"));

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.getState().activateSftp();

    await store.getState().connectSftpHost("right", "aws-host-1");

    expect(api.knownHosts.probeHost).not.toHaveBeenCalled();
    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "aws-host-1",
        endpointId: expect.any(String),
      }),
    );
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
      targetDescription: "AWS SSM 쨌 i-legacy",
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
      message: "釉뚮씪?곗??먯꽌 default AWS 濡쒓렇?몄쓣 吏꾪뻾?섎뒗 以묒엯?덈떎.",
    });

    expect(store.getState().sftp.rightPane.connectionProgress).toEqual({
      endpointId: "endpoint-aws",
      hostId: "aws-host-1",
      stage: "browser-login",
      message: "釉뚮씪?곗??먯꽌 default AWS 濡쒓렇?몄쓣 吏꾪뻾?섎뒗 以묒엯?덈떎.",
    });
  });

  it("keeps endpoint-scoped AWS SFTP diagnostics on the pane", async () => {
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
      stage: "sending-public-key",
      message: "AccessDeniedException: not authorized",
      reasonCode: "eic-access-denied",
      diagnosticId: "diag-aws",
      details: {
        profileName: "default",
        region: "ap-northeast-2",
      },
    });

    expect(store.getState().sftp.rightPane.connectionDiagnostic).toEqual(
      expect.objectContaining({
        reasonCode: "eic-access-denied",
        diagnosticId: "diag-aws",
      }),
    );
  });

  it("preserves the final AWS SFTP diagnostic after connect rejects", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([createAwsEc2Host()]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "aws-host-1",
      hostLabel: "AWS Linux",
      host: "aws-ssm:default:ap-northeast-2:i-aws",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });
    const store = createAppStore(api);
    api.sftp.connect = vi.fn().mockImplementation(async (input) => {
      store.getState().handleSftpConnectionProgressEvent({
        endpointId: input.endpointId,
        hostId: input.hostId,
        stage: "connecting-sftp",
        message: "unable to authenticate",
        reasonCode: "ssh-auth-failed",
        diagnosticId: "diag-auth",
        details: {
          password: "must-not-copy",
          profileName: "default",
        },
      });
      throw new Error("[SFTP 연결] unable to authenticate");
    });

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "aws-host-1");

    expect(store.getState().sftp.rightPane.connectionProgress).toBeNull();
    expect(store.getState().sftp.rightPane.connectionDiagnostic).toMatchObject({
      reasonCode: "ssh-auth-failed",
      diagnosticId: "diag-auth",
      message: "unable to authenticate",
    });
  });
});
