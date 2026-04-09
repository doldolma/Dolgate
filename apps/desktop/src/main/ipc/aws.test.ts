import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerAwsIpcHandlers } from "./aws";

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

describe("registerAwsIpcHandlers", () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  it("records an awsProfiles tombstone when deleting a managed AWS profile", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const getProfileDetails = vi.fn().mockResolvedValue({
      id: "profile-default",
      profileName: "default",
    });
    const deleteProfile = vi.fn().mockResolvedValue(undefined);
    const upsertDeletion = vi.fn();
    const queueSync = vi.fn();

    registerAwsIpcHandlers({
      awsService: {
        listProfiles: vi.fn(),
        listExternalProfiles: vi.fn(),
        createProfile: vi.fn(),
        prepareSsoProfile: vi.fn(),
        getProfileDetails,
        getExternalProfileDetails: vi.fn(),
        importExternalProfiles: vi.fn(),
        updateProfile: vi.fn(),
        renameProfile: vi.fn(),
        deleteProfile,
        getProfileStatus: vi.fn(),
        login: vi.fn(),
        listRegions: vi.fn(),
        listEc2Instances: vi.fn(),
        listEcsClusters: vi.fn(),
        resolveManagedProfileNameOrFallback: vi.fn(),
        describeEcsClusterSnapshot: vi.fn(),
        describeEcsClusterUtilization: vi.fn(),
        describeEcsServiceActionContext: vi.fn(),
        loadEcsServiceLogs: vi.fn(),
        openEcsExecShell: vi.fn(),
        inspectHostSshMetadata: vi.fn(),
      },
      syncOutbox: {
        upsertDeletion,
      },
      queueSync,
      hosts: {
        backfillAwsProfileReferences: vi.fn(() => []),
        getById: vi.fn(),
      },
      assertAwsEcsHost: vi.fn(),
      coreManager: {
        connectAwsSession: vi.fn(),
      },
    } as any);

    const handler = handlers.get(ipcChannels.aws.deleteProfile);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.deleteProfile handler to be registered");
    }

    await handler({}, "default");

    expect(getProfileDetails).toHaveBeenCalledWith("default");
    expect(deleteProfile).toHaveBeenCalledWith("default");
    expect(upsertDeletion).toHaveBeenCalledWith("awsProfiles", "profile-default");
    expect(queueSync).toHaveBeenCalledTimes(1);
  });

  it("retries ECS exec shell setup once with a fresh action context when the cached task selection is stale", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const describeEcsServiceActionContext = vi
      .fn()
      .mockResolvedValueOnce({
        runningTasks: [],
      })
      .mockResolvedValueOnce({
        runningTasks: [
          {
            taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
            enableExecuteCommand: true,
            containers: [{ containerName: "api" }],
          },
        ],
      });
    const invalidateEcsServiceActionContext = vi.fn();
    const connectLocalSession = vi.fn().mockResolvedValue({ sessionId: "session-1" });

    registerAwsIpcHandlers({
      awsService: {
        resolveManagedProfileNameOrFallback: vi.fn().mockReturnValue("default"),
        ensureAwsCliAvailable: vi.fn().mockResolvedValue(undefined),
        ensureSessionManagerPluginAvailable: vi.fn().mockResolvedValue(undefined),
        describeEcsServiceActionContext,
        invalidateEcsServiceActionContext,
      },
      hosts: {
        getById: vi.fn().mockReturnValue({
          id: "host-1",
          label: "prod",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
        }),
      },
      assertAwsEcsHost: vi.fn(),
      coreManager: {
        connectLocalSession,
      },
      normalizeEcsExecPermissionError: vi.fn((error) => error as Error),
    } as any);

    const handler = handlers.get(ipcChannels.aws.openEcsExecShell);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.openEcsExecShell handler to be registered");
    }

    await expect(
      handler({}, {
        hostId: "host-1",
        serviceName: "api",
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        containerName: "api",
        cols: 120,
        rows: 40,
      }),
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(invalidateEcsServiceActionContext).toHaveBeenCalledWith(
      "default",
      "ap-northeast-2",
      "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
      "api",
    );
    expect(describeEcsServiceActionContext).toHaveBeenCalledTimes(2);
    expect(connectLocalSession).toHaveBeenCalledTimes(1);
  });

  it("retries ECS tunnel startup once after invalidating the cached action context", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const invalidateEcsServiceActionContext = vi.fn();
    const resolveEcsTaskTunnelTargetForTask = vi
      .fn()
      .mockResolvedValueOnce("ecs:prod_task-1_runtime-old")
      .mockResolvedValueOnce("ecs:prod_task-1_runtime-new");
    const startSsmPortForward = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale target"))
      .mockResolvedValueOnce({ ruleId: "runtime-1" });

    registerAwsIpcHandlers({
      awsService: {
        resolveManagedProfileNameOrFallback: vi.fn().mockReturnValue("default"),
        ensureAwsCliAvailable: vi.fn().mockResolvedValue(undefined),
        ensureSessionManagerPluginAvailable: vi.fn().mockResolvedValue(undefined),
        resolveEcsTaskTunnelTargetForTask,
        invalidateEcsServiceActionContext,
      },
      hosts: {
        getById: vi.fn().mockReturnValue({
          id: "host-1",
          label: "prod",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
        }),
      },
      assertAwsEcsHost: vi.fn(),
      coreManager: {
        startSsmPortForward,
      },
    } as any);

    const handler = handlers.get(ipcChannels.aws.startEcsServiceTunnel);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.startEcsServiceTunnel handler to be registered");
    }

    await expect(
      handler({}, {
        hostId: "host-1",
        serviceName: "api",
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        containerName: "api",
        targetPort: 8080,
        bindAddress: "127.0.0.1",
        bindPort: 18080,
      }),
    ).resolves.toEqual({ ruleId: "runtime-1" });

    expect(invalidateEcsServiceActionContext).toHaveBeenCalledWith(
      "default",
      "ap-northeast-2",
      "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
      "api",
    );
    expect(resolveEcsTaskTunnelTargetForTask).toHaveBeenCalledTimes(2);
    expect(startSsmPortForward).toHaveBeenCalledTimes(2);
  });
});
