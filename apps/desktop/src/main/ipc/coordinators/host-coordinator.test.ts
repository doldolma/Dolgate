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

function createCoordinator(
  options: { probeHostKey?: ReturnType<typeof vi.fn>; serverProxy?: boolean } = {},
) {
  const host = options.serverProxy
    ? { ...createAwsHost(), awsSsmServerProxyEnabled: true }
    : createAwsHost();
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
      requireManagedProfileName: vi.fn((_id, name) => name),
      buildServerProxySessionEnvSpec: vi.fn().mockResolvedValue({
        env: { AWS_ACCESS_KEY_ID: "AKIA" },
        unsetEnv: [],
      }),
    },
    authService: {
      getServerUrl: vi.fn(() => "https://sync.example.com"),
      getAccessToken: vi.fn(() => "token-1"),
      refreshSession: vi.fn().mockResolvedValue({ status: "authenticated" }),
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
      createEphemeralAwsSftpKeyPair: vi.fn(() => ({
        privateKeyPem: "private",
        publicKey: "public",
      })),
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
    tailnets: {
      list: vi.fn(() => [
        {
          id: "net-a",
          label: "Work",
          tailnetName: "gridwiz.com",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    },
    resolveRuntimeSshSecrets: vi
      .fn()
      .mockResolvedValue({ secrets: {}, shouldPersistHostSecret: false }),
    ensureCertificateAuthReady: vi.fn().mockResolvedValue(null),
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

  it("probes AWS host key through the server proxy when enabled", async () => {
    const probeHostKey = vi.fn().mockResolvedValue({
      algorithm: "ecdsa-sha2-nistp256",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
    });
    const { deps, coordinator } = createCoordinator({
      probeHostKey,
      serverProxy: true,
    });
    const emitProgress = vi.fn();

    await expect(
      coordinator.buildHostKeyProbeResult(emitProgress, {
        hostId: "host-1",
        endpointId: "endpoint-1",
      }),
    ).resolves.toMatchObject({
      host: "aws-ssm:prod:ap-northeast-2:i-123",
      port: 22,
      status: "untrusted",
    });

    // 서버 프록시 경로: WS 릴레이로 인스턴스에 붙어 키를 읽고, 로컬 SSM 터널은 열지 않는다.
    expect(probeHostKey).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "i-123",
        port: 22,
        wsProxy: expect.objectContaining({
          url: expect.stringContaining("/api/aws-ssh-tunnel/ws"),
          authToken: "token-1",
        }),
      }),
    );
    expect(deps.awsSsmTunnelService.start).not.toHaveBeenCalled();
  });
});

// 코어가 실제로 붙은 tailnet 과 대조하려면 기대 이름을 함께 넘겨야 한다. 안 넘기면 다른
// 계정으로 로그인해 엉뚱한 tailnet 의 동명 머신에 붙어도 그냥 진행된다.
describe("resolveTailnetRoute", () => {
  it("carries the expected tailnet name from the settings record", () => {
    const { coordinator } = createCoordinator();

    expect(coordinator.resolveTailnetRoute({ tailnetId: "net-a" })).toEqual({
      tailnetId: "net-a",
      tailnetName: "gridwiz.com",
    });
  });

  it("returns no route when the host does not use a tailnet", () => {
    const { coordinator } = createCoordinator();

    expect(coordinator.resolveTailnetRoute({})).toEqual({});
    expect(coordinator.resolveTailnetRoute({ tailnetId: null })).toEqual({});
    expect(coordinator.resolveTailnetRoute({ tailnetId: "  " })).toEqual({});
  });

  // 저장소의 신뢰 범위 정규화(normalizeTailnetScope)와 같은 규칙이어야 한다. 여기서 안
  // 다듬으면 같은 tailnet 이 경로에서는 안 잡히고 신뢰 범위에서는 잡혀 어긋난다.
  it("trims the id so a padded value still resolves", () => {
    const { coordinator } = createCoordinator();

    expect(coordinator.resolveTailnetRoute({ tailnetId: " net-a " })).toEqual({
      tailnetId: "net-a",
      tailnetName: "gridwiz.com",
    });
  });

  // 설정이 지워졌는데 호스트에만 id 가 남은 경우. 경로만 비워서 넘기면 일반 네트워크로
  // 나가는데 그건 실패가 아니라 성공이다 — tailnet 안에 있다고 믿는 트래픽이 공개망으로
  // 나가고, 신뢰 범위는 여전히 그 tailnet 이라 거기서 받은 키가 tailnet 범위에 저장된다.
  //
  // 이 경로는 평범하게 열린다: 설정에서 tailnet 삭제(호스트의 tailnetId 는 남는다), 툼스톤
  // 전파, 호스트 전송 번들 가져오기(번들은 tailnets 를 담지 않는다).
  it("refuses to connect when the tailnet setting is gone", () => {
    const { coordinator } = createCoordinator();

    expect(() => coordinator.resolveTailnetRoute({ tailnetId: "net-deleted" })).toThrow(
      /tailnet/i,
    );
  });
});
