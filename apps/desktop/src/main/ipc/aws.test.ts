import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerAwsIpcHandlers } from "./aws";
import { withVaults } from "../vault-catalog.test-support";

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
    const listProfiles = vi.fn().mockResolvedValue([]);
    const refreshAwsProfileNameCaches = vi.fn(() => []);
    const upsertDeletion = vi.fn();
    const queueSync = vi.fn();

    registerAwsIpcHandlers(withVaults({
      awsService: {
        listProfiles,
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
        refreshAwsProfileNameCaches,
        getById: vi.fn(),
      },
      assertAwsEcsHost: vi.fn(),
      coreManager: {
        connectAwsSession: vi.fn(),
      },
    }) as any);

    const handler = handlers.get(ipcChannels.aws.deleteProfile);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected aws.deleteProfile handler to be registered");
    }

    await handler({}, "default");

    expect(getProfileDetails).toHaveBeenCalledWith("default");
    expect(deleteProfile).toHaveBeenCalledWith("default");
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(refreshAwsProfileNameCaches).toHaveBeenCalledWith([]);
    expect(upsertDeletion).toHaveBeenCalledWith("awsProfiles", "profile-default");
    expect(queueSync).toHaveBeenCalledTimes(1);
  });

  it("lists the AWS profiles of the vault the settings screen picks, names only for a team", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const listProfiles = vi.fn().mockResolvedValue([{ id: "p-1", name: "personal" }]);
    const listMetadata = vi.fn(() => [
      { id: "t-1", name: "team-static", kind: "static", region: "ap-northeast-2", updatedAt: "t" },
    ]);
    registerAwsIpcHandlers(
      withVaults({ awsService: { listProfiles } }, { "team-1": { awsProfiles: { listMetadata } } }) as any,
    );
    const list = handlers.get(ipcChannels.aws.listProfiles)!;

    await expect(list({})).resolves.toEqual([{ id: "p-1", name: "personal" }]);
    await expect(list({}, "personal")).resolves.toEqual([{ id: "p-1", name: "personal" }]);
    await expect(list({}, "team-1")).resolves.toEqual([{ id: "t-1", name: "team-static" }]);
    await expect(list({}, "team-gone")).resolves.toEqual([]);
    expect(listProfiles).toHaveBeenCalledTimes(2);
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
    });
    const login = vi.fn().mockResolvedValue(undefined);

    registerAwsIpcHandlers(withVaults({
      awsService: {
        requireManagedProfileName,
        getProfileStatus,
        login,
      },
    }) as any);

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

  // 설정의 팀 묶음에서 만들고 고친 것은 그 팀으로 간다(4-7). 개인 경로는 지금 그대로다.
  it("manages a team's AWS profiles in that team, and the team's hosts follow a rename or delete", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
    const awsService = {
      createProfile: vi.fn().mockResolvedValue(undefined),
      prepareSsoProfile: vi.fn().mockResolvedValue({}),
      getProfileDetails: vi.fn().mockResolvedValue({ id: "t-1", profileName: "prod" }),
      updateProfile: vi.fn().mockResolvedValue(undefined),
      updateProfileRegion: vi.fn().mockResolvedValue(undefined),
      renameProfile: vi.fn().mockResolvedValue(undefined),
      deleteProfile: vi.fn().mockResolvedValue(undefined),
      getProfileStatus: vi.fn().mockResolvedValue({}),
      login: vi.fn().mockResolvedValue(undefined),
      listProfiles: vi.fn(),
    };
    const teamProfiles = [{ id: "t-1", name: "prod-team", kind: "static", updatedAt: "t" }];
    const team = {
      awsProfiles: {
        listMetadata: vi.fn(() => teamProfiles),
        getMetadataByName: vi.fn((name: string) => teamProfiles.find((profile) => profile.name === name) ?? null),
      },
      hosts: { refreshAwsProfileNameCaches: vi.fn(() => []) },
      syncOutbox: { upsertDeletion: vi.fn(), clear: vi.fn() },
    };
    const personalHosts = { updateAwsProfileCache: vi.fn(), refreshAwsProfileNameCaches: vi.fn() };
    const personalOutbox = { upsertDeletion: vi.fn() };
    const queueSync = vi.fn();
    registerAwsIpcHandlers(
      withVaults({ awsService, hosts: personalHosts, syncOutbox: personalOutbox, queueSync }, { "team-1": team }) as any,
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
    const vault = { teamId: "team-1", profiles: team.awsProfiles };

    await call(ipcChannels.aws.createProfile, {
      kind: "static",
      profileName: "prod",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      vaultId: "team-1",
    });
    await call(ipcChannels.aws.prepareSsoProfile, { profileName: "corp", ssoStartUrl: "u", ssoRegion: "r", vaultId: "team-1" });
    await call(ipcChannels.aws.getProfileDetails, "prod", "team-1");
    await call(ipcChannels.aws.updateProfile, { profileName: "prod", accessKeyId: "AKIA", secretAccessKey: "s", vaultId: "team-1" });
    await call(ipcChannels.aws.updateProfileRegion, { profileName: "prod", region: "us-east-1", vaultId: "team-1" });
    await call(ipcChannels.aws.getProfileStatus, "prod", "team-1");
    await call(ipcChannels.aws.login, "corp", "team-1");

    expect(awsService.createProfile).toHaveBeenCalledWith(expect.objectContaining({ profileName: "prod" }), vault);
    expect(awsService.prepareSsoProfile).toHaveBeenCalledWith(expect.objectContaining({ profileName: "corp" }), vault);
    expect(awsService.getProfileDetails).toHaveBeenCalledWith("prod", vault);
    expect(awsService.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ profileName: "prod" }), vault);
    expect(awsService.updateProfileRegion).toHaveBeenCalledWith(expect.objectContaining({ region: "us-east-1" }), vault);
    expect(awsService.getProfileStatus).toHaveBeenCalledWith("prod", vault);
    expect(awsService.login).toHaveBeenCalledWith("corp", vault);

    // 이름 바꾸기·지우기 — 그 팀 호스트가 기억하는 프로필 이름이 따라가고, 지움 표시는 그 팀에 남는다. 지움 기록이
    // 먼저다: 지운 뒤 펼치는 사이 팀 동기화가 돌아도 서버 사본으로 되살리지 않게(실제 앱에서 잠깐 되살아났다).
    awsService.deleteProfile.mockImplementationOnce(async () => {
      expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith("awsProfiles", "t-1");
    });
    await call(ipcChannels.aws.renameProfile, { profileName: "prod", nextProfileName: "prod-team", vaultId: "team-1" });
    expect(awsService.renameProfile).toHaveBeenCalledWith(expect.objectContaining({ nextProfileName: "prod-team" }), vault);
    expect(team.hosts.refreshAwsProfileNameCaches).toHaveBeenLastCalledWith([{ id: "t-1", name: "prod-team" }]);
    await call(ipcChannels.aws.deleteProfile, "prod-team", "team-1");
    expect(awsService.deleteProfile).toHaveBeenCalledWith("prod-team", vault);
    expect(team.hosts.refreshAwsProfileNameCaches).toHaveBeenCalledTimes(2);
    expect(team.syncOutbox.upsertDeletion).toHaveBeenCalledWith("awsProfiles", "t-1");
    expect(queueSync).toHaveBeenCalledTimes(5);
    // 개인 쪽은 건드리지 않고, 팀 이름 바꾸기·지우기는 상세(STS)를 다시 부르지 않는다.
    expect(personalHosts.updateAwsProfileCache).not.toHaveBeenCalled();
    expect(personalHosts.refreshAwsProfileNameCaches).not.toHaveBeenCalled();
    expect(personalOutbox.upsertDeletion).not.toHaveBeenCalled();
    expect(awsService.getProfileDetails).toHaveBeenCalledTimes(1);

    // 이 기기에 없는 팀이면 쓰지 않는다.
    await expect(
      call(ipcChannels.aws.createProfile, { kind: "static", profileName: "x", accessKeyId: "A", secretAccessKey: "S", vaultId: "team-gone" }),
    ).rejects.toThrow();
    expect(awsService.createProfile).toHaveBeenCalledTimes(1);

    // 못 지우면 남긴 지움 기록도 거둔다 — 남기면 다음 동기화가 서버에서 지워 버린다.
    awsService.deleteProfile.mockRejectedValueOnce(new Error("locked"));
    await expect(call(ipcChannels.aws.deleteProfile, "prod-team", "team-1")).rejects.toThrow("locked");
    expect(team.syncOutbox.clear).toHaveBeenCalledWith("awsProfiles", "t-1");
  });

  it("updates an aws profile region and queues sync", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const updateProfileRegion = vi.fn().mockResolvedValue(undefined);
    const queueSync = vi.fn();

    registerAwsIpcHandlers(withVaults({
      awsService: {
        requireManagedProfileName: vi.fn(),
        updateProfileRegion,
      },
      queueSync,
    }) as any);

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

    registerAwsIpcHandlers(withVaults({
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
    }) as any);

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

    registerAwsIpcHandlers(withVaults({
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        ensureAwsCliAvailable,
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
    }) as any);

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

    registerAwsIpcHandlers(withVaults({
      awsService: {
        requireManagedProfileName: vi.fn().mockReturnValue("default"),
        ensureAwsCliAvailable: vi.fn().mockResolvedValue(undefined),
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
    }) as any);

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
