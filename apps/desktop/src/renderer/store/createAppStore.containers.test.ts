import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
} from "@shared";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, isSshHostRecord } from "@shared";
import type { HostContainersTabState } from "./createAppStore";
import { createAppStore, upsertTransferJob } from "./createAppStore";
import {
  createAwsEc2Host,
  createContainerDetails,
  createContainerSummary,
  createContainerTab,
  createDeferred,
  createEcsHost,
  createMockApi,
  createUntrustedHostProbe,
  flushMicrotasks,
} from "./createAppStore.test-support";

describe("createAppStore containers", () => {
  it("updates the containers tab progress from host-scoped connection events", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "browser-login",
      message: "釉뚮씪?곗??먯꽌 ?뱀씤??吏꾪뻾?섎뒗 以묒엯?덈떎.",
    });

    expect(
      store
        .getState()
        .containerTabs.find((tab) => tab.hostId === "host-1")
        ?.connectionProgress,
    ).toEqual({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "browser-login",
      message: "釉뚮씪?곗??먯꽌 ?뱀씤??吏꾪뻾?섎뒗 以묒엯?덈떎.",
    });
  });

  it("opens host containers inside the fixed containers section without touching the main tab strip", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    const beforeTabStrip = store.getState().tabStrip;

    await store.getState().openHostContainersTab("host-1");

    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");
    expect(store.getState().tabStrip).toEqual(beforeTabStrip);
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1"),
    ).toMatchObject({ lifecycleId: "lifecycle-1" });
    expect(api.containers.beginLifecycle).toHaveBeenCalledWith("host-1");
  });

  it("routes aws-ecs hosts into an ECS containers tab instead of starting a terminal session", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: "Servers",
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    }));

    await store.getState().connectHost("ecs-host-1", 120, 32);

    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("ecs-host-1");
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1"),
    ).toMatchObject({
      kind: "ecs-cluster",
      lifecycleId: "lifecycle-1",
      ecsMetricsLoadedAt: "2025-01-01T00:00:10.000Z",
    });
    expect(api.aws.loadEcsClusterSnapshot).toHaveBeenCalledWith("ecs-host-1");
    expect(api.aws.loadEcsClusterUtilization).toHaveBeenCalledWith("ecs-host-1");
  });

  it("tracks ECS cluster loading progress from profile check through utilization", async () => {
    const api = createMockApi();
    const profileStatus =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatusById"]>>
      >();
    const snapshot =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["loadEcsClusterSnapshot"]>>
      >();
    const utilization =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["loadEcsClusterUtilization"]>>
      >();
    api.aws.getProfileStatusById = vi.fn().mockReturnValue(profileStatus.promise);
    api.aws.loadEcsClusterSnapshot = vi.fn().mockReturnValue(snapshot.promise);
    api.aws.loadEcsClusterUtilization = vi
      .fn()
      .mockReturnValue(utilization.promise);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));

    const connectPromise = store.getState().connectHost("ecs-host-1", 120, 32);
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toMatchObject({
      stage: "checking-profile",
      message: "default 프로필 인증 상태를 확인하는 중입니다.",
    });

    profileStatus.resolve({
      id: "default",
      profileName: "default",
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      errorMessage: null,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toMatchObject({
      stage: "loading-ecs-cluster",
      message: "ECS 클러스터와 서비스 목록을 불러오는 중입니다.",
    });

    snapshot.resolve({
      profileName: "default",
      region: "ap-northeast-2",
      cluster: {
        clusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
        clusterName: "prod",
        status: "ACTIVE",
        activeServicesCount: 1,
        runningTasksCount: 1,
        pendingTasksCount: 0,
      },
      services: [],
      metricsWarning: null,
      loadedAt: "2025-01-01T00:00:00.000Z",
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toMatchObject({
      stage: "loading-ecs-metrics",
      message: "AWS ECS/CloudWatch 사용량 지표를 가져오는 중입니다.",
    });

    utilization.resolve({
      loadedAt: "2025-01-01T00:00:10.000Z",
      warning: null,
      services: [],
    });
    await connectPromise;

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toBeNull();
  });

  it("starts AWS SSO login before loading an ECS cluster when the SSO profile is expired", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi
      .fn()
      .mockResolvedValueOnce({
        id: "default",
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: "釉뚮씪?곗? 濡쒓렇?몄씠 ?꾩슂?⑸땲??",
      })
      .mockResolvedValueOnce({
        id: "default",
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
      });
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));

    await store.getState().connectHost("ecs-host-1", 120, 32);

    expect(api.aws.loginById).toHaveBeenCalledWith("profile-default");
    expect(api.aws.loadEcsClusterSnapshot).toHaveBeenCalledWith("ecs-host-1");
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1"),
    ).toMatchObject({
      kind: "ecs-cluster",
      isLoading: false,
      errorMessage: undefined,
    });
  });

  it("shows browser-login progress while ECS waits for AWS SSO login", async () => {
    const api = createMockApi();
    const login = createDeferred<void>();
    api.aws.getProfileStatusById = vi
      .fn()
      .mockResolvedValueOnce({
        id: "default",
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: "브라우저 로그인이 필요합니다.",
      })
      .mockResolvedValueOnce({
        id: "default",
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
      });
    api.aws.loginById = vi.fn().mockReturnValue(login.promise);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));

    const connectPromise = store.getState().connectHost("ecs-host-1", 120, 32);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toMatchObject({
      stage: "browser-login",
      message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
    });

    login.resolve();
    await connectPromise;

    expect(api.aws.loginById).toHaveBeenCalledWith("profile-default");
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.connectionProgress,
    ).toBeNull();
  });

  it("opens AWS SSO login for an ECS host profile on demand", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));

    await store.getState().loginAwsProfileForEcsHost("ecs-host-1");

    expect(api.aws.loginById).toHaveBeenCalledWith("profile-default");
  });

  it("ignores on-demand ECS SSO login for missing or non-ECS hosts", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().loginAwsProfileForEcsHost("missing-host");
    await store.getState().loginAwsProfileForEcsHost("host-1");

    expect(api.aws.loginById).not.toHaveBeenCalled();
  });

  it("recovers an ECS snapshot load once when the first request reports an expired SSO session", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi
      .fn()
      .mockResolvedValueOnce({
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
      })
      .mockResolvedValueOnce({
        profileName: "default",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
      });
    api.aws.loadEcsClusterSnapshot = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'aws:load-ecs-cluster-snapshot': Error: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
        ),
      )
      .mockResolvedValueOnce({
        profileName: "default",
        region: "ap-northeast-2",
        cluster: {
          clusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          clusterName: "prod",
          status: "ACTIVE",
          activeServicesCount: 1,
          runningTasksCount: 1,
          pendingTasksCount: 0,
        },
        services: [],
        metricsWarning: null,
        loadedAt: "2025-01-01T00:00:00.000Z",
      });
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));

    await store.getState().connectHost("ecs-host-1", 120, 32);

    expect(api.aws.loginById).toHaveBeenCalledWith("profile-default");
    expect(api.aws.loadEcsClusterSnapshot).toHaveBeenCalledTimes(2);
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1"),
    ).toMatchObject({
      kind: "ecs-cluster",
      isLoading: false,
      errorMessage: undefined,
    });
  });

  it("refreshes ECS utilization without replacing the existing cluster metadata", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: "Servers",
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      containerTabs: [
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
          title: "prod cluster 쨌 ECS",
          ecsSnapshot: {
            profileName: "default",
            region: "ap-northeast-2",
            cluster: {
              clusterArn:
                "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
              clusterName: "prod",
              status: "ACTIVE",
              activeServicesCount: 1,
              runningTasksCount: 1,
              pendingTasksCount: 0,
            },
            services: [
              {
                serviceArn:
                  "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api",
                serviceName: "api",
                status: "ACTIVE",
                rolloutState: "COMPLETED",
                desiredCount: 1,
                runningCount: 1,
                pendingCount: 0,
                launchType: "FARGATE",
                servicePorts: [],
                exposureKinds: [],
                cpuUtilizationPercent: null,
                memoryUtilizationPercent: null,
                taskDefinitionRevision: 7,
                latestEventMessage: null,
              },
            ],
            metricsWarning: null,
            loadedAt: "2025-01-01T00:00:00.000Z",
          },
        }),
      ],
      activeContainerHostId: "ecs-host-1",
      activeWorkspaceTab: "containers",
    }));

    await store.getState().refreshEcsClusterUtilization("ecs-host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "ecs-host-1");
    expect(nextTab?.ecsSnapshot?.cluster.clusterName).toBe("prod");
    expect(nextTab?.ecsSnapshot?.services[0]).toMatchObject({
      serviceName: "api",
      cpuUtilizationPercent: 23.4,
      memoryUtilizationPercent: 61.2,
    });
    expect(nextTab?.ecsUtilizationHistoryByServiceName.api).toEqual({
      cpuHistory: [
        {
          timestamp: "2025-01-01T00:00:00.000Z",
          value: 22.1,
        },
        {
          timestamp: "2025-01-01T00:01:00.000Z",
          value: 23.4,
        },
      ],
      memoryHistory: [
        {
          timestamp: "2025-01-01T00:00:00.000Z",
          value: 59.8,
        },
        {
          timestamp: "2025-01-01T00:01:00.000Z",
          value: 61.2,
        },
      ],
    });
    expect(nextTab?.ecsMetricsLoadedAt).toBe("2025-01-01T00:00:10.000Z");
    expect(nextTab?.isLoading).toBe(false);
    expect(api.aws.loadEcsClusterSnapshot).not.toHaveBeenCalled();
    expect(api.aws.loadEcsClusterUtilization).toHaveBeenCalledWith("ecs-host-1");
  });

  it("stops persisted ECS service tunnels when the ECS tab is closed", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: null,
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      containerTabs: [
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
          ecsTunnelStatesByServiceName: {
            worker: {
              serviceName: "worker",
              taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
              containerName: "worker",
              targetPort: "7001",
              bindPort: "0",
              autoLocalPort: true,
              loading: false,
              error: null,
              runtime: {
                ruleId: "ecs-service-tunnel:1",
                hostId: "ecs-host-1",
                transport: "ecs-task",
                bindAddress: "127.0.0.1",
                bindPort: 43110,
                status: "running",
                updatedAt: "2025-01-01T00:00:10.000Z",
                startedAt: "2025-01-01T00:00:00.000Z",
                mode: "local",
                method: "ssm-remote-host",
              },
            },
          },
        }),
      ],
      activeContainerHostId: "ecs-host-1",
      activeWorkspaceTab: "containers",
    }));

    await store.getState().closeHostContainersTab("ecs-host-1");

    expect(api.aws.stopEcsServiceTunnel).toHaveBeenCalledWith(
      "ecs-service-tunnel:1",
    );
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1"),
    ).toBeUndefined();
  });

  it("tracks ECS service tunnel runtimes in the global port forward runtime list", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: null,
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      containerTabs: [
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
          ecsTunnelStatesByServiceName: {
            worker: {
              serviceName: "worker",
              taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
              containerName: "worker",
              targetPort: "7001",
              bindPort: "0",
              autoLocalPort: true,
              loading: true,
              error: null,
              runtime: {
                ruleId: "ecs-service-tunnel:1",
                hostId: "ecs-host-1",
                transport: "ecs-task",
                bindAddress: "127.0.0.1",
                bindPort: 0,
                status: "starting",
                updatedAt: "2025-01-01T00:00:05.000Z",
                startedAt: "2025-01-01T00:00:05.000Z",
                mode: "local",
                method: "ssm-remote-host",
              },
            },
          },
        }),
      ],
    }));

    store.getState().handlePortForwardEvent({
      runtime: {
        ruleId: "ecs-service-tunnel:1",
        hostId: "ecs-host-1",
        transport: "ecs-task",
        bindAddress: "127.0.0.1",
        bindPort: 43110,
        status: "running",
        updatedAt: "2025-01-01T00:00:10.000Z",
        startedAt: "2025-01-01T00:00:05.000Z",
        mode: "local",
        method: "ssm-remote-host",
      },
    });

    expect(store.getState().portForwardRuntimes).toEqual([
      expect.objectContaining({
        ruleId: "ecs-service-tunnel:1",
        hostId: "ecs-host-1",
        transport: "ecs-task",
        bindPort: 43110,
        status: "running",
      }),
    ]);
    expect(
      (
        store.getState().containerTabs.find(
          (tab) => tab.hostId === "ecs-host-1",
        ) as HostContainersTabState
      ).ecsTunnelStatesByServiceName.worker.runtime,
    ).toEqual(
      expect.objectContaining({
        ruleId: "ecs-service-tunnel:1",
        bindPort: 43110,
        status: "running",
      }),
    );
  });

  it("does not rewrite ECS tunnel tab state when the persisted tunnel payload is unchanged", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    const tunnelState = {
      serviceName: "worker",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
      containerName: "worker",
      targetPort: "7001",
      bindPort: "0",
      autoLocalPort: true,
      loading: false,
      error: null,
      runtime: {
        ruleId: "ecs-service-tunnel:1",
        hostId: "ecs-host-1",
        transport: "ecs-task" as const,
        bindAddress: "127.0.0.1",
        bindPort: 43110,
        status: "running" as const,
        updatedAt: "2025-01-01T00:00:10.000Z",
        startedAt: "2025-01-01T00:00:00.000Z",
        mode: "local" as const,
        method: "ssm-remote-host" as const,
      },
    };

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: null,
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      containerTabs: [
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
          ecsTunnelStatesByServiceName: {
            worker: tunnelState,
          },
        }),
      ],
    }));

    const beforeTabs = store.getState().containerTabs;
    store.getState().setEcsClusterTunnelState("ecs-host-1", "worker", tunnelState);

    expect(store.getState().containerTabs).toBe(beforeTabs);
  });

  it("merges sequential ECS log state updaters against the latest store state", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
        }),
      ],
    }));

    store.getState().setEcsClusterLogsState("ecs-host-1", "worker", (previous) => ({
      ...previous,
      follow: false,
      rangeMode: "absolute",
      absoluteRange: {
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-02",
        endTime: "12:30:00",
      },
    }));
    store.getState().setEcsClusterLogsState("ecs-host-1", "worker", (previous) => ({
      ...previous,
      loading: true,
      taskArn: "task-1",
    }));

    const ecsTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "ecs-host-1");

    expect(ecsTab?.ecsLogsByServiceName.worker).toMatchObject({
      follow: false,
      rangeMode: "absolute",
      absoluteRange: {
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-02",
        endTime: "12:30:00",
      },
      loading: true,
      taskArn: "task-1",
    });
  });

  it("stops persisted container service tunnels when the host containers tab is closed", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-1", {
          kind: "host-containers",
          containerTunnelStatesByContainerId: {
            "container-1": {
              containerId: "container-1",
              containerName: "api",
              networkName: "bridge",
              targetPort: "8080",
              bindPort: "0",
              autoLocalPort: true,
              loading: false,
              error: null,
              runtime: {
                ruleId: "container-service-tunnel:1",
                hostId: "host-1",
                transport: "container",
                bindAddress: "127.0.0.1",
                bindPort: 43110,
                status: "running",
                updatedAt: "2025-01-01T00:00:10.000Z",
                startedAt: "2025-01-01T00:00:00.000Z",
                mode: "local",
                method: "ssh-native",
              },
            },
          },
        }),
      ],
      activeContainerHostId: "host-1",
      activeWorkspaceTab: "containers",
    }));

    await store.getState().closeHostContainersTab("host-1");

    expect(api.containers.stopTunnel).toHaveBeenCalledWith(
      "container-service-tunnel:1",
    );
    expect(api.containers.release).toHaveBeenCalledWith("host-1");
  });

  it("tracks container service tunnel runtimes in the global port forward runtime list", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-1", {
          kind: "host-containers",
          containerTunnelStatesByContainerId: {
            "container-1": {
              containerId: "container-1",
              containerName: "api",
              networkName: "bridge",
              targetPort: "8080",
              bindPort: "0",
              autoLocalPort: true,
              loading: true,
              error: null,
              runtime: {
                ruleId: "container-service-tunnel:1",
                hostId: "host-1",
                transport: "container",
                bindAddress: "127.0.0.1",
                bindPort: 0,
                status: "starting",
                updatedAt: "2025-01-01T00:00:05.000Z",
                startedAt: "2025-01-01T00:00:05.000Z",
                mode: "local",
                method: "ssh-native",
              },
            },
          },
        }),
      ],
    }));

    store.getState().handlePortForwardEvent({
      runtime: {
        ruleId: "container-service-tunnel:1",
        hostId: "host-1",
        transport: "container",
        bindAddress: "127.0.0.1",
        bindPort: 43110,
        status: "running",
        updatedAt: "2025-01-01T00:00:10.000Z",
        startedAt: "2025-01-01T00:00:05.000Z",
        mode: "local",
        method: "ssh-native",
      },
    });

    expect(store.getState().portForwardRuntimes).toEqual([
      expect.objectContaining({
        ruleId: "container-service-tunnel:1",
        hostId: "host-1",
        transport: "container",
        bindPort: 43110,
        status: "running",
      }),
    ]);
    expect(
      (
        store.getState().containerTabs.find(
          (tab) => tab.hostId === "host-1",
        ) as HostContainersTabState
      ).containerTunnelStatesByContainerId["container-1"]?.runtime,
    ).toEqual(
      expect.objectContaining({
        ruleId: "container-service-tunnel:1",
        bindPort: 43110,
        status: "running",
      }),
    );
  });

  it("does not rewrite container tunnel tab state when the persisted tunnel payload is unchanged", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    const tunnelState = {
      containerId: "container-1",
      containerName: "api",
      networkName: "bridge",
      targetPort: "8080",
      bindPort: "0",
      autoLocalPort: true,
      loading: false,
      error: null,
      runtime: {
        ruleId: "container-service-tunnel:1",
        hostId: "host-1",
        transport: "container" as const,
        bindAddress: "127.0.0.1",
        bindPort: 43110,
        status: "running" as const,
        updatedAt: "2025-01-01T00:00:10.000Z",
        startedAt: "2025-01-01T00:00:00.000Z",
        mode: "local" as const,
        method: "ssh-native" as const,
      },
    };

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-1", {
          kind: "host-containers",
          containerTunnelStatesByContainerId: {
            "container-1": tunnelState,
          },
        }),
      ],
    }));

    const beforeTabs = store.getState().containerTabs;
    store
      .getState()
      .setHostContainerTunnelState("host-1", "container-1", tunnelState);

    expect(store.getState().containerTabs).toBe(beforeTabs);
  });

  it("merges ECS utilization history by timestamp and prunes points outside the 10 minute window", async () => {
    const api = createMockApi();
    api.aws.loadEcsClusterUtilization = vi.fn().mockResolvedValue({
      loadedAt: "2025-01-01T00:10:00.000Z",
      warning: null,
      services: [
        {
          serviceName: "api",
          cpuUtilizationPercent: 24.5,
          memoryUtilizationPercent: 62.8,
          cpuHistory: [
            {
              timestamp: "2025-01-01T00:09:00.000Z",
              value: 24.5,
            },
          ],
          memoryHistory: [
            {
              timestamp: "2025-01-01T00:09:00.000Z",
              value: 62.8,
            },
          ],
        },
      ],
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          id: "ecs-host-1",
          kind: "aws-ecs",
          label: "prod cluster",
          awsProfileId: "profile-default",
          awsProfileName: "default",
          awsRegion: "ap-northeast-2",
          awsEcsClusterArn:
            "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
          awsEcsClusterName: "prod",
          groupName: "Servers",
          tags: [],
          terminalThemeId: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      containerTabs: [
        createContainerTab("ecs-host-1", {
          kind: "ecs-cluster",
          title: "prod cluster 쨌 ECS",
          ecsSnapshot: {
            profileName: "default",
            region: "ap-northeast-2",
            cluster: {
              clusterArn:
                "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
              clusterName: "prod",
              status: "ACTIVE",
              activeServicesCount: 1,
              runningTasksCount: 1,
              pendingTasksCount: 0,
            },
            services: [
              {
                serviceArn:
                  "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api",
                serviceName: "api",
                status: "ACTIVE",
                rolloutState: "COMPLETED",
                desiredCount: 1,
                runningCount: 1,
                pendingCount: 0,
                launchType: "FARGATE",
                servicePorts: [],
                exposureKinds: [],
                cpuUtilizationPercent: 23.4,
                memoryUtilizationPercent: 61.2,
                taskDefinitionRevision: 7,
                latestEventMessage: null,
              },
            ],
            metricsWarning: null,
            loadedAt: "2025-01-01T00:00:00.000Z",
          },
          ecsUtilizationHistoryByServiceName: {
            api: {
              cpuHistory: [
                {
                  timestamp: "2024-12-31T23:59:00.000Z",
                  value: 12,
                },
                {
                  timestamp: "2025-01-01T00:09:00.000Z",
                  value: 20,
                },
              ],
              memoryHistory: [
                {
                  timestamp: "2024-12-31T23:59:00.000Z",
                  value: 40,
                },
                {
                  timestamp: "2025-01-01T00:09:00.000Z",
                  value: 58,
                },
              ],
            },
          },
        }),
      ],
      activeContainerHostId: "ecs-host-1",
      activeWorkspaceTab: "containers",
    }));

    await store.getState().refreshEcsClusterUtilization("ecs-host-1");

    const history =
      store.getState().containerTabs.find((tab) => tab.hostId === "ecs-host-1")
        ?.ecsUtilizationHistoryByServiceName.api;
    expect(history).toEqual({
      cpuHistory: [
        {
          timestamp: "2025-01-01T00:09:00.000Z",
          value: 24.5,
        },
      ],
      memoryHistory: [
        {
          timestamp: "2025-01-01T00:09:00.000Z",
          value: 62.8,
        },
      ],
    });
  });

  it("releases the host containers endpoint and keeps focus inside the containers section when another host tab remains", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState({
      pendingInteractiveAuth: {
        source: "containers",
        endpointId: "containers:host-1",
        hostId: "host-1",
        challengeId: "challenge-1",
        name: "warpgate",
        instruction: "?뱀씤??湲곕떎由щ뒗 以묒엯?덈떎.",
        prompts: [],
        provider: "warpgate",
        approvalUrl: "https://warpgate.example.com/authorize",
        authCode: "ABCD-1234",
        autoSubmitted: false,
      },
    });

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-2", {
          title: "Stage 쨌 Containers",
        }),
      ],
    }));

    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");

    await store.getState().closeHostContainersTab("host-1");

    expect(api.containers.release).toHaveBeenCalledWith(
      "host-1",
      "lifecycle-1",
    );
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1"),
    ).toBeUndefined();
    expect(store.getState().pendingInteractiveAuth).toBeNull();
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-2");
  });

  it("leaves the fixed containers section active when the last host tab closes", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().closeHostContainersTab("host-1");

    expect(api.containers.release).toHaveBeenCalledWith(
      "host-1",
      "lifecycle-1",
    );
    expect(store.getState().containerTabs).toEqual([]);
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBeNull();
  });

  it("reorders container subtabs independently from the dynamic tab strip", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: [
        ...state.containerTabs,
        createContainerTab("host-2", {
          title: "Stage 쨌 Containers",
          runtime: "docker",
        }),
      ],
    }));

    const beforeTabStrip = store.getState().tabStrip;

    store.getState().reorderContainerTab("host-2", "host-1", "before");

    expect(store.getState().containerTabs.map((tab) => tab.hostId)).toEqual([
      "host-2",
      "host-1",
    ]);
    expect(store.getState().tabStrip).toEqual(beforeTabStrip);
  });

  it("disconnects a container shell session through the standard ssh disconnect flow", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    expect(api.containers.openShell).toHaveBeenCalledWith(
      "host-1",
      "container-1",
    );
    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");

    await store.getState().disconnectTab("session-container-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("session-container-1");
    expect(store.getState().tabs[0]?.status).toBe("disconnecting");
  });

  it("surfaces AWS host-key probe timeouts on the containers tab instead of leaving the overlay stuck", async () => {
    const api = createMockApi();
    vi.mocked(api.knownHosts.probeHost).mockRejectedValue(
      new Error("Timed out waiting for SSH core response: probeHostKey"),
    );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));

    await expect(
      store.getState().openHostContainersTab("aws-host-1"),
    ).resolves.toBeUndefined();

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "aws-host-1");

    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
    expect(containerTab?.errorMessage).toBe(
      "Timed out waiting for SSH core response: probeHostKey",
    );
  });

  // 터미널·SFTP와 같은 계약: 이미 신뢰된 호스트의 키가 바뀌면 탭을 오류로 남기지 않고 교체
  // 프롬프트를 띄우고, 수락하면 이 탭의 목록 조회를 이어간다.
  it("re-prompts to replace the key when a trusted host's key changed on containers connect", async () => {
    const api = createMockApi();
    api.knownHosts.list = vi.fn().mockResolvedValue([
      {
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAAOLD",
        fingerprintSha256: "SHA256:old",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const listResult = await api.containers.list("host-1");
    vi.mocked(api.containers.list)
      .mockRejectedValueOnce(
        new Error("ssh handshake failed: host key mismatch"),
      )
      .mockResolvedValue(listResult);
    vi.mocked(api.knownHosts.probeHost).mockResolvedValue({
      hostId: "host-1",
      hostLabel: "Prod",
      host: "prod.example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAANEW",
      fingerprintSha256: "SHA256:new",
      status: "mismatch",
      existing: {
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAAOLD",
        fingerprintSha256: "SHA256:old",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe("mismatch");
    expect(store.getState().pendingHostKeyPrompt?.action).toMatchObject({
      kind: "containers",
      hostId: "host-1",
    });
    const blockedTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(blockedTab?.errorMessage).toBeUndefined();
    expect(blockedTab?.isLoading).toBe(false);

    await store.getState().acceptPendingHostKeyPrompt("replace");

    expect(api.knownHosts.replace).toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    const recoveredTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(recoveredTab?.errorMessage).toBeUndefined();
  });

  it("runs host-key preflight again when refreshing host containers", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    vi.mocked(api.knownHosts.probeHost).mockClear();
    vi.mocked(api.containers.list).mockClear();

    await store.getState().refreshHostContainers("host-1");

    expect(api.knownHosts.probeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-1",
        endpointId: "containers:host-1",
      }),
    );
    expect(api.containers.list).toHaveBeenCalledWith("host-1");
  });

  it("stops container refresh at the known-host prompt when the host key is not trusted", async () => {
    const api = createMockApi();
    vi.mocked(api.knownHosts.probeHost).mockResolvedValueOnce(
      createUntrustedHostProbe(),
    );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().refreshHostContainers("host-1");

    expect(api.containers.list).not.toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toMatchObject({
      action: {
        kind: "containers",
        hostId: "host-1",
      },
      probe: {
        status: "untrusted",
      },
    });
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1"),
    ).toMatchObject({
      isLoading: false,
      connectionProgress: null,
    });
  });

  it("marks the pending AWS container shell session as error when host-key probing times out", async () => {
    const api = createMockApi();
    vi.mocked(api.containers.list).mockResolvedValue({
      hostId: "aws-host-1",
      runtime: "docker",
      containers: [createContainerSummary()],
    });
    vi.mocked(api.containers.inspect).mockResolvedValue(createContainerDetails());
    vi.mocked(api.knownHosts.probeHost).mockResolvedValueOnce({
      hostId: "aws-host-1",
      hostLabel: "AWS Linux",
      host: "aws-ssm://i-aws",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });
    vi.mocked(api.knownHosts.probeHost).mockRejectedValueOnce(
      new Error("Timed out waiting for SSH core response: probeHostKey"),
    );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));
    await store.getState().openHostContainersTab("aws-host-1");

    await expect(
      store.getState().openHostContainerShell("aws-host-1", "container-1"),
    ).resolves.toBeUndefined();

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "aws-host-1");

    expect(api.containers.openShell).not.toHaveBeenCalled();
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toBe(
      "Timed out waiting for SSH core response: probeHostKey",
    );
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
  });

  it("forwards AWS container-shell progress events into the pending session tab", async () => {
    const api = createMockApi();
    const openShellDeferred = createDeferred<{ sessionId: string }>();
    vi.mocked(api.containers.list).mockResolvedValue({
      hostId: "aws-host-1",
      runtime: "docker",
      containers: [createContainerSummary()],
    });
    vi.mocked(api.containers.inspect).mockResolvedValue(createContainerDetails());
    vi.mocked(api.containers.openShell).mockReturnValue(openShellDeferred.promise);
    vi.mocked(api.knownHosts.probeHost).mockResolvedValue({
      hostId: "aws-host-1",
      hostLabel: "AWS Linux",
      host: "aws-ssm://i-aws",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));
    await store.getState().openHostContainersTab("aws-host-1");
    const openShellPromise = store
      .getState()
      .openHostContainerShell("aws-host-1", "container-1");
    await flushMicrotasks();

    const pendingSessionId = store.getState().tabs[0]?.sessionId;
    expect(pendingSessionId?.startsWith("pending:")).toBe(true);

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:aws-host-1",
      hostId: "aws-host-1",
      stage: "browser-login",
      message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "browser-login",
      message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
      blockingKind: "browser",
    });

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:aws-host-1",
      hostId: "aws-host-1",
      stage: "checking-ssm",
      message: "AWS Linux 인스턴스의 SSM 연결 상태를 확인하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "checking-ssm",
      message: "AWS Linux 인스턴스의 SSM 연결 상태를 확인하는 중입니다.",
      blockingKind: "none",
    });

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:aws-host-1",
      hostId: "aws-host-1",
      stage: "loading-instance-metadata",
      message: "SSH 설정을 자동으로 확인하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "loading-instance-metadata",
      message: "SSH 설정을 자동으로 확인하는 중입니다.",
    });

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:aws-host-1",
      hostId: "aws-host-1",
      stage: "opening-tunnel",
      message: "컨테이너 런타임 확인을 위한 내부 터널을 여는 중입니다.",
    });

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "aws-host-1");

    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "opening-tunnel",
      message: "컨테이너 런타임 확인을 위한 내부 터널을 여는 중입니다.",
      blockingKind: "none",
    });
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();

    openShellDeferred.resolve({ sessionId: "session-container-1" });
    await openShellPromise;
  });

  it("keeps a loaded containers tab visible while container shell waits for host trust", async () => {
    const api = createMockApi();
    vi.mocked(api.containers.list).mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [createContainerSummary()],
    });
    vi.mocked(api.containers.inspect).mockResolvedValue(createContainerDetails());
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    vi.mocked(api.knownHosts.probeHost).mockResolvedValue(
      createUntrustedHostProbe(),
    );
    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "probing-host-key",
      message: "SSH 호스트 키를 확인하는 중입니다.",
    });

    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "opening-tunnel",
      message: "SSH 호스트 키 확인을 위한 내부 터널을 여는 중입니다.",
    });

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");

    expect(api.containers.openShell).not.toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe("untrusted");
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "awaiting-host-trust",
    );
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
    expect(containerTab?.details?.id).toBe("container-1");
  });

  it("keeps the containers tab visible after trusting a container shell host key", async () => {
    const api = createMockApi();
    const openShellDeferred = createDeferred<{ sessionId: string }>();
    vi.mocked(api.containers.list).mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [createContainerSummary()],
    });
    vi.mocked(api.containers.inspect).mockResolvedValue(createContainerDetails());
    vi.mocked(api.containers.openShell).mockReturnValue(openShellDeferred.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    vi.mocked(api.knownHosts.probeHost).mockResolvedValue(
      createUntrustedHostProbe(),
    );
    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "probing-host-key",
      message: "SSH 호스트 키를 확인하는 중입니다.",
    });

    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "opening-tunnel",
      message: "SSH 호스트 키 확인을 위한 내부 터널을 여는 중입니다.",
    });

    const acceptPromise = store.getState().acceptPendingHostKeyPrompt("trust");
    await flushMicrotasks();

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "connecting-containers",
      message: "Prod 컨테이너 런타임 연결을 준비하는 중입니다.",
    });

    let containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");

    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
    expect(store.getState().activeWorkspaceTab).toContain("session:");

    openShellDeferred.resolve({ sessionId: "session-container-1" });
    await acceptPromise;

    containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");

    expect(api.knownHosts.trust).toHaveBeenCalled();
    expect(api.containers.openShell).toHaveBeenCalledWith(
      "host-1",
      "container-1",
    );
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");
    expect(store.getState().tabs[0]?.status).toBe("connecting");
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
    expect(containerTab?.details?.id).toBe("container-1");
  });

  it("clears the containers tab overlay when container shell host trust is dismissed", async () => {
    const api = createMockApi();
    vi.mocked(api.containers.list).mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [createContainerSummary()],
    });
    vi.mocked(api.containers.inspect).mockResolvedValue(createContainerDetails());
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    vi.mocked(api.knownHosts.probeHost).mockResolvedValue(
      createUntrustedHostProbe(),
    );
    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "probing-host-key",
      message: "SSH 호스트 키를 확인하는 중입니다.",
    });

    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "containers:host-1",
      hostId: "host-1",
      stage: "opening-tunnel",
      message: "SSH 호스트 키 확인을 위한 내부 터널을 여는 중입니다.",
    });

    store.getState().dismissPendingHostKeyPrompt();

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");

    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "호스트 키 확인이 취소되었습니다.",
    );
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
    expect(containerTab?.details?.id).toBe("container-1");
  });

  it("keeps container-shell retry context until the first shell output arrives", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");
    expect(store.getState().pendingConnectionAttempts).toEqual([
      expect.objectContaining({
        sessionId: "session-container-1",
        source: "container-shell",
        hostId: "host-1",
        containerId: "container-1",
      }),
    ]);

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "session-container-1",
      payload: {},
    });

    expect(store.getState().tabs[0]?.status).toBe("connected");
    expect(store.getState().tabs[0]?.connectionProgress).toBeNull();
    expect(store.getState().pendingConnectionAttempts).toEqual([
      expect.objectContaining({
        sessionId: "session-container-1",
        source: "container-shell",
      }),
    ]);

    store.getState().markSessionOutput("session-container-1");

    expect(store.getState().tabs[0]?.hasReceivedOutput).toBe(true);
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("clears stale containers overlay after opening a container shell", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              isLoading: true,
              connectionProgress: {
                endpointId: "containers:host-1",
                hostId: "host-1",
                stage: "connecting-containers",
                message: "Prod 컨테이너 런타임 연결을 준비하는 중입니다.",
              },
            }
          : tab,
      ),
    }));

    await store.getState().openHostContainerShell("host-1", "container-1");

    const containerTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");

    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");
    expect(containerTab?.isLoading).toBe(false);
    expect(containerTab?.connectionProgress).toBeNull();
  });

  it("keeps an immediate-closing container shell session open as a close-only error overlay", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "session-container-1",
      payload: {},
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.sessionId).toBe("session-container-1");
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("keeps a missing-shell container session open when core reports error before close", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "session-container-1",
      payload: {},
    });
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-container-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
    expect(store.getState().pendingConnectionAttempts).toEqual([
      expect.objectContaining({
        sessionId: "session-container-1",
        source: "container-shell",
      }),
    ]);

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("removes a connected container shell normally after the first output and later close", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "session-container-1",
      payload: {},
    });
    store.getState().markSessionOutput("session-container-1");
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {
        message: "closed",
      },
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("closes a missing-shell container session through the standard close action", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("host-1", "container-1");

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "session-container-1",
      payload: {},
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    await store.getState().disconnectTab("session-container-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("session-container-1");
    expect(store.getState().tabs).toHaveLength(0);
  });

  it("deduplicates overlapping container log lines while following", async () => {
    const api = createMockApi();
    api.containers.logs = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [
          "2025-01-01T00:00:00.000000000Z first",
          "2025-01-01T00:00:01.000000000Z second",
        ],
        cursor: "2025-01-01T00:00:01.000000000Z",
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker",
        lines: [
          "2025-01-01T00:00:01.000000000Z second",
          "2025-01-01T00:00:02.000000000Z third",
        ],
        cursor: "2025-01-01T00:00:02.000000000Z",
      });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsFollowEnabled: true,
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");
    await store.getState().refreshHostContainerLogs("host-1", {
      followCursor: "2025-01-01T00:00:01.000000000Z",
    });

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logs?.lines,
    ).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
      "2025-01-01T00:00:01.000000000Z second",
      "2025-01-01T00:00:02.000000000Z third",
    ]);
  });

  it("keeps existing log lines visible while a follow refresh is pending", async () => {
    const deferred = createDeferred<HostContainerLogsSnapshot>();
    const api = createMockApi();
    api.containers.logs = vi.fn().mockReturnValueOnce(deferred.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsState: "ready",
              logsLoading: false,
              logsFollowEnabled: true,
              logs: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                lines: ["2025-01-01T00:00:00.000000000Z first"],
                cursor: "2025-01-01T00:00:00.000000000Z",
              },
            }
          : tab,
      ),
    }));

    const refreshPromise = store.getState().refreshHostContainerLogs("host-1", {
      followCursor: "2025-01-01T00:00:00.000000000Z",
    });

    const inFlightTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(inFlightTab?.logsState).toBe("ready");
    expect(inFlightTab?.logsLoading).toBe(true);
    expect(inFlightTab?.logs?.lines).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
    ]);

    deferred.resolve({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker",
      lines: [
        "2025-01-01T00:00:00.000000000Z first",
        "2025-01-01T00:00:01.000000000Z second",
      ],
      cursor: "2025-01-01T00:00:01.000000000Z",
    });

    await refreshPromise;

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsState).toBe("ready");
    expect(nextTab?.logsLoading).toBe(false);
    expect(nextTab?.logs?.lines).toEqual([
      "2025-01-01T00:00:00.000000000Z first",
      "2025-01-01T00:00:01.000000000Z second",
    ]);
  });

  it("marks empty container log responses as empty instead of ready", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logsState,
    ).toBe("empty");
  });

  it("marks malformed container log responses distinctly", async () => {
    const api = createMockApi();
    api.containers.logs = vi
      .fn()
      .mockRejectedValue(
        new Error("Invalid containersLogs response: lines must be string[]"),
      );

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsState).toBe("malformed");
    expect(nextTab?.logsError).toBe(
      "컨테이너 로그 응답을 해석하지 못했습니다. 다시 불러오기를 시도해 주세요.",
    );
  });

  it("loads older container logs by increasing the tail window", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
            }
          : tab,
      ),
    }));

    await store.getState().loadMoreHostContainerLogs("host-1");

    expect(api.containers.logs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 1200,
      followCursor: null,
      startTime: expect.any(String),
      endTime: expect.any(String),
    });
    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.logsTailWindow,
    ).toBe(1200);
  });

  it("applies container log ranges and disables follow for bounded refreshes", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsFollowEnabled: true,
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerLogs("host-1", {
      tail: 500,
      rangeMode: "absolute",
      absoluteRange: {
        startDate: "2026-03-01",
        startTime: "00:00:00",
        endDate: "2026-03-02",
        endTime: "12:30:00",
      },
    });

    expect(api.containers.logs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 500,
      followCursor: null,
      startTime: new Date(2026, 2, 1, 0, 0, 0).toISOString(),
      endTime: new Date(2026, 2, 2, 12, 30, 0).toISOString(),
    });
    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsFollowEnabled).toBe(false);
    expect(nextTab?.logsRangeMode).toBe("absolute");
    expect(nextTab?.logsAbsoluteRange).toEqual({
      startDate: "2026-03-01",
      startTime: "00:00:00",
      endDate: "2026-03-02",
      endTime: "12:30:00",
    });
  });

  it("resets container log range when follow is re-enabled", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsRangeMode: "absolute",
              logsAbsoluteRange: {
                startDate: "2026-03-01",
                startTime: "00:00:00",
                endDate: "2026-03-02",
                endTime: "12:30:00",
              },
            }
          : tab,
      ),
    }));

    store.getState().setHostContainerLogsFollow("host-1", true);
    await store.getState().refreshHostContainerLogs("host-1");

    expect(api.containers.logs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 200,
      followCursor: null,
      startTime: null,
      endTime: null,
    });
    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsFollowEnabled).toBe(true);
    expect(nextTab?.logsRangeMode).toBe("recent");
    expect(nextTab?.logsRelativeRange).toEqual({
      presetKey: "30m",
      amount: "30",
      unit: "minute",
    });
    expect(nextTab?.logsAbsoluteRange).toBeNull();
  });

  it("stores remote container log search results and metrics samples", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              activePanel: "logs",
              logsSearchQuery: "error",
            }
          : tab,
      ),
    }));

    await store.getState().searchHostContainerLogs("host-1");
    await store.getState().refreshHostContainerStats("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.searchLogs).toHaveBeenCalledWith({
      hostId: "host-1",
      containerId: "container-1",
      tail: 200,
      query: "error",
      startTime: expect.any(String),
      endTime: expect.any(String),
    });
    expect(nextTab?.logsSearchMode).toBe("remote");
    expect(nextTab?.metricsState).toBe("ready");
    expect(nextTab?.metricsSamples).toHaveLength(1);
  });

  it("tracks pending container actions and clears them after a successful refresh", async () => {
    const api = createMockApi();
    const pending = createDeferred<void>();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Exited (0) 3 hours ago",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Up 5 seconds",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      });
    api.containers.start = vi.fn().mockReturnValue(pending.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    const actionPromise = store.getState().runHostContainerAction("host-1", "start");
    await flushMicrotasks();

    expect(
      store.getState().containerTabs.find((tab) => tab.hostId === "host-1")
        ?.pendingAction,
    ).toBe("start");

    pending.resolve(undefined);
    await actionPromise;

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.start).toHaveBeenCalledWith("host-1", "container-1");
    expect(api.containers.list).toHaveBeenCalledTimes(2);
    expect(nextTab?.pendingAction).toBeNull();
    expect(nextTab?.actionError).toBeUndefined();
    expect(nextTab?.items[0]?.status).toBe("Up 5 seconds");
  });

  it("stores container action failures and clears pending state", async () => {
    const api = createMockApi();
    api.containers.list = vi.fn().mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [
        {
          id: "container-1",
          name: "app",
          runtime: "docker",
          image: "nginx:latest",
          status: "Up 5 seconds",
          createdAt: "2025-01-01T00:00:00.000Z",
          ports: "",
        },
      ],
    });
    api.containers.restart = vi
      .fn()
      .mockRejectedValue(new Error("restart failed"));

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().runHostContainerAction("host-1", "restart");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.pendingAction).toBeNull();
    expect(nextTab?.actionError).toBe("restart failed");
  });

  it("clears the selected container when remove succeeds and the refreshed list is empty", async () => {
    const api = createMockApi();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [
          {
            id: "container-1",
            name: "app",
            runtime: "docker",
            image: "nginx:latest",
            status: "Exited (0) 3 hours ago",
            createdAt: "2025-01-01T00:00:00.000Z",
            ports: "",
          },
        ],
      })
      .mockResolvedValueOnce({
        hostId: "host-1",
        runtime: "docker",
        containers: [],
      });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    await store.getState().runHostContainerAction("host-1", "remove");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(api.containers.remove).toHaveBeenCalledWith("host-1", "container-1");
    expect(nextTab?.items).toEqual([]);
    expect(nextTab?.selectedContainerId).toBeNull();
    expect(nextTab?.details).toBeNull();
  });

  it("trims container metrics history to the most recent 720 samples", async () => {
    const api = createMockApi();
    api.containers.list = vi.fn().mockResolvedValue({
      hostId: "host-1",
      runtime: "docker",
      containers: [
        {
          id: "container-1",
          name: "app",
          runtime: "docker",
          image: "nginx:latest",
          status: "Up 5 seconds",
          createdAt: "2025-01-01T00:00:00.000Z",
          ports: "",
        },
      ],
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    const samples = Array.from({ length: 720 }, (_, index) => ({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker" as const,
      recordedAt: new Date(2025, 0, 1, 0, 0, index).toISOString(),
      cpuPercent: index,
      memoryUsedBytes: index,
      memoryLimitBytes: 1000,
      memoryPercent: index,
      networkRxBytes: index,
      networkTxBytes: index,
      blockReadBytes: index,
      blockWriteBytes: index,
    }));

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              metricsSamples: samples,
              metricsState: "ready",
            }
          : tab,
      ),
    }));

    api.containers.stats = vi.fn().mockResolvedValue({
      hostId: "host-1",
      containerId: "container-1",
      runtime: "docker",
      recordedAt: "2025-01-01T00:12:00.000Z",
      cpuPercent: 999,
      memoryUsedBytes: 999,
      memoryLimitBytes: 1000,
      memoryPercent: 99,
      networkRxBytes: 999,
      networkTxBytes: 999,
      blockReadBytes: 999,
      blockWriteBytes: 999,
    });

    await store.getState().refreshHostContainerStats("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.metricsSamples).toHaveLength(720);
    expect(nextTab?.metricsSamples[0]?.recordedAt).toBe(samples[1]?.recordedAt);
    expect(nextTab?.metricsSamples.at(-1)?.recordedAt).toBe(
      "2025-01-01T00:12:00.000Z",
    );
  });

  it("does not fetch container metrics when nothing is selected", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: null,
            }
          : tab,
      ),
    }));

    await store.getState().refreshHostContainerStats("host-1");

    expect(api.containers.stats).not.toHaveBeenCalled();
  });

  it("switches log search back to local mode and clears remote search state", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              selectedContainerId: "container-1",
              logsFollowEnabled: true,
              logsSearchQuery: "old",
              logsSearchMode: "remote",
              logsSearchResult: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                query: "old",
                lines: ["old result"],
                matchCount: 1,
              },
              logsSearchError: "stale",
            }
          : tab,
      ),
    }));

    store.getState().setHostContainerLogsSearchQuery("host-1", "error");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsSearchQuery).toBe("error");
    expect(nextTab?.logsSearchMode).toBe("local");
    expect(nextTab?.logsFollowEnabled).toBe(false);
    expect(nextTab?.logsSearchResult).toBeNull();
    expect(nextTab?.logsSearchError).toBeUndefined();
  });

  it("clears container log search query and results", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");

    store.setState((state) => ({
      containerTabs: state.containerTabs.map((tab) =>
        tab.hostId === "host-1"
          ? {
              ...tab,
              logsSearchQuery: "error",
              logsSearchMode: "remote",
              logsSearchLoading: true,
              logsSearchError: "failed",
              logsSearchResult: {
                hostId: "host-1",
                containerId: "container-1",
                runtime: "docker",
                query: "error",
                lines: ["error result"],
                matchCount: 1,
              },
            }
          : tab,
      ),
    }));

    store.getState().clearHostContainerLogsSearch("host-1");

    const nextTab = store
      .getState()
      .containerTabs.find((tab) => tab.hostId === "host-1");
    expect(nextTab?.logsSearchQuery).toBe("");
    expect(nextTab?.logsSearchMode).toBeNull();
    expect(nextTab?.logsSearchLoading).toBe(false);
    expect(nextTab?.logsSearchError).toBeUndefined();
    expect(nextTab?.logsSearchResult).toBeNull();
  });

  it("keeps session splitting working even when containers are open in their own section", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: "tab-2",
          stableId: "tab-2",
          sessionId: "session-2",
          source: "local",
          hostId: null,
          title: "Session 2",
          status: "connected",
          sessionShare: null,
          hasReceivedOutput: true,
          lastEventAt: "2026-03-28T00:00:00.000Z",
        },
      ],
      tabStrip: [
        { kind: "session", sessionId: "session-1" },
        { kind: "session", sessionId: "session-2" },
      ],
    }));
    await store.getState().openHostContainersTab("host-1");

    const created = store.getState().splitSessionIntoWorkspace("session-1", "right");

    expect(created).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]!.id },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe(
      `workspace:${store.getState().workspaces[0]!.id}`,
    );
  });
});
