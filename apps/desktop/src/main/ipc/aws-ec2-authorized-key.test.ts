import { describe, expect, it, vi } from "vitest";
import {
  installAwsEc2AuthorizedKeyOverSsm,
  installSshPublicKeyWithAwsSupport,
} from "./aws-ec2-authorized-key";

vi.mock("../aws-ws-proxy", () => ({
  buildAwsServerProxyStartMessage: vi.fn().mockResolvedValue({ kind: "start" }),
  buildAwsWsProxyTarget: vi.fn().mockReturnValue({ url: "wss://relay" }),
  runWithAwsServerProxyAuthRetry: vi.fn((_auth, fn) => fn("access-token")),
}));

vi.mock("./coordinators/aws-ssm-ssh-retry", () => ({
  retryAwsSsmSshOperation: vi.fn((fn) => fn()),
}));

function createAwsHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "aws-host-1",
    kind: "aws-ec2" as const,
    label: "AWS Linux",
    awsProfileId: "profile-1",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-aws123",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "aws-linux",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready" as const,
    awsSshMetadataError: null,
    awsSsmServerProxyEnabled: false,
    groupName: "Servers",
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createCtx(
  host: ReturnType<typeof createAwsHost>,
  overrides: Record<string, unknown> = {},
) {
  const installAuthorizedKey = vi
    .fn()
    .mockResolvedValue({ status: "installed" });
  const tunnelStart = vi.fn().mockResolvedValue({
    runtimeId: "aws-ec2-install-runtime",
    bindAddress: "127.0.0.1",
    bindPort: 2222,
  });
  const tunnelStop = vi.fn().mockResolvedValue(undefined);
  const sendSshPublicKey = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    resolveAwsSftpPreflight: vi.fn().mockResolvedValue(host),
    awsService: {
      requireManagedProfileName: vi
        .fn()
        .mockReturnValue("managed-profile"),
      sendSshPublicKey,
    },
    authService: {
      getServerUrl: vi.fn().mockReturnValue("https://relay.example.com"),
    },
    requireTrustedHostKeys: vi.fn().mockReturnValue(["TRUSTED_KEY"]),
    createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
      privateKeyPem: "EPHEMERAL_PRIVATE",
      publicKey: "EPHEMERAL_PUBLIC",
    }),
    reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
    awsSsmTunnelService: { start: tunnelStart, stop: tunnelStop },
    coreManager: { installAuthorizedKey },
    ...overrides,
  };
  return { ctx, installAuthorizedKey, tunnelStart, tunnelStop, sendSshPublicKey };
}

describe("installAwsEc2AuthorizedKeyOverSsm", () => {
  it("pushes an EIC key, installs over a direct SSM tunnel, and tears it down", async () => {
    const host = createAwsHost();
    const { ctx, installAuthorizedKey, tunnelStart, tunnelStop, sendSshPublicKey } =
      createCtx(host);

    await expect(
      installAwsEc2AuthorizedKeyOverSsm(ctx as any, host as any, "PERMANENT_PUBLIC"),
    ).resolves.toEqual({ status: "installed" });

    expect(sendSshPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ osUser: "ubuntu", publicKey: "EPHEMERAL_PUBLIC" }),
    );
    expect(tunnelStart).toHaveBeenCalledTimes(1);
    expect(installAuthorizedKey).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 2222,
        username: "ubuntu",
        authType: "privateKey",
        privateKeyPem: "EPHEMERAL_PRIVATE",
        publicKey: "PERMANENT_PUBLIC",
      }),
    );
    expect(installAuthorizedKey.mock.calls[0][0].wsProxy).toBeUndefined();
    expect(tunnelStop).toHaveBeenCalledWith("aws-ec2-install-runtime");
  });

  it("installs over the server-proxy WS relay without a local tunnel or EIC push", async () => {
    const host = createAwsHost({ awsSsmServerProxyEnabled: true });
    const { ctx, installAuthorizedKey, tunnelStart, sendSshPublicKey } =
      createCtx(host);

    await expect(
      installAwsEc2AuthorizedKeyOverSsm(ctx as any, host as any, "PERMANENT_PUBLIC"),
    ).resolves.toEqual({ status: "installed" });

    expect(tunnelStart).not.toHaveBeenCalled();
    expect(sendSshPublicKey).not.toHaveBeenCalled();
    expect(installAuthorizedKey).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "i-aws123",
        port: 22,
        publicKey: "PERMANENT_PUBLIC",
        wsProxy: { url: "wss://relay" },
      }),
    );
  });

  it("tears the direct tunnel down when the install fails", async () => {
    const host = createAwsHost();
    const installAuthorizedKey = vi
      .fn()
      .mockRejectedValue(new Error("sshd unreachable"));
    const { ctx, tunnelStop } = createCtx(host, {
      coreManager: { installAuthorizedKey },
    });

    await expect(
      installAwsEc2AuthorizedKeyOverSsm(ctx as any, host as any, "PERMANENT_PUBLIC"),
    ).rejects.toThrow("sshd unreachable");
    expect(tunnelStop).toHaveBeenCalledWith("aws-ec2-install-runtime");
  });
});

describe("installSshPublicKeyWithAwsSupport", () => {
  it("routes ssh hosts to the coordinator and ec2 hosts over SSH-over-SSM, merging in order", async () => {
    const awsHost = createAwsHost();
    const { ctx, installAuthorizedKey } = createCtx(awsHost);
    const hostsById: Record<string, unknown> = {
      "ssh-1": { id: "ssh-1", kind: "ssh", label: "Prod" },
      "aws-host-1": awsHost,
    };
    const installSshPublicKey = vi.fn().mockResolvedValue({
      secretRef: "key-ref",
      mode: "installOnly",
      results: [{ hostId: "ssh-1", hostLabel: "Prod", status: "installed" }],
    });
    const resolveSshPublicKey = vi.fn().mockResolvedValue({
      secretRef: "key-ref",
      publicKey: "PERMANENT_PUBLIC",
    });
    const fullCtx = {
      ...ctx,
      hosts: { getById: vi.fn((id: string) => hostsById[id] ?? null) },
      installSshPublicKey,
      resolveSshPublicKey,
    };

    const result = await installSshPublicKeyWithAwsSupport(fullCtx as any, {
      secretRef: "key-ref",
      hostIds: ["ssh-1", "aws-host-1"],
      mode: "installAndUse",
    });

    expect(installSshPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ hostIds: ["ssh-1"] }),
    );
    expect(installAuthorizedKey).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: "PERMANENT_PUBLIC", host: "127.0.0.1" }),
    );
    expect(result.results.map((entry) => entry.hostId)).toEqual([
      "ssh-1",
      "aws-host-1",
    ]);
    expect(result.results[1]).toMatchObject({
      hostId: "aws-host-1",
      status: "installed",
    });
  });

  it("passes through to the coordinator unchanged when no ec2 hosts are selected", async () => {
    const installSshPublicKey = vi.fn().mockResolvedValue({
      secretRef: "key-ref",
      mode: "installAndUse",
      results: [{ hostId: "ssh-1", hostLabel: "Prod", status: "installed" }],
    });
    const fullCtx = {
      hosts: {
        getById: vi.fn(() => ({ id: "ssh-1", kind: "ssh", label: "Prod" })),
      },
      installSshPublicKey,
    };
    const input = {
      secretRef: "key-ref",
      hostIds: ["ssh-1"],
      mode: "installAndUse" as const,
    };

    const result = await installSshPublicKeyWithAwsSupport(fullCtx as any, input);

    expect(installSshPublicKey).toHaveBeenCalledWith(input);
    expect(result.results).toHaveLength(1);
  });

  it("reports the ec2 install as failed without throwing when SSH-over-SSM fails", async () => {
    const awsHost = createAwsHost();
    const installAuthorizedKey = vi
      .fn()
      .mockRejectedValue(new Error("EIC not supported"));
    const { ctx } = createCtx(awsHost, {
      coreManager: { installAuthorizedKey },
    });
    const resolveSshPublicKey = vi.fn().mockResolvedValue({
      secretRef: "key-ref",
      publicKey: "PERMANENT_PUBLIC",
    });
    const fullCtx = {
      ...ctx,
      hosts: { getById: vi.fn(() => awsHost) },
      installSshPublicKey: vi.fn(),
      resolveSshPublicKey,
    };

    const result = await installSshPublicKeyWithAwsSupport(fullCtx as any, {
      secretRef: "key-ref",
      hostIds: ["aws-host-1"],
      mode: "installOnly",
    });

    expect(result.results[0]).toMatchObject({
      hostId: "aws-host-1",
      status: "failed",
      message: "EIC not supported",
    });
    expect(fullCtx.installSshPublicKey).not.toHaveBeenCalled();
  });
});
