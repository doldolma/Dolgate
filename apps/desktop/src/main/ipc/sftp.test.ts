import { beforeEach, describe, expect, it, vi } from "vitest";
import { inferAwsSftpDiagnosticReasonCode } from "@shared";
import { ipcChannels } from "../../common/ipc-channels";

const ipcHandlers = new Map<string, (...args: any[]) => any>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

import { registerSftpIpcHandlers } from "./sftp";

function createAwsHost(overrides = {}) {
  return {
    id: "aws-host-1",
    kind: "aws-ec2" as const,
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
    awsSshMetadataStatus: "ready" as const,
    awsSshMetadataError: null,
    groupName: "Servers",
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createContext(host = createAwsHost()) {
  const emitSftpConnectionProgress = vi.fn();
  return {
    hosts: {
      getById: vi.fn().mockReturnValue(host),
    },
    assertSftpCompatibleHost: vi.fn(),
    consumeAwsSftpPreflight: vi.fn().mockReturnValue(host),
    resolveAwsSftpPreflight: vi.fn(),
    awsService: {
      resolveManagedProfileNameOrFallback: vi.fn().mockReturnValue("default"),
      sendSshPublicKey: vi.fn().mockResolvedValue(undefined),
    },
    requireTrustedHostKey: vi.fn().mockReturnValue("AAAATEST"),
    emitSftpConnectionProgress,
    emitSftpConnectionFailureProgress: vi.fn((input) => {
      const message =
        input.error instanceof Error ? input.error.message : "failed";
      emitSftpConnectionProgress({
        endpointId: input.endpointId,
        hostId: input.host.id,
        stage: input.stage,
        message,
        reasonCode:
          input.reasonCode ??
          inferAwsSftpDiagnosticReasonCode(input.stage, message),
        diagnosticId: "diag-test",
        details: {
          profileName: "default",
          region: input.host.awsRegion,
          instanceId: input.host.awsInstanceId,
        },
      });
      return new Error(`[${input.stage}] ${message}`);
    }),
    createEphemeralAwsSftpKeyPair: vi.fn().mockReturnValue({
      privateKeyPem: "PRIVATE KEY",
      publicKey: "PUBLIC KEY",
    }),
    reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
    awsSsmTunnelService: {
      start: vi.fn().mockResolvedValue({
        runtimeId: "aws-sftp-runtime",
        bindAddress: "127.0.0.1",
        bindPort: 2222,
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    coreManager: {
      sftpConnect: vi.fn().mockResolvedValue({
        id: "endpoint-aws",
        kind: "remote",
        hostId: host.id,
        title: host.label,
        path: "/home/ubuntu",
        connectedAt: "2025-01-01T00:00:00.000Z",
      }),
    },
    trackAwsSftpTunnelRuntime: vi.fn(),
    clearAwsSftpPreflight: vi.fn(),
  } as any;
}

describe("registerSftpIpcHandlers", () => {
  beforeEach(() => {
    ipcHandlers.clear();
  });

  it("emits a missing-username diagnostic when AWS SSH metadata has no username", async () => {
    const ctx = createContext(createAwsHost({ awsSshUsername: null }));
    registerSftpIpcHandlers(ctx);

    const handler = ipcHandlers.get(ipcChannels.sftp.connect);
    expect(handler).toBeTypeOf("function");

    await expect(
      handler?.(null, {
        hostId: "aws-host-1",
        endpointId: "endpoint-aws",
      }),
    ).rejects.toThrow("자동으로 SSH 사용자명을 확인하지 못했습니다.");

    expect(ctx.emitSftpConnectionFailureProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "endpoint-aws",
        stage: "loading-instance-metadata",
        reasonCode: "missing-username",
      }),
    );
    expect(ctx.coreManager.sftpConnect).not.toHaveBeenCalled();
  });

  it("classifies EC2 Instance Connect access errors without passing secrets into diagnostics", async () => {
    const ctx = createContext();
    ctx.awsService.sendSshPublicKey.mockRejectedValue(
      new Error("AccessDeniedException: not authorized"),
    );
    registerSftpIpcHandlers(ctx);

    const handler = ipcHandlers.get(ipcChannels.sftp.connect);
    await expect(
      handler?.(null, {
        hostId: "aws-host-1",
        endpointId: "endpoint-aws",
      }),
    ).rejects.toThrow("AccessDeniedException");

    expect(ctx.emitSftpConnectionFailureProgress).toHaveBeenCalledWith(
      expect.not.objectContaining({
        privateKeyPem: "PRIVATE KEY",
        publicKey: "PUBLIC KEY",
      }),
    );
    expect(ctx.emitSftpConnectionProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "sending-public-key",
        reasonCode: "eic-access-denied",
      }),
    );
  });

  it("emits a tunnel diagnostic and keeps SFTP connect from running when SSM tunnel startup fails", async () => {
    const ctx = createContext();
    ctx.awsSsmTunnelService.start.mockRejectedValue(
      new Error("session-manager-plugin failed"),
    );
    registerSftpIpcHandlers(ctx);

    const handler = ipcHandlers.get(ipcChannels.sftp.connect);
    await expect(
      handler?.(null, {
        hostId: "aws-host-1",
        endpointId: "endpoint-aws",
      }),
    ).rejects.toThrow("session-manager-plugin failed");

    expect(ctx.emitSftpConnectionFailureProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "endpoint-aws",
        stage: "opening-tunnel",
      }),
    );
    expect(ctx.coreManager.sftpConnect).not.toHaveBeenCalled();
  });
});
