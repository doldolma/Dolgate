import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";

const ipcHandlers = new Map<string, (...args: any[]) => any>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock("./aws-ec2-ssh-over-ssm", () => ({
  connectAwsEc2OverSsm: vi.fn(),
}));

import {
  registerSshIpcHandlers,
  resolveAgentForwardingEndpoint,
} from "./ssh";
import { connectAwsEc2OverSsm } from "./aws-ec2-ssh-over-ssm";

const connectAwsEc2OverSsmMock = vi.mocked(connectAwsEc2OverSsm);

function createContext() {
  return {
    hosts: {
      getById: vi.fn(),
    },
    activityLogs: {
      append: vi.fn(),
    },
    awsService: {
      requireManagedProfileName: vi.fn(),
      buildManagedSessionEnvSpec: vi.fn(),
      buildServerProxySessionEnvSpec: vi.fn(),
      shouldUseInProcessSsm: vi.fn(() => false),
      startSsmShellSession: vi.fn(),
    },
    coreManager: {
      connect: vi.fn(),
      connectLocalSession: vi.fn(),
      connectAwsSession: vi.fn(),
      connectAwsServerProxySession: vi.fn(),
    },
    authService: {
      getServerUrl: vi.fn(() => "https://sync.example.com"),
      getAccessToken: vi.fn(() => "access-token"),
      refreshSession: vi.fn(),
    },
    sessionReplayService: {
      noteSessionConfigured: vi.fn(),
    },
    assertSshHost: vi.fn(),
    requireTrustedHostKey: vi.fn(),
    resolveTailnetRoute: vi.fn(() => ({})),
    requireTrustedHostKeys: vi.fn(),
    requireConfiguredSshUsername: vi.fn(),
    resolveRuntimeSshSecrets: vi.fn(),
    resolveJumpHostTarget: vi.fn().mockResolvedValue(undefined),
    ensureCertificateAuthReady: vi.fn(),
    pendingSessionSecrets: new Map(),
  } as any;
}

describe("registerSshIpcHandlers", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    connectAwsEc2OverSsmMock.mockReset();
    // 기본값: SSH-over-SSM 실패 → 기존 테스트들은 SSM 셸 폴백 경로를 검증한다.
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));
  });

  it("resolves agent endpoints: shell env override, macOS env, macOS launchctl, and Windows OpenSSH agent", async () => {
    // 셸 해석은 결정성을 위해 스텁(실제 셸을 띄우지 않음).
    const noShell = async () => null;

    // 셸 해석 실패 시 process.env.SSH_AUTH_SOCK 폴백.
    await expect(
      resolveAgentForwardingEndpoint(
        "darwin",
        { SSH_AUTH_SOCK: "/tmp/agent.sock" } as NodeJS.ProcessEnv,
        undefined,
        noShell,
      ),
    ).resolves.toEqual({
      kind: "unix",
      endpoint: "/tmp/agent.sock",
    });

    // env·셸 모두 없으면 macOS launchctl 폴백.
    await expect(
      resolveAgentForwardingEndpoint(
        "darwin",
        {} as NodeJS.ProcessEnv,
        async () => "/private/tmp/com.apple.launchd.agent/Listeners",
        noShell,
      ),
    ).resolves.toEqual({
      kind: "unix",
      endpoint: "/private/tmp/com.apple.launchd.agent/Listeners",
    });

    // 셸 프로필의 SSH_AUTH_SOCK(1Password 등)가 최우선 — env·launchctl보다 앞선다.
    await expect(
      resolveAgentForwardingEndpoint(
        "darwin",
        { SSH_AUTH_SOCK: "/tmp/default.sock" } as NodeJS.ProcessEnv,
        async () => "/tmp/launchctl.sock",
        async () => "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
      ),
    ).resolves.toEqual({
      kind: "unix",
      endpoint:
        "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    });

    await expect(
      resolveAgentForwardingEndpoint("win32", {} as NodeJS.ProcessEnv),
    ).resolves.toEqual({
      kind: "windows-openssh-pipe",
      endpoint: "\\\\.\\pipe\\openssh-ssh-agent",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("configures local terminal lifecycle metadata and replay dimensions", async () => {
    const ctx = createContext();
    ctx.coreManager.connectLocalSession.mockResolvedValue({
      sessionId: "local-session-1",
    });
    registerSshIpcHandlers(ctx);

    const connectLocalHandler = ipcHandlers.get(ipcChannels.ssh.connectLocal);
    await expect(
      connectLocalHandler?.(null, {
        title: "Terminal 2",
        cols: 132,
        rows: 44,
      }),
    ).resolves.toEqual({ sessionId: "local-session-1" });

    expect(ctx.coreManager.connectLocalSession).toHaveBeenCalledWith({
      cols: 132,
      rows: 44,
      title: "Terminal 2",
      shellKind: undefined,
      executable: undefined,
      args: undefined,
      env: undefined,
      workingDirectory: undefined,
      lifecycle: {
        hostId: "local-terminal",
        hostLabel: "Local Terminal",
        connectionKind: "local",
      },
    });
    expect(ctx.sessionReplayService.noteSessionConfigured).toHaveBeenCalledWith(
      "local-session-1",
      132,
      44,
    );
  });

  it("blocks certificate auth before connect when certificate inspection reports an error", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      secretRef: "secret-1",
    });
    ctx.requireTrustedHostKey.mockReturnValue("trusted");
    ctx.requireTrustedHostKeys.mockReturnValue(["trusted"]);
    ctx.requireConfiguredSshUsername.mockReturnValue("ubuntu");
    ctx.resolveRuntimeSshSecrets.mockResolvedValue({
      secrets: {
        privateKeyPem: "PRIVATE KEY",
        certificateText: "CERTIFICATE",
      },
      shouldPersistHostSecret: false,
    });
    ctx.ensureCertificateAuthReady.mockRejectedValue(
      new Error(
        "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
      ),
    );

    registerSshIpcHandlers(ctx);

    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);
    expect(connectHandler).toBeTypeOf("function");

    await expect(
      connectHandler?.(null, {
        hostId: "host-1",
        cols: 120,
        rows: 32,
      }),
    ).rejects.toThrow(
      "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
    );
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
  });

  it("forwards startup commands for direct SSH sessions", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
    });
    ctx.requireTrustedHostKeys.mockReturnValue(["trusted"]);
    ctx.requireConfiguredSshUsername.mockReturnValue("ubuntu");
    ctx.resolveRuntimeSshSecrets.mockResolvedValue({
      secrets: { password: "secret" },
      shouldPersistHostSecret: false,
    });
    ctx.coreManager.connect.mockResolvedValue({ sessionId: "session-ssh" });
    registerSshIpcHandlers(ctx);

    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);
    await connectHandler?.(null, {
      hostId: "host-1",
      cols: 120,
      rows: 32,
      startupCommand: "cd /srv/app",
    });

    expect(ctx.coreManager.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "ssh",
        startupCommand: "cd /srv/app",
      }),
    );
  });

  it("forwards SSH agent forwarding settings for direct SSH sessions", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      agentForwarding: true,
    });
    ctx.requireTrustedHostKeys.mockReturnValue(["trusted"]);
    ctx.requireConfiguredSshUsername.mockReturnValue("ubuntu");
    ctx.resolveRuntimeSshSecrets.mockResolvedValue({
      secrets: { password: "secret" },
      shouldPersistHostSecret: false,
    });
    ctx.coreManager.connect.mockResolvedValue({ sessionId: "session-ssh" });
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/dolgate-agent.sock");
    registerSshIpcHandlers(ctx);

    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);
    await connectHandler?.(null, {
      hostId: "host-1",
      cols: 120,
      rows: 32,
    });

    const expectedEndpoint =
      process.platform === "win32"
        ? {
            agentForwardingEndpointKind: "windows-openssh-pipe",
            agentForwardingEndpoint: "\\\\.\\pipe\\openssh-ssh-agent",
          }
        : {
            agentForwardingEndpointKind: "unix",
            agentForwardingEndpoint: "/tmp/dolgate-agent.sock",
          };
    expect(ctx.coreManager.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        agentForwarding: true,
        ...expectedEndpoint,
      }),
    );
  });

  it("forwards startup commands for Warpgate SSH sessions", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "warpgate-1",
      kind: "warpgate-ssh",
      label: "Warpgate Prod",
      warpgateBaseUrl: "https://warpgate.example.com",
      warpgateSshHost: "warpgate.example.com",
      warpgateSshPort: 2222,
      warpgateTargetId: "target-1",
      warpgateTargetName: "prod",
      warpgateUsername: "operator",
    });
    ctx.requireTrustedHostKeys.mockReturnValue(["trusted"]);
    ctx.coreManager.connect.mockResolvedValue({ sessionId: "session-warpgate" });
    registerSshIpcHandlers(ctx);

    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);
    await connectHandler?.(null, {
      hostId: "warpgate-1",
      cols: 120,
      rows: 32,
      startupCommand: "tmux attach",
    });

    expect(ctx.coreManager.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "warpgate",
        startupCommand: "tmux attach",
      }),
    );
  });

  it("uses the local AWS SSM session path when server proxy is disabled", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
    });
    ctx.awsService.requireManagedProfileName.mockReturnValue("managed-prod");
    ctx.awsService.buildManagedSessionEnvSpec.mockReturnValue({
      env: { AWS_CONFIG_FILE: "/managed/config" },
      unsetEnv: ["AWS_PROFILE"],
    });
    ctx.coreManager.connectAwsSession.mockResolvedValue({ sessionId: "session-local-aws" });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, {
        hostId: "aws-host-1",
        cols: 120,
        rows: 32,
        startupCommand: "sudo -i",
      }),
    ).resolves.toEqual({ sessionId: "session-local-aws" });

    expect(ctx.coreManager.connectAwsSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "managed-prod",
        region: "ap-southeast-2",
        instanceId: "i-123",
        env: { AWS_CONFIG_FILE: "/managed/config" },
        unsetEnv: ["AWS_PROFILE"],
        startupCommand: "sudo -i",
      }),
    );
    expect(ctx.awsService.startSsmShellSession).not.toHaveBeenCalled();
    expect(ctx.coreManager.connectAwsServerProxySession).not.toHaveBeenCalled();
  });

  it("issues an in-process SSM session token and forwards it to the core", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
    });
    ctx.awsService.requireManagedProfileName.mockReturnValue("managed-prod");
    ctx.awsService.buildManagedSessionEnvSpec.mockReturnValue({
      env: { AWS_CONFIG_FILE: "/managed/config" },
      unsetEnv: ["AWS_PROFILE"],
    });
    ctx.awsService.shouldUseInProcessSsm.mockReturnValue(true);
    ctx.awsService.startSsmShellSession.mockResolvedValue({
      sessionId: "ssm-sess-1",
      streamUrl: "wss://ssmmessages.ap-southeast-2.amazonaws.com/v1/data-channel/ssm-sess-1",
      tokenValue: "token-1",
    });
    ctx.coreManager.connectAwsSession.mockResolvedValue({ sessionId: "session-local-aws" });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, {
        hostId: "aws-host-1",
        cols: 120,
        rows: 32,
      }),
    ).resolves.toEqual({ sessionId: "session-local-aws" });

    expect(ctx.awsService.startSsmShellSession).toHaveBeenCalledWith(
      "managed-prod",
      "ap-southeast-2",
      "i-123",
    );
    expect(ctx.coreManager.connectAwsSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ssmSession: {
          sessionId: "ssm-sess-1",
          streamUrl:
            "wss://ssmmessages.ap-southeast-2.amazonaws.com/v1/data-channel/ssm-sess-1",
          tokenValue: "token-1",
        },
      }),
    );
  });

  it("uses the server proxy AWS SSM session path when enabled", async () => {
    const ctx = createContext();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            serverVersion: "test",
            capabilities: {
              sync: { awsProfiles: true },
              sessions: { awsSsm: true },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: true,
    });
    ctx.awsService.requireManagedProfileName.mockReturnValue("managed-prod");
    ctx.awsService.buildServerProxySessionEnvSpec.mockResolvedValue({
      env: {
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_REGION: "ap-southeast-2",
        AWS_DEFAULT_REGION: "ap-southeast-2",
      },
      unsetEnv: ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"],
    });
    ctx.coreManager.connectAwsServerProxySession.mockResolvedValue({
      sessionId: "session-server-proxy",
    });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, {
        hostId: "aws-host-1",
        cols: 140,
        rows: 40,
        title: "AWS Prod",
        startupCommand: "sudo -i",
      }),
    ).resolves.toEqual({ sessionId: "session-server-proxy" });

    expect(ctx.awsService.buildServerProxySessionEnvSpec).toHaveBeenCalledWith(
      "managed-prod",
      "ap-southeast-2",
    );
    expect(ctx.coreManager.connectAwsServerProxySession).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://sync.example.com",
        accessToken: "access-token",
        profileName: "managed-prod",
        region: "ap-southeast-2",
        instanceId: "i-123",
        env: expect.objectContaining({
          AWS_ACCESS_KEY_ID: "AKIATEST",
        }),
        unsetEnv: ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"],
        startupCommand: "sudo -i",
      }),
    );
    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
  });

  function createAwsEc2Context(hostOverrides: Record<string, unknown> = {}) {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
      ...hostOverrides,
    });
    ctx.awsService.requireManagedProfileName.mockReturnValue(
      "managed-prod",
    );
    ctx.awsService.buildManagedSessionEnvSpec.mockReturnValue({
      env: { AWS_CONFIG_FILE: "/managed/config" },
      unsetEnv: ["AWS_PROFILE"],
    });
    ctx.coreManager.connectAwsSession.mockResolvedValue({
      sessionId: "session-ssm-shell",
    });
    return ctx;
  }

  it("connects EC2 over SSH-over-SSM first and skips the SSM shell when it succeeds", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockResolvedValue({ sessionId: "session-ssh" });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, {
        hostId: "aws-host-1",
        cols: 120,
        rows: 32,
        startupCommand: "sudo -i",
      }),
    ).resolves.toEqual({ sessionId: "session-ssh" });

    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: "aws-host-1" }),
      expect.objectContaining({
        cols: 120,
        rows: 32,
        startupCommand: "sudo -i",
        awaitReady: true,
      }),
    );
    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
    expect(ctx.coreManager.connectAwsServerProxySession).not.toHaveBeenCalled();
    expect(ctx.activityLogs.append).not.toHaveBeenCalled();
  });

  it("connects server-proxy EC2 hosts over SSH-over-SSM first as well", async () => {
    const ctx = createAwsEc2Context({ awsSsmServerProxyEnabled: true });
    connectAwsEc2OverSsmMock.mockResolvedValue({
      sessionId: "session-ssh-proxy",
    });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).resolves.toEqual({ sessionId: "session-ssh-proxy" });

    // 프록시 모드도 SSH-over-SSM이 성공하면 SSM 셸(프록시 세션)을 열지 않는다.
    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(1);
    expect(ctx.coreManager.connectAwsServerProxySession).not.toHaveBeenCalled();
    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
  });

  it("falls back to the server-proxy SSM session when proxy-mode SSH-over-SSM fails", async () => {
    const ctx = createAwsEc2Context({ awsSsmServerProxyEnabled: true });
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            serverVersion: "test",
            capabilities: { sessions: { awsSsm: true } },
          }),
          { status: 200 },
        ),
      ),
    );
    ctx.awsService.buildServerProxySessionEnvSpec.mockResolvedValue({
      env: { AWS_REGION: "ap-southeast-2" },
      unsetEnv: [],
    });
    ctx.coreManager.connectAwsServerProxySession.mockResolvedValue({
      sessionId: "session-server-proxy-fallback",
    });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).resolves.toEqual({ sessionId: "session-server-proxy-fallback" });

    expect(ctx.coreManager.connectAwsServerProxySession).toHaveBeenCalledTimes(1);
    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
    expect(ctx.activityLogs.append).toHaveBeenCalledWith(
      "warn",
      "session",
      expect.objectContaining({ messageKey: "sshIpc.fallbackNotice" }),
      expect.objectContaining({ hostId: "aws-host-1" }),
    );
  });

  it("falls back to the SSM shell and records an activity log when SSH-over-SSM fails", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("EIC not supported"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).resolves.toEqual({ sessionId: "session-ssm-shell" });

    expect(ctx.coreManager.connectAwsSession).toHaveBeenCalledTimes(1);
    expect(ctx.activityLogs.append).toHaveBeenCalledWith(
      "warn",
      "session",
      expect.objectContaining({ messageKey: "sshIpc.fallbackNotice" }),
      expect.objectContaining({
        hostId: "aws-host-1",
        reason: "EIC not supported",
      }),
    );
  });

  it("rethrows host-key trust errors without falling back to the SSM shell", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(
      new Error("Host key is not trusted yet."),
    );

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).rejects.toThrow("Host key is not trusted yet.");

    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
    expect(ctx.activityLogs.append).not.toHaveBeenCalled();
  });

  it.each([
    "host key mismatch",
    "Host key changed.",
    "trusted host key is required",
    "Host key trust is required.",
  ])(
    "rethrows host-key security errors without falling back: %s",
    async (message) => {
      const ctx = createAwsEc2Context();
      connectAwsEc2OverSsmMock.mockRejectedValue(new Error(message));

      registerSshIpcHandlers(ctx);
      const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

      await expect(
        connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
      ).rejects.toThrow(message);

      expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
      expect(ctx.activityLogs.append).not.toHaveBeenCalled();
    },
  );

  it("skips the SSH-over-SSM attempt on the next connect after a fallback", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });
    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    // 첫 연결만 SSH를 시도하고, 두 번째는 기억된 폴백으로 곧장 SSM 셸.
    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(1);
    expect(ctx.coreManager.connectAwsSession).toHaveBeenCalledTimes(2);
  });

  it("retries SSH-over-SSM after a fallback when the host connection settings change", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    // 호스트의 SSH 포트가 바뀌면 시그니처가 달라져 SSH부터 다시 시도한다.
    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
      awsSshPort: 2222,
    });
    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(2);
  });

  it("retries SSH-over-SSM after a fallback when the SSH username changes", async () => {
    const ctx = createAwsEc2Context({ awsSshUsername: "ubuntu" });
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
      awsSshUsername: "ec2-user",
    });
    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(2);
  });

  it("retries SSH-over-SSM after a fallback when the availability zone changes", async () => {
    const ctx = createAwsEc2Context({ awsAvailabilityZone: "ap-southeast-2a" });
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    ctx.hosts.getById.mockReturnValue({
      id: "aws-host-1",
      kind: "aws-ec2",
      label: "AWS Prod",
      awsProfileId: "profile-1",
      awsProfileName: "default",
      awsRegion: "ap-southeast-2",
      awsInstanceId: "i-123",
      awsSsmServerProxyEnabled: false,
      awsAvailabilityZone: "ap-southeast-2b",
    });
    await connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 });

    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(2);
  });

  it("does not memoize the SSH-over-SSM failure when the SSM shell fallback also fails", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));
    ctx.coreManager.connectAwsSession
      .mockRejectedValueOnce(new Error("ssm denied"))
      .mockResolvedValueOnce({ sessionId: "session-ssm-shell" });

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).rejects.toThrow(
      "SSH-over-SSM 연결 실패 후 SSM 셸 폴백도 실패했습니다.",
    );

    await expect(
      connectHandler?.(null, { hostId: "aws-host-1", cols: 120, rows: 32 }),
    ).resolves.toEqual({ sessionId: "session-ssm-shell" });

    expect(connectAwsEc2OverSsmMock).toHaveBeenCalledTimes(2);
    expect(ctx.activityLogs.append).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for tmux connections when SSH-over-SSM fails", async () => {
    const ctx = createAwsEc2Context();
    connectAwsEc2OverSsmMock.mockRejectedValue(new Error("sshd unreachable"));

    registerSshIpcHandlers(ctx);
    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);

    await expect(
      connectHandler?.(null, {
        hostId: "aws-host-1",
        cols: 120,
        rows: 32,
        tmux: true,
      }),
    ).rejects.toThrow("sshd unreachable");

    expect(ctx.coreManager.connectAwsSession).not.toHaveBeenCalled();
  });
});
