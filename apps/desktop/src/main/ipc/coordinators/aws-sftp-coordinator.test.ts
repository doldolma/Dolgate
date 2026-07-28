import { describe, expect, it, vi } from "vitest";
import { createAwsSftpCoordinator } from "./aws-sftp-coordinator";

function createAwsHost(overrides: Record<string, unknown> = {}) {
  return {
    id: "host-1",
    kind: "aws-ec2",
    label: "Prod EC2",
    groupName: null,
    tags: [],
    terminalThemeId: null,
    awsProfileId: null,
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-123",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "prod",
    awsPlatform: "linux",
    awsPrivateIp: "10.0.0.10",
    awsState: "running",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready",
    awsSshMetadataError: null,
    ...overrides,
  } as any;
}

function createCoordinator(
  overrides: Record<string, unknown> = {},
  hostOverrides: Record<string, unknown> = {},
) {
  const host = createAwsHost(hostOverrides);
  const deps = {
    hosts: {
      update: vi.fn((_id, draft) => ({ ...host, ...draft })),
      getById: vi.fn(() => host),
    },
    awsService: {
      requireManagedProfileName: vi.fn((_id, name) => name),
      getProfileStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
      login: vi.fn().mockResolvedValue(undefined),
      shouldUseInProcessSsm: vi.fn(() => false),
      describeEc2Instance: vi.fn().mockResolvedValue(null),
      isManagedInstance: vi.fn().mockResolvedValue(true),
      loadHostSshMetadata: vi.fn().mockResolvedValue({
        recommendedUsername: "ubuntu",
        sshPort: 22,
      }),
    },
    queueSync: vi.fn(),
    emitSftpConnectionProgress: vi.fn(),
    ...overrides,
  } as any;

  return {
    deps,
    host,
    coordinator: createAwsSftpCoordinator(deps),
  };
}

describe("AWS SFTP coordinator", () => {
  it("performs browser login for unauthenticated SSO profiles before preflight", async () => {
    const { deps, coordinator, host } = createCoordinator();
    deps.awsService.getProfileStatus
      .mockResolvedValueOnce({ isAuthenticated: false, isSsoProfile: true })
      .mockResolvedValueOnce({ isAuthenticated: true, isSsoProfile: true });

    await expect(
      coordinator.resolvePreflight({
        endpointId: "endpoint-1",
        host,
        allowBrowserLogin: true,
      }),
    ).resolves.toMatchObject({ id: "host-1" });

    expect(deps.awsService.login).toHaveBeenCalledWith("prod");
  });

  it("emits a sanitized diagnostic when an instance is not managed by SSM", async () => {
    const progress = vi.fn();
    const { deps, coordinator, host } = createCoordinator({
      emitSftpConnectionProgress: progress,
    });
    deps.awsService.isManagedInstance.mockResolvedValue(false);

    await expect(
      coordinator.resolvePreflight({
        endpointId: "endpoint-1",
        host,
        allowBrowserLogin: true,
      }),
    ).rejects.toThrow("[SSM 확인]");

    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpointId: "endpoint-1",
        hostId: "host-1",
        reasonCode: "not-managed-instance",
      }),
    );
  });

  it("preserves the AWS SSM server proxy flag while refreshing SSH metadata", async () => {
    const { deps, coordinator, host } = createCoordinator(
      {},
      {
        awsSsmServerProxyEnabled: true,
        awsSshUsername: null,
        awsSshMetadataStatus: "idle",
      },
    );

    await expect(
      coordinator.resolvePreflight({
        endpointId: "endpoint-1",
        host,
        allowBrowserLogin: true,
      }),
    ).resolves.toMatchObject({
      awsSsmServerProxyEnabled: true,
      awsSshUsername: "ubuntu",
    });

    expect(deps.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        awsSsmServerProxyEnabled: true,
        awsSshMetadataStatus: "loading",
      }),
    );
    expect(deps.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        awsSsmServerProxyEnabled: true,
        awsSshMetadataStatus: "ready",
        awsSshUsername: "ubuntu",
      }),
    );
  });

  it("prunes stale preflight cache entries before consuming", () => {
    const { coordinator, host } = createCoordinator();
    const now = 1_800_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 121_000);

    coordinator.storePreflight("endpoint-1", host);

    expect(coordinator.consumePreflight("endpoint-1", host.id)).toBeNull();
  });

  it("removes secret-looking diagnostic fields", () => {
    const { coordinator, host } = createCoordinator();

    const error = coordinator.formatSftpStageError(
      "checking-profile",
      new Error("boom"),
      {
        details: coordinator.buildDiagnosticDetails(host, {
          password: "hidden",
          accessToken: "hidden",
          safe: "visible",
        }),
      },
    ) as Error & {
      awsSftpDiagnostic?: { details?: Record<string, unknown> };
    };

    expect(error.awsSftpDiagnostic?.details).toMatchObject({ safe: "visible" });
    expect(error.awsSftpDiagnostic?.details).not.toHaveProperty("password");
    expect(error.awsSftpDiagnostic?.details).not.toHaveProperty("accessToken");
  });
});
