import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  ContainersWorkspace,
  formatContainerLogTimestamp,
  getContainerStatusPresentation,
  parseAnsiStyledSegments,
  parseContainerLogLine,
  shortenContainerImage,
  stripAnsiControlSequences,
} from "./ContainersWorkspace";

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
      ports: [],
      mounts: [],
      networks: [],
      environment: [],
      labels: [],
    },
    detailsLoading: false,
    logs: null,
    logsState: "idle",
    logsLoading: false,
    logsTailWindow: 200,
    logsFollowEnabled: false,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    pendingAction: null,
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

afterEach(() => {
  vi.useRealTimers();
  uPlotMock.instances.length = 0;
  uPlotMock.ctor.mockClear();
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
    expect(cpuChart.data[0]).toEqual([
      new Date("2025-01-01T00:00:00.000Z").getTime(),
      new Date("2025-01-01T00:00:05.000Z").getTime(),
    ]);
    expect(cpuChart.data[1]).toEqual([12.5, 15]);

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
      screen.getByText("error happened").closest(".containers-workspace__log-row"),
    ).toHaveClass("containers-workspace__log-row--match");

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
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    const followSwitch = screen.getByRole("switch", { name: "Follow" });
    expect(followSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(followSwitch);
    expect(onSetLogsFollow).toHaveBeenCalledWith("host-1", true);
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

    const { container } = render(
      <ContainersWorkspace
        {...createProps(logsTab)}
        host={host}
        onSetLogsFollow={onSetLogsFollow}
      />,
    );

    const logsOutput = container.querySelector(
      ".containers-workspace__logs-output",
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

    const { container, rerender } = render(
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

    const logsOutput = container.querySelector(
      ".containers-workspace__logs-output",
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
    ).toHaveClass("containers-workspace__log-segment--yellow");
    expect(screen.getByText("INFO")).toHaveClass(
      "containers-workspace__log-segment--green",
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
      expect(onRefreshLogs).toHaveBeenCalledWith("host-1");
    });
  });
});
