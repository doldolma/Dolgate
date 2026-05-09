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

describe("createAppStore sessions and auth recovery", () => {
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

  it("uses the serial connection flow for serial hosts without SSH auth prompts", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "serial-1",
        kind: "serial",
        label: "Console",
        transport: "local",
        devicePath: "/dev/tty.usbserial-0001",
        host: null,
        port: null,
        baudRate: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
        transmitLineEnding: "none",
        localEcho: false,
        localLineEditing: false,
        groupName: null,
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("serial-1", 120, 32);

    expect(api.serial.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "serial-1",
        cols: 120,
        rows: 32,
      }),
    );
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingMissingUsernamePrompt).toBeNull();
    expect(store.getState().tabs[0]?.sessionId).toBe("serial-session-1");
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

  it("opens a unified auth retry request for SSH authentication failures", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: {
        message:
          "ssh handshake failed: ssh: handshake failed: ssh: unexpected message type 51 (expected 60)",
      },
    });

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      authType: "password",
      initialUsername: "ubuntu",
    });
  });

  it("opens the retry dialog when certificate preflight fails before connect", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "certificate",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.ssh.connect = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
        ),
      );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      authType: "certificate",
      initialUsername: "ubuntu",
      message: "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
    });
  });

  it("retries SSH auth with username and reopens using the attempted username on failure", async () => {
    const api = createMockApi();
    let currentHost: HostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      privateKeyPath: null,
      certificatePath: null,
      secretRef: "host:host-1",
      groupName: "Servers",
      terminalThemeId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    api.hosts.list = vi.fn().mockResolvedValue([currentHost]);
    api.hosts.update = vi.fn().mockImplementation(async (_id, draft) => {
      currentHost = {
        ...currentHost,
        ...draft,
        kind: "ssh",
        id: currentHost.id,
        createdAt: currentHost.createdAt,
        updatedAt: "2025-01-02T00:00:00.000Z",
      };
      return currentHost;
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: {
        message: "authentication failed",
      },
    });

    await store.getState().submitCredentialRetry({
      username: "test11",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
      passphrase: "secret",
    });

    expect(api.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "test11",
      }),
    );
    expect(api.ssh.connect).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingCredentialRetry).toBeNull();

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-2",
      payload: {
        message: "authentication failed",
      },
    });
    await flushMicrotasks();

    expect(api.hosts.update).toHaveBeenLastCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "ubuntu",
      }),
    );
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      authType: "certificate",
      initialUsername: "test11",
    });
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

  it("opens ECS exec shell using only /bin/sh", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    expect(api.aws.openEcsExecShell).toHaveBeenCalledTimes(1);
    expect(api.aws.openEcsExecShell).toHaveBeenCalledWith({
      hostId: "ecs-host-1",
      serviceName: "api",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      containerName: "api",
      cols: 120,
      rows: 32,
      command: "/bin/sh",
    });
  });

  it("keeps a missing-shell ECS exec session open as a close-only error overlay", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });

    expect(store.getState().tabs[0]?.status).toBe("connected");
    expect(store.getState().tabs[0]?.shellKind).toBe("aws-ecs-exec");

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });
    await flushMicrotasks();

    expect(api.aws.openEcsExecShell).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("retries a failed ECS exec shell using /bin/sh again", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" })
      .mockResolvedValueOnce({ sessionId: "ecs-shell-2" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    await store.getState().retrySessionConnection("ecs-shell-1");

    expect(api.aws.openEcsExecShell).toHaveBeenNthCalledWith(2, {
      hostId: "ecs-host-1",
      serviceName: "api",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      containerName: "api",
      cols: 120,
      rows: 32,
      command: "/bin/sh",
    });
    expect(store.getState().tabs[0]?.sessionId).toBe("ecs-shell-2");
  });

  it("closes a missing-shell ECS exec session through the standard close action", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    await store.getState().disconnectTab("ecs-shell-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("ecs-shell-1");
    expect(store.getState().tabs).toHaveLength(0);
  });

  it("keeps a missing-shell ECS exec session open even if a small chunk arrives before the 127 error", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().markSessionOutput(
      "ecs-shell-1",
      new Uint8Array([27, 91, 54, 110]),
    );
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("keeps an ECS exec session open when it closes immediately without a separate error event", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("shows a clearer permission error when ECS exec is denied by IAM", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "AccessDeniedException: User is not authorized to perform: ecs:ExecuteCommand on resource: *",
        ),
      );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ecs:ExecuteCommand",
    );
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "권한이 없습니다",
    );
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

  it("returns to the containers tab when a container shell session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    await store.getState().openHostContainerShell("host-1", "container-1");
    await store.getState().disconnectTab("session-container-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");
  });

  it("falls back to home when the stored containers return target no longer exists", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    await store.getState().openHostContainerShell("host-1", "container-1");
    await store.getState().closeHostContainersTab("host-1");
    await store.getState().disconnectTab("session-container-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
  });

  it("returns to the previous settings section when a session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openSettingsSection("security");
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("security");
  });

  it("returns to the sftp tab when a session opened from sftp closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("sftp");
  });

  it("returns to the previously active session when the latest session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-2");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-2",
      payload: {},
    });

    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-1");
    expect(store.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      "local-session-1",
    ]);
  });

  it("preserves the original return target across a retried local session", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openSettingsSection("security");
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "local-session-1",
      payload: {
        message: "failed to start shell",
      },
    });

    await store.getState().retrySessionConnection("local-session-1");
    await store.getState().disconnectTab("local-session-2");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-2",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("security");
  });

  it("does not change focus when a background session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-2");
    expect(store.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      "local-session-2",
    ]);
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

  it("refreshes hosts and keychain entries after removing a keychain secret", async () => {
    const api = createMockApi();
    let hosts: HostRecord[] = [
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    let keychainEntries = [
      {
        secretRef: "secret-1",
        label: "Prod Secret",
        hasPassword: true,
        hasPassphrase: false,
        hasManagedPrivateKey: false,
        hasCertificate: false,
        linkedHostCount: 1,
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];

    api.hosts.list = vi.fn().mockImplementation(async () => hosts);
    api.keychain.list = vi.fn().mockImplementation(async () => keychainEntries);
    api.keychain.remove = vi.fn().mockImplementation(async (secretRef: string) => {
      hosts = hosts.map((host) =>
        isSshHostRecord(host) && host.secretRef === secretRef
          ? { ...host, secretRef: null, updatedAt: "2025-01-02T00:00:00.000Z" }
          : host,
      );
      keychainEntries = keychainEntries.filter((entry) => entry.secretRef !== secretRef);
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().removeKeychainSecret("secret-1");

    expect(api.keychain.remove).toHaveBeenCalledWith("secret-1");
    expect(api.hosts.list).toHaveBeenCalledTimes(2);
    expect(api.keychain.list).toHaveBeenCalledTimes(2);
    const refreshedHost = store.getState().hosts[0];
    expect(isSshHostRecord(refreshedHost)).toBe(true);
    if (isSshHostRecord(refreshedHost)) {
      expect(refreshedHost.secretRef).toBeNull();
    }
    expect(store.getState().keychainEntries).toEqual([]);
  });

  it("refreshes hosts and keychain entries after cloning a keychain secret for a host", async () => {
    const api = createMockApi();
    let hosts: HostRecord[] = [
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    let keychainEntries = [
      {
        secretRef: "secret-1",
        label: "Shared Secret",
        hasPassword: false,
        hasPassphrase: true,
        hasManagedPrivateKey: true,
        hasCertificate: false,
        linkedHostCount: 1,
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];

    api.hosts.list = vi.fn().mockImplementation(async () => hosts);
    api.keychain.list = vi.fn().mockImplementation(async () => keychainEntries);
    api.keychain.cloneForHost = vi.fn().mockImplementation(async ({ hostId }: { hostId: string }) => {
      hosts = hosts.map((host) =>
        isSshHostRecord(host) && host.id === hostId
          ? { ...host, secretRef: "secret-2", updatedAt: "2025-01-02T00:00:00.000Z" }
          : host,
      );
      keychainEntries = [
        ...keychainEntries,
        {
          secretRef: "secret-2",
          label: "Prod Host Secret",
          hasPassword: false,
          hasPassphrase: true,
          hasManagedPrivateKey: true,
          hasCertificate: false,
          linkedHostCount: 1,
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ];
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().cloneKeychainSecretForHost("host-1", "secret-1", {
      passphrase: "next-passphrase",
    });

    expect(api.keychain.cloneForHost).toHaveBeenCalledWith({
      hostId: "host-1",
      sourceSecretRef: "secret-1",
      secrets: { passphrase: "next-passphrase" },
    });
    expect(api.hosts.list).toHaveBeenCalledTimes(2);
    expect(api.keychain.list).toHaveBeenCalledTimes(2);
    const clonedHost = store.getState().hosts[0];
    expect(isSshHostRecord(clonedHost)).toBe(true);
    if (isSshHostRecord(clonedHost)) {
      expect(clonedHost.secretRef).toBe("secret-2");
    }
    expect(store.getState().keychainEntries.map((entry) => entry.secretRef)).toEqual([
      "secret-2",
      "secret-1",
    ]);
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
        errorMessage: "釉뚮씪?곗? 濡쒓렇?몄씠 ?꾩슂?⑸땲??",
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
      errorMessage: "???꾨줈?꾩? AWS CLI ?먭꺽 利앸챸???꾩슂?⑸땲??",
      missingTools: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();

    await store.getState().connectHost("aws-host-2", 120, 32);

    expect(api.aws.login).not.toHaveBeenCalled();
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toBe(
      "???꾨줈?꾩? AWS CLI ?먭꺽 利앸챸???꾩슂?⑸땲??",
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
      id: null,
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      accountId: null,
      arn: null,
      errorMessage: "釉뚮씪?곗? 濡쒓렇?몄씠 ?꾩슂?⑸땲??",
      missingTools: [],
    });
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "browser-login",
    );

    login.resolve(undefined);
    await flushMicrotasks();

    secondStatus.resolve({
      id: null,
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
      id: null,
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
});
