import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostCoordinator } from "./host-coordinator";

function createAwsHost() {
  return {
    id: "host-1",
    kind: "aws-ec2",
    label: "Prod EC2",
    awsProfileId: null,
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-123",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "prod",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    groupName: "Servers",
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as any;
}

function createCoordinator(options: { probeHostKey?: ReturnType<typeof vi.fn> } = {}) {
  const host = createAwsHost();
  const deps = {
    hosts: {
      getById: vi.fn(() => host),
      list: vi.fn(() => []),
    },
    knownHosts: {
      listByHostPort: vi.fn(() => []),
      getByHostPortAlgorithm: vi.fn(() => null),
      touch: vi.fn(),
    },
    coreManager: {
      probeHostKey:
        options.probeHostKey ??
        vi
          .fn()
          .mockRejectedValueOnce(new Error("ssh handshake failed: EOF"))
          .mockResolvedValueOnce({
            algorithm: "ecdsa-sha2-nistp256",
            publicKeyBase64: "AAAATEST",
            fingerprintSha256: "SHA256:test",
          }),
    },
    awsService: {
      resolveManagedProfileNameOrFallback: vi.fn((_id, name) => name),
    },
    awsSsmTunnelService: {
      start: vi.fn().mockResolvedValue({
        runtimeId: "runtime-1",
        bindAddress: "127.0.0.1",
        bindPort: 2222,
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    awsSftpCoordinator: {
      resolvePreflight: vi.fn().mockResolvedValue(host),
      reserveLoopbackPort: vi.fn().mockResolvedValue(2222),
      storePreflight: vi.fn(),
      formatSftpStageError: vi.fn((stage, error, errorOptions = {}) => {
        const message = error instanceof Error ? error.message : String(error);
        const formatted = new Error(`[${stage}] ${message}`);
        Object.assign(formatted, {
          awsSftpDiagnostic: {
            stage,
            reasonCode: errorOptions.reasonCode ?? "unknown",
            diagnosticId: "diag-1",
            message,
            details: errorOptions.details ?? {},
          },
        });
        return formatted;
      }),
      buildDiagnosticDetails: vi.fn(() => ({})),
    },
  } as any;

  return {
    deps,
    host,
    coordinator: createHostCoordinator(deps),
  };
}

describe("host coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries AWS host-key probe once after a transient SSH handshake failure", async () => {
    vi.useFakeTimers();
    const { deps, coordinator } = createCoordinator();
    const emitProgress = vi.fn();

    const probePromise = coordinator.buildHostKeyProbeResult(emitProgress, {
      hostId: "host-1",
      endpointId: "endpoint-1",
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(probePromise).resolves.toMatchObject({
      hostId: "host-1",
      host: "aws-ssm:prod:ap-northeast-2:i-123",
      port: 22,
      algorithm: "ecdsa-sha2-nistp256",
      status: "untrusted",
    });
    expect(deps.coreManager.probeHostKey).toHaveBeenCalledTimes(2);
    expect(deps.awsSsmTunnelService.stop).toHaveBeenCalledWith("runtime-1");
  });

  it("does not report transient AWS host-key probe failures as missing trust", async () => {
    vi.useFakeTimers();
    const probeHostKey = vi
      .fn()
      .mockRejectedValue(new Error("ssh handshake failed: EOF"));
    const { deps, coordinator } = createCoordinator({ probeHostKey });
    const emitProgress = vi.fn();

    const probePromise = coordinator.buildHostKeyProbeResult(emitProgress, {
      hostId: "host-1",
      endpointId: "endpoint-1",
    });
    const expectation = expect(probePromise).rejects.toMatchObject({
      awsSftpDiagnostic: {
        stage: "probing-host-key",
        reasonCode: "tunnel-open-failed",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    expect(deps.coreManager.probeHostKey).toHaveBeenCalledTimes(2);
    expect(emitProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "probing-host-key",
        reasonCode: "tunnel-open-failed",
      }),
    );
  });
});
