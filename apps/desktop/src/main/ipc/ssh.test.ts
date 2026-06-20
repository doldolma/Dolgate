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

import { registerSshIpcHandlers } from "./ssh";

function createContext() {
  return {
    hosts: {
      getById: vi.fn(),
    },
    awsService: {
      resolveManagedProfileNameOrFallback: vi.fn(),
      buildManagedSessionEnvSpec: vi.fn(),
      buildServerProxySessionEnvSpec: vi.fn(),
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
    ctx.awsService.resolveManagedProfileNameOrFallback.mockReturnValue("managed-prod");
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
    expect(ctx.coreManager.connectAwsServerProxySession).not.toHaveBeenCalled();
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
    ctx.awsService.resolveManagedProfileNameOrFallback.mockReturnValue("managed-prod");
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
});
