import type { ReactElement } from "react";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import type { HostContainersTabState } from "../store/createAppStore";

const uPlotMock = vi.hoisted(() => {
  const instances: Array<{
    opts: any;
    data: any;
    target: HTMLElement | null;
    instance: any;
  }> = [];

  const ctor = vi.fn().mockImplementation(function UPlotMock(
    this: Record<string, unknown>,
    opts: any,
    data: any,
    target?: HTMLElement,
  ) {
    const root = document.createElement("div");
    root.className = "uplot";
    const over = document.createElement("div");
    over.className = "u-over";
    root.appendChild(over);
    target?.appendChild(root);

    this.root = root;
    this.over = over;
    this.width = opts.width;
    this.height = opts.height;
    this.bbox = {
      left: 0,
      top: 0,
      width: opts.width,
      height: opts.height,
    };
    this.cursor = {
      idx: null,
      left: null,
      top: null,
    };
    this.destroy = vi.fn(() => {
      root.remove();
    });
    this.setData = vi.fn((nextData: any) => {
      this.data = nextData;
    });
    this.setSize = vi.fn((nextSize: { width: number; height: number }) => {
      this.width = nextSize.width;
      this.height = nextSize.height;
    });
    this.data = data;

    instances.push({
      opts,
      data,
      target: target ?? null,
      instance: this,
    });
  });

  return {
    ctor,
    instances,
  };
});

vi.mock("uplot", () => ({
  default: uPlotMock.ctor,
}));

import {
  ContainerTunnelErrorBoundary,
  ContainersWorkspace,
  formatContainerLogTimestamp,
  getContainerStatusPresentation,
  parseAnsiStyledSegments,
  parseContainerLogLine,
  shortenContainerImage,
  stripAnsiControlSequences,
} from "./ContainersWorkspace";

const containersApi = {
  startTunnel: vi.fn().mockResolvedValue({
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
  }),
  stopTunnel: vi.fn().mockResolvedValue(undefined),
};

function createHost(): HostRecord {
  return {
    id: "host-1",
    kind: "ssh",
    label: "nas",
    hostname: "example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

function createTab(): HostContainersTabState {
  return {
    kind: "host-containers",
    hostId: "host-1",
    title: "nas",
    runtime: "docker",
    unsupportedReason: null,
    connectionProgress: null,
    items: [
      {
        id: "container-1",
        name: "emqx",
        runtime: "docker",
        image: "docker.io/emqx/emqx:5.8.6",
        status: "Up 2 months",
        createdAt: "2025-10-15T08:55:31.000Z",
        ports: "4370/tcp, 5369/tcp, 8883/tcp",
      },
    ],
    selectedContainerId: "container-1",
    activePanel: "overview",
    isLoading: false,
    details: {
      id: "container-1",
      name: "emqx",
      runtime: "docker",
      image: "docker.io/emqx/emqx:5.8.6",
      status: "running",
      createdAt: "2025-10-15T08:55:31.000Z",
      command: "docker-entrypoint.sh",
      entrypoint: "/usr/bin/emqx",
      ports: [
        {
          containerPort: 1883,
          protocol: "tcp",
          publishedBindings: [],
        },
      ],
      mounts: [],
      networks: [
        {
          name: "bridge",
          ipAddress: "172.18.0.2",
          aliases: ["emqx"],
        },
      ],
      environment: [],
      labels: [],
    },
    detailsLoading: false,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsTailWindow: 200,
    logsFollowEnabled: false,
    logsRangeMode: "recent",
    logsRelativeRange: {
      presetKey: "30m",
      amount: "30",
      unit: "minute",
    },
    logsAbsoluteRange: null,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    pendingAction: null,
    containerTunnelStatesByContainerId: {},
    ecsSnapshot: null,
    ecsMetricsWarning: null,
    ecsMetricsLoadedAt: null,
    ecsMetricsLoading: false,
    ecsUtilizationHistoryByServiceName: {},
    ecsLogsByServiceName: {},
    ecsSelectedServiceName: null,
    ecsActivePanel: "overview",
    ecsTunnelStatesByServiceName: {},
  };
}

function createProps(
  tab: HostContainersTabState = createTab(),
): Parameters<typeof ContainersWorkspace>[0] {
  return {
    host: createHost(),
    tab,
    isActive: true,
    interactiveAuth: null,
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onSelectContainer: vi.fn().mockResolvedValue(undefined),
    onSetPanel: vi.fn(),
    onSetTunnelState: vi.fn(),
    onRefreshLogs: vi.fn().mockResolvedValue(undefined),
    onLoadMoreLogs: vi.fn().mockResolvedValue(undefined),
    onSetLogsFollow: vi.fn(),
    onSetLogsSearchQuery: vi.fn(),
    onSearchLogs: vi.fn().mockResolvedValue(undefined),
    onClearLogsSearch: vi.fn(),
    onRefreshMetrics: vi.fn().mockResolvedValue(undefined),
    onRunAction: vi.fn().mockResolvedValue(undefined),
    onOpenShell: vi.fn().mockResolvedValue(undefined),
    onRespondInteractiveAuth: vi.fn().mockResolvedValue(undefined),
    onReopenInteractiveAuthUrl: vi.fn().mockResolvedValue(undefined),
    onClearInteractiveAuth: vi.fn(),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "dolssh", {
    configurable: true,
    writable: true,
    value: {
      containers: containersApi,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  uPlotMock.instances.length = 0;
  uPlotMock.ctor.mockClear();
  vi.clearAllMocks();
});

describe("container list presentation helpers", () => {
  it("shortens image names to the last segment", () => {
    expect(shortenContainerImage("docker.io/emqx/emqx:5.8.6")).toBe(
      "emqx:5.8.6",
    );
  });

  it("maps running and uptime from docker status text", () => {
    expect(getContainerStatusPresentation("Up 2 months")).toEqual({
      label: "Running",
      tone: "running",
      uptime: "2 months",
    });
  });

  it("maps restarting, paused, and exited statuses to compact pills", () => {
    expect(
      getContainerStatusPresentation("Restarting (1) 5 seconds ago"),
    ).toMatchObject({
      label: "Restarting",
      tone: "starting",
    });
    expect(getContainerStatusPresentation("Paused")).toMatchObject({
      label: "Paused",
      tone: "paused",
    });
    expect(getContainerStatusPresentation("Exited (0) 3 hours ago")).toMatchObject({
      label: "Stopped",
      tone: "stopped",
    });
  });

  it("parses timestamped container log lines into local labels", () => {
    const line =
      "2025-10-15T08:55:31.000000000Z broker connected";

    expect(parseContainerLogLine(line)).toEqual({
      raw: line,
      message: "broker connected",
      timestampRaw: "2025-10-15T08:55:31.000000000Z",
      timestampLabel: formatContainerLogTimestamp(
        "2025-10-15T08:55:31.000000000Z",
      ),
    });
  });

  it("strips ANSI color codes from parsed container log messages", () => {
    const line =
      "2026-03-28T09:00:54.613802395Z [\u001b[33;21m2026-03-28 18:00:54,613\u001b[0m|\u001b[32mINFO\u001b[0m] hello";

    expect(parseContainerLogLine(line)).toEqual({
      raw: line,
      message:
        "[\u001b[33;21m2026-03-28 18:00:54,613\u001b[0m|\u001b[32mINFO\u001b[0m] hello",
      timestampRaw: "2026-03-28T09:00:54.613802395Z",
      timestampLabel: formatContainerLogTimestamp(
        "2026-03-28T09:00:54.613802395Z",
      ),
    });
  });

  it("strips ANSI color codes from raw fallback log lines", () => {
    expect(stripAnsiControlSequences("\u001b[31merror\u001b[0m plain")).toBe(
      "error plain",
    );
  });

  it("parses ANSI styled segments for colored log rendering", () => {
    expect(
      parseAnsiStyledSegments(
        "[\u001b[33;21m2026-03-28 18:00:54,613\u001b[0m|\u001b[32mINFO\u001b[0m]",
      ),
    ).toEqual([
      {
        text: "[",
        foreground: null,
        bold: false,
      },
      {
        text: "2026-03-28 18:00:54,613",
        foreground: "yellow",
        bold: false,
      },
      {
        text: "|",
        foreground: null,
        bold: false,
      },
      {
        text: "INFO",
        foreground: "green",
        bold: false,
      },
      {
        text: "]",
        foreground: null,
        bold: false,
      },
    ]);
  });
});

describe("ContainersWorkspace", () => {
  it("marks the selected detail panel tab accessibly and keeps disabled tabs visually inactive", () => {
    render(
      <ContainersWorkspace
        {...createProps({
          ...createTab(),
          selectedContainerId: null,
          activePanel: "overview",
        })}
      />,
    );

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    const logsTab = screen.getByRole("tab", { name: "Logs" });

    expect(
      screen.getByRole("tablist", { name: "컨테이너 상세 패널" }),
    ).toBeInTheDocument();
    expect(overviewTab).toHaveAttribute("aria-selected", "true");
    expect(overviewTab).toHaveClass("bg-[var(--selection-tint)]");
    expect(overviewTab).toHaveClass("border-[var(--selection-border)]");
    expect(logsTab).toHaveAttribute("aria-selected", "false");
    expect(logsTab).toBeDisabled();
    expect(logsTab).not.toHaveClass("bg-[var(--selection-tint)]");
  });

  it("shows only essential list fields and moves uptime into details", () => {
    render(<ContainersWorkspace {...createProps()} />);

    const listItem = screen.getByRole("button", { name: /emqx/i });
    expect(within(listItem).getByText("emqx")).toBeInTheDocument();
    expect(within(listItem).getByText("Running")).toBeInTheDocument();
    expect(within(listItem).getByText("emqx:5.8.6")).toBeInTheDocument();
    expect(screen.queryByText(/4370\/tcp/)).not.toBeInTheDocument();

    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.getByText("2 months")).toBeInTheDocument();
  });

  it("uses a wider summary grid and wraps long overview values inside each card", () => {
    render(<ContainersWorkspace {...createProps()} />);

    const summaryGrid = screen.getByTestId("containers-overview-summary-grid");
    expect(summaryGrid.className).toContain(
      "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]",
    );

    const idValue = screen.getByTestId("containers-overview-summary-id");
    expect(idValue.className).toContain("min-w-0");
    expect(idValue.className).toContain("[overflow-wrap:anywhere]");

    const imageValue = screen.getByTestId("containers-overview-summary-image");
    expect(imageValue.className).toContain("min-w-0");
    expect(imageValue.className).toContain("[overflow-wrap:anywhere]");
  });

  it("enables running-container actions from inspect status and keeps remove disabled", () => {
    render(<ContainersWorkspace {...createProps()} />);

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("opens the action confirm modal and only runs the action after confirmation", async () => {
    const onRunAction = vi.fn().mockResolvedValue(undefined);
    const exitedTab = {
      ...createTab(),
      items: [
        {
          ...createTab().items[0],
          status: "Exited (0) 3 hours ago",
        },
      ],
      details: {
        ...createTab().details!,
        status: "exited",
      },
    };

    render(
      <ContainersWorkspace
        {...createProps(exitedTab)}
        onRunAction={onRunAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      screen.getByRole("heading", { name: "컨테이너를 삭제할까요?" }),
    ).toBeInTheDocument();
    expect(onRunAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onRunAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    await waitFor(() => {
      expect(onRunAction).toHaveBeenCalledWith("host-1", "remove");
    });
  });

  it("renders metrics cards and polls while the metrics panel stays active", async () => {
    vi.useFakeTimers();
    const onRefreshMetrics = vi.fn().mockResolvedValue(undefined);
    const metricsTab = {
      ...createTab(),
      activePanel: "metrics" as const,
      metricsState: "ready" as const,
      metricsSamples: [
        {
          hostId: "host-1",
          containerId: "container-1",
          runtime: "docker" as const,
          recordedAt: "2025-01-01T00:00:00.000Z",
          cpuPercent: 12.5,
          memoryUsedBytes: 1024,
          memoryLimitBytes: 2048,
          memoryPercent: 50,
          networkRxBytes: 100,
          networkTxBytes: 200,
          blockReadBytes: 300,
          blockWriteBytes: 400,
        },
        {
          hostId: "host-1",
          containerId: "container-1",
          runtime: "docker" as const,
          recordedAt: "2025-01-01T00:00:05.000Z",
          cpuPercent: 15,
          memoryUsedBytes: 1200,
          memoryLimitBytes: 2048,
          memoryPercent: 58.6,
          networkRxBytes: 200,
          networkTxBytes: 320,
          blockReadBytes: 450,
          blockWriteBytes: 560,
        },
      ],
    };

    const { rerender } = render(
      <ContainersWorkspace
        {...createProps(metricsTab)}
        onRefreshMetrics={onRefreshMetrics}
      />,
    );

    expect(uPlotMock.ctor).toHaveBeenCalledTimes(4);
    expect(screen.getAllByText("CPU")).toHaveLength(2);
    expect(screen.getAllByText("Memory")).toHaveLength(2);
    expect(screen.getByText("Network I/O")).toBeInTheDocument();
    expect(screen.getAllByText("Block I/O")).toHaveLength(2);
    expect(onRefreshMetrics).not.toHaveBeenCalled();

    const cpuChart = uPlotMock.instances[0];
    expect(cpuChart.opts.axes).toHaveLength(2);
    expect(cpuChart.opts.series).toHaveLength(2);
    expect(cpuChart.opts.scales.y.range).toEqual([0, 100]);
    expect(cpuChart.data[0]).toEqual([
      new Date("2025-01-01T00:00:00.000Z").getTime(),
      new Date("2025-01-01T00:00:05.000Z").getTime(),
    ]);
    expect(cpuChart.data[1]).toEqual([12.5, 15]);

    const memoryChart = uPlotMock.instances[1];
    expect(memoryChart.opts.scales.y.range).toEqual([0, 100]);

    const networkChart = uPlotMock.instances[2];
    expect(networkChart.opts.series).toHaveLength(3);
    expect(networkChart.data[1]).toEqual([0, 20]);
    expect(networkChart.data[2]).toEqual([0, 24]);

    expect(cpuChart.opts.hooks.setCursor).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefreshMetrics).toHaveBeenCalledTimes(1);
    expect(onRefreshMetrics).toHaveBeenCalledWith("host-1");

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...metricsTab,
          activePanel: "overview",
        })}
        onRefreshMetrics={onRefreshMetrics}
      />,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefreshMetrics).toHaveBeenCalledTimes(1);
  });

  it("expands the CPU chart range above 100% while keeping memory fixed", () => {
    const metricsTab = {
      ...createTab(),
      activePanel: "metrics" as const,
      metricsState: "ready" as const,
      metricsSamples: [
        {
          hostId: "host-1",
          containerId: "container-1",
          runtime: "docker" as const,
          recordedAt: "2025-01-01T00:00:00.000Z",
          cpuPercent: 135,
          memoryUsedBytes: 1024,
          memoryLimitBytes: 2048,
          memoryPercent: 50,
          networkRxBytes: 100,
          networkTxBytes: 200,
          blockReadBytes: 300,
          blockWriteBytes: 400,
        },
        {
          hostId: "host-1",
          containerId: "container-1",
          runtime: "docker" as const,
          recordedAt: "2025-01-01T00:00:05.000Z",
          cpuPercent: 182,
          memoryUsedBytes: 1200,
          memoryLimitBytes: 2048,
          memoryPercent: 58.6,
          networkRxBytes: 200,
          networkTxBytes: 320,
          blockReadBytes: 450,
          blockWriteBytes: 560,
        },
      ],
    };

    render(<ContainersWorkspace {...createProps(metricsTab)} />);

    const cpuChart = uPlotMock.instances[0];
    const memoryChart = uPlotMock.instances[1];

    expect(cpuChart.opts.scales.y.range).toEqual([0, 200]);
    expect(memoryChart.opts.scales.y.range).toEqual([0, 100]);
  });

  it("filters local log results and shows remote search counts", () => {
    const host = createHost();
    const localTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: [
          "2025-10-15T08:55:31.000000000Z broker connected",
          "2025-10-15T08:55:32.000000000Z error happened",
        ],
        cursor: "2025-10-15T08:55:32.000000000Z",
      },
      logsState: "ready" as const,
      logsSearchQuery: "error",
      logsSearchMode: "local" as const,
    };

    const { rerender } = render(
      <ContainersWorkspace {...createProps(localTab)} host={host} />,
    );

    expect(screen.getByText("현재 버퍼에서 1건 일치")).toBeInTheDocument();
    expect(screen.getByText("error happened")).toBeInTheDocument();
    expect(screen.queryByText("broker connected")).not.toBeInTheDocument();
    expect(
      screen
        .getByText("error happened")
        .closest('[data-log-match="true"]'),
    ).toHaveAttribute("data-log-match", "true");

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...localTab,
          logsSearchMode: "remote",
          logsSearchResult: {
            hostId: "host-1",
            containerId: "container-1",
            runtime: "docker",
            query: "error",
            lines: ["2025-10-15T08:55:35.000000000Z remote error"],
            matchCount: 1,
          },
        })}
        host={host}
      />,
    );

    expect(screen.getByText("원격 검색 결과 1건")).toBeInTheDocument();
    expect(screen.getByText("remote error")).toBeInTheDocument();
  });

  it("opens local Ctrl+F find over the rendered log buffer without changing log filters", async () => {
    const host = createHost();
    const onSetLogsSearchQuery = vi.fn();
    const tab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: [
          "2026-03-28T09:00:54.613802395Z error \u001b[32mINFO\u001b[0m visible info",
          "2026-03-28T09:00:55.613802395Z \u001b[32mINFO\u001b[0m hidden",
        ],
        cursor: "2026-03-28T09:00:55.613802395Z",
      },
      logsState: "ready" as const,
      logsSearchQuery: "error",
      logsSearchMode: "local" as const,
    };

    const { container } = render(
      <ContainersWorkspace
        {...createProps(tab)}
        host={host}
        onSetLogsSearchQuery={onSetLogsSearchQuery}
      />,
    );

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    const localFindInput = await screen.findByLabelText("현재 로그에서 찾기");
    await waitFor(() => {
      expect(localFindInput).toHaveFocus();
    });
    fireEvent.change(localFindInput, { target: { value: "info" } });

    expect(onSetLogsSearchQuery).not.toHaveBeenCalled();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("visible")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();

    const marks = container.querySelectorAll('[data-local-find-match="true"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("INFO");
    expect(marks[0].closest('[data-ansi-tone="green"]')).not.toBeNull();
    expect(container.querySelector('[data-local-find-active="true"]')).toHaveTextContent(
      "INFO",
    );

    fireEvent.keyDown(localFindInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("2/2")).toBeInTheDocument();
    });
    expect(container.querySelector('[data-local-find-active="true"]')).toHaveTextContent(
      "info",
    );

    fireEvent.keyDown(localFindInput, { key: "Escape" });

    expect(screen.queryByLabelText("현재 로그에서 찾기")).not.toBeInTheDocument();
  });

  it("expands container logs into focus mode and restores the regular layout", () => {
    const logsTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["2025-10-15T08:55:31.000000000Z broker connected"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    render(<ContainersWorkspace {...createProps(logsTab)} />);

    expect(screen.getByTestId("containers-sidebar")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "셸 접속" })).toHaveLength(1);
    expect(
      within(screen.getByTestId("container-action-controls")).getByRole("button", {
        name: "셸 접속",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("container-panel-switcher-row")).getByRole("button", {
        name: "로그 크게 보기",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "로그 크게 보기" }));

    expect(screen.getByTestId("containers-logs-focus-layout")).toBeInTheDocument();
    expect(screen.queryByTestId("containers-sidebar")).toBeNull();
    expect(screen.queryByTestId("container-action-controls")).toBeNull();
    expect(screen.queryByTestId("container-panel-switcher-row")).toBeNull();
    expect(screen.getByText("broker connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "셸 접속" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "일반 보기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "일반 보기" }));

    expect(screen.getByTestId("containers-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("container-action-controls")).toBeInTheDocument();
    expect(screen.getByTestId("container-panel-switcher-row")).toBeInTheDocument();
  });

  it("shows the container log range picker and reloads logs with an absolute range", async () => {
    const onRefreshLogs = vi.fn().mockResolvedValue(undefined);
    const logsTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["2025-10-15T08:55:31.000000000Z broker connected"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    render(
      <ContainersWorkspace
        {...createProps(logsTab)}
        onRefreshLogs={onRefreshLogs}
      />,
    );

    expect(screen.getByRole("button", { name: "로그 범위" })).toHaveTextContent(
      "최근 30분",
    );

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
      expect(onRefreshLogs).toHaveBeenCalledWith(
        "host-1",
        expect.objectContaining({
          tail: 200,
          followCursor: null,
          startTime: new Date(2026, 2, 1, 0, 0, 0).toISOString(),
          endTime: new Date(2026, 2, 2, 12, 30, 0).toISOString(),
          rangeMode: "absolute",
          relativeRange: null,
          absoluteRange: {
            startDate: "2026-03-01",
            startTime: "00:00:00",
            endDate: "2026-03-02",
            endTime: "12:30:00",
          },
        }),
      );
    });
  });

  it("calls load more and disables it when remote search is active or the tail cap is reached", () => {
    const onLoadMoreLogs = vi.fn().mockResolvedValue(undefined);
    const logsTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["2025-10-15T08:55:31.000000000Z broker connected"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    const { rerender } = render(
      <ContainersWorkspace
        {...createProps(logsTab)}
        onLoadMoreLogs={onLoadMoreLogs}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(onLoadMoreLogs).toHaveBeenCalledWith("host-1");

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...logsTab,
          logsSearchMode: "remote",
        })}
        onLoadMoreLogs={onLoadMoreLogs}
      />,
    );
    expect(screen.getByRole("button", { name: "더 보기" })).toBeDisabled();

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...logsTab,
          logsTailWindow: 20000,
        })}
        onLoadMoreLogs={onLoadMoreLogs}
      />,
    );
    expect(screen.getByRole("button", { name: "더 보기" })).toBeDisabled();
  });

  it("toggles follow from the logs toolbar switch", () => {
    const onSetLogsFollow = vi.fn();
    const onRefreshLogs = vi.fn().mockResolvedValue(undefined);
    const logsTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logsState: "ready" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["2025-10-15T08:55:31.000000000Z broker connected"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
    };

    render(
      <ContainersWorkspace
        {...createProps(logsTab)}
        onRefreshLogs={onRefreshLogs}
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    const followSwitch = screen.getByRole("switch", { name: "Follow" });
    expect(followSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(followSwitch);
    expect(onSetLogsFollow).toHaveBeenCalledWith("host-1", true);
    expect(onRefreshLogs).toHaveBeenCalledWith("host-1", {
      tail: 200,
      followCursor: null,
      startTime: null,
      endTime: null,
    });
  });

  it("scrolls logs to the latest line when the logs panel is active", async () => {
    const host = createHost();
    const tab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["line 1", "line 2", "line 3"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

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

    render(<ContainersWorkspace {...createProps(tab)} host={host} />);

    await waitFor(() => {
      expect(setScrollTop).toHaveBeenCalledWith(scrollHeight);
    });
  });

  it("keeps logs pinned to the latest line while follow appends new logs", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const host = createHost();
    const initialTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logsFollowEnabled: true,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["line 1", "line 2"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    const { rerender } = render(
      <ContainersWorkspace {...createProps(initialTab)} host={host} />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    scrollIntoView.mockClear();

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...initialTab,
          logs: {
            ...initialTab.logs!,
            lines: ["line 1", "line 2", "line 3"],
            cursor: "2025-10-15T08:55:32.000000000Z",
          },
        })}
        host={host}
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
  });

  it("turns follow off when the user scrolls away from the latest logs", async () => {
    const onSetLogsFollow = vi.fn();
    const host = createHost();
    const logsTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logsFollowEnabled: true,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["line 1", "line 2", "line 3"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    render(
      <ContainersWorkspace
        {...createProps(logsTab)}
        host={host}
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    const logsOutput = screen.getByTestId(
      "containers-logs-output",
    ) as HTMLDivElement | null;
    expect(logsOutput).not.toBeNull();

    await waitFor(() => {
      expect(logsOutput).toBeTruthy();
    });

    if (!logsOutput) {
      throw new Error("logs output missing");
    }

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    Object.defineProperty(logsOutput, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(logsOutput, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(logsOutput, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });

    fireEvent.scroll(logsOutput);

    expect(onSetLogsFollow).toHaveBeenCalledWith("host-1", false);
  });

  it("does not auto-scroll new log lines after manual scroll turns follow off", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const onSetLogsFollow = vi.fn();
    const host = createHost();
    const initialTab = {
      ...createTab(),
      activePanel: "logs" as const,
      logsFollowEnabled: true,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: ["line 1", "line 2"],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    const { rerender } = render(
      <ContainersWorkspace
        {...createProps(initialTab)}
        host={host}
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    scrollIntoView.mockClear();

    const logsOutput = screen.getByTestId(
      "containers-logs-output",
    ) as HTMLDivElement | null;
    expect(logsOutput).not.toBeNull();

    if (!logsOutput) {
      throw new Error("logs output missing");
    }

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });

    Object.defineProperty(logsOutput, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(logsOutput, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(logsOutput, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });

    fireEvent.scroll(logsOutput);
    expect(onSetLogsFollow).toHaveBeenCalledWith("host-1", false);

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...initialTab,
          logsFollowEnabled: false,
          logs: {
            ...initialTab.logs!,
            lines: ["line 1", "line 2", "line 3"],
            cursor: "2025-10-15T08:55:32.000000000Z",
          },
        })}
        host={host}
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("line 3")).toBeInTheDocument();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
  });

  it("renders local-time log timestamps and preserves the raw timestamp in title", () => {
    const host = createHost();
    const tab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: [
          "2025-10-15T08:55:31.000000000Z broker connected",
          "raw fallback log line",
        ],
        cursor: "2025-10-15T08:55:31.000000000Z",
      },
      logsState: "ready" as const,
    };

    render(<ContainersWorkspace {...createProps(tab)} host={host} />);

    const timestamp = screen.getByText(
      formatContainerLogTimestamp("2025-10-15T08:55:31.000000000Z") ?? "",
    );
    expect(timestamp).toHaveAttribute(
      "title",
      "2025-10-15T08:55:31.000000000Z",
    );
    expect(screen.getByText("broker connected")).toBeInTheDocument();
    expect(screen.getByText("raw fallback log line")).toBeInTheDocument();
  });

  it("renders ANSI-colored log messages as styled spans", () => {
    const host = createHost();
    const tab = {
      ...createTab(),
      activePanel: "logs" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: [
          "2026-03-28T09:00:54.613802395Z [\u001b[33;21m2026-03-28 18:00:54,613\u001b[0m|\u001b[32mINFO\u001b[0m] hello",
        ],
        cursor: "2026-03-28T09:00:54.613802395Z",
      },
      logsState: "ready" as const,
    };

    render(<ContainersWorkspace {...createProps(tab)} host={host} />);

    expect(
      screen.getByText("2026-03-28 18:00:54,613"),
    ).toHaveAttribute("data-ansi-tone", "yellow");
    expect(screen.getByText("INFO")).toHaveAttribute(
      "data-ansi-tone",
      "green",
    );
    expect(
      screen.getByText((content) => content.includes("hello")),
    ).toBeInTheDocument();
  });

  it("retries automatically when the current logs state is empty", async () => {
    const onRefreshLogs = vi.fn().mockResolvedValue(undefined);
    const host = createHost();
    const emptyLogsTab = {
      ...createTab(),
      activePanel: "overview" as const,
      logs: {
        hostId: "host-1",
        containerId: "container-1",
        runtime: "docker" as const,
        lines: [],
        cursor: null,
      },
      logsState: "empty" as const,
    };

    const { rerender } = render(
      <ContainersWorkspace
        {...createProps(emptyLogsTab)}
        host={host}
        onRefreshLogs={onRefreshLogs}
      />,
    );

    rerender(
      <ContainersWorkspace
        {...createProps({
          ...emptyLogsTab,
          activePanel: "logs",
        })}
        host={host}
        onRefreshLogs={onRefreshLogs}
      />,
    );

    await waitFor(() => {
      expect(onRefreshLogs).toHaveBeenCalledWith(
        "host-1",
        expect.objectContaining({
          tail: 200,
          followCursor: null,
          startTime: expect.any(String),
          endTime: expect.any(String),
        }),
      );
    });
  });

  it("shows the Tunnel tab and starts an ephemeral container tunnel", async () => {
    const props = createProps({
      ...createTab(),
      activePanel: "tunnel",
    });

    render(<ContainersWorkspace {...props} host={createHost()} />);

    expect(screen.getByRole("tab", { name: "Tunnel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Tunnel" })).toHaveClass(
      "bg-[var(--selection-tint)]",
    );
    expect(screen.getByLabelText("Network")).toHaveValue("bridge");
    expect(screen.getByLabelText("Port")).toHaveValue("1883");
    expect(screen.getByRole("button", { name: "Start tunnel" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Start tunnel" }));

    await waitFor(() => {
      expect(containersApi.startTunnel).toHaveBeenCalledWith({
        hostId: "host-1",
        containerId: "container-1",
        networkName: "bridge",
        targetPort: 1883,
        bindAddress: "127.0.0.1",
        bindPort: 0,
      });
    });
  });

  it("restores the persisted ephemeral tunnel runtime for the selected container", () => {
    const props = createProps({
      ...createTab(),
      activePanel: "tunnel",
      containerTunnelStatesByContainerId: {
        "container-1": {
          containerId: "container-1",
          containerName: "emqx",
          networkName: "bridge",
          targetPort: "1883",
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
            startedAt: "2025-01-01T00:00:05.000Z",
            mode: "local",
            method: "ssh-native",
          },
        },
      },
    });

    render(
      <ContainersWorkspace
        {...props}
        host={createHost()}
      />,
    );

    expect(screen.getByText("터널 상태")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:43110")).toBeInTheDocument();
    expect(screen.getByText("bridge:1883")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Stop" }).length).toBeGreaterThan(0);
    expect(props.onSetTunnelState).not.toHaveBeenCalled();
  });

  it("isolates tunnel render errors behind an inline fallback", () => {
    function ThrowingTunnelPanel(): ReactElement {
      throw new Error("boom");
    }

    render(
      <ContainerTunnelErrorBoundary resetKey="test">
        <ThrowingTunnelPanel />
      </ContainerTunnelErrorBoundary>,
    );

    expect(
      screen.getByText("컨테이너 Tunnel을 표시하지 못했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
