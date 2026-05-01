import { useState } from "react";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AwsEcsClusterSnapshot,
  AwsEcsHostRecord,
  AwsEcsServiceActionContext,
  AwsEcsServiceLogsSnapshot,
  PortForwardRuntimeEvent,
} from "@shared";
import type {
  EcsServiceLogsViewState,
  HostContainersTabState,
} from "../store/createAppStore";
import { AwsEcsWorkspace } from "./AwsEcsWorkspace";

const uPlotMock = vi.hoisted(() => {
  const ctor = vi.fn().mockImplementation(function UPlotMock(
    this: Record<string, unknown>,
    opts: any,
    _data: any,
    target?: HTMLElement,
  ) {
    const root = document.createElement("div");
    root.className = "uplot";
    target?.appendChild(root);
    this.destroy = vi.fn(() => {
      root.remove();
    });
    this.setData = vi.fn();
    this.setSize = vi.fn();
    this.width = opts.width;
    this.height = opts.height;
    this.bbox = { left: 0, top: 0, width: opts.width, height: opts.height };
    this.cursor = { idx: null, left: null, top: null };
  });

  return { ctor };
});

vi.mock("uplot", () => ({
  default: uPlotMock.ctor,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHost(): AwsEcsHostRecord {
  return {
    id: "ecs-host-1",
    kind: "aws-ecs",
    label: "prod ecs",
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsEcsClusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
    awsEcsClusterName: "prod",
  };
}

function createSnapshot(
  overrides: Partial<AwsEcsClusterSnapshot> = {},
): AwsEcsClusterSnapshot {
  return {
    profileName: "default",
    region: "ap-northeast-2",
    cluster: {
      clusterArn: "arn:aws:ecs:ap-northeast-2:123456789012:cluster/prod",
      clusterName: "prod",
      status: "ACTIVE",
      activeServicesCount: 2,
      runningTasksCount: 3,
      pendingTasksCount: 1,
    },
    services: [
      {
        serviceArn: "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/api",
        serviceName: "api",
        status: "ACTIVE",
        rolloutState: "COMPLETED",
        desiredCount: 2,
        runningCount: 2,
        pendingCount: 0,
        launchType: "FARGATE",
        servicePorts: [{ port: 8080, protocol: "tcp" }],
        exposureKinds: ["alb", "service-connect"],
        cpuUtilizationPercent: 23.4,
        memoryUtilizationPercent: 61.2,
        taskDefinitionArn: "api:7",
        taskDefinitionRevision: 7,
        latestEventMessage: "steady state",
        deployments: [
          {
            id: "ecs-svc/1",
            status: "PRIMARY",
            rolloutState: "COMPLETED",
            desiredCount: 2,
            runningCount: 2,
            pendingCount: 0,
            taskDefinitionRevision: 7,
            updatedAt: "2026-03-29T00:10:00.000Z",
          },
        ],
        events: [
          {
            id: "event-1",
            message: "service api registered targets",
            createdAt: "2026-03-29T00:09:00.000Z",
          },
        ],
      },
      {
        serviceArn:
          "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/worker",
        serviceName: "worker",
        status: "ACTIVE",
        rolloutState: "IN_PROGRESS",
        rolloutStateReason: "deployment in progress",
        desiredCount: 2,
        runningCount: 1,
        pendingCount: 1,
        capacityProviderSummary: "gw-prod-priv-asg (weight 1)",
        servicePorts: [
          { port: 7001, protocol: "tcp" },
          { port: 7002, protocol: "tcp" },
        ],
        exposureKinds: ["alb"],
        cpuUtilizationPercent: 78,
        memoryUtilizationPercent: 64,
        taskDefinitionArn: "worker:14",
        taskDefinitionRevision: 14,
        latestEventMessage: "deployment in progress",
        deployments: [
          {
            id: "ecs-svc/2",
            status: "PRIMARY",
            rolloutState: "IN_PROGRESS",
            rolloutStateReason: "waiting for healthy targets",
            desiredCount: 2,
            runningCount: 1,
            pendingCount: 1,
            taskDefinitionRevision: 14,
            updatedAt: "2026-03-29T00:10:00.000Z",
          },
        ],
        events: [
          {
            id: "event-2",
            message: "deployment in progress",
            createdAt: "2026-03-29T00:09:00.000Z",
          },
        ],
      },
    ],
    metricsWarning: null,
    loadedAt: "2026-03-29T00:10:00.000Z",
    ...overrides,
  };
}

function createTab(
  snapshot: AwsEcsClusterSnapshot,
  options: Partial<HostContainersTabState> = {},
): HostContainersTabState {
  return {
    kind: "ecs-cluster",
    hostId: "ecs-host-1",
    title: "prod · ECS",
    runtime: null,
    unsupportedReason: null,
    connectionProgress: null,
    items: [],
    selectedContainerId: null,
    activePanel: "overview",
    isLoading: false,
    errorMessage: undefined,
    details: null,
    detailsLoading: false,
    detailsError: undefined,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsError: undefined,
    logsFollowEnabled: false,
    logsTailWindow: 200,
    logsRangeMode: "recent",
    logsRelativeRange: {
      presetKey: "30m",
      amount: "30",
      unit: "minute",
    },
    logsAbsoluteRange: null,
    logsSearchQuery: "",
    logsSearchMode: "local",
    logsSearchLoading: false,
    logsSearchError: undefined,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    metricsError: undefined,
    pendingAction: null,
    actionError: undefined,
    ecsSnapshot: snapshot,
    ecsMetricsWarning: null,
    ecsMetricsLoadedAt: "2026-03-29T00:10:05.000Z",
    ecsMetricsLoading: false,
    ecsUtilizationHistoryByServiceName: {
      api: {
        cpuHistory: [
          { timestamp: "2026-03-29T00:01:00.000Z", value: 18.2 },
          { timestamp: "2026-03-29T00:02:00.000Z", value: 23.4 },
        ],
        memoryHistory: [
          { timestamp: "2026-03-29T00:01:00.000Z", value: 55.1 },
          { timestamp: "2026-03-29T00:02:00.000Z", value: 61.2 },
        ],
      },
      worker: {
        cpuHistory: [
          { timestamp: "2026-03-29T00:01:00.000Z", value: 60 },
          { timestamp: "2026-03-29T00:02:00.000Z", value: 78 },
        ],
        memoryHistory: [
          { timestamp: "2026-03-29T00:01:00.000Z", value: 58 },
          { timestamp: "2026-03-29T00:02:00.000Z", value: 64 },
        ],
      },
    },
    ecsLogsByServiceName: {},
    ecsSelectedServiceName: "worker",
    ecsActivePanel: "overview",
    containerTunnelStatesByContainerId: {},
    ecsTunnelStatesByServiceName: {},
    ...options,
  };
}

function createActionContext(
  overrides: Partial<AwsEcsServiceActionContext> = {},
): AwsEcsServiceActionContext {
  return {
    serviceName: "worker",
    serviceArn: "arn:aws:ecs:ap-northeast-2:123456789012:service/prod/worker",
    taskDefinitionArn: "worker:14",
    taskDefinitionRevision: 14,
    containers: [
      {
        containerName: "worker",
        ports: [
          { port: 7001, protocol: "tcp" },
          { port: 7002, protocol: "tcp" },
        ],
        execEnabled: true,
        logSupport: {
          containerName: "worker",
          supported: true,
          logGroupName: "/ecs/worker",
          logRegion: "ap-northeast-2",
          logStreamPrefix: "ecs",
        },
      },
    ],
    runningTasks: [
      {
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        taskId: "task-1",
        lastStatus: "RUNNING",
        enableExecuteCommand: true,
        containers: [
          {
            containerName: "worker",
            lastStatus: "RUNNING",
            runtimeId: "runtime-1",
          },
        ],
      },
    ],
    deployments: [
      {
        id: "ecs-svc/2",
        status: "PRIMARY",
        rolloutState: "IN_PROGRESS",
        rolloutStateReason: "waiting for healthy targets",
        desiredCount: 2,
        runningCount: 1,
        pendingCount: 1,
        taskDefinitionRevision: 14,
      },
    ],
    events: [
      {
        id: "event-2",
        message: "deployment in progress",
        createdAt: "2026-03-29T00:09:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createLogsSnapshot(
  overrides: Partial<AwsEcsServiceLogsSnapshot> = {},
): AwsEcsServiceLogsSnapshot {
  return {
    serviceName: "worker",
    entries: [
      {
        id: "log-1",
        timestamp: "2026-03-29T00:11:00.000Z",
        message: "hello from task-1",
        taskId: "task-1",
        containerName: "worker",
      },
    ],
    taskOptions: [
      {
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        taskId: "task-1",
      },
    ],
    containerOptions: ["worker"],
    followCursor: "2026-03-29T00:11:00.000Z",
    loadedAt: "2026-03-29T00:11:01.000Z",
    unsupportedReason: null,
    ...overrides,
  };
}

function createEmptyEcsServiceLogsState(): EcsServiceLogsViewState {
  return {
    loading: false,
    refreshing: false,
    error: null,
    snapshot: null,
    follow: true,
    query: "",
    taskArn: null,
    containerName: null,
    rangeMode: "recent",
    relativeRange: {
      presetKey: "30m",
      amount: "30",
      unit: "minute",
    },
    absoluteRange: null,
  };
}

function renderStoreBackedWorkspace(
  tabOptions: Partial<HostContainersTabState> = {},
) {
  const host = createHost();
  const snapshot = createSnapshot();

  function Harness() {
    const [tab, setTab] = useState(() => createTab(snapshot, tabOptions));

    return (
      <AwsEcsWorkspace
        host={host}
        tab={tab}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onSelectService={(_hostId, serviceName) => {
          setTab((previous) => ({
            ...previous,
            ecsSelectedServiceName: serviceName,
          }));
        }}
        onSetPanel={(_hostId, panel) => {
          setTab((previous) => ({
            ...previous,
            ecsActivePanel: panel,
          }));
        }}
        onSetLogsState={(_hostId, serviceName, logsState) => {
          setTab((previous) => {
            const nextLogsByServiceName = { ...previous.ecsLogsByServiceName };
            if (logsState === null) {
              delete nextLogsByServiceName[serviceName];
            } else {
              const currentLogsState =
                previous.ecsLogsByServiceName[serviceName] ??
                createEmptyEcsServiceLogsState();
              nextLogsByServiceName[serviceName] =
                typeof logsState === "function"
                  ? logsState(currentLogsState)
                  : logsState;
            }
            return {
              ...previous,
              ecsLogsByServiceName: nextLogsByServiceName,
            };
          });
        }}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />
    );
  }

  return render(<Harness />);
}

describe("AwsEcsWorkspace", () => {
  let portForwardListener: ((event: PortForwardRuntimeEvent) => void) | null = null;
  const awsApi = {
    loadEcsServiceActionContext: vi.fn(),
    loadEcsServiceLogs: vi.fn(),
    startEcsServiceTunnel: vi.fn(),
    stopEcsServiceTunnel: vi.fn(),
  };

  beforeEach(() => {
    Object.defineProperty(window, "dolssh", {
      configurable: true,
      value: {
        aws: awsApi,
        portForwards: {
          onEvent: vi.fn((listener: (event: PortForwardRuntimeEvent) => void) => {
            portForwardListener = listener;
            return () => {
              if (portForwardListener === listener) {
                portForwardListener = null;
              }
            };
          }),
        },
      },
    });
    portForwardListener = null;
    awsApi.loadEcsServiceActionContext.mockReset();
    awsApi.loadEcsServiceLogs.mockReset();
    awsApi.startEcsServiceTunnel.mockReset();
    awsApi.stopEcsServiceTunnel.mockReset();
    awsApi.loadEcsServiceActionContext.mockResolvedValue(createActionContext());
    awsApi.loadEcsServiceLogs.mockResolvedValue(createLogsSnapshot());
    awsApi.startEcsServiceTunnel.mockResolvedValue({
      ruleId: "ecs-service-tunnel:1",
      hostId: "ecs-host-1",
      transport: "ecs-task",
      bindAddress: "127.0.0.1",
      bindPort: 4200,
      status: "running",
      updatedAt: "2026-03-29T00:11:02.000Z",
      startedAt: "2026-03-29T00:11:02.000Z",
      mode: "local",
      method: "ssm-remote-host",
    });
    awsApi.stopEcsServiceTunnel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows ECS progress stage and message while the initial snapshot is loading", () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: true,
          ecsSnapshot: null,
          connectionProgress: {
            endpointId: "containers:ecs-host-1",
            hostId: "ecs-host-1",
            stage: "loading-ecs-cluster",
            message: "ECS 클러스터와 서비스 목록을 불러오는 중입니다.",
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("ECS 클러스터 조회")).toBeInTheDocument();
    expect(
      screen.getByText("ECS 클러스터와 서비스 목록을 불러오는 중입니다."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ecs-summary-cards")).toBeNull();
  });

  it("keeps the existing ECS snapshot visible and shows a progress banner during refresh", () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: true,
          connectionProgress: {
            endpointId: "containers:ecs-host-1",
            hostId: "ecs-host-1",
            stage: "loading-ecs-metrics",
            message: "AWS ECS/CloudWatch 사용량 지표를 가져오는 중입니다.",
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId("ecs-summary-cards")).toBeInTheDocument();
    expect(screen.getByText("사용량 지표 조회")).toBeInTheDocument();
    expect(
      screen.getByText("AWS ECS/CloudWatch 사용량 지표를 가져오는 중입니다."),
    ).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
  });

  it("shows a browser reopen action while ECS SSO login progress is active", async () => {
    const login = createDeferred<void>();
    const onOpenAwsSsoLogin = vi.fn().mockReturnValue(login.promise);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: true,
          ecsSnapshot: null,
          connectionProgress: {
            endpointId: "containers:ecs-host-1",
            hostId: "ecs-host-1",
            stage: "browser-login",
            message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenAwsSsoLogin={onOpenAwsSsoLogin}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "브라우저 다시 열기" }));

    expect(onOpenAwsSsoLogin).toHaveBeenCalledWith("ecs-host-1");
    expect(
      screen.getByRole("button", { name: "브라우저 여는 중..." }),
    ).toBeDisabled();

    login.resolve();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "브라우저 다시 열기" }),
      ).toBeEnabled(),
    );
  });

  it("shows the browser reopen action in the ECS refresh banner too", () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: true,
          connectionProgress: {
            endpointId: "containers:ecs-host-1",
            hostId: "ecs-host-1",
            stage: "browser-login",
            message: "브라우저에서 default AWS 로그인을 진행하는 중입니다.",
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenAwsSsoLogin={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId("ecs-summary-cards")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "브라우저 다시 열기" }),
    ).toBeInTheDocument();
  });

  it("offers SSO login recovery actions for ECS authentication errors", async () => {
    const onOpenAwsSsoLogin = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: false,
          errorMessage:
            "The SSO session associated with this profile has expired.",
        })}
        isActive={false}
        onRefresh={onRefresh}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenAwsSsoLogin={onOpenAwsSsoLogin}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "브라우저에서 로그인" }));

    await waitFor(() => {
      expect(onOpenAwsSsoLogin).toHaveBeenCalledWith("ecs-host-1");
      expect(onRefresh).toHaveBeenCalledWith("ecs-host-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("does not show SSO recovery actions for generic ECS errors", () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          isLoading: false,
          errorMessage: "ECS 클러스터 정보를 불러오지 못했습니다.",
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenAwsSsoLogin={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).queryByRole("button", { name: "브라우저에서 로그인" })).toBeNull();
    expect(within(alert).queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("renders split view with overview, deployments, and recent events", () => {
    const { container } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getAllByText("Services")).toHaveLength(2);
    expect(
      screen.queryByText(/메타 정보는 수동 새로고침으로/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass(
      "bg-[var(--selection-tint)]",
    );
    expect(screen.getByText("배포 정보")).toBeInTheDocument();
    expect(screen.getByText("Deployments")).toBeInTheDocument();
    expect(screen.getByText("Recent events")).toBeInTheDocument();
    expect(screen.getByText("waiting for healthy targets")).toBeInTheDocument();
    expect(screen.getByText("deployment in progress")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="ecs-service-row"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="ecs-service-row"]')?.textContent).toContain("worker");
    expect(
      container.querySelector('[data-testid="ecs-service-row"]')?.className,
    ).toContain("shrink-0");
    const selectedRowText =
      container.querySelector('[data-testid="ecs-service-row"]')?.textContent ?? "";
    expect(selectedRowText).not.toContain("1 / 2");
  });

  it("keeps non-selected failed services visually neutral and reserves strong borders for the selected row", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = createSnapshot({
      services: [
        {
          ...baseSnapshot.services[0]!,
          rolloutState: "FAILED",
          rolloutStateReason: "deployment failed",
          latestEventMessage: "deployment failed",
        },
        {
          ...baseSnapshot.services[1]!,
          rolloutState: "COMPLETED",
          rolloutStateReason: undefined,
          pendingCount: 0,
        },
      ],
    });

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(snapshot, { ecsSelectedServiceName: "worker" })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const serviceRows = screen.getAllByTestId("ecs-service-row");
    const failedRow = serviceRows.find((row) => row.textContent?.includes("api"));
    const selectedRow = serviceRows.find((row) =>
      row.textContent?.includes("worker"),
    );

    expect(failedRow).toBeTruthy();
    expect(selectedRow).toBeTruthy();
    expect(failedRow?.className).toContain("border-[var(--border)]");
    expect(failedRow?.className).not.toContain(
      "border-[color-mix(in_srgb,var(--danger)_28%,var(--border)_72%)]",
    );
    expect(selectedRow?.className).toContain("border-[var(--selection-border)]");
  });

  it("switches to logs panel and loads awslogs entries", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenCalledWith({
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: null,
        containerName: null,
        followCursor: null,
        limit: 5000,
      });
    });

    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveClass(
      "bg-[var(--selection-tint)]",
    );
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();
  });

  it("opens local Ctrl+F find over rendered ECS logs without changing the log filter", async () => {
    const { container } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsActivePanel: "logs",
          ecsLogsByServiceName: {
            worker: {
              ...createEmptyEcsServiceLogsState(),
              snapshot: createLogsSnapshot({
                entries: [
                  {
                    id: "log-1",
                    timestamp: "2026-03-29T00:11:00.000Z",
                    message: "worker completed",
                    taskId: "task-1",
                    containerName: "worker",
                  },
                ],
              }),
            },
          },
        })}
        isActive={true}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    const localFindInput = await screen.findByLabelText("현재 로그에서 찾기");
    await waitFor(() => {
      expect(localFindInput).toHaveFocus();
    });
    fireEvent.change(localFindInput, { target: { value: "worker" } });

    expect(screen.getByLabelText("로그 검색")).toHaveValue("");
    expect(screen.getByText("1/2")).toBeInTheDocument();
    const marks = container.querySelectorAll('[data-local-find-match="true"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("worker");
    expect(container.querySelector('[data-local-find-active="true"]')).toHaveTextContent(
      "worker",
    );

    fireEvent.keyDown(localFindInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("2/2")).toBeInTheDocument();
    });

    fireEvent.keyDown(localFindInput, { key: "Enter", shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeInTheDocument();
    });

    fireEvent.keyDown(localFindInput, { key: "Escape" });

    expect(screen.queryByLabelText("현재 로그에서 찾기")).not.toBeInTheDocument();
  });

  it("expands ECS logs into focus mode and restores the regular layout", () => {
    const { container } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsActivePanel: "logs",
          ecsLogsByServiceName: {
            worker: {
              ...createEmptyEcsServiceLogsState(),
              snapshot: createLogsSnapshot(),
            },
          },
        })}
        isActive={true}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId("ecs-summary-cards")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="ecs-service-row"]')).toHaveLength(2);
    expect(
      within(screen.getByTestId("ecs-service-action-controls")).getByRole("button", {
        name: "쉘 접속",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("ecs-panel-switcher-row")).getByRole("button", {
        name: "로그 크게 보기",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 크게 보기" }));

    expect(screen.getByTestId("ecs-logs-focus-layout")).toBeInTheDocument();
    expect(screen.queryByTestId("ecs-summary-cards")).toBeNull();
    expect(screen.queryByTestId("ecs-services-sidebar")).toBeNull();
    expect(screen.queryByTestId("ecs-service-action-controls")).toBeNull();
    expect(screen.queryByTestId("ecs-panel-switcher-row")).toBeNull();
    expect(container.querySelectorAll('[data-testid="ecs-service-row"]')).toHaveLength(0);
    expect(screen.getByText("hello from task-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "쉘 접속" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "일반 보기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "일반 보기" }));

    expect(screen.getByTestId("ecs-summary-cards")).toBeInTheDocument();
    expect(screen.getByTestId("ecs-services-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("ecs-service-action-controls")).toBeInTheDocument();
    expect(screen.getByTestId("ecs-panel-switcher-row")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="ecs-service-row"]')).toHaveLength(2);
  });

  it("shows a generic empty-state message when the selected range has no logs", async () => {
    awsApi.loadEcsServiceLogs.mockResolvedValueOnce(
      createLogsSnapshot({
        entries: [],
        followCursor: null,
      }),
    );

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    expect(await screen.findByText("표시할 로그가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("최근 30분 기준 로그가 없습니다.")).toBeNull();
    expect(screen.queryByText("선택한 범위에 로그가 없습니다.")).toBeNull();
  });

  it("shows a floating loading chip without replacing visible logs during manual refresh", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    const deferredLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    awsApi.loadEcsServiceLogs.mockReturnValueOnce(deferredLogs.promise);

    fireEvent.click(
      screen.getByRole("button", { name: /불러오는 중|다시 불러오기/ }),
    );

    expect(screen.getByText("hello from task-1")).toBeInTheDocument();
    expect(screen.getByTestId("ecs-logs-loading-chip")).toHaveTextContent("갱신 중...");
    expect(screen.queryByText("서비스 로그를 불러오는 중입니다.")).toBeNull();

    deferredLogs.resolve(createLogsSnapshot());
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ecs-logs-loading-chip")).toBeNull();
    });
  });

  it("applies an absolute log range and reloads logs with start and end times", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 범위" }));

    expect(await screen.findByRole("dialog", { name: "로그 범위 선택" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "절대 범위" }));
    fireEvent.change(screen.getByLabelText("시작 날짜"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByLabelText("시작 시간"), {
      target: { value: "00:00:00" },
    });
    fireEvent.change(screen.getByLabelText("종료 날짜"), {
      target: { value: "2026-03-02" },
    });
    fireEvent.change(screen.getByLabelText("종료 시간"), {
      target: { value: "12:30:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenLastCalledWith({
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: null,
        containerName: null,
        followCursor: null,
        startTime: new Date(2026, 2, 1, 0, 0, 0).toISOString(),
        endTime: new Date(2026, 2, 2, 12, 30, 0).toISOString(),
        limit: 5000,
      });
    });

    expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("keeps the selected absolute range after reload in the store-backed path", async () => {
    renderStoreBackedWorkspace();

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 범위" }));
    expect(await screen.findByRole("dialog", { name: "로그 범위 선택" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "절대 범위" }));
    fireEvent.change(screen.getByLabelText("시작 날짜"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByLabelText("시작 시간"), {
      target: { value: "00:00:00" },
    });
    fireEvent.change(screen.getByLabelText("종료 날짜"), {
      target: { value: "2026-03-02" },
    });
    fireEvent.change(screen.getByLabelText("종료 시간"), {
      target: { value: "12:30:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenLastCalledWith({
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: null,
        containerName: null,
        followCursor: null,
        startTime: new Date(2026, 2, 1, 0, 0, 0).toISOString(),
        endTime: new Date(2026, 2, 2, 12, 30, 0).toISOString(),
        limit: 5000,
      });
    });

    expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("button", { name: "로그 범위" })).toHaveTextContent(
      "2026/03/01 00:00 - 2026/03/02 12:30",
    );
  });

  it("restores recent follow mode after re-enabling follow in the store-backed path", async () => {
    renderStoreBackedWorkspace();

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 범위" }));
    expect(await screen.findByRole("dialog", { name: "로그 범위 선택" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "절대 범위" }));
    fireEvent.change(screen.getByLabelText("시작 날짜"), {
      target: { value: "2026-03-01" },
    });
    fireEvent.change(screen.getByLabelText("시작 시간"), {
      target: { value: "00:00:00" },
    });
    fireEvent.change(screen.getByLabelText("종료 날짜"), {
      target: { value: "2026-03-02" },
    });
    fireEvent.change(screen.getByLabelText("종료 시간"), {
      target: { value: "12:30:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    fireEvent.click(screen.getByRole("switch", { name: "Follow" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenLastCalledWith({
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: null,
        containerName: null,
        followCursor: null,
        limit: 5000,
      });
    });

    expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: "로그 범위" })).toHaveTextContent(
      "최근 30분",
    );
  });

  it("keeps relative range preset labels on a single line in the range dialog", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 범위" }));
    expect(await screen.findByRole("dialog", { name: "로그 범위 선택" })).toBeInTheDocument();

    expect(screen.getByText("1일 전부터")).toHaveClass("whitespace-nowrap");
    expect(screen.getByText("사용자 지정 범위")).toHaveClass("whitespace-nowrap");
  });

  it("scrolls logs to the latest line when the logs panel becomes active", async () => {
    const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTop",
    );
    const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const setScrollTop = vi.fn();
    const scrollHeight = 4321;

    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      set: setScrollTop,
      get: () => 0,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={true}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    await screen.findByText("hello from task-1");

    await waitFor(() => {
      expect(setScrollTop).toHaveBeenCalledWith(scrollHeight);
    });

    if (originalScrollTopDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTopDescriptor);
    }
    if (originalScrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        originalScrollHeightDescriptor,
      );
    }
  });

  it("disables log selectors while a log filter change is loading", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    const deferredWorkerLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    awsApi.loadEcsServiceLogs.mockReturnValueOnce(deferredWorkerLogs.promise);

    fireEvent.change(screen.getByLabelText("Task"), {
      target: {
        value: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
      },
    });

    await waitFor(() => {
      const logRefreshButton = screen.getByRole("button", {
        name: /불러오는 중|다시 불러오기/,
      });
      expect(screen.getByLabelText("Task")).toBeDisabled();
      expect(screen.getByLabelText("Container")).toBeDisabled();
      expect(logRefreshButton).toBeDisabled();
      expect(screen.getByTestId("ecs-logs-loading-chip")).toHaveTextContent("갱신 중...");
      expect(screen.getByText("hello from task-1")).toBeInTheDocument();
    });

    deferredWorkerLogs.resolve(createLogsSnapshot());

    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      const logRefreshButton = screen.getByRole("button", { name: "다시 불러오기" });
      expect(screen.getByLabelText("Task")).not.toBeDisabled();
      expect(screen.getByLabelText("Container")).not.toBeDisabled();
      expect(logRefreshButton).not.toBeDisabled();
      expect(screen.queryByTestId("ecs-logs-loading-chip")).toBeNull();
    });
  });

  it("hides the previous service logs immediately while the next service is loading", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    const deferredApiLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    awsApi.loadEcsServiceLogs.mockReturnValueOnce(deferredApiLogs.promise);

    fireEvent.click(screen.getByRole("button", { name: /^api\b/i }));

    expect(screen.queryByText("hello from task-1")).not.toBeInTheDocument();
    expect(
      screen.getByText("서비스 로그를 불러오는 중입니다."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ecs-logs-loading-chip")).toBeNull();

    deferredApiLogs.resolve(
      createLogsSnapshot({
        serviceName: "api",
        entries: [
          {
            id: "api-log-1",
            timestamp: "2026-03-29T00:12:00.000Z",
            message: "hello from api",
            taskId: "task-api-1",
            containerName: "api",
          },
        ],
        containerOptions: ["api"],
      }),
    );

    expect(await screen.findByText("hello from api")).toBeInTheDocument();
  });

  it("shows the loading chip during silent follow polling without hiding existing logs", async () => {
    const deferredLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    awsApi.loadEcsServiceLogs.mockReturnValueOnce(deferredLogs.promise);
    let followRefreshTick: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler) => {
        if (typeof handler === "function") {
          followRefreshTick = handler as () => void;
        }
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      });
    const clearIntervalSpy = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => undefined);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsActivePanel: "logs",
          ecsLogsByServiceName: {
            worker: {
              ...createEmptyEcsServiceLogsState(),
              snapshot: createLogsSnapshot(),
              follow: true,
            },
          },
        })}
        isActive={true}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText("hello from task-1")).toBeInTheDocument();
    awsApi.loadEcsServiceLogs.mockClear();
    expect(followRefreshTick).not.toBeNull();

    await act(async () => {
      followRefreshTick?.();
    });

    expect(awsApi.loadEcsServiceLogs).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ecs-logs-loading-chip")).toHaveTextContent("갱신 중...");
    expect(screen.getByText("hello from task-1")).toBeInTheDocument();

    deferredLogs.resolve(createLogsSnapshot());
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ecs-logs-loading-chip")).toBeNull();
    });

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("restores cached logs immediately when returning to a previously viewed service", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    awsApi.loadEcsServiceLogs.mockResolvedValueOnce(
      createLogsSnapshot({
        serviceName: "api",
        entries: [
          {
            id: "api-log-1",
            timestamp: "2026-03-29T00:12:00.000Z",
            message: "hello from api",
            taskId: "task-api-1",
            containerName: "api",
          },
        ],
        containerOptions: ["api"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^api\b/i }));
    expect(await screen.findByText("hello from api")).toBeInTheDocument();

    const loadCallCountBeforeReturn = awsApi.loadEcsServiceLogs.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^worker\b/i }));

    expect(screen.getByText("hello from task-1")).toBeInTheDocument();
    expect(awsApi.loadEcsServiceLogs).toHaveBeenCalledTimes(loadCallCountBeforeReturn);
  });

  it("keeps late log responses scoped to their service cache without polluting the active view", async () => {
    const deferredWorkerLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    const deferredApiLogs = createDeferred<AwsEcsServiceLogsSnapshot>();
    awsApi.loadEcsServiceLogs
      .mockReturnValueOnce(deferredWorkerLogs.promise)
      .mockReturnValueOnce(deferredApiLogs.promise);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenNthCalledWith(1, {
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: null,
        containerName: null,
        followCursor: null,
        limit: 5000,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /^api\b/i }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceLogs).toHaveBeenNthCalledWith(2, {
        hostId: "ecs-host-1",
        serviceName: "api",
        taskArn: null,
        containerName: null,
        followCursor: null,
        limit: 5000,
      });
    });

    deferredApiLogs.resolve(
      createLogsSnapshot({
        serviceName: "api",
        entries: [
          {
            id: "api-log-1",
            timestamp: "2026-03-29T00:12:00.000Z",
            message: "hello from api",
            taskId: "task-api-1",
            containerName: "api",
          },
        ],
        containerOptions: ["api"],
      }),
    );

    expect(await screen.findByText("hello from api")).toBeInTheDocument();

    deferredWorkerLogs.resolve(
      createLogsSnapshot({
        serviceName: "worker",
        entries: [
          {
            id: "worker-log-2",
            timestamp: "2026-03-29T00:12:30.000Z",
            message: "late worker log",
            taskId: "task-1",
            containerName: "worker",
          },
        ],
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("hello from api")).toBeInTheDocument();
    expect(screen.queryByText("late worker log")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^worker\b/i }));

    expect(await screen.findByText("late worker log")).toBeInTheDocument();
    expect(awsApi.loadEcsServiceLogs).toHaveBeenCalledTimes(2);
  });

  it("restores per-service log UI state when switching between services", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("로그 검색"), {
      target: { value: "task-1" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Follow" }));

    awsApi.loadEcsServiceLogs.mockResolvedValueOnce(
      createLogsSnapshot({
        serviceName: "api",
        entries: [
          {
            id: "api-log-1",
            timestamp: "2026-03-29T00:12:00.000Z",
            message: "hello from api",
            taskId: "task-api-1",
            containerName: "api",
          },
        ],
        containerOptions: ["api"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^api\b/i }));
    expect(await screen.findByText("hello from api")).toBeInTheDocument();
    expect(screen.getByLabelText("로그 검색")).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /^worker\b/i }));

    expect(await screen.findByDisplayValue("task-1")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Follow" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("opens shell picker and starts ECS Exec through the provided action", async () => {
    const onOpenEcsExecShell = vi.fn().mockResolvedValue(undefined);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={onOpenEcsExecShell}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "쉘 접속" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "쉘 접속" })[1]);

    await waitFor(() => {
      expect(onOpenEcsExecShell).toHaveBeenCalledWith(
        "ecs-host-1",
        "worker",
        "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        "worker",
      );
    });
  });

  it("keeps a started tunnel alive across panel changes", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));
    await waitFor(() => {
      expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledWith(
        "ecs-host-1",
        "worker",
      );
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Port") as HTMLSelectElement).value,
      ).toBe("7001");
    });

    fireEvent.click(screen.getByRole("button", { name: "Start tunnel" }));

    await waitFor(() => {
      expect(awsApi.startEcsServiceTunnel).toHaveBeenCalledWith({
        hostId: "ecs-host-1",
        serviceName: "worker",
        taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/task-1",
        containerName: "worker",
        targetPort: 7001,
        bindAddress: "127.0.0.1",
        bindPort: 0,
      });
    });

    act(() => {
      portForwardListener?.({
        runtime: {
          ruleId: "ecs-service-tunnel:1",
          hostId: "ecs-host-1",
          transport: "ecs-task",
          bindAddress: "127.0.0.1",
          bindPort: 43110,
          status: "running",
          updatedAt: "2026-03-29T00:11:03.000Z",
          startedAt: "2026-03-29T00:11:02.000Z",
          mode: "local",
          method: "ssm-remote-host",
        },
      });
    });

    expect(screen.getByText("127.0.0.1:43110")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:7001")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));

    expect(awsApi.stopEcsServiceTunnel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));
    expect(screen.getByText("127.0.0.1:43110")).toBeInTheDocument();
  });

  it("restores a persisted tunnel runtime from the ECS tab state", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsActivePanel: "tunnel",
          ecsSelectedServiceName: "worker",
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
                updatedAt: "2026-03-29T00:11:03.000Z",
                startedAt: "2026-03-29T00:11:02.000Z",
                mode: "local",
                method: "ssm-remote-host",
              },
            },
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("tab", { name: "Tunnel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Tunnel" })).toHaveClass(
      "bg-[var(--selection-tint)]",
    );
    expect(screen.getByText("127.0.0.1:43110")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:7001")).toBeInTheDocument();
  });

  it("restores the previous tunnel state when returning to the same service", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Port") as HTMLSelectElement).value,
      ).toBe("7001");
    });

    fireEvent.click(screen.getByRole("button", { name: "Start tunnel" }));

    await waitFor(() => {
      expect(awsApi.startEcsServiceTunnel).toHaveBeenCalledTimes(1);
    });

    act(() => {
      portForwardListener?.({
        runtime: {
          ruleId: "ecs-service-tunnel:1",
          hostId: "ecs-host-1",
          transport: "ecs-task",
          bindAddress: "127.0.0.1",
          bindPort: 43110,
          status: "running",
          updatedAt: "2026-03-29T00:11:03.000Z",
          startedAt: "2026-03-29T00:11:02.000Z",
          mode: "local",
          method: "ssm-remote-host",
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /^api\b/i }));
    fireEvent.click(screen.getByRole("button", { name: /^worker\b/i }));

    expect(screen.getByText("127.0.0.1:43110")).toBeInTheDocument();
    expect(awsApi.stopEcsServiceTunnel).not.toHaveBeenCalled();
  });

  it("keeps Start tunnel disabled until task, container, and port options are ready", async () => {
    const deferredContext = createDeferred<AwsEcsServiceActionContext>();
    awsApi.loadEcsServiceActionContext.mockReturnValueOnce(deferredContext.promise);

    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));

    const startButton = screen.getByRole("button", { name: "Start tunnel" });
    expect(startButton).toBeDisabled();
    expect(screen.getByLabelText("Task")).toBeDisabled();
    expect(screen.getByLabelText("Container")).toBeDisabled();
    expect(screen.getByLabelText("Port")).toBeDisabled();

    deferredContext.resolve(createActionContext());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start tunnel" })).not.toBeDisabled();
      expect(screen.getByLabelText("Task")).not.toBeDisabled();
      expect(screen.getByLabelText("Container")).not.toBeDisabled();
      expect(screen.getByLabelText("Port")).not.toBeDisabled();
    });
  });

  it("loads tunnel action context only once for the selected service across rerenders", async () => {
    const initialTab = createTab(createSnapshot());
    const { rerender } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={initialTab}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledTimes(1);
      expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledWith(
        "ecs-host-1",
        "worker",
      );
    });

    rerender(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsMetricsLoadedAt: "2026-03-29T00:10:15.000Z",
          ecsUtilizationHistoryByServiceName: {
            api: {
              cpuHistory: [
                { timestamp: "2026-03-29T00:01:00.000Z", value: 18.2 },
                { timestamp: "2026-03-29T00:02:00.000Z", value: 23.4 },
                { timestamp: "2026-03-29T00:03:00.000Z", value: 25.1 },
              ],
              memoryHistory: [
                { timestamp: "2026-03-29T00:01:00.000Z", value: 55.1 },
                { timestamp: "2026-03-29T00:02:00.000Z", value: 61.2 },
                { timestamp: "2026-03-29T00:03:00.000Z", value: 60.4 },
              ],
            },
            worker: {
              cpuHistory: [
                { timestamp: "2026-03-29T00:01:00.000Z", value: 60 },
                { timestamp: "2026-03-29T00:02:00.000Z", value: 78 },
                { timestamp: "2026-03-29T00:03:00.000Z", value: 74 },
              ],
              memoryHistory: [
                { timestamp: "2026-03-29T00:01:00.000Z", value: 58 },
                { timestamp: "2026-03-29T00:02:00.000Z", value: 64 },
                { timestamp: "2026-03-29T00:03:00.000Z", value: 66 },
              ],
            },
          },
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledTimes(1);
  });

  it("does not retry tunnel action context automatically after an error", async () => {
    awsApi.loadEcsServiceActionContext.mockRejectedValueOnce(
      new Error("AWS CLI가 설치되어 있지 않습니다."),
    );

    const { rerender } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tunnel" }));

    await waitFor(() => {
      expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledTimes(1);
    });

    expect(
      await screen.findByText("AWS CLI가 설치되어 있지 않습니다."),
    ).toBeInTheDocument();

    rerender(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot(), {
          ecsMetricsLoadedAt: "2026-03-29T00:10:15.000Z",
        })}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(awsApi.loadEcsServiceActionContext).toHaveBeenCalledTimes(1);
  });

  it("polls ECS utilization every 10 seconds only while active", () => {
    vi.useFakeTimers();
    const onRefreshUtilization = vi.fn().mockResolvedValue(undefined);

    const { rerender, unmount } = render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={true}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={onRefreshUtilization}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(onRefreshUtilization).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onRefreshUtilization).toHaveBeenCalledTimes(1);
    expect(onRefreshUtilization).toHaveBeenCalledWith("ecs-host-1");

    rerender(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={onRefreshUtilization}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onRefreshUtilization).toHaveBeenCalledTimes(1);

    unmount();
    vi.useRealTimers();
  });

  it("renders metrics with shared uPlot charts", async () => {
    render(
      <AwsEcsWorkspace
        host={createHost()}
        tab={createTab(createSnapshot())}
        isActive={false}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onRefreshUtilization={vi.fn().mockResolvedValue(undefined)}
        onOpenEcsExecShell={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));

    expect(await screen.findByTestId("metric-plot:CPU")).toBeInTheDocument();
    expect(screen.getByTestId("metric-plot:Memory")).toBeInTheDocument();
  });
});
