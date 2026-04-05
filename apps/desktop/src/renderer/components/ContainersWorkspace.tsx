import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getHostBadgeLabel } from "@shared";
import type { HostContainerDetails, HostRecord } from "@shared";
import { cn } from "../lib/cn";
import { formatConnectionProgressStageLabel } from "../lib/connection-progress";
import type {
  ContainerTunnelTabState,
  ContainersWorkspacePanel,
  HostContainersTabState,
  PendingContainersInteractiveAuth,
} from "../store/createAppStore";
import { useContainersWorkspaceController } from "../controllers/useContainersWorkspaceController";
import {
  Button,
  Card,
  EmptyState,
  FieldGroup,
  FilterRow,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  PanelSection,
  SelectField,
  SectionLabel,
  StatusBadge,
  TabButton,
  Tabs,
  ToggleSwitch,
  Toolbar,
} from "../ui";
import {
  UPlotMetricChart,
  type MetricChartSeriesDefinition,
} from "./UPlotMetricChart";
import { TerminalInteractiveAuthOverlay } from "./terminal-workspace/TerminalInteractiveAuthOverlay";

interface ContainersWorkspaceProps {
  host: HostRecord;
  tab: HostContainersTabState;
  isActive: boolean;
  interactiveAuth: PendingContainersInteractiveAuth | null;
  onRefresh: (hostId: string) => Promise<void>;
  onSelectContainer: (
    hostId: string,
    containerId: string | null,
  ) => Promise<void>;
  onSetPanel: (hostId: string, panel: ContainersWorkspacePanel) => void;
  onSetTunnelState: (
    hostId: string,
    containerId: string,
    state: ContainerTunnelTabState | null,
  ) => void;
  onRefreshLogs: (
    hostId: string,
    options?: { tail?: number; followCursor?: string | null },
  ) => Promise<void>;
  onLoadMoreLogs: (hostId: string) => Promise<void>;
  onSetLogsFollow: (hostId: string, enabled: boolean) => void;
  onSetLogsSearchQuery: (hostId: string, query: string) => void;
  onSearchLogs: (hostId: string) => Promise<void>;
  onClearLogsSearch: (hostId: string) => void;
  onRefreshMetrics: (hostId: string) => Promise<void>;
  onRunAction: (
    hostId: string,
    action: "start" | "stop" | "restart" | "remove",
  ) => Promise<void>;
  onOpenShell: (hostId: string, containerId: string) => Promise<void>;
  onRespondInteractiveAuth: (
    challengeId: string,
    responses: string[],
  ) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void>;
  onClearInteractiveAuth: () => void;
}

type ContainerStatusTone = "running" | "starting" | "paused" | "stopped";

interface ContainerStatusPresentation {
  label: string;
  tone: ContainerStatusTone;
  uptime: string | null;
}

interface DerivedContainerMetricsPoint {
  recordedAtMs: number;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  networkRxRate: number;
  networkTxRate: number;
  blockReadRate: number;
  blockWriteRate: number;
}

interface ParsedContainerLogLine {
  raw: string;
  message: string;
  timestampRaw: string | null;
  timestampLabel: string | null;
}

type AnsiForegroundTone =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

interface AnsiStyledSegment {
  text: string;
  foreground: AnsiForegroundTone | null;
  bold: boolean;
}

const containerLogTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?:\s(.*))?$/;
const ansiControlSequencePattern =
  // Strip common ANSI CSI/OSC escape sequences from container log display text.
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g;
const ansiSgrPattern = /\u001B\[([0-9;]*)m/g;

const ansiForegroundCodeMap = new Map<number, AnsiForegroundTone>([
  [30, "black"],
  [31, "red"],
  [32, "green"],
  [33, "yellow"],
  [34, "blue"],
  [35, "magenta"],
  [36, "cyan"],
  [37, "white"],
  [90, "brightBlack"],
  [91, "brightRed"],
  [92, "brightGreen"],
  [93, "brightYellow"],
  [94, "brightBlue"],
  [95, "brightMagenta"],
  [96, "brightCyan"],
  [97, "brightWhite"],
]);

const ansiToneClasses: Record<AnsiForegroundTone, string> = {
  black: "text-[var(--ansi-black)]",
  red: "text-[var(--ansi-red)]",
  green: "text-[var(--ansi-green)]",
  yellow: "text-[var(--ansi-yellow)]",
  blue: "text-[var(--ansi-blue)]",
  magenta: "text-[var(--ansi-magenta)]",
  cyan: "text-[var(--ansi-cyan)]",
  white: "text-[var(--ansi-white)]",
  brightBlack: "text-[var(--ansi-bright-black)]",
  brightRed: "text-[var(--ansi-bright-red)]",
  brightGreen: "text-[var(--ansi-bright-green)]",
  brightYellow: "text-[var(--ansi-bright-yellow)]",
  brightBlue: "text-[var(--ansi-bright-blue)]",
  brightMagenta: "text-[var(--ansi-bright-magenta)]",
  brightCyan: "text-[var(--ansi-bright-cyan)]",
  brightWhite: "text-[var(--ansi-bright-white)]",
};

const detailCardClass =
  "grid gap-[0.8rem] rounded-[20px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[1rem] py-[1rem]";
const summaryGridClass =
  "grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[0.8rem]";
const summaryCardClass =
  "grid min-w-0 gap-[0.35rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[1rem] py-[0.95rem]";
const emptyDetailClass =
  "rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_82%,transparent_18%)] px-4 py-4 text-[var(--text-soft)]";
const logsOutputClass =
  "grid min-h-0 flex-1 content-start gap-[0.35rem] overflow-auto rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[rgba(7,13,24,0.88)] px-[1.05rem] py-4 text-[rgba(226,234,255,0.92)]";

function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("ko-KR");
}

function formatKeyValuePairs(
  pairs: Array<{ key: string; value: string }>,
  emptyMessage: string,
) {
  if (pairs.length === 0) {
    return <div className={emptyDetailClass}>{emptyMessage}</div>;
  }

  return (
    <div className="grid gap-3">
      {pairs.map((pair) => (
        <div
          key={`${pair.key}:${pair.value}`}
          className="grid gap-[0.3rem] rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.8rem]"
        >
          <dt className="text-[0.82rem] text-[var(--text-soft)]">{pair.key}</dt>
          <dd className="m-0 break-words whitespace-pre-wrap">
            {pair.value || "-"}
          </dd>
        </div>
      ))}
    </div>
  );
}

export function shortenContainerImage(image: string): string {
  const trimmed = image.trim();
  if (!trimmed) {
    return "-";
  }

  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1) ?? trimmed;
}

function titleCase(value: string): string {
  if (!value) {
    return value;
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function formatContainerLogTimestamp(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function stripAnsiControlSequences(value: string): string {
  return value.replace(ansiControlSequencePattern, "");
}

export function parseAnsiStyledSegments(value: string): AnsiStyledSegment[] {
  if (!value) {
    return [];
  }

  const segments: AnsiStyledSegment[] = [];
  let foreground: AnsiForegroundTone | null = null;
  let bold = false;
  let lastIndex = 0;

  function pushText(text: string) {
    const cleaned = stripAnsiControlSequences(text);
    if (!cleaned) {
      return;
    }
    segments.push({
      text: cleaned,
      foreground,
      bold,
    });
  }

  for (const match of value.matchAll(ansiSgrPattern)) {
    const matchIndex = match.index ?? 0;
    pushText(value.slice(lastIndex, matchIndex));
    lastIndex = matchIndex + match[0].length;

    const codes =
      match[1]?.length
        ? match[1]
            .split(";")
            .map((part) => Number.parseInt(part, 10))
            .filter((code) => Number.isFinite(code))
        : [0];

    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) {
        foreground = null;
        bold = false;
        continue;
      }
      if (code === 1) {
        bold = true;
        continue;
      }
      if (code === 22) {
        bold = false;
        continue;
      }
      if (code === 39) {
        foreground = null;
        continue;
      }
      const mappedForeground = ansiForegroundCodeMap.get(code);
      if (mappedForeground) {
        foreground = mappedForeground;
        continue;
      }
      if (code === 38 || code === 48) {
        const mode = codes[index + 1];
        if (mode === 5) {
          index += 2;
        } else if (mode === 2) {
          index += 4;
        }
      }
    }
  }

  pushText(value.slice(lastIndex));

  return segments;
}

export function parseContainerLogLine(line: string): ParsedContainerLogLine {
  const match = line.match(containerLogTimestampPattern);
  if (!match) {
    return {
      raw: line,
      message: line,
      timestampRaw: null,
      timestampLabel: null,
    };
  }

  const timestampRaw = match[1];
  const timestampLabel = formatContainerLogTimestamp(timestampRaw);
  if (!timestampLabel) {
    return {
      raw: line,
      message: line,
      timestampRaw: null,
      timestampLabel: null,
    };
  }

  return {
    raw: line,
    message: match[2] ?? "",
    timestampRaw,
    timestampLabel,
  };
}

function renderAnsiStyledMessage(value: string) {
  const segments = parseAnsiStyledSegments(value);
  if (segments.length === 0) {
    return stripAnsiControlSequences(value) || "\u00A0";
  }

  return segments.map((segment, index) => {
    return (
      <span
        key={`${index}:${segment.text}:${segment.foreground ?? "plain"}:${segment.bold ? "bold" : "normal"}`}
        className={cn(
          segment.bold ? "font-bold" : "",
          segment.foreground ? ansiToneClasses[segment.foreground] : "",
        )}
        data-ansi-tone={segment.foreground ?? undefined}
        data-ansi-bold={segment.bold ? "true" : undefined}
      >
        {segment.text}
      </span>
    );
  });
}

export function getContainerStatusPresentation(
  rawStatus: string,
): ContainerStatusPresentation {
  const normalized = rawStatus.trim();
  const lowered = normalized.toLowerCase();

  if (lowered.startsWith("up ")) {
    return {
      label: "Running",
      tone: "running",
      uptime: normalized.slice(3).trim() || null,
    };
  }

  if (lowered.includes("restarting")) {
    return {
      label: "Restarting",
      tone: "starting",
      uptime: null,
    };
  }

  if (lowered.includes("paused")) {
    return {
      label: "Paused",
      tone: "paused",
      uptime: null,
    };
  }

  if (
    lowered.includes("exited") ||
    lowered.includes("stopped") ||
    lowered.includes("dead")
  ) {
    return {
      label: "Stopped",
      tone: "stopped",
      uptime: null,
    };
  }

  if (lowered.includes("created")) {
    return {
      label: "Created",
      tone: "stopped",
      uptime: null,
    };
  }

  return {
    label: titleCase(normalized || "Unknown"),
    tone: "stopped",
    uptime: null,
  };
}

function canStartContainer(rawStatus: string): boolean {
  const lowered = rawStatus.trim().toLowerCase();
  return (
    lowered === "exited" ||
    lowered === "stopped" ||
    lowered === "dead" ||
    lowered === "created" ||
    lowered.includes("exited") ||
    lowered.includes("stopped") ||
    lowered.includes("dead") ||
    lowered.includes("created")
  );
}

function canStopContainer(rawStatus: string): boolean {
  const lowered = rawStatus.trim().toLowerCase();
  return (
    lowered === "running" ||
    lowered === "paused" ||
    lowered === "restarting" ||
    lowered.startsWith("up ") ||
    lowered.includes("restarting") ||
    lowered.includes("paused")
  );
}

function canRestartContainer(rawStatus: string): boolean {
  return canStopContainer(rawStatus);
}

function canRemoveContainer(rawStatus: string): boolean {
  return !canStopContainer(rawStatus);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatBytesPerSecond(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function deriveContainerMetricsPoints(
  samples: HostContainersTabState["metricsSamples"],
): DerivedContainerMetricsPoint[] {
  return samples.map((sample, index) => {
    const previous = index > 0 ? samples[index - 1] : null;
    const deltaSeconds = previous
      ? Math.max(
          (new Date(sample.recordedAt).getTime() -
            new Date(previous.recordedAt).getTime()) /
            1000,
          1,
        )
      : 1;
    return {
      recordedAtMs: new Date(sample.recordedAt).getTime(),
      cpuPercent: sample.cpuPercent,
      memoryPercent: sample.memoryPercent,
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryLimitBytes: sample.memoryLimitBytes,
      networkRxRate: previous
        ? Math.max(sample.networkRxBytes - previous.networkRxBytes, 0) /
          deltaSeconds
        : 0,
      networkTxRate: previous
        ? Math.max(sample.networkTxBytes - previous.networkTxBytes, 0) /
          deltaSeconds
        : 0,
      blockReadRate: previous
        ? Math.max(sample.blockReadBytes - previous.blockReadBytes, 0) /
          deltaSeconds
        : 0,
      blockWriteRate: previous
        ? Math.max(sample.blockWriteBytes - previous.blockWriteBytes, 0) /
          deltaSeconds
        : 0,
    };
  });
}

function resolveCpuMetricChartRange(
  cpuValues: number[],
): readonly [number, number] {
  const validValues = cpuValues.filter((value) => Number.isFinite(value));
  if (validValues.length === 0) {
    return [0, 100];
  }

  const maxCpu = Math.max(0, ...validValues);
  const paddedUpperBound = Math.ceil((maxCpu * 1.05) / 10) * 10;
  return [0, Math.max(100, paddedUpperBound)];
}

function matchesContainerLogQuery(line: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return line.toLowerCase().includes(normalizedQuery);
}

function createEmptyContainerTunnelState(): ContainerTunnelTabState {
  return {
    containerId: "",
    containerName: "",
    networkName: "",
    targetPort: "",
    bindPort: "0",
    autoLocalPort: true,
    loading: false,
    error: null,
    runtime: null,
  };
}

function arePortForwardRuntimeRecordsEqual(
  left: ContainerTunnelTabState["runtime"],
  right: ContainerTunnelTabState["runtime"],
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.ruleId === right.ruleId &&
    left.hostId === right.hostId &&
    left.transport === right.transport &&
    left.bindAddress === right.bindAddress &&
    left.bindPort === right.bindPort &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.startedAt === right.startedAt &&
    left.mode === right.mode &&
    left.method === right.method &&
    left.message === right.message
  );
}

function areContainerTunnelTabStatesEqual(
  left: ContainerTunnelTabState | null | undefined,
  right: ContainerTunnelTabState | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.containerId === right.containerId &&
    left.containerName === right.containerName &&
    left.networkName === right.networkName &&
    left.targetPort === right.targetPort &&
    left.bindPort === right.bindPort &&
    left.autoLocalPort === right.autoLocalPort &&
    left.loading === right.loading &&
    left.error === right.error &&
    arePortForwardRuntimeRecordsEqual(left.runtime, right.runtime)
  );
}

function getTunnelEligibleNetworks(details: HostContainerDetails | null) {
  const networks = Array.isArray(details?.networks) ? details.networks : [];
  return networks.filter((network) => Boolean(network.ipAddress?.trim()));
}

function getTunnelEligiblePorts(details: HostContainerDetails | null) {
  const ports = Array.isArray(details?.ports) ? details.ports : [];
  return ports.filter(
    (port) => port.protocol === "tcp" && port.containerPort > 0,
  );
}

function resolveDefaultTunnelNetworkName(
  details: HostContainerDetails | null,
  currentValue: string,
): string {
  const eligibleNetworks = getTunnelEligibleNetworks(details);
  if (eligibleNetworks.length === 0) {
    return "";
  }
  if (eligibleNetworks.some((network) => network.name === currentValue)) {
    return currentValue;
  }
  return eligibleNetworks[0]?.name ?? "";
}

function resolveDefaultTunnelTargetPort(
  details: HostContainerDetails | null,
  currentValue: string,
): string {
  const eligiblePorts = getTunnelEligiblePorts(details);
  if (eligiblePorts.length === 0) {
    return "";
  }
  if (
    eligiblePorts.some((port) => String(port.containerPort) === currentValue)
  ) {
    return currentValue;
  }
  return eligiblePorts[0] ? String(eligiblePorts[0].containerPort) : "";
}

function buildDefaultContainerTunnelState(
  containerId: string,
  containerName: string,
  details: HostContainerDetails | null,
): ContainerTunnelTabState {
  return {
    ...createEmptyContainerTunnelState(),
    containerId,
    containerName,
    networkName: resolveDefaultTunnelNetworkName(details, ""),
    targetPort: resolveDefaultTunnelTargetPort(details, ""),
  };
}

function hydrateContainerTunnelState(
  containerId: string,
  containerName: string,
  details: HostContainerDetails | null,
  tunnelState: ContainerTunnelTabState | null | undefined,
): ContainerTunnelTabState {
  if (!tunnelState) {
    return buildDefaultContainerTunnelState(containerId, containerName, details);
  }

  return {
    ...tunnelState,
    containerId,
    containerName,
    networkName: details
      ? resolveDefaultTunnelNetworkName(details, tunnelState.networkName)
      : tunnelState.networkName,
    targetPort: details
      ? resolveDefaultTunnelTargetPort(details, tunnelState.targetPort)
      : tunnelState.targetPort,
    loading: false,
    error: null,
  };
}

function normalizePersistedContainerTunnelState(
  tunnelState: ContainerTunnelTabState,
): ContainerTunnelTabState | null {
  const nextState: ContainerTunnelTabState = {
    ...tunnelState,
    loading: false,
    error: null,
  };
  const shouldClear =
    !nextState.runtime &&
    !nextState.networkName &&
    !nextState.targetPort &&
    nextState.autoLocalPort &&
    (nextState.bindPort === "" || nextState.bindPort === "0");
  return shouldClear ? null : nextState;
}

export class ContainerTunnelErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Failed to render container tunnel panel.", error, info);
  }

  componentDidUpdate(prevProps: Readonly<{ resetKey: string }>) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <NoticeCard tone="danger" title="컨테이너 Tunnel을 표시하지 못했습니다.">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              this.setState({ hasError: false });
            }}
          >
            다시 시도
          </Button>
        </NoticeCard>
      );
    }
    return this.props.children;
  }
}

interface ContainerTunnelPanelProps {
  selectedContainer: HostContainersTabState["items"][number] | null;
  selectedContainerDetails: HostContainerDetails | null;
  detailsLoading: boolean;
  tunnelState: ContainerTunnelTabState;
  onUpdateTunnelState: (
    updater: (previous: ContainerTunnelTabState) => ContainerTunnelTabState,
  ) => void;
  onStartTunnel: () => void;
  onStopTunnel: () => void;
}

function ContainerTunnelPanel({
  selectedContainer,
  selectedContainerDetails,
  detailsLoading,
  tunnelState,
  onUpdateTunnelState,
  onStartTunnel,
  onStopTunnel,
}: ContainerTunnelPanelProps) {
  const tunnelNetworks = useMemo(
    () => getTunnelEligibleNetworks(selectedContainerDetails),
    [selectedContainerDetails],
  );
  const tunnelPorts = useMemo(
    () => getTunnelEligiblePorts(selectedContainerDetails),
    [selectedContainerDetails],
  );
  const isSelectedContainerRunning =
    selectedContainerDetails?.status.trim().toLowerCase() === "running";
  const canStartTunnel =
    !!selectedContainer &&
    !!selectedContainerDetails &&
    isSelectedContainerRunning &&
    !tunnelState.runtime &&
    !tunnelState.loading &&
    !!tunnelState.networkName &&
    !!tunnelState.targetPort &&
    (tunnelState.autoLocalPort ||
      (!!tunnelState.bindPort && Number(tunnelState.bindPort) > 0));
  const isTunnelFormDisabled =
    !selectedContainer ||
    !selectedContainerDetails ||
    detailsLoading ||
    tunnelState.loading ||
    !!tunnelState.runtime;
  const tunnelRuntimeLocalEndpoint = tunnelState.runtime
    ? `${tunnelState.runtime.bindAddress}:${tunnelState.runtime.bindPort || "auto"}`
    : null;
  const tunnelRuntimeRemoteEndpoint =
    tunnelState.networkName && tunnelState.targetPort
      ? `${tunnelState.networkName}:${tunnelState.targetPort}`
      : null;

  if (!selectedContainer) {
    return (
      <EmptyState
        title="컨테이너를 선택하면 터널을 열 수 있습니다."
        description="실행 중인 컨테이너를 선택한 뒤 네트워크와 포트를 고르세요."
      />
    );
  }

  if (detailsLoading && !selectedContainerDetails) {
    return (
      <div className={emptyDetailClass}>터널 정보를 준비하는 중입니다...</div>
    );
  }

  return (
    <PanelSection className="min-h-0 overflow-y-auto pr-px">
      <div className="grid gap-[0.8rem] md:grid-cols-2">
        <FieldGroup label="Network">
          <SelectField
            value={tunnelState.networkName}
            disabled={isTunnelFormDisabled}
            onChange={(event) => {
              onUpdateTunnelState((previous) => ({
                ...previous,
                networkName: event.target.value,
              }));
            }}
          >
            {tunnelNetworks.length === 0 ? (
              <option value="">선택 가능한 네트워크 없음</option>
            ) : null}
            {tunnelNetworks.map((network) => (
              <option key={network.name} value={network.name}>
                {network.name}
              </option>
            ))}
          </SelectField>
        </FieldGroup>
        <FieldGroup label="Port">
          <SelectField
            value={tunnelState.targetPort}
            disabled={isTunnelFormDisabled || tunnelPorts.length === 0}
            onChange={(event) => {
              onUpdateTunnelState((previous) => ({
                ...previous,
                targetPort: event.target.value,
              }));
            }}
          >
            {tunnelPorts.length === 0 ? (
              <option value="">포트 없음</option>
            ) : null}
            {tunnelPorts.map((port) => (
              <option
                key={`${port.containerPort}/${port.protocol}`}
                value={String(port.containerPort)}
              >
                {port.containerPort}/{port.protocol}
              </option>
            ))}
          </SelectField>
        </FieldGroup>
        <FieldGroup label="Local port" className="md:col-span-2">
          <div className="grid gap-3">
            <ToggleSwitch
              checked={tunnelState.autoLocalPort}
              aria-label="Auto (random)"
              label="Auto (random)"
              description="사용 가능한 로컬 포트를 자동으로 할당합니다."
              disabled={isTunnelFormDisabled}
              onClick={() => {
                onUpdateTunnelState((previous) => ({
                  ...previous,
                  autoLocalPort: !previous.autoLocalPort,
                  bindPort: previous.autoLocalPort
                    ? previous.bindPort || "9000"
                    : "0",
                }));
              }}
            />
            <Input
              type="number"
              className="min-h-[2.35rem] rounded-[12px] bg-[var(--surface)] px-[0.7rem] py-[0.45rem]"
              value={tunnelState.bindPort}
              placeholder="0"
              disabled={isTunnelFormDisabled || tunnelState.autoLocalPort}
              onChange={(event) => {
                onUpdateTunnelState((previous) => ({
                  ...previous,
                  bindPort: event.target.value,
                }));
              }}
            />
          </div>
        </FieldGroup>
      </div>

      {tunnelState.runtime ? (
        <div className="grid gap-[0.85rem] rounded-[18px] border border-[color-mix(in_srgb,var(--accent-strong)_20%,var(--border)_80%)] bg-[color-mix(in_srgb,var(--accent-strong)_8%,var(--surface)_92%)] px-4 py-[0.9rem] shadow-[var(--shadow)]">
          <div className="flex items-center justify-between gap-3">
            <strong>터널 상태</strong>
            <StatusBadge tone={tunnelState.runtime.status === "running" ? "running" : "stopped"}>
              {tunnelState.runtime.status === "running"
                ? "Running"
                : tunnelState.runtime.status}
            </StatusBadge>
          </div>
          <div className="grid gap-[0.9rem] md:grid-cols-2">
            <div className="grid gap-[0.22rem]">
              <span className="text-[0.76rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]">
                Local
              </span>
              <strong className="break-words text-[1rem] leading-[1.35]">
                {tunnelRuntimeLocalEndpoint}
              </strong>
            </div>
            <div className="grid gap-[0.22rem]">
              <span className="text-[0.76rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]">
                Remote
              </span>
              <strong className="break-words text-[1rem] leading-[1.35]">
                {tunnelRuntimeRemoteEndpoint}
              </strong>
            </div>
          </div>
        </div>
      ) : null}

      {tunnelState.error ? (
        <NoticeCard tone="danger" role="alert">
          {tunnelState.error}
        </NoticeCard>
      ) : null}

      <div className="flex justify-end gap-[0.6rem]">
        {tunnelState.runtime ? (
          <Button type="button" variant="secondary" disabled={tunnelState.loading} onClick={onStopTunnel}>
            {tunnelState.loading ? "정지 중..." : "Stop"}
          </Button>
        ) : (
          <Button type="button" variant="primary" disabled={!canStartTunnel} onClick={onStartTunnel}>
            {tunnelState.loading ? "시작 중..." : "Start tunnel"}
          </Button>
        )}
      </div>
    </PanelSection>
  );
}

function OverviewSection({
  details,
  statusSummary,
}: {
  details: HostContainerDetails | null;
  statusSummary?: string | null;
}) {
  if (!details) {
    return (
      <EmptyState
        title="컨테이너를 선택하면 상세 정보를 볼 수 있습니다."
        description="목록에서 컨테이너를 선택하면 실행 정보와 메타데이터를 보여줍니다."
      />
    );
  }

  const statusPresentation = getContainerStatusPresentation(
    statusSummary || details.status,
  );
  const shortImage = shortenContainerImage(details.image);

  return (
    <PanelSection className="min-h-0 overflow-y-auto pr-px">
      <div className={summaryGridClass} data-testid="containers-overview-summary-grid">
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">ID</span>
          <strong
            title={details.id}
            data-testid="containers-overview-summary-id"
            className="min-w-0 leading-[1.35] [overflow-wrap:anywhere]"
          >
            {details.id}
          </strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">이미지</span>
          <strong
            title={details.image}
            data-testid="containers-overview-summary-image"
            className="min-w-0 leading-[1.35] [overflow-wrap:anywhere]"
          >
            {shortImage}
          </strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">상태</span>
          <strong className="min-w-0 leading-[1.35]">{details.status}</strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">Uptime</span>
          <strong className="min-w-0 leading-[1.35]">
            {statusPresentation.uptime || "-"}
          </strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">생성 시간</span>
          <strong className="min-w-0 leading-[1.35] [overflow-wrap:anywhere]">
            {formatCreatedAt(details.createdAt)}
          </strong>
        </div>
      </div>

      <div className={detailCardClass}>
        <div className="flex items-center justify-between gap-3">
          <h3>실행 정보</h3>
        </div>
        <dl className="grid gap-[0.85rem]">
          <div className="grid gap-[0.3rem]">
            <dt className="text-[0.82rem] text-[var(--text-soft)]">Entrypoint</dt>
            <dd className="m-0 break-words whitespace-pre-wrap">{details.entrypoint || "-"}</dd>
          </div>
          <div className="grid gap-[0.3rem]">
            <dt className="text-[0.82rem] text-[var(--text-soft)]">Command</dt>
            <dd className="m-0 break-words whitespace-pre-wrap">{details.command || "-"}</dd>
          </div>
        </dl>
      </div>

      <div className={detailCardClass}>
        <div className="flex items-center justify-between gap-3">
          <h3>마운트</h3>
        </div>
        {details.mounts.length === 0 ? (
          <div className={emptyDetailClass}>마운트 정보가 없습니다.</div>
        ) : (
          <div className="grid gap-[0.7rem]">
            {details.mounts.map((mount) => (
              <div
                key={`${mount.source}:${mount.destination}`}
                className="grid gap-[0.2rem] rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.85rem]"
              >
                <strong className="break-words">{mount.destination}</strong>
                <span className="text-[var(--text-soft)]">{mount.source}</span>
                <small className="text-[var(--text-soft)]">
                  {mount.type}
                  {mount.mode ? ` · ${mount.mode}` : ""}
                  {mount.readOnly ? " · read-only" : ""}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={detailCardClass}>
        <div className="flex items-center justify-between gap-3">
          <h3>네트워크</h3>
        </div>
        {details.networks.length === 0 ? (
          <div className={emptyDetailClass}>네트워크 정보가 없습니다.</div>
        ) : (
          <div className="grid gap-[0.7rem]">
            {details.networks.map((network) => (
              <div
                key={network.name}
                className="grid gap-[0.2rem] rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_72%,transparent_28%)] px-[0.9rem] py-[0.85rem]"
              >
                <strong className="break-words">{network.name}</strong>
                <span className="text-[var(--text-soft)]">{network.ipAddress || "IP 없음"}</span>
                {network.aliases.length > 0 ? (
                  <small className="text-[var(--text-soft)]">{network.aliases.join(", ")}</small>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={detailCardClass}>
        <div className="flex items-center justify-between gap-3">
          <h3>환경 변수</h3>
        </div>
        {formatKeyValuePairs(details.environment, "환경 변수가 없습니다.")}
      </div>

      <div className={detailCardClass}>
        <div className="flex items-center justify-between gap-3">
          <h3>라벨</h3>
        </div>
        {formatKeyValuePairs(details.labels, "라벨이 없습니다.")}
      </div>
    </PanelSection>
  );
}

function MetricsSection({ tab }: { tab: HostContainersTabState }) {
  const points = useMemo(
    () => deriveContainerMetricsPoints(tab.metricsSamples),
    [tab.metricsSamples],
  );
  const latest = points.at(-1) ?? null;
  const timestamps = useMemo(
    () => points.map((point) => point.recordedAtMs),
    [points],
  );
  const cpuSeries = useMemo<MetricChartSeriesDefinition[]>(
    () => [
      {
        label: "CPU",
        values: points.map((point) => point.cpuPercent),
        tone: "primary",
        format: "percent",
      },
    ],
    [points],
  );
  const cpuChartRange = useMemo(
    () => resolveCpuMetricChartRange(points.map((point) => point.cpuPercent)),
    [points],
  );
  const memorySeries = useMemo<MetricChartSeriesDefinition[]>(
    () => [
      {
        label: "Memory",
        values: points.map((point) => point.memoryPercent),
        tone: "primary",
        format: "percent",
      },
    ],
    [points],
  );
  const networkSeries = useMemo<MetricChartSeriesDefinition[]>(
    () => [
      {
        label: "Rx",
        values: points.map((point) => point.networkRxRate),
        tone: "primary",
        format: "bytesPerSecond",
      },
      {
        label: "Tx",
        values: points.map((point) => point.networkTxRate),
        tone: "secondary",
        format: "bytesPerSecond",
      },
    ],
    [points],
  );
  const blockSeries = useMemo<MetricChartSeriesDefinition[]>(
    () => [
      {
        label: "Read",
        values: points.map((point) => point.blockReadRate),
        tone: "primary",
        format: "bytesPerSecond",
      },
      {
        label: "Write",
        values: points.map((point) => point.blockWriteRate),
        tone: "secondary",
        format: "bytesPerSecond",
      },
    ],
    [points],
  );

  if (tab.metricsError && points.length === 0) {
    return (
      <NoticeCard tone="danger" role="alert">
        {tab.metricsError}
      </NoticeCard>
    );
  }

  if (tab.metricsLoading && points.length === 0) {
    return (
      <div className={emptyDetailClass}>메트릭을 불러오는 중입니다...</div>
    );
  }

  if (!latest) {
    return (
      <EmptyState
        title="표시할 메트릭이 없습니다."
        description="컨테이너가 실행 중인지 확인한 뒤 잠시 후 다시 새로고침해 주세요."
      />
    );
  }

  return (
    <PanelSection className="min-h-0 overflow-y-auto pr-px">
      {tab.metricsError ? (
        <NoticeCard tone="danger" role="alert">
          {tab.metricsError}
        </NoticeCard>
      ) : null}
      <div className={summaryGridClass}>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">CPU</span>
          <strong>{formatPercentValue(latest.cpuPercent)}</strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">Memory</span>
          <strong>
            {formatBytes(latest.memoryUsedBytes)} /{" "}
            {formatBytes(latest.memoryLimitBytes)}
          </strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">Network</span>
          <strong>
            {formatBytesPerSecond(latest.networkRxRate)} /{" "}
            {formatBytesPerSecond(latest.networkTxRate)}
          </strong>
        </div>
        <div className={summaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">Block I/O</span>
          <strong>
            {formatBytesPerSecond(latest.blockReadRate)} /{" "}
            {formatBytesPerSecond(latest.blockWriteRate)}
          </strong>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-[0.85rem]">
        <UPlotMetricChart
          title="CPU"
          currentLabel={formatPercentValue(latest.cpuPercent)}
          timestamps={timestamps}
          series={cpuSeries}
          yFormat="percent"
          fixedRange={cpuChartRange}
        />
        <UPlotMetricChart
          title="Memory"
          currentLabel={formatPercentValue(latest.memoryPercent)}
          timestamps={timestamps}
          series={memorySeries}
          yFormat="percent"
          fixedRange={[0, 100]}
        />
        <UPlotMetricChart
          title="Network I/O"
          currentLabel={`${formatBytesPerSecond(latest.networkRxRate)} / ${formatBytesPerSecond(latest.networkTxRate)}`}
          timestamps={timestamps}
          series={networkSeries}
          yFormat="bytesPerSecond"
        />
        <UPlotMetricChart
          title="Block I/O"
          currentLabel={`${formatBytesPerSecond(latest.blockReadRate)} / ${formatBytesPerSecond(latest.blockWriteRate)}`}
          timestamps={timestamps}
          series={blockSeries}
          yFormat="bytesPerSecond"
        />
      </div>
    </PanelSection>
  );
}

export function ContainersWorkspace({
  host,
  tab,
  isActive,
  interactiveAuth,
  onRefresh,
  onSelectContainer,
  onSetPanel,
  onSetTunnelState,
  onRefreshLogs,
  onLoadMoreLogs,
  onSetLogsFollow,
  onSetLogsSearchQuery,
  onSearchLogs,
  onClearLogsSearch,
  onRefreshMetrics,
  onRunAction,
  onOpenShell,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearInteractiveAuth,
}: ContainersWorkspaceProps) {
  const { startContainerTunnel, stopContainerTunnel } =
    useContainersWorkspaceController();
  const [promptResponses, setPromptResponses] = useState<string[]>([]);
  const [pendingConfirmAction, setPendingConfirmAction] = useState<
    "start" | "stop" | "restart" | "remove" | null
  >(null);
  const [tunnelState, setTunnelState] = useState<ContainerTunnelTabState>(
    createEmptyContainerTunnelState,
  );
  const tunnelStateRef = useRef<ContainerTunnelTabState>(
    createEmptyContainerTunnelState(),
  );
  const logsOutputRef = useRef<HTMLDivElement | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);
  const previousPanelRef = useRef<ContainersWorkspacePanel>(tab.activePanel);
  const previousLogsContainerIdRef = useRef<string | null>(
    tab.selectedContainerId,
  );
  const hasInitializedLogsViewRef = useRef(false);
  const suppressFollowScrollRef = useRef(false);
  const releaseFollowScrollFrameRef = useRef<number | null>(null);
  const selectedContainer = useMemo(
    () => tab.items.find((item) => item.id === tab.selectedContainerId) ?? null,
    [tab.items, tab.selectedContainerId],
  );
  const matchingInteractiveAuth =
    interactiveAuth?.hostId === host.id ? interactiveAuth : null;
  const shouldShowConnectingOverlay = tab.isLoading && !matchingInteractiveAuth;
  const selectedContainerDetails =
    tab.details && tab.details.id === tab.selectedContainerId ? tab.details : null;
  const selectedContainerStatusSummary = useMemo(
    () =>
      tab.items.find((item) => item.id === tab.selectedContainerId)?.status ??
      null,
    [tab.items, tab.selectedContainerId],
  );
  const persistedContainerTunnelStates =
    tab.containerTunnelStatesByContainerId ?? {};
  const trimmedLogsSearchQuery = tab.logsSearchQuery.trim();
  const effectiveLogLines = useMemo(() => {
    if (tab.logsSearchMode === "remote") {
      return tab.logsSearchResult?.lines ?? [];
    }
    const lines = tab.logs?.lines ?? [];
    if (!trimmedLogsSearchQuery) {
      return lines;
    }
    return lines.filter((line) =>
      matchesContainerLogQuery(line, trimmedLogsSearchQuery),
    );
  }, [
    tab.logs?.lines,
    tab.logsSearchMode,
    tab.logsSearchResult?.lines,
    trimmedLogsSearchQuery,
  ]);
  const logMatchCount = useMemo(() => {
    if (tab.logsSearchMode === "remote") {
      return tab.logsSearchResult?.matchCount ?? 0;
    }
    if (!trimmedLogsSearchQuery) {
      return 0;
    }
    return effectiveLogLines.length;
  }, [
    effectiveLogLines.length,
    tab.logsSearchMode,
    tab.logsSearchResult?.matchCount,
    trimmedLogsSearchQuery,
  ]);
  const canLoadMoreLogs =
    !!tab.selectedContainerId &&
    !tab.logsLoading &&
    tab.logsTailWindow < 20000 &&
    tab.logsSearchMode !== "remote";
  const canSearchRemoteLogs =
    !!tab.selectedContainerId &&
    !tab.logsSearchLoading &&
    trimmedLogsSearchQuery.length > 0;
  const canStart = selectedContainer
    ? canStartContainer(selectedContainer.status)
    : false;
  const canStop = selectedContainer
    ? canStopContainer(selectedContainer.status)
    : false;
  const canRestart = selectedContainer
    ? canRestartContainer(selectedContainer.status)
    : false;
  const canRemove = selectedContainer
    ? canRemoveContainer(selectedContainer.status)
    : false;
  const persistedTunnelState = selectedContainer
    ? persistedContainerTunnelStates[selectedContainer.id] ?? null
    : null;

  useEffect(() => {
    tunnelStateRef.current = tunnelState;
  }, [tunnelState]);

  useEffect(() => {
    if (!selectedContainer) {
      const emptyState = createEmptyContainerTunnelState();
      setTunnelState((previous) =>
        areContainerTunnelTabStatesEqual(previous, emptyState)
          ? previous
          : emptyState,
      );
      return;
    }

    const nextState = hydrateContainerTunnelState(
      selectedContainer.id,
      selectedContainer.name,
      selectedContainerDetails,
      persistedTunnelState,
    );
    setTunnelState((previous) =>
      areContainerTunnelTabStatesEqual(previous, nextState)
        ? previous
        : nextState,
    );
  }, [
    selectedContainer,
    selectedContainerDetails,
    persistedTunnelState,
  ]);

  const persistTunnelState = useCallback(
    (
      container: NonNullable<typeof selectedContainer>,
      nextState: ContainerTunnelTabState,
    ) => {
      if (!onSetTunnelState) {
        return;
      }
      onSetTunnelState(
        host.id,
        container.id,
        normalizePersistedContainerTunnelState({
          ...nextState,
          containerId: container.id,
          containerName: container.name,
        }),
      );
    },
    [host.id, onSetTunnelState],
  );

  const updateTunnelDraft = useCallback(
    (
      updater: (previous: ContainerTunnelTabState) => ContainerTunnelTabState,
    ) => {
      if (!selectedContainer) {
        return;
      }
      const previous =
        tunnelStateRef.current.containerId === selectedContainer.id
          ? tunnelStateRef.current
          : hydrateContainerTunnelState(
              selectedContainer.id,
              selectedContainer.name,
              selectedContainerDetails,
              persistedTunnelState,
            );
      const nextState = updater(previous);
      setTunnelState(nextState);
      persistTunnelState(selectedContainer, nextState);
    },
    [
      persistTunnelState,
      persistedTunnelState,
      selectedContainer,
      selectedContainerDetails,
    ],
  );

  useEffect(() => {
    const enteredLogs =
      previousPanelRef.current !== "logs" && tab.activePanel === "logs";
    previousPanelRef.current = tab.activePanel;

    if (!isActive || tab.activePanel !== "logs" || !tab.selectedContainerId) {
      return;
    }
    if (
      tab.logsLoading ||
      tab.logsState === "ready" ||
      tab.logsState === "error" ||
      tab.logsState === "malformed"
    ) {
      return;
    }
    if (tab.logsState === "empty" && !enteredLogs) {
      return;
    }
    void onRefreshLogs(host.id);
  }, [
    host.id,
    isActive,
    onRefreshLogs,
    tab.activePanel,
    tab.logsLoading,
    tab.logsState,
    tab.selectedContainerId,
  ]);

  useEffect(() => {
    if (
      !isActive ||
      tab.activePanel !== "metrics" ||
      !tab.selectedContainerId ||
      tab.metricsLoading ||
      tab.metricsState === "ready"
    ) {
      return;
    }
    void onRefreshMetrics(host.id);
  }, [
    host.id,
    isActive,
    onRefreshMetrics,
    tab.activePanel,
    tab.metricsLoading,
    tab.metricsState,
    tab.selectedContainerId,
  ]);

  useEffect(() => {
    if (
      !isActive ||
      tab.activePanel !== "metrics" ||
      !tab.selectedContainerId
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      void onRefreshMetrics(host.id);
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [host.id, isActive, onRefreshMetrics, tab.activePanel, tab.selectedContainerId]);

  useEffect(() => {
    if (
      !isActive ||
      tab.activePanel !== "logs" ||
      !tab.selectedContainerId ||
      !tab.logsFollowEnabled
    ) {
      return;
    }
    if (!tab.logs?.cursor) {
      return;
    }

    const interval = window.setInterval(() => {
      void onRefreshLogs(host.id, {
        tail: tab.logsTailWindow,
        followCursor: tab.logs?.cursor ?? null,
      });
    }, 2500);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    host.id,
    isActive,
    onRefreshLogs,
    tab.activePanel,
    tab.logs?.cursor,
    tab.logsFollowEnabled,
    tab.logsTailWindow,
    tab.selectedContainerId,
  ]);

  useEffect(() => {
    setPromptResponses(
      matchingInteractiveAuth
        ? new Array(matchingInteractiveAuth.prompts.length).fill("")
        : [],
    );
  }, [
    matchingInteractiveAuth?.challengeId,
    matchingInteractiveAuth?.prompts.length,
  ]);

  useEffect(() => {
    return () => {
      if (releaseFollowScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(releaseFollowScrollFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!isActive || tab.activePanel !== "logs") {
      return;
    }
    const enteredLogs =
      previousPanelRef.current !== "logs" && tab.activePanel === "logs";
    const selectedContainerChanged =
      previousLogsContainerIdRef.current !== tab.selectedContainerId;
    const isInitialLogsRender = !hasInitializedLogsViewRef.current;
    const shouldAutoScroll =
      isInitialLogsRender ||
      enteredLogs ||
      selectedContainerChanged ||
      tab.logsFollowEnabled ||
      tab.logsSearchMode === "remote";
    hasInitializedLogsViewRef.current = true;
    previousLogsContainerIdRef.current = tab.selectedContainerId;
    if (!shouldAutoScroll) {
      return;
    }
    const logNode = logsOutputRef.current;
    if (!logNode) {
      return;
    }
    suppressFollowScrollRef.current = true;
    if (releaseFollowScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(releaseFollowScrollFrameRef.current);
    }
    logNode.scrollTop = logNode.scrollHeight;
    if (typeof logsBottomRef.current?.scrollIntoView === "function") {
      logsBottomRef.current.scrollIntoView({ block: "end" });
    }
    releaseFollowScrollFrameRef.current = window.requestAnimationFrame(() => {
      suppressFollowScrollRef.current = false;
      releaseFollowScrollFrameRef.current = null;
    });
  }, [
    isActive,
    tab.activePanel,
    effectiveLogLines.length,
    tab.logsFollowEnabled,
    tab.logsSearchMode,
  ]);

  function handleLogsScroll() {
    if (!tab.logsFollowEnabled || suppressFollowScrollRef.current) {
      return;
    }
    const logNode = logsOutputRef.current;
    if (!logNode) {
      return;
    }
    const distanceFromBottom =
      logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight;
    if (distanceFromBottom > 24) {
      onSetLogsFollow(host.id, false);
    }
  }

  async function handleStartTunnel() {
    if (!selectedContainer || !selectedContainerDetails) {
      return;
    }
    const currentContainer = selectedContainer;
    const currentDetails = selectedContainerDetails;
    const currentTunnelState =
      tunnelStateRef.current.containerId === currentContainer.id
        ? tunnelStateRef.current
        : hydrateContainerTunnelState(
            currentContainer.id,
            currentContainer.name,
            currentDetails,
            persistedTunnelState,
          );
    const isSelectedContainerRunning =
      currentDetails.status.trim().toLowerCase() === "running";

    if (!isSelectedContainerRunning) {
      setTunnelState((previous) => ({
        ...previous,
        error: "실행 중인 컨테이너에서만 터널을 시작할 수 있습니다.",
      }));
      return;
    }

    const targetPort = Number(currentTunnelState.targetPort);
    const bindPort = currentTunnelState.autoLocalPort
      ? 0
      : Number(currentTunnelState.bindPort);
    if (!currentTunnelState.networkName) {
      setTunnelState((previous) => ({
        ...previous,
        error: "네트워크를 선택해 주세요.",
      }));
      return;
    }
    if (!Number.isFinite(targetPort) || targetPort <= 0) {
      setTunnelState((previous) => ({
        ...previous,
        error: "포트를 선택해 주세요.",
      }));
      return;
    }
    if (!tunnelState.autoLocalPort && (!Number.isFinite(bindPort) || bindPort <= 0)) {
      setTunnelState((previous) => ({
        ...previous,
        error: "로컬 포트를 확인해 주세요.",
      }));
      return;
    }

    setTunnelState((previous) => ({
      ...previous,
      containerId: currentContainer.id,
      containerName: currentContainer.name,
      loading: true,
      error: null,
    }));
    try {
      const runtime = await startContainerTunnel({
        hostId: host.id,
        containerId: currentContainer.id,
        networkName: currentTunnelState.networkName,
        targetPort,
        bindAddress: "127.0.0.1",
        bindPort,
      });
      const nextState = {
        ...currentTunnelState,
        containerId: currentContainer.id,
        containerName: currentContainer.name,
        loading: false,
        runtime,
        error: null,
      };
      persistTunnelState(currentContainer, nextState);
      setTunnelState((previous) =>
        previous.containerId === currentContainer.id ? nextState : previous,
      );
    } catch (error) {
      setTunnelState((previous) =>
        previous.containerId === currentContainer.id
          ? {
              ...previous,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "컨테이너 터널을 시작하지 못했습니다.",
            }
          : previous,
      );
    }
  }

  async function handleStopTunnel() {
    if (!selectedContainer || !tunnelStateRef.current.runtime?.ruleId) {
      return;
    }
    const currentContainer = selectedContainer;
    const currentTunnelState =
      tunnelStateRef.current.containerId === currentContainer.id
        ? tunnelStateRef.current
        : hydrateContainerTunnelState(
            currentContainer.id,
            currentContainer.name,
            selectedContainerDetails,
            persistedTunnelState,
          );
    const runtimeId = currentTunnelState.runtime?.ruleId;
    if (!runtimeId) {
      return;
    }
    setTunnelState((previous) => ({
      ...previous,
      loading: true,
      error: null,
    }));
    try {
      await stopContainerTunnel(runtimeId);
      const nextState = {
        ...currentTunnelState,
        loading: false,
        error: null,
        runtime: null,
      };
      persistTunnelState(currentContainer, nextState);
      setTunnelState((previous) =>
        previous.containerId === currentContainer.id ? nextState : previous,
      );
    } catch (error) {
      setTunnelState((previous) =>
        previous.containerId === currentContainer.id
          ? {
              ...previous,
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "컨테이너 터널을 중지하지 못했습니다.",
            }
          : previous,
      );
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-4">
      <Toolbar className="justify-between gap-4 rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-[1.15rem] py-[1.1rem]">
        <div>
          <SectionLabel>Host Containers</SectionLabel>
          <h2>{host.label}</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-[0.9rem] text-[var(--text-soft)]">
            <span>{getHostBadgeLabel(host)}</span>
            {tab.runtime ? (
              <span>{tab.runtime === "docker" ? "Docker" : "Podman"}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void onRefresh(host.id);
            }}
            disabled={tab.isLoading}
          >
            {tab.isLoading ? "새로고침 중..." : "새로고침"}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              if (!tab.selectedContainerId) {
                return;
              }
              void onOpenShell(host.id, tab.selectedContainerId);
            }}
            disabled={!tab.selectedContainerId}
          >
            셸 접속
          </Button>
        </div>
      </Toolbar>

      {tab.unsupportedReason ? (
        <NoticeCard
          title="이 호스트에서는 컨테이너 런타임을 찾지 못했습니다."
          className="grid h-full content-center gap-2"
        >
          <SectionLabel className="mb-1">Runtime Unavailable</SectionLabel>
          <p>{tab.unsupportedReason}</p>
        </NoticeCard>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-4 rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.15rem]">
            <div className="flex items-center justify-between gap-3">
              <strong>컨테이너</strong>
              <span>{tab.items.length}</span>
            </div>
            {tab.errorMessage ? (
              <NoticeCard tone="danger" role="alert">
                {tab.errorMessage}
              </NoticeCard>
            ) : null}
            <div className="flex min-h-0 flex-col gap-[0.7rem] overflow-y-auto pr-px">
              {tab.items.length === 0 && !tab.isLoading ? (
                <div className={emptyDetailClass}>감지된 컨테이너가 없습니다.</div>
              ) : null}
              {tab.items.map((item) => (
                <ContainerListItem
                  key={item.id}
                  id={item.id}
                  name={item.name}
                  image={item.image}
                  status={item.status}
                  isActive={item.id === tab.selectedContainerId}
                  onSelect={() => {
                    void onSelectContainer(host.id, item.id);
                  }}
                />
              ))}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col gap-4 rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.15rem]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3>{selectedContainer?.name ?? "컨테이너를 선택하세요"}</h3>
                {selectedContainer ? <p>{selectedContainer.image}</p> : null}
              </div>
              <div className="flex flex-col items-start gap-3 self-stretch">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setPendingConfirmAction("start")}
                    disabled={!selectedContainer || !canStart || !!tab.pendingAction}
                  >
                    Start
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setPendingConfirmAction("stop")}
                    disabled={!selectedContainer || !canStop || !!tab.pendingAction}
                  >
                    Stop
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setPendingConfirmAction("restart")}
                    disabled={!selectedContainer || !canRestart || !!tab.pendingAction}
                  >
                    Restart
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setPendingConfirmAction("remove")}
                    disabled={!selectedContainer || !canRemove || !!tab.pendingAction}
                  >
                    Remove
                  </Button>
                </div>
                <Tabs className="gap-2 border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_88%,transparent_12%)] p-1.5">
                  <TabButton type="button" active={tab.activePanel === "overview"} onClick={() => onSetPanel(host.id, "overview")}>
                    Overview
                  </TabButton>
                  <TabButton
                    type="button"
                    active={tab.activePanel === "logs"}
                    onClick={() => onSetPanel(host.id, "logs")}
                    disabled={!tab.selectedContainerId}
                  >
                    Logs
                  </TabButton>
                  <TabButton
                    type="button"
                    active={tab.activePanel === "metrics"}
                    onClick={() => onSetPanel(host.id, "metrics")}
                    disabled={!tab.selectedContainerId}
                  >
                    Metrics
                  </TabButton>
                  <TabButton
                    type="button"
                    active={tab.activePanel === "tunnel"}
                    onClick={() => onSetPanel(host.id, "tunnel")}
                    disabled={!tab.selectedContainerId}
                  >
                    Tunnel
                  </TabButton>
                </Tabs>
              </div>
            </div>
            {tab.actionError ? (
              <NoticeCard tone="danger" role="alert">
                {tab.actionError}
              </NoticeCard>
            ) : null}

            {tab.activePanel === "overview" ? (
              <>
                {tab.detailsError ? (
                  <NoticeCard tone="danger" role="alert">
                    {tab.detailsError}
                  </NoticeCard>
                ) : null}
                {tab.detailsLoading ? (
                  <div className={emptyDetailClass}>상세 정보를 불러오는 중입니다...</div>
                ) : (
                  <OverviewSection
                    details={tab.details}
                    statusSummary={selectedContainerStatusSummary}
                  />
                )}
              </>
            ) : tab.activePanel === "metrics" ? (
              <MetricsSection tab={tab} />
            ) : tab.activePanel === "tunnel" ? (
              <ContainerTunnelErrorBoundary
                resetKey={`${selectedContainer?.id ?? "none"}:${tunnelState.runtime?.ruleId ?? "idle"}`}
              >
                <ContainerTunnelPanel
                  selectedContainer={selectedContainer}
                  selectedContainerDetails={selectedContainerDetails}
                  detailsLoading={tab.detailsLoading}
                  tunnelState={tunnelState}
                  onUpdateTunnelState={updateTunnelDraft}
                  onStartTunnel={() => {
                    void handleStartTunnel();
                  }}
                  onStopTunnel={() => {
                    void handleStopTunnel();
                  }}
                />
              </ContainerTunnelErrorBoundary>
            ) : (
              <PanelSection className="min-h-0">
                <FilterRow className="items-center justify-between">
                  <ToggleSwitch
                    checked={tab.logsFollowEnabled}
                    aria-label="Follow"
                    className="max-w-[15rem]"
                    label="Follow"
                    description="새 로그가 들어오면 하단을 자동으로 따라갑니다."
                    onClick={() => onSetLogsFollow(host.id, !tab.logsFollowEnabled)}
                  />
                  <div className="flex min-w-[18rem] flex-1 flex-wrap items-center gap-3">
                    <Input
                      type="search"
                      className="min-w-[14rem] flex-1"
                      value={tab.logsSearchQuery}
                      placeholder="로그 검색"
                      onChange={(event) =>
                        onSetLogsSearchQuery(host.id, event.target.value)
                      }
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        void onSearchLogs(host.id);
                      }}
                      disabled={!canSearchRemoteLogs}
                    >
                      {tab.logsSearchLoading ? "검색 중..." : "원격 검색"}
                    </Button>
                    {(tab.logsSearchMode || tab.logsSearchQuery) ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => onClearLogsSearch(host.id)}
                      >
                        검색 지우기
                      </Button>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void onLoadMoreLogs(host.id);
                    }}
                    disabled={!canLoadMoreLogs}
                  >
                    더 보기
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void onRefreshLogs(host.id);
                    }}
                    disabled={!tab.selectedContainerId || tab.logsLoading}
                  >
                    {tab.logsLoading ? "불러오는 중..." : "다시 불러오기"}
                  </Button>
                </FilterRow>
                {trimmedLogsSearchQuery ? (
                  <div className="text-[0.84rem] text-[var(--text-soft)]">
                    {tab.logsSearchMode === "remote"
                      ? `원격 검색 결과 ${logMatchCount}건`
                      : `현재 버퍼에서 ${logMatchCount}건 일치`}
                  </div>
                ) : null}
                {tab.logsSearchError ? (
                  <NoticeCard tone="danger" role="alert">
                    {tab.logsSearchError}
                  </NoticeCard>
                ) : null}
                {tab.logsError ? (
                  <NoticeCard tone="danger" role="alert">
                    {tab.logsError}
                  </NoticeCard>
                ) : null}
                <div
                  ref={logsOutputRef}
                  className={logsOutputClass}
                  data-testid="containers-logs-output"
                  onScroll={handleLogsScroll}
                  style={{
                    fontFamily:
                      "var(--terminal-font-family, 'SFMono-Regular', Consolas, monospace)",
                    fontSize: "0.83rem",
                    lineHeight: "1.55",
                  }}
                >
                  {tab.logsState === "loading" || tab.logsState === "idle" ? (
                    <div className={emptyDetailClass}>로그를 불러오는 중입니다...</div>
                  ) : tab.logsState === "empty" ? (
                    <div className={emptyDetailClass}>
                      최근 {tab.logsTailWindow}줄 기준 로그가 없습니다.
                    </div>
                  ) : tab.logsState === "error" ||
                    tab.logsState === "malformed" ? (
                    <div className={emptyDetailClass}>
                      다시 불러오기를 시도해 주세요.
                    </div>
                  ) : effectiveLogLines.length ? (
                    effectiveLogLines.map((line, index) => {
                      const parsedLine = parseContainerLogLine(line);
                      const isMatch =
                        !!trimmedLogsSearchQuery &&
                        matchesContainerLogQuery(line, trimmedLogsSearchQuery);
                      if (!parsedLine.timestampRaw || !parsedLine.timestampLabel) {
                        return (
                          <div
                            key={`${index}:${parsedLine.raw}`}
                            className={cn(
                              "grid grid-cols-[minmax(0,1fr)] items-start gap-[0.9rem]",
                              isMatch
                                ? "mx-[-0.35rem] rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_16%,transparent_84%)] px-[0.35rem] py-[0.22rem]"
                                : "",
                            )}
                            data-log-match={isMatch ? "true" : undefined}
                          >
                            <span className="min-w-0 break-words whitespace-pre-wrap">
                              {renderAnsiStyledMessage(parsedLine.message)}
                            </span>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={`${index}:${parsedLine.raw}`}
                          className={cn(
                            "grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-[0.9rem]",
                            isMatch
                              ? "mx-[-0.35rem] rounded-[10px] bg-[color-mix(in_srgb,var(--accent-strong)_16%,transparent_84%)] px-[0.35rem] py-[0.22rem]"
                              : "",
                          )}
                          data-log-match={isMatch ? "true" : undefined}
                        >
                          <span
                            className="whitespace-nowrap text-[rgba(163,181,214,0.82)]"
                            title={parsedLine.timestampRaw}
                          >
                            {parsedLine.timestampLabel}
                          </span>
                          <span className="min-w-0 break-words whitespace-pre-wrap">
                            {renderAnsiStyledMessage(parsedLine.message)}
                          </span>
                        </div>
                      );
                    })
                  ) : trimmedLogsSearchQuery ? (
                    <div className={emptyDetailClass}>검색 결과가 없습니다.</div>
                  ) : null}
                  <div
                    ref={logsBottomRef}
                    className="h-px w-full"
                    aria-hidden="true"
                  />
                </div>
              </PanelSection>
            )}
          </section>
        </div>
      )}

      {matchingInteractiveAuth ? (
        <div
          className="absolute inset-0 z-[3] grid place-items-center rounded-[20px] bg-[rgba(12,20,32,0.18)]"
          role="status"
          aria-live="polite"
          aria-label="Container interactive authentication required"
        >
          <TerminalInteractiveAuthOverlay
            interactiveAuth={matchingInteractiveAuth}
            promptResponses={promptResponses}
            onPromptResponseChange={(index, value) => {
              const nextResponses = [...promptResponses];
              nextResponses[index] = value;
              setPromptResponses(nextResponses);
            }}
            onSubmit={() => {
              void onRespondInteractiveAuth(
                matchingInteractiveAuth.challengeId,
                promptResponses,
              );
            }}
            onCopyApprovalUrl={async () => {
              await navigator.clipboard.writeText(
                matchingInteractiveAuth.approvalUrl ?? "",
              );
            }}
            onReopenApprovalUrl={() => {
              void onReopenInteractiveAuthUrl();
            }}
            onClose={() => {
              onClearInteractiveAuth();
            }}
          />
        </div>
      ) : shouldShowConnectingOverlay ? (
        <div
          className="absolute inset-0 z-[3] grid place-items-center rounded-[20px] bg-[rgba(12,20,32,0.18)]"
          role="status"
          aria-live="polite"
          aria-label="Container connection in progress"
        >
          <Card className="grid max-w-[20rem] justify-items-center gap-[0.45rem] px-[1.1rem] py-4 text-center">
            <div
              aria-hidden="true"
              className="h-5 w-5 animate-[sftp-spinner_0.8s_linear_infinite] rounded-full border-2 border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] border-t-[var(--accent-strong)]"
            />
            <strong>{`${host.label} 연결 중...`}</strong>
            <span className="font-semibold text-[var(--text)]">
              {formatConnectionProgressStageLabel(tab.connectionProgress?.stage)}
            </span>
            <span className="text-[0.9rem] leading-[1.5] text-[var(--text-soft)]">
              {tab.connectionProgress?.message ??
                "컨테이너 런타임과 연결 상태를 준비하고 있습니다."}
            </span>
          </Card>
        </div>
      ) : null}

      {pendingConfirmAction && selectedContainer ? (
        <div className="modal-backdrop" role="presentation">
          <ModalShell
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-action-confirm-title"
          >
            <ModalHeader>
              <h3 id="container-action-confirm-title">
                {pendingConfirmAction === "remove"
                  ? "컨테이너를 삭제할까요?"
                  : `컨테이너를 ${pendingConfirmAction}할까요?`}
              </h3>
            </ModalHeader>
            <ModalBody>
              <p>
                <strong>{selectedContainer.name}</strong> 컨테이너에{" "}
                <code>{pendingConfirmAction}</code> 작업을 실행합니다.
              </p>
            </ModalBody>
            <ModalFooter>
              <Button type="button" variant="secondary" onClick={() => setPendingConfirmAction(null)}>
                취소
              </Button>
              <Button
                type="button"
                variant={pendingConfirmAction === "remove" ? "danger" : "primary"}
                onClick={() => {
                  void onRunAction(host.id, pendingConfirmAction).finally(() => {
                    setPendingConfirmAction(null);
                  });
                }}
                disabled={!!tab.pendingAction}
              >
                {tab.pendingAction ? "실행 중..." : "확인"}
              </Button>
            </ModalFooter>
          </ModalShell>
        </div>
      ) : null}
    </div>
  );
}

function ContainerListItem({
  id,
  name,
  image,
  status,
  isActive,
  onSelect,
}: {
  id: string;
  name: string;
  image: string;
  status: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  const statusPresentation = getContainerStatusPresentation(status);
  const shortImage = shortenContainerImage(image);

  return (
    <button
      type="button"
      className={cn(
        "flex w-full flex-col items-stretch gap-2 rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_84%,transparent_16%)] px-4 py-[0.95rem] text-left text-[var(--text)] transition-[border-color,box-shadow] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)]",
        isActive
          ? "border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_14%,transparent_86%),var(--shadow)]"
          : "",
      )}
      onClick={onSelect}
      title={name}
      data-container-id={id}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="min-w-0 truncate" title={name}>
          {name}
        </strong>
        <StatusBadge
          tone={statusPresentation.tone}
          className="min-h-[1.55rem] shrink-0 px-[0.58rem] py-[0.2rem] text-[0.74rem]"
          title={status}
        >
          {statusPresentation.label}
        </StatusBadge>
      </div>
      <div
        className="min-w-0 truncate text-[var(--text-soft)]"
        title={image}
      >
        {shortImage}
      </div>
    </button>
  );
}
