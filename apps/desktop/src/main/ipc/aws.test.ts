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
        requireManagedProfileName: vi.fn(),
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
        refreshAwsProfileNameCaches: vi.fn(() => []),
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

  it("resolves host authentication operations by managed profile ID", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const requireManagedProfileName = vi.fn().mockReturnValue("prod-admin");
    const getProfileStatus = vi.fn().mockResolvedValue({
      profileName: "prod-admin",
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      missingTools: [],
    });
    const login = vi.fn().mockResolvedValue(undefined);

    registerAwsIpcHandlers({
      awsService: {
        requireManagedProfileName,
        getProfileStatus,
        login,
      },
    } as any);

    await handlers.get(ipcChannels.aws.getProfileStatusById)?.(
      {},
      "profile-prod",
    );
    await handlers.get(ipcChannels.aws.loginById)?.({}, "profile-prod");

    expect(requireManagedProfileName).toHaveBeenNthCalledWith(
      1,
      "profile-prod",
      null,
    );
    expect(requireManagedProfileName).toHaveBeenNthCalledWith(
      2,
      "profile-prod",
      null,
    );
    expect(getProfileStatus).toHaveBeenCalledWith("prod-admin");
    expect(login).toHaveBeenCalledWith("prod-admin");
  });

  it("updates an aws profile region and queues sync", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const updateProfileRegion = vi.fn().mockResolvedValue(undefined);
    const queueSync = vi.fn();

    registerAwsIpcHandlers({
      awsService: {
        requireManagedProfileName: vi.fn(),
        updateProfileRegion,
      },
      queueSync,
    } as any);

    const handler = handlers.get(ipcChannels.aws.updateProfileRegion);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.updateProfileRegion handler to be registered");
    }

    await handler({}, { profileName: "corp-sso", region: "ap-southeast-2" });

    expect(updateProfileRegion).toHaveBeenCalledWith({
      profileName: "corp-sso",
      region: "ap-southeast-2",
    });
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
    const connectAwsSession = vi.fn().mockResolvedValue({ sessionId: "session-1" });
    const startEcsExecSession = vi.fn().mockResolvedValue({
      sessionId: "ecs-sess-1",
      streamUrl: "wss://ssmmessages.ap-northeast-2.amazonaws.com/v1/data-channel/ecs-sess-1",
      tokenValue: "token-ecs-1",
    });
    const noteSessionConfigured = vi.fn();
    const runWithSessionOwner = vi.fn(
      (_ownerWebContentsId: number, action: () => Promise<unknown>) => action(),
    );

    registerAwsIpcHandlers({
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        startEcsExecSession,
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
        connectAwsSession,
        runWithSessionOwner,
      },
      sessionReplayService: {
        noteSessionConfigured,
      },
      normalizeEcsExecPermissionError: vi.fn((error) => error as Error),
    } as any);

    const handler = handlers.get(ipcChannels.aws.openEcsExecShell);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.openEcsExecShell handler to be registered");
    }

    await expect(
      handler({ sender: { id: 73 } }, {
        hostId: "host-1",
        serviceName: "api",
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        containerName: "api",
        cols: 120,
        rows: 40,
      }),
    ).resolves.toEqual({ sessionId: "session-1" });

    expect(runWithSessionOwner).toHaveBeenCalledWith(73, expect.any(Function));
    expect(invalidateEcsServiceActionContext).toHaveBeenCalledWith(
      "default",
      "ap-northeast-2",
      "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
      "api",
    );
    expect(describeEcsServiceActionContext).toHaveBeenCalledTimes(2);
    expect(connectAwsSession).toHaveBeenCalledTimes(1);
    expect(connectAwsSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionKind: "aws-ecs-exec",
        connectionDetails: "api · api · task-1",
        ssmSession: {
          sessionId: "ecs-sess-1",
          streamUrl:
            "wss://ssmmessages.ap-northeast-2.amazonaws.com/v1/data-channel/ecs-sess-1",
          tokenValue: "token-ecs-1",
        },
      }),
    );
    expect(noteSessionConfigured).toHaveBeenCalledWith("session-1", 120, 40);
  });

  it("opens the ECS Exec shell over an in-process SSM session when enabled", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const describeEcsServiceActionContext = vi.fn().mockResolvedValue({
      runningTasks: [
        {
          taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
          enableExecuteCommand: true,
          containers: [{ containerName: "api" }],
        },
      ],
    });
    const startEcsExecSession = vi.fn().mockResolvedValue({
      sessionId: "ecs-sess-1",
      streamUrl: "wss://ssmmessages.ap-northeast-2.amazonaws.com/v1/data-channel/ecs-sess-1",
      tokenValue: "token-ecs-1",
    });
    const ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    const connectAwsSession = vi.fn().mockResolvedValue({ sessionId: "session-1" });
    const noteSessionConfigured = vi.fn();

    registerAwsIpcHandlers({
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        ensureAwsCliAvailable,
        ensureSessionManagerPluginAvailable: vi.fn().mockResolvedValue(undefined),
        shouldUseInProcessSsm: vi.fn().mockReturnValue(true),
        startEcsExecSession,
        describeEcsServiceActionContext,
        invalidateEcsServiceActionContext: vi.fn(),
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
        connectAwsSession,
      },
      sessionReplayService: {
        noteSessionConfigured,
      },
      normalizeEcsExecPermissionError: vi.fn((error) => error as Error),
    } as any);

    const handler = handlers.get(ipcChannels.aws.openEcsExecShell);
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

    // No CLI/plugin preflight when running in-process.
    expect(ensureAwsCliAvailable).not.toHaveBeenCalled();
    expect(startEcsExecSession).toHaveBeenCalledWith({
      profileName: "default",
      region: "ap-northeast-2",
      clusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
      containerName: "api",
      command: "/bin/sh",
    });
    expect(connectAwsSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionKind: "aws-ecs-exec",
        connectionDetails: "api · api · task-1",
        ssmSession: {
          sessionId: "ecs-sess-1",
          streamUrl:
            "wss://ssmmessages.ap-northeast-2.amazonaws.com/v1/data-channel/ecs-sess-1",
          tokenValue: "token-ecs-1",
        },
      }),
    );
    expect(noteSessionConfigured).toHaveBeenCalledWith("session-1", 120, 40);
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
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
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
