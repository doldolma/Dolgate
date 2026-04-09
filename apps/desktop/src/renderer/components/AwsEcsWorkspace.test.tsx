import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AwsEcsClusterSnapshot,
  AwsEcsHostRecord,
  AwsEcsServiceActionContext,
  AwsEcsServiceLogsSnapshot,
  PortForwardRuntimeEvent,
} from "@shared";
import type { HostContainersTabState } from "../store/createAppStore";
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
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass("ring-1");
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
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveClass("ring-1");
    expect(await screen.findByText("hello from task-1")).toBeInTheDocument();
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
    });
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
    expect(screen.getByRole("tab", { name: "Tunnel" })).toHaveClass("ring-1");
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
