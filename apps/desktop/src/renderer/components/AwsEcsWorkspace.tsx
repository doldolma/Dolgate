import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getHostBadgeLabel, getHostSubtitle } from "@shared";
import { cn } from "../lib/cn";
import type {
  AwsEcsServiceActionContainerSummary,
  AwsEcsServiceActionContext,
  AwsEcsServiceExposureKind,
  AwsEcsServiceLogEntry,
  AwsEcsServiceSummary,
  AwsEcsServiceTaskSummary,
  AwsMetricHistoryPoint,
  HostRecord,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
} from "@shared";
import type {
  EcsDetailPanel,
  EcsServiceLogsStateUpdater,
  EcsServiceLogsViewState,
  EcsTunnelTabState,
  HostContainersTabState,
  LogsAbsoluteRangeValue,
  LogsRangeMode,
  LogsRelativeRangeValue,
} from "../store/createAppStore";
import { useAwsEcsWorkspaceController } from "../controllers/useAwsEcsWorkspaceController";
import {
  Badge,
  Button,
  Card,
  CardMain,
  CardMessage,
  CardMeta,
  CardTitleRow,
  EmptyState,
  FieldGroup,
  FilterRow,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  SelectField,
  StatusBadge,
  TabButton,
  Tabs,
  ToggleSwitch,
  Toolbar,
} from "../ui";
import type { StatusBadgeTone } from "../ui/StatusBadge";
import {
  UPlotMetricChart,
  type MetricChartSeriesDefinition,
} from "./UPlotMetricChart";
import {
  countLocalFindMatches,
  LogLocalFindBar,
  renderLocalFindHighlightedText,
  shouldOpenLogLocalFind,
} from "./LogLocalFind";
import { LogsRangePickerDialog } from "./LogsRangePickerDialog";
import {
  createDefaultLogsRelativeRange,
  formatLogsRangeLabel,
  normalizeLogsAbsoluteRange,
  normalizeLogsRelativeRange,
} from "../lib/log-range";
import { formatConnectionProgressStageLabel } from "../lib/connection-progress";
import {
  isAwsSsoAuthenticationErrorMessage,
  normalizeErrorMessage,
} from "../store/utils";

interface AwsEcsWorkspaceProps {
  host: HostRecord;
  tab: HostContainersTabState;
  isActive: boolean;
  onRefresh: (hostId: string) => Promise<void>;
  onRefreshUtilization: (hostId: string) => Promise<void>;
  onOpenAwsSsoLogin?: (hostId: string) => Promise<void>;
  onSelectService?: (hostId: string, serviceName: string | null) => void;
  onSetPanel?: (hostId: string, panel: EcsDetailPanel) => void;
  onSetTunnelState?: (
    hostId: string,
    serviceName: string,
    state: EcsTunnelTabState | null,
  ) => void;
  onSetLogsState?: (
    hostId: string,
    serviceName: string,
    state: EcsServiceLogsStateUpdater | null,
  ) => void;
  onOpenEcsExecShell: (
    hostId: string,
    serviceName: string,
    taskArn: string,
    containerName: string,
  ) => Promise<void>;
}

interface ServiceActionContextState {
  loading: boolean;
  error: string | null;
  data: AwsEcsServiceActionContext | null;
}

type LogsPanelState = EcsServiceLogsViewState;
type LogsStateUpdater = EcsServiceLogsStateUpdater;

interface TunnelPanelState {
  serviceName: string | null;
  loading: boolean;
  error: string | null;
  runtime: PortForwardRuntimeRecord | null;
  taskArn: string | null;
  containerName: string | null;
  targetPort: string;
  autoLocalPort: boolean;
  bindPort: string;
}

interface ShellPickerState {
  open: boolean;
  serviceName: string | null;
  loading: boolean;
  error: string | null;
  taskArn: string | null;
  containerName: string | null;
  submitting: boolean;
}

const ecsSummaryCardClass =
  "grid gap-[0.35rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[1rem] py-[0.95rem]";
const ecsSectionCardClass =
  "grid gap-[0.8rem] rounded-[18px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_92%,transparent_8%)] px-[1rem] py-[0.95rem] shadow-none";
const ecsEmptyDetailClass =
  "rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_82%,transparent_18%)] px-4 py-4 text-[var(--text-soft)]";
const ecsLogsOutputClass =
  "grid min-h-0 flex-1 content-start gap-[0.35rem] overflow-auto rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[rgba(7,13,24,0.88)] px-[1.05rem] py-4 text-[rgba(226,234,255,0.92)]";
const ecsLogsOverlayChipClass =
  "pointer-events-none absolute left-[1rem] right-[1rem] top-[1rem] z-[2] flex items-center justify-center gap-[0.45rem] rounded-[12px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-strong)_76%,var(--accent-strong)_24%)] px-[0.95rem] py-[0.42rem] text-[0.8rem] font-semibold text-[rgba(243,247,255,0.98)] shadow-[var(--shadow)] backdrop-blur-[10px]";
const ecsFactsGridClass =
  "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem_1rem] max-[760px]:grid-cols-1";
const ecsFactsItemClass = "grid gap-[0.2rem]";
const ecsFactsLabelClass =
  "m-0 text-[0.76rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]";
const ecsFactsValueClass =
  "m-0 text-[0.98rem] font-semibold text-[var(--text)]";
const ecsTimelineClass = "grid gap-[0.7rem]";
const ecsTimelineItemClass =
  "grid gap-[0.55rem] rounded-[16px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_84%,transparent_16%)] px-[0.95rem] py-[0.85rem]";
const ecsLogsMetaClass = "mt-[-0.2rem]";
const ecsTunnelFormClass =
  "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.8rem_0.9rem] max-[760px]:grid-cols-1";
const ecsTunnelRuntimeCardClass =
  "grid gap-[0.85rem] rounded-[18px] border border-[var(--selection-border)] bg-[var(--selection-tint)] px-[1rem] py-[0.9rem] shadow-none";
const ecsTunnelRuntimeGridClass =
  "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1";
const ecsDetailTabsClass =
  "gap-[0.55rem] rounded-[18px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-muted)_86%,transparent_14%)] p-[0.35rem] shadow-none";
const ecsDetailTabButtonBaseClass =
  "min-w-[5.75rem] border border-transparent bg-[color-mix(in_srgb,var(--surface)_18%,transparent_82%)] text-[color-mix(in_srgb,var(--text-soft)_90%,black_10%)] shadow-none";
const ecsDetailTabButtonActiveClass =
  "border-[var(--selection-border)] bg-[var(--selection-tint)] text-[var(--accent-strong)] shadow-none";
const ecsDetailTabButtonInactiveClass =
  "hover:border-[color-mix(in_srgb,var(--border)_80%,white_20%)] hover:bg-[color-mix(in_srgb,var(--surface)_56%,transparent_44%)] hover:text-[var(--text)]";

function formatLoadedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("ko-KR");
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function formatChartPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function buildPercentMetricSeries(
  points: AwsMetricHistoryPoint[],
  label: string,
): {
  timestamps: number[];
  series: MetricChartSeriesDefinition[];
} {
  const normalizedPoints = points
    .map((point) => ({
      timestampMs: Date.parse(point.timestamp),
      value: point.value,
    }))
    .filter(
      (point): point is { timestampMs: number; value: number } =>
        Number.isFinite(point.timestampMs) && typeof point.value === "number",
    )
    .sort((left, right) => left.timestampMs - right.timestampMs);

  return {
    timestamps: normalizedPoints.map((point) => point.timestampMs),
    series: [
      {
        label,
        values: normalizedPoints.map((point) => point.value),
        tone: "primary",
        format: "percent",
      },
    ],
  };
}

function formatServicePorts(service: AwsEcsServiceSummary): string | null {
  if (service.servicePorts.length === 0) {
    return null;
  }
  const visiblePorts = service.servicePorts
    .slice(0, 2)
    .map((port) => `${port.port}/${port.protocol}`);
  const hiddenCount = service.servicePorts.length - visiblePorts.length;
  return hiddenCount > 0
    ? `Ports ${visiblePorts.join(", ")} +${hiddenCount}`
    : `Ports ${visiblePorts.join(", ")}`;
}

function getExposureBadgeLabels(
  exposureKinds: AwsEcsServiceExposureKind[],
): string[] {
  const labels = new Set<string>();
  for (const exposureKind of exposureKinds) {
    if (exposureKind === "service-connect") {
      labels.add("Svc Connect");
    } else {
      labels.add("ALB/NLB");
    }
  }
  return [...labels];
}

function getServiceStatusTone(service: AwsEcsServiceSummary): StatusBadgeTone {
  const status = service.status.trim().toUpperCase();
  if (status === "ACTIVE") {
    return "running";
  }
  if (status === "DRAINING" || status === "PROVISIONING") {
    return "starting";
  }
  return "error";
}

function getRolloutTone(
  rolloutState: string | null | undefined,
): StatusBadgeTone {
  const normalized = rolloutState?.trim().toUpperCase();
  if (!normalized) {
    return "starting";
  }
  if (normalized === "ACTIVE" || normalized === "COMPLETED") {
    return "running";
  }
  if (normalized === "FAILED") {
    return "error";
  }
  return "starting";
}

function isStatusIssue(service: AwsEcsServiceSummary): boolean {
  return service.status.trim().toUpperCase() !== "ACTIVE";
}

function isRolloutIssue(service: AwsEcsServiceSummary): boolean {
  const normalized = service.rolloutState?.trim().toUpperCase();
  return Boolean(normalized && normalized !== "COMPLETED");
}

function hasPendingTasks(service: AwsEcsServiceSummary): boolean {
  return service.pendingCount > 0;
}

function compareServices(
  left: AwsEcsServiceSummary,
  right: AwsEcsServiceSummary,
): number {
  const leftRank =
    Number(isStatusIssue(left)) * 4 +
    Number(isRolloutIssue(left)) * 2 +
    Number(hasPendingTasks(left));
  const rightRank =
    Number(isStatusIssue(right)) * 4 +
    Number(isRolloutIssue(right)) * 2 +
    Number(hasPendingTasks(right));

  if (leftRank !== rightRank) {
    return rightRank - leftRank;
  }
  return left.serviceName.localeCompare(right.serviceName);
}

function createEmptyLogsState(): LogsPanelState {
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
    relativeRange: createDefaultLogsRelativeRange(),
    absoluteRange: null,
  };
}

function pruneEcsLogsByServiceName<T>(
  logsByServiceName: Record<string, T>,
  serviceNames: string[],
): Record<string, T> {
  const validServiceNames = new Set(serviceNames);
  return Object.fromEntries(
    Object.entries(logsByServiceName).filter(([serviceName]) =>
      validServiceNames.has(serviceName),
    ),
  );
}

function createEmptyTunnelState(): TunnelPanelState {
  return {
    serviceName: null,
    loading: false,
    error: null,
    runtime: null,
    taskArn: null,
    containerName: null,
    targetPort: "",
    autoLocalPort: true,
    bindPort: "",
  };
}

function createEmptyShellPickerState(): ShellPickerState {
  return {
    open: false,
    serviceName: null,
    loading: false,
    error: null,
    taskArn: null,
    containerName: null,
    submitting: false,
  };
}

function mergeLogEntries(
  existing: AwsEcsServiceLogEntry[],
  incoming: AwsEcsServiceLogEntry[],
): AwsEcsServiceLogEntry[] {
  const byId = new Map<string, AwsEcsServiceLogEntry>();
  for (const entry of existing) {
    byId.set(entry.id, entry);
  }
  for (const entry of incoming) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
        left.id.localeCompare(right.id),
    )
    .slice(-8000);
}

function getTaskLabel(task: AwsEcsServiceTaskSummary): string {
  return task.taskId || task.taskArn;
}

function getContainersForTask(
  context: AwsEcsServiceActionContext | null,
  taskArn: string | null,
  options?: { requireExec?: boolean; requirePorts?: boolean },
): AwsEcsServiceActionContainerSummary[] {
  if (!context) {
    return [];
  }
  const task = context.runningTasks.find((item) => item.taskArn === taskArn);
  const visibleNames = new Set(
    (task?.containers ?? []).map((container) => container.containerName),
  );
  return context.containers.filter((container) => {
    if (visibleNames.size > 0 && !visibleNames.has(container.containerName)) {
      return false;
    }
    if (options?.requireExec && !container.execEnabled) {
      return false;
    }
    if (options?.requirePorts && container.ports.length === 0) {
      return false;
    }
    return true;
  });
}

function getDefaultTaskArn(context: AwsEcsServiceActionContext | null): string | null {
  return context?.runningTasks[0]?.taskArn ?? null;
}

function getLogEntrySearchText(entry: AwsEcsServiceLogEntry): string {
  return [
    entry.timestamp,
    entry.taskId,
    entry.containerName,
    entry.logStreamName,
    entry.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getLogEntryRenderedPrefix(entry: AwsEcsServiceLogEntry): string {
  return [entry.containerName, entry.taskId].filter(Boolean).join(" · ");
}

function buildTunnelStateFromContext(
  serviceName: string,
  context: AwsEcsServiceActionContext | null,
  previous: TunnelPanelState,
): TunnelPanelState {
  if (!context) {
    return {
      ...previous,
      serviceName,
      error: null,
      runtime:
        previous.serviceName === serviceName ? previous.runtime : null,
      taskArn: previous.serviceName === serviceName ? previous.taskArn : null,
      containerName:
        previous.serviceName === serviceName ? previous.containerName : null,
      targetPort: previous.serviceName === serviceName ? previous.targetPort : "",
      autoLocalPort: previous.serviceName === serviceName
        ? previous.autoLocalPort
        : true,
      bindPort: previous.serviceName === serviceName ? previous.bindPort : "",
    };
  }

  const nextTaskArn =
    previous.serviceName === serviceName &&
    previous.taskArn &&
    context.runningTasks.some((task) => task.taskArn === previous.taskArn)
      ? previous.taskArn
      : getDefaultTaskArn(context);
  const containerOptions = getContainersForTask(context, nextTaskArn, {
    requirePorts: true,
  });
  const nextContainerName =
    previous.serviceName === serviceName &&
    previous.containerName &&
    containerOptions.some(
      (container) => container.containerName === previous.containerName,
    )
      ? previous.containerName
      : containerOptions[0]?.containerName ?? null;
  const nextPorts =
    containerOptions.find(
      (container) => container.containerName === nextContainerName,
    )?.ports ?? [];
  const nextTargetPort =
    previous.serviceName === serviceName &&
    previous.targetPort &&
    nextPorts.some((port) => String(port.port) === previous.targetPort)
      ? previous.targetPort
      : nextPorts[0]
        ? String(nextPorts[0].port)
        : "";

  return {
    ...previous,
    serviceName,
    error: null,
    runtime:
      previous.serviceName === serviceName ? previous.runtime : null,
    taskArn: nextTaskArn,
    containerName: nextContainerName,
    targetPort: nextTargetPort,
    autoLocalPort:
      previous.serviceName === serviceName ? previous.autoLocalPort : true,
    bindPort: previous.serviceName === serviceName ? previous.bindPort : "",
  };
}

function areTunnelStatesEqual(
  left: TunnelPanelState,
  right: TunnelPanelState,
): boolean {
  return (
    left.serviceName === right.serviceName &&
    left.loading === right.loading &&
    left.error === right.error &&
    left.runtime === right.runtime &&
    left.taskArn === right.taskArn &&
    left.containerName === right.containerName &&
    left.targetPort === right.targetPort &&
    left.autoLocalPort === right.autoLocalPort &&
    left.bindPort === right.bindPort
  );
}

function toPersistedTunnelState(
  tunnelState: TunnelPanelState,
): EcsTunnelTabState | null {
  if (!tunnelState.serviceName) {
    return null;
  }
  const shouldClear =
    !tunnelState.runtime &&
    !tunnelState.taskArn &&
    !tunnelState.containerName &&
    !tunnelState.targetPort &&
    tunnelState.autoLocalPort &&
    (tunnelState.bindPort === "" || tunnelState.bindPort === "0");
  if (shouldClear) {
    return null;
  }
  return {
    serviceName: tunnelState.serviceName,
    taskArn: tunnelState.taskArn,
    containerName: tunnelState.containerName,
    targetPort: tunnelState.targetPort,
    bindPort: tunnelState.bindPort || "0",
    autoLocalPort: tunnelState.autoLocalPort,
    loading: false,
    error: null,
    runtime: tunnelState.runtime,
  };
}

function buildShellPickerStateFromContext(
  serviceName: string,
  context: AwsEcsServiceActionContext | null,
  previous: ShellPickerState,
): ShellPickerState {
  if (!context) {
    return {
      ...previous,
      open: true,
      serviceName,
      loading: false,
      error: "ECS Exec 컨텍스트를 불러오지 못했습니다.",
      taskArn: null,
      containerName: null,
    };
  }
  const nextTaskArn =
    previous.serviceName === serviceName &&
    previous.taskArn &&
    context.runningTasks.some((task) => task.taskArn === previous.taskArn)
      ? previous.taskArn
      : getDefaultTaskArn(context);
  const containerOptions = getContainersForTask(context, nextTaskArn, {
    requireExec: true,
  });
  const nextContainerName =
    previous.serviceName === serviceName &&
    previous.containerName &&
    containerOptions.some(
      (container) => container.containerName === previous.containerName,
    )
      ? previous.containerName
      : containerOptions[0]?.containerName ?? null;

  return {
    ...previous,
    open: true,
    serviceName,
    loading: false,
    error:
      context.runningTasks.length === 0
        ? "이 서비스에 실행 중인 task가 없습니다."
        : containerOptions.length === 0
          ? "ECS Exec로 연결할 수 있는 컨테이너가 없습니다."
          : null,
    taskArn: nextTaskArn,
    containerName: nextContainerName,
  };
}

function MetricsPanel({
  service,
  history,
}: {
  service: AwsEcsServiceSummary;
  history: {
    cpuHistory: AwsMetricHistoryPoint[];
    memoryHistory: AwsMetricHistoryPoint[];
  };
}) {
  const cpuChart = useMemo(
    () => buildPercentMetricSeries(history.cpuHistory, "CPU"),
    [history.cpuHistory],
  );
  const memoryChart = useMemo(
    () => buildPercentMetricSeries(history.memoryHistory, "Memory"),
    [history.memoryHistory],
  );

  return (
    <div className="grid min-h-0 gap-[0.9rem] overflow-y-auto pr-px">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[0.8rem]">
        <div className={ecsSummaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">CPU</span>
          <strong>{formatChartPercent(service.cpuUtilizationPercent)}</strong>
        </div>
        <div className={ecsSummaryCardClass}>
          <span className="text-[0.82rem] text-[var(--text-soft)]">Memory</span>
          <strong>{formatChartPercent(service.memoryUtilizationPercent)}</strong>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-[0.85rem]">
        {cpuChart.timestamps.length > 0 ? (
          <UPlotMetricChart
            title="CPU"
            currentLabel={formatChartPercent(service.cpuUtilizationPercent)}
            timestamps={cpuChart.timestamps}
            series={cpuChart.series}
            yFormat="percent"
            fixedRange={[0, 100]}
          />
        ) : (
          <div className={ecsSectionCardClass}>
            <div className="flex items-baseline justify-between gap-3">
              <strong>CPU</strong>
              <span className="tabular-nums text-[0.82rem] text-[var(--text-soft)]">
                {formatChartPercent(service.cpuUtilizationPercent)}
              </span>
            </div>
            <div className={ecsEmptyDetailClass}>
              최근 10분 CPU 추세 데이터가 없습니다.
            </div>
          </div>
        )}

        {memoryChart.timestamps.length > 0 ? (
          <UPlotMetricChart
            title="Memory"
            currentLabel={formatChartPercent(service.memoryUtilizationPercent)}
            timestamps={memoryChart.timestamps}
            series={memoryChart.series}
            yFormat="percent"
            fixedRange={[0, 100]}
          />
        ) : (
          <div className={ecsSectionCardClass}>
            <div className="flex items-baseline justify-between gap-3">
              <strong>Memory</strong>
              <span className="tabular-nums text-[0.82rem] text-[var(--text-soft)]">
                {formatChartPercent(service.memoryUtilizationPercent)}
              </span>
            </div>
            <div className={ecsEmptyDetailClass}>
              최근 10분 Memory 추세 데이터가 없습니다.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AwsEcsWorkspace({
  host,
  tab,
  isActive,
  onRefresh,
  onRefreshUtilization,
  onOpenAwsSsoLogin,
  onSelectService,
  onSetPanel,
  onSetTunnelState,
  onSetLogsState,
  onOpenEcsExecShell,
}: AwsEcsWorkspaceProps) {
  const {
    loadEcsServiceActionContext,
    loadEcsServiceLogs,
    onPortForwardRuntimeEvent,
    startEcsServiceTunnel,
    stopEcsServiceTunnel,
  } = useAwsEcsWorkspaceController();
  const snapshot = tab.ecsSnapshot;
  const progressTitle = tab.connectionProgress
    ? formatConnectionProgressStageLabel(tab.connectionProgress.stage)
    : "ECS 클러스터 조회";
  const progressMessage =
    tab.connectionProgress?.message ??
    "AWS ECS 서비스 스냅샷과 현재 사용량 지표를 가져오고 있습니다.";
  const canOpenSsoLoginFromProgress =
    tab.connectionProgress?.stage === "browser-login" &&
    Boolean(onOpenAwsSsoLogin);
  const canRecoverSsoError =
    Boolean(tab.errorMessage) &&
    isAwsSsoAuthenticationErrorMessage(tab.errorMessage ?? "") &&
    Boolean(onOpenAwsSsoLogin);
  const services = useMemo(
    () => (snapshot ? [...snapshot.services].sort(compareServices) : []),
    [snapshot],
  );
  const [serviceContexts, setServiceContexts] = useState<
    Record<string, ServiceActionContextState>
  >({});
  const [localEcsLogsByServiceName, setLocalEcsLogsByServiceName] = useState<
    Record<string, LogsPanelState>
  >(tab.ecsLogsByServiceName);
  const [logsRangePickerOpen, setLogsRangePickerOpen] = useState(false);
  const [localSelectedServiceName, setLocalSelectedServiceName] = useState<
    string | null
  >(tab.ecsSelectedServiceName);
  const [localActivePanel, setLocalActivePanel] = useState<EcsDetailPanel>(
    tab.ecsActivePanel,
  );
  const [tunnelState, setTunnelState] = useState<TunnelPanelState>(
    createEmptyTunnelState,
  );
  const [shellPickerState, setShellPickerState] = useState<ShellPickerState>(
    createEmptyShellPickerState,
  );
  const [logsFocusMode, setLogsFocusMode] = useState(false);
  const [localFindOpen, setLocalFindOpen] = useState(false);
  const [localFindQuery, setLocalFindQuery] = useState("");
  const [activeLocalFindMatchIndex, setActiveLocalFindMatchIndex] = useState(0);
  const [ssoLoginActionState, setSsoLoginActionState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const tunnelStatesRef = useRef<Record<string, TunnelPanelState>>({});
  const serviceContextsRef = useRef<Record<string, ServiceActionContextState>>({});
  const inFlightContextRequestsRef = useRef<
    Partial<Record<string, Promise<AwsEcsServiceActionContext | null>>>
  >({});
  const selectedServiceName =
    onSelectService ? tab.ecsSelectedServiceName : localSelectedServiceName;
  const activePanel = onSetPanel ? tab.ecsActivePanel : localActivePanel;
  const ecsLogsByServiceName = onSetLogsState
    ? tab.ecsLogsByServiceName
    : localEcsLogsByServiceName;
  const latestLogsRequestIdRef = useRef<Record<string, number>>({});
  const logsOutputRef = useRef<HTMLDivElement | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);
  const localFindInputRef = useRef<HTMLInputElement | null>(null);
  const localFindMatchRefs = useRef<Map<number, HTMLElement>>(new Map());
  const previousPanelRef = useRef<EcsDetailPanel>(tab.ecsActivePanel);
  const previousLogsTargetRef = useRef<string | null>(null);
  const logsAutoLoadKeyRef = useRef<string | null>(null);
  const hasInitializedLogsViewRef = useRef(false);
  const suppressLogsScrollRef = useRef(false);
  const releaseLogsScrollFrameRef = useRef<number | null>(null);

  const openAwsSsoLogin = useCallback(
    async (options: { refreshAfterLogin?: boolean } = {}) => {
      if (!onOpenAwsSsoLogin) {
        return;
      }
      setSsoLoginActionState({ loading: true, error: null });
      try {
        await onOpenAwsSsoLogin(host.id);
        if (options.refreshAfterLogin) {
          await onRefresh(host.id);
        }
        setSsoLoginActionState({ loading: false, error: null });
      } catch (error) {
        setSsoLoginActionState({
          loading: false,
          error: normalizeErrorMessage(
            error,
            "AWS SSO 로그인 창을 열지 못했습니다.",
          ),
        });
      }
    },
    [host.id, onOpenAwsSsoLogin, onRefresh],
  );

  useEffect(() => {
    serviceContextsRef.current = serviceContexts;
  }, [serviceContexts]);

  useEffect(() => {
    setSsoLoginActionState((current) =>
      current.loading ? current : { loading: false, error: null },
    );
  }, [host.id, tab.connectionProgress?.stage, tab.errorMessage]);

  useEffect(() => {
    tunnelStatesRef.current = tab.ecsTunnelStatesByServiceName;
    setServiceContexts({});
    serviceContextsRef.current = {};
    inFlightContextRequestsRef.current = {};
    setLocalEcsLogsByServiceName(tab.ecsLogsByServiceName);
    setLogsRangePickerOpen(false);
    setLocalSelectedServiceName(tab.ecsSelectedServiceName);
    setLocalActivePanel(tab.ecsActivePanel);
    latestLogsRequestIdRef.current = {};
    logsAutoLoadKeyRef.current = null;
    previousLogsTargetRef.current = null;
    hasInitializedLogsViewRef.current = false;
    setLocalFindOpen(false);
    setLocalFindQuery("");
    setActiveLocalFindMatchIndex(0);
    localFindMatchRefs.current.clear();
    setLogsFocusMode(false);
    setTunnelState(createEmptyTunnelState());
    setShellPickerState(createEmptyShellPickerState());
  }, [host.id]);

  useEffect(() => {
    tunnelStatesRef.current = tab.ecsTunnelStatesByServiceName;
  }, [tab.ecsTunnelStatesByServiceName]);

  useEffect(() => {
    if (onSetLogsState) {
      return;
    }
    const nextServiceNames = services.map((service) => service.serviceName);
    setLocalEcsLogsByServiceName((previous) => {
      const next = pruneEcsLogsByServiceName(previous, nextServiceNames);
      const previousKeys = Object.keys(previous).sort();
      const nextKeys = Object.keys(next).sort();
      return previousKeys.length === nextKeys.length &&
        previousKeys.every((key, index) => key === nextKeys[index])
        ? previous
        : next;
    });
  }, [onSetLogsState, services]);

  useEffect(() => {
    return onPortForwardRuntimeEvent((event: PortForwardRuntimeEvent) => {
      for (const [serviceName, state] of Object.entries(tunnelStatesRef.current)) {
        if (state.runtime?.ruleId === event.runtime.ruleId) {
          tunnelStatesRef.current[serviceName] = {
            ...state,
            loading: false,
            runtime:
              event.runtime.status === "stopped" ? null : event.runtime,
            error:
              event.runtime.status === "error"
                ? event.runtime.message ?? state.error
                : state.error,
          };
        }
      }
      setTunnelState((previous) =>
        previous.runtime?.ruleId === event.runtime.ruleId
          ? {
              ...previous,
              loading: false,
              runtime:
                event.runtime.status === "stopped" ? null : event.runtime,
              error:
                event.runtime.status === "error"
                  ? event.runtime.message ?? previous.error
                  : previous.error,
            }
          : previous,
      );
    });
  }, []);

  useEffect(() => {
    if (!services.length) {
      if (onSelectService && tab.ecsSelectedServiceName !== null) {
        onSelectService(host.id, null);
      }
      return;
    }
    if (
      onSelectService &&
      (
        !tab.ecsSelectedServiceName ||
        !services.some((service) => service.serviceName === tab.ecsSelectedServiceName)
      )
    ) {
      onSelectService(host.id, services[0].serviceName);
    }
  }, [host.id, onSelectService, services, tab.ecsSelectedServiceName]);

  useEffect(() => {
    previousPanelRef.current = activePanel;
  }, [activePanel]);

  const selectedService = useMemo(
    () =>
      services.find((service) => service.serviceName === selectedServiceName) ??
      services[0] ??
      null,
    [selectedServiceName, services],
  );
  const isLogsPanel = activePanel === "logs";
  const logsFocusModeActive = logsFocusMode && isLogsPanel && Boolean(selectedService);

  useEffect(() => {
    if (!isLogsPanel) {
      setLogsFocusMode(false);
    }
  }, [isLogsPanel]);

  const setServiceLogsState = useCallback(
    (serviceName: string, updater: LogsStateUpdater) => {
      if (onSetLogsState) {
        onSetLogsState(host.id, serviceName, updater);
        return;
      }
      setLocalEcsLogsByServiceName((previous) => {
        const current = previous[serviceName]
          ? { ...createEmptyLogsState(), ...previous[serviceName] }
          : createEmptyLogsState();
        const next =
          typeof updater === "function" ? updater(current) : updater;
        return {
          ...previous,
          [serviceName]: next,
        };
      });
    },
    [host.id, onSetLogsState],
  );
  const logsState = selectedService
    ? {
        ...createEmptyLogsState(),
        ...(ecsLogsByServiceName[selectedService.serviceName] ?? {}),
      }
    : createEmptyLogsState();
  const registerLocalFindMatchRef = useCallback(
    (matchIndex: number) => (node: HTMLElement | null) => {
      if (node) {
        localFindMatchRefs.current.set(matchIndex, node);
        return;
      }
      localFindMatchRefs.current.delete(matchIndex);
    },
    [],
  );
  const closeLocalFind = useCallback(() => {
    setLocalFindOpen(false);
    setLocalFindQuery("");
    setActiveLocalFindMatchIndex(0);
    localFindMatchRefs.current.clear();
  }, []);
  const logsRangeMode = logsState.rangeMode;
  const logsRelativeRange = logsState.relativeRange;
  const logsAbsoluteRange = logsState.absoluteRange;
  const setLogsState = useCallback(
    (updater: LogsStateUpdater) => {
      if (!selectedService?.serviceName) {
        return;
      }
      setServiceLogsState(selectedService.serviceName, updater);
    },
    [selectedService?.serviceName, setServiceLogsState],
  );
  const serviceContextState = selectedService
    ? serviceContexts[selectedService.serviceName]
    : undefined;
  const selectedServiceHistory = selectedService
    ? tab.ecsUtilizationHistoryByServiceName[selectedService.serviceName] ?? {
        cpuHistory: [],
        memoryHistory: [],
      }
    : { cpuHistory: [], memoryHistory: [] };
  const logsRangeLabel = useMemo(
    () => formatLogsRangeLabel(logsRangeMode, logsAbsoluteRange, logsRelativeRange),
    [logsAbsoluteRange, logsRangeMode, logsRelativeRange],
  );
  const selectedContext =
    selectedService ? serviceContextState?.data ?? null : null;

  useEffect(() => {
    if (!selectedService?.serviceName) {
      const emptyState = createEmptyTunnelState();
      setTunnelState((previous) =>
        areTunnelStatesEqual(previous, emptyState) ? previous : emptyState,
      );
      return;
    }
    const persistedState =
      tab.ecsTunnelStatesByServiceName[selectedService.serviceName] ?? null;
    const nextState = persistedState
      ? {
          ...createEmptyTunnelState(),
          ...persistedState,
          loading: false,
          error: null,
        }
      : {
          ...createEmptyTunnelState(),
          serviceName: selectedService.serviceName,
        };
    setTunnelState((previous) =>
      areTunnelStatesEqual(previous, nextState) ? previous : nextState,
    );
  }, [selectedService?.serviceName, tab.ecsTunnelStatesByServiceName]);

  useEffect(() => {
    if (!tunnelState.serviceName) {
      return;
    }
    const shouldClear =
      !tunnelState.runtime &&
      !tunnelState.loading &&
      !tunnelState.error &&
      !tunnelState.taskArn &&
      !tunnelState.containerName &&
      !tunnelState.targetPort &&
      tunnelState.autoLocalPort &&
      (tunnelState.bindPort === "" || tunnelState.bindPort === "0");

    if (shouldClear) {
      delete tunnelStatesRef.current[tunnelState.serviceName];
      return;
    }

    tunnelStatesRef.current[tunnelState.serviceName] = tunnelState;
  }, [tunnelState]);

  useEffect(() => {
    if (!onSetTunnelState || !tunnelState.serviceName) {
      return;
    }
    const nextPersistedState = toPersistedTunnelState(tunnelState);
    const persistedState =
      tab.ecsTunnelStatesByServiceName[tunnelState.serviceName] ?? null;
    const hasSamePersistedState =
      (persistedState === null && nextPersistedState === null) ||
      (persistedState !== null &&
        nextPersistedState !== null &&
        areTunnelStatesEqual(
          { ...createEmptyTunnelState(), ...persistedState, loading: false, error: null },
          { ...createEmptyTunnelState(), ...nextPersistedState, loading: false, error: null },
        ));
    if (hasSamePersistedState) {
      return;
    }
    onSetTunnelState(
      host.id,
      tunnelState.serviceName,
      nextPersistedState,
    );
  }, [host.id, onSetTunnelState, tab.ecsTunnelStatesByServiceName, tunnelState]);

  const loadServiceContext = useCallback(
    async (serviceName: string, force = false) => {
      const current = serviceContextsRef.current[serviceName];
      if (!force && current?.data) {
        return current.data;
      }
      if (!force && current?.loading) {
        return inFlightContextRequestsRef.current[serviceName] ?? null;
      }
      if (!force && inFlightContextRequestsRef.current[serviceName]) {
        return inFlightContextRequestsRef.current[serviceName];
      }
      setServiceContexts((previous) => ({
        ...previous,
        [serviceName]: {
          loading: true,
          error: null,
          data: previous[serviceName]?.data ?? null,
        },
      }));
      const request = (async () => {
        try {
          const data = await loadEcsServiceActionContext(host.id, serviceName);
          setServiceContexts((previous) => ({
            ...previous,
            [serviceName]: {
              loading: false,
              error: null,
              data,
            },
          }));
          return data;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "서비스 액션 정보를 불러오지 못했습니다.";
          setServiceContexts((previous) => ({
            ...previous,
            [serviceName]: {
              loading: false,
              error: message,
              data: previous[serviceName]?.data ?? null,
            },
          }));
          return null;
        } finally {
          delete inFlightContextRequestsRef.current[serviceName];
        }
      })();
      inFlightContextRequestsRef.current[serviceName] = request;
      return request;
    },
    [host.id],
  );

  const loadLogs = useCallback(
    async (input: {
      serviceName: string;
      taskArn?: string | null;
      containerName?: string | null;
      followCursor?: string | null;
      startTime?: string | null;
      endTime?: string | null;
      append?: boolean;
      silent?: boolean;
    }) => {
      const requestId =
        (latestLogsRequestIdRef.current[input.serviceName] ?? 0) + 1;
      latestLogsRequestIdRef.current[input.serviceName] = requestId;
      const requestedTaskArn = input.taskArn ?? null;
      const requestedContainerName = input.containerName ?? null;
      setServiceLogsState(input.serviceName, (previous) => ({
        ...previous,
        loading: input.silent ? previous.loading : true,
        refreshing:
          previous.snapshot !== null && !previous.snapshot.unsupportedReason,
        error: null,
        taskArn: requestedTaskArn,
        containerName: requestedContainerName,
      }));
      try {
        const snapshot = await loadEcsServiceLogs({
          hostId: host.id,
          serviceName: input.serviceName,
          taskArn: requestedTaskArn,
          containerName: requestedContainerName,
          followCursor: input.followCursor ?? null,
          ...(input.startTime ? { startTime: input.startTime } : {}),
          ...(input.endTime ? { endTime: input.endTime } : {}),
          limit: 5000,
        });
        if (latestLogsRequestIdRef.current[input.serviceName] !== requestId) {
          return;
        }
        setServiceLogsState(input.serviceName, (previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: null,
          taskArn: requestedTaskArn,
          containerName: requestedContainerName,
          snapshot:
            input.append &&
            previous.snapshot
              ? {
                  ...snapshot,
                  entries: mergeLogEntries(previous.snapshot.entries, snapshot.entries),
                }
              : snapshot,
        }));
      } catch (error) {
        if (latestLogsRequestIdRef.current[input.serviceName] !== requestId) {
          return;
        }
        setServiceLogsState(input.serviceName, (previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error:
            error instanceof Error
              ? error.message
              : "ECS 서비스 로그를 불러오지 못했습니다.",
          taskArn: requestedTaskArn,
          containerName: requestedContainerName,
        }));
      }
    },
    [host.id, loadEcsServiceLogs, setServiceLogsState],
  );

  const buildLogsRangeArgs = useCallback(
    (followCursor?: string | null) => {
      if (logsState.follow) {
        return {
          startTime: null,
          endTime: null,
          followCursor: followCursor ?? null,
        };
      }
      if (logsRangeMode === "absolute") {
        const normalizedRange = normalizeLogsAbsoluteRange(logsAbsoluteRange);
        if (normalizedRange) {
          return {
            startTime: normalizedRange.startTime,
            endTime: normalizedRange.endTime,
            followCursor: null,
          };
        }
      }
      const normalizedRelativeRange = normalizeLogsRelativeRange(logsRelativeRange);
      if (normalizedRelativeRange) {
        return {
          startTime: normalizedRelativeRange.startTime,
          endTime: normalizedRelativeRange.endTime,
          followCursor: null,
        };
      }
      return {
        startTime: null,
        endTime: null,
        followCursor: followCursor ?? null,
      };
    },
    [logsAbsoluteRange, logsRangeMode, logsRelativeRange, logsState.follow],
  );

  useEffect(() => {
    if (!isActive || !snapshot || tab.isLoading || tab.ecsMetricsLoading) {
      return;
    }
    if (!tab.ecsMetricsLoadedAt) {
      void onRefreshUtilization(host.id);
    }
    const interval = window.setInterval(() => {
      void onRefreshUtilization(host.id);
    }, 10_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    host.id,
    isActive,
    onRefreshUtilization,
    snapshot,
    tab.isLoading,
    tab.ecsMetricsLoadedAt,
    tab.ecsMetricsLoading,
  ]);

  useEffect(() => {
    const selectedServiceId = selectedService?.serviceName ?? null;
    if (!selectedServiceId || activePanel !== "logs") {
      return;
    }
    const rangeArgs = buildLogsRangeArgs();
    const autoLoadKey = [
      selectedServiceId,
      logsState.taskArn ?? "",
      logsState.containerName ?? "",
      rangeArgs.startTime ?? "",
      rangeArgs.endTime ?? "",
      rangeArgs.followCursor ?? "",
    ].join("|");
    if (logsState.snapshot) {
      return;
    }
    if (logsState.loading || logsAutoLoadKeyRef.current === autoLoadKey) {
      return;
    }
    logsAutoLoadKeyRef.current = autoLoadKey;
    void loadLogs({
      serviceName: selectedServiceId,
      taskArn: logsState.taskArn,
      containerName: logsState.containerName,
      startTime: rangeArgs.startTime,
      endTime: rangeArgs.endTime,
      followCursor: rangeArgs.followCursor,
    });
  }, [
    activePanel,
    buildLogsRangeArgs,
    loadLogs,
    logsState.containerName,
    logsState.loading,
    logsState.snapshot,
    logsState.taskArn,
    selectedService?.serviceName,
  ]);

  useEffect(() => {
    const selectedServiceId = selectedService?.serviceName ?? null;
    if (!selectedServiceId || activePanel !== "tunnel") {
      return;
    }
    const cachedState =
      tunnelStatesRef.current[selectedServiceId] ?? {
        ...createEmptyTunnelState(),
        serviceName: selectedServiceId,
      };
    if (selectedContext) {
      setTunnelState((previous) =>
        buildTunnelStateFromContext(
          selectedServiceId,
          selectedContext,
          previous.serviceName === selectedServiceId ? previous : cachedState,
        ),
      );
      return;
    }
    setTunnelState((previous) => {
      const baseState =
        previous.serviceName === selectedServiceId ? previous : cachedState;
      const next = buildTunnelStateFromContext(selectedServiceId, null, baseState);
      return areTunnelStatesEqual(previous, next) ? previous : next;
    });
    if (serviceContextState?.loading || serviceContextState?.error) {
      return;
    }
    if (serviceContextState) {
      return;
    }
    void loadServiceContext(selectedServiceId);
  }, [
    activePanel,
    loadServiceContext,
    selectedContext,
    selectedService?.serviceName,
    serviceContextState?.loading,
  ]);

  useEffect(() => {
    if (
      !isActive ||
      activePanel !== "logs" ||
      !logsState.follow ||
      logsRangeMode === "absolute" ||
      !logsState.snapshot ||
      !!logsState.error ||
      !selectedService?.serviceName
    ) {
      return;
    }
    const selectedServiceId = selectedService.serviceName;
    const interval = window.setInterval(() => {
      void loadLogs({
        serviceName: selectedServiceId,
        taskArn: logsState.taskArn,
        containerName: logsState.containerName,
        followCursor: logsState.snapshot?.followCursor ?? null,
        append: true,
        silent: true,
      });
    }, 5_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    activePanel,
    isActive,
    loadLogs,
    logsState.containerName,
    logsState.follow,
    logsRangeMode,
    logsState.snapshot?.followCursor,
    logsState.taskArn,
    selectedService?.serviceName,
  ]);

  useEffect(() => {
    return () => {
      if (releaseLogsScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(releaseLogsScrollFrameRef.current);
      }
    };
  }, []);

  const filteredLogs = useMemo(() => {
    const entries = logsState.snapshot?.entries ?? [];
    const query = logsState.query.trim().toLowerCase();
    if (!query) {
      return entries;
    }
    return entries.filter((entry) => getLogEntrySearchText(entry).includes(query));
  }, [logsState.query, logsState.snapshot?.entries]);
  const trimmedLogsSearchQuery = logsState.query.trim();
  const logMatchCount = filteredLogs.length;
  const trimmedLocalFindQuery = localFindOpen ? localFindQuery.trim() : "";
  const ecsLocalFind = useMemo(() => {
    let nextMatchIndex = 0;
    const rows = filteredLogs.map((entry) => {
      const timestampText = formatLoadedAt(entry.timestamp);
      const prefixText = getLogEntryRenderedPrefix(entry);
      const timestampMatchCount = trimmedLocalFindQuery
        ? countLocalFindMatches(timestampText, trimmedLocalFindQuery)
        : 0;
      const prefixMatchCount =
        prefixText && trimmedLocalFindQuery
          ? countLocalFindMatches(prefixText, trimmedLocalFindQuery)
          : 0;
      const messageMatchCount = trimmedLocalFindQuery
        ? countLocalFindMatches(entry.message, trimmedLocalFindQuery)
        : 0;
      const matchIndexOffset = nextMatchIndex;
      nextMatchIndex +=
        timestampMatchCount + prefixMatchCount + messageMatchCount;
      return {
        entry,
        timestampText,
        prefixText,
        timestampMatchCount,
        prefixMatchCount,
        messageMatchCount,
        matchIndexOffset,
      };
    });
    return {
      rows,
      matchCount: nextMatchIndex,
    };
  }, [filteredLogs, trimmedLocalFindQuery]);

  const moveLocalFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (ecsLocalFind.matchCount === 0) {
        return;
      }
      setActiveLocalFindMatchIndex((current) => {
        const next = current + direction;
        if (next < 0) {
          return ecsLocalFind.matchCount - 1;
        }
        return next % ecsLocalFind.matchCount;
      });
    },
    [ecsLocalFind.matchCount],
  );

  useEffect(() => {
    if (!localFindOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      localFindInputRef.current?.focus();
      localFindInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [localFindOpen]);

  useEffect(() => {
    if (!isActive || activePanel !== "logs") {
      closeLocalFind();
    }
  }, [activePanel, closeLocalFind, isActive]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldOpenLogLocalFind({
          active: isActive,
          visible: activePanel === "logs",
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          defaultPrevented: event.defaultPrevented,
        })
      ) {
        return;
      }
      event.preventDefault();
      setLocalFindOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePanel, isActive]);

  useEffect(() => {
    setActiveLocalFindMatchIndex((current) => {
      if (ecsLocalFind.matchCount === 0) {
        return 0;
      }
      return Math.min(current, ecsLocalFind.matchCount - 1);
    });
  }, [ecsLocalFind.matchCount]);

  useLayoutEffect(() => {
    if (!isActive || activePanel !== "logs") {
      return;
    }
    const currentLogsTargetKey = selectedService
      ? [
          selectedService.serviceName,
          logsState.taskArn ?? "",
          logsState.containerName ?? "",
        ].join("|")
      : null;
    const enteredLogs =
      previousPanelRef.current !== "logs" && activePanel === "logs";
    const selectedLogsTargetChanged =
      previousLogsTargetRef.current !== currentLogsTargetKey;
    const isInitialLogsRender = !hasInitializedLogsViewRef.current;
    const shouldAutoScroll =
      isInitialLogsRender ||
      enteredLogs ||
      selectedLogsTargetChanged ||
      logsState.follow;

    hasInitializedLogsViewRef.current = true;
    previousLogsTargetRef.current = currentLogsTargetKey;

    if (!shouldAutoScroll) {
      return;
    }

    const logNode = logsOutputRef.current;
    if (!logNode) {
      return;
    }

    suppressLogsScrollRef.current = true;
    if (releaseLogsScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(releaseLogsScrollFrameRef.current);
    }
    logNode.scrollTop = logNode.scrollHeight;
    if (typeof logsBottomRef.current?.scrollIntoView === "function") {
      logsBottomRef.current.scrollIntoView({ block: "end" });
    }
    releaseLogsScrollFrameRef.current = window.requestAnimationFrame(() => {
      suppressLogsScrollRef.current = false;
      releaseLogsScrollFrameRef.current = null;
    });
  }, [
    activePanel,
    filteredLogs.length,
    isActive,
    logsState.containerName,
    logsState.follow,
    logsState.taskArn,
    selectedService,
  ]);

  useLayoutEffect(() => {
    if (
      !localFindOpen ||
      !trimmedLocalFindQuery ||
      ecsLocalFind.matchCount === 0
    ) {
      return;
    }
    const matchNode = localFindMatchRefs.current.get(activeLocalFindMatchIndex);
    if (!matchNode || typeof matchNode.scrollIntoView !== "function") {
      return;
    }
    suppressLogsScrollRef.current = true;
    if (releaseLogsScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(releaseLogsScrollFrameRef.current);
    }
    matchNode.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
    releaseLogsScrollFrameRef.current = window.requestAnimationFrame(() => {
      suppressLogsScrollRef.current = false;
      releaseLogsScrollFrameRef.current = null;
    });
  }, [
    activeLocalFindMatchIndex,
    ecsLocalFind.matchCount,
    localFindOpen,
    trimmedLocalFindQuery,
  ]);

  function handleLogsScroll() {
    if (!logsState.follow || suppressLogsScrollRef.current) {
      return;
    }
    const logNode = logsOutputRef.current;
    if (!logNode) {
      return;
    }
    const distanceFromBottom =
      logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight;
    if (distanceFromBottom > 24) {
      setLogsState((previous) => ({
        ...previous,
        follow: false,
      }));
    }
  }

  const handleSelectService = useCallback((serviceName: string) => {
    if (onSelectService) {
      onSelectService(host.id, serviceName);
      return;
    }
    setLocalSelectedServiceName(serviceName);
  }, [host.id, onSelectService]);

  const handleToggleLogsFollow = useCallback(() => {
    const nextFollow = !logsState.follow;
    if (nextFollow) {
      setLogsState((previous) => ({
        ...previous,
        follow: true,
        rangeMode: "recent",
        relativeRange: createDefaultLogsRelativeRange(),
        absoluteRange: null,
      }));
      if (selectedService) {
        void loadLogs({
          serviceName: selectedService.serviceName,
          taskArn: logsState.taskArn,
          containerName: logsState.containerName,
        });
      }
      return;
    }
    setLogsState((previous) => ({
      ...previous,
      follow: nextFollow,
    }));
  }, [
    loadLogs,
    logsState.containerName,
    logsState.follow,
    logsState.taskArn,
    selectedService,
  ]);

  const handleApplyLogsRange = useCallback(
    (
      nextMode: LogsRangeMode,
      nextAbsoluteValue: LogsAbsoluteRangeValue | null,
      nextRelativeValue: LogsRelativeRangeValue | null,
    ) => {
      setLogsRangePickerOpen(false);
      setLogsState((previous) => ({
        ...previous,
        follow: false,
        rangeMode: nextMode,
        relativeRange:
          nextMode === "recent"
            ? nextRelativeValue ?? createDefaultLogsRelativeRange()
            : createDefaultLogsRelativeRange(),
        absoluteRange: nextMode === "absolute" ? nextAbsoluteValue : null,
      }));
      if (!selectedService) {
        return;
      }
      const rangeArgs = nextMode === "absolute"
        ? normalizeLogsAbsoluteRange(nextAbsoluteValue)
        : normalizeLogsRelativeRange(
            nextRelativeValue ?? createDefaultLogsRelativeRange(),
          );
      void loadLogs({
        serviceName: selectedService.serviceName,
        taskArn: logsState.taskArn,
        containerName: logsState.containerName,
        followCursor: null,
        startTime: rangeArgs?.startTime ?? null,
        endTime: rangeArgs?.endTime ?? null,
      });
    },
    [loadLogs, logsState.containerName, logsState.taskArn, selectedService],
  );

  const handleOpenShell = useCallback(
    async (serviceName: string) => {
      handleSelectService(serviceName);
      setShellPickerState({
        open: true,
        serviceName,
        loading: true,
        error: null,
        taskArn: null,
        containerName: null,
        submitting: false,
      });
      const context = await loadServiceContext(serviceName);
      setShellPickerState((previous) =>
        buildShellPickerStateFromContext(serviceName, context, previous),
      );
    },
    [handleSelectService, loadServiceContext],
  );

  const handleRetryTunnelContext = useCallback(async () => {
    if (!selectedService) {
      return;
    }
    const context = await loadServiceContext(selectedService.serviceName, true);
    setTunnelState((previous) =>
      buildTunnelStateFromContext(selectedService.serviceName, context, previous),
    );
  }, [loadServiceContext, selectedService]);

  const handleStartTunnel = useCallback(async () => {
    if (!selectedService || !tunnelState.taskArn || !tunnelState.containerName) {
      return;
    }
    const targetPort = Number(tunnelState.targetPort);
    const bindPort = tunnelState.autoLocalPort ? 0 : Number(tunnelState.bindPort);
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
      loading: true,
      error: null,
    }));
    try {
      const runtime = await startEcsServiceTunnel({
        hostId: host.id,
        serviceName: selectedService.serviceName,
        taskArn: tunnelState.taskArn,
        containerName: tunnelState.containerName,
        targetPort,
        bindAddress: "127.0.0.1",
        bindPort,
      });
      setTunnelState((previous) => ({
        ...previous,
        loading: false,
        runtime,
        error: null,
      }));
    } catch (error) {
      setTunnelState((previous) => ({
        ...previous,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "ECS 터널을 시작하지 못했습니다.",
      }));
    }
  }, [host.id, selectedService, tunnelState]);

  const handleStopTunnel = useCallback(async () => {
    if (!tunnelState.runtime?.ruleId) {
      return;
    }
    const runtimeId = tunnelState.runtime.ruleId;
    setTunnelState((previous) => ({
      ...previous,
      loading: true,
      error: null,
    }));
    try {
      await stopEcsServiceTunnel(runtimeId);
      setTunnelState((previous) =>
        previous.runtime?.ruleId === runtimeId
          ? { ...previous, loading: false, runtime: null }
          : previous,
      );
    } catch (error) {
      setTunnelState((previous) => ({
        ...previous,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "ECS 터널을 중지하지 못했습니다.",
      }));
    }
  }, [tunnelState.runtime?.ruleId]);

  const handleSubmitShell = useCallback(async () => {
    if (
      !shellPickerState.serviceName ||
      !shellPickerState.taskArn ||
      !shellPickerState.containerName
    ) {
      return;
    }
    setShellPickerState((previous) => ({
      ...previous,
      submitting: true,
      error: null,
    }));
    try {
      await onOpenEcsExecShell(
        host.id,
        shellPickerState.serviceName,
        shellPickerState.taskArn,
        shellPickerState.containerName,
      );
      setShellPickerState(createEmptyShellPickerState());
    } catch (error) {
      setShellPickerState((previous) => ({
        ...previous,
        submitting: false,
        error:
          error instanceof Error
            ? error.message
            : "ECS 셸 연결을 시작하지 못했습니다.",
      }));
    }
  }, [
    host.id,
    onOpenEcsExecShell,
    shellPickerState.containerName,
    shellPickerState.serviceName,
    shellPickerState.taskArn,
  ]);

  const tunnelTaskOptions = selectedContext?.runningTasks ?? [];
  const tunnelContainerOptions = getContainersForTask(
    selectedContext,
    tunnelState.taskArn,
    { requirePorts: true },
  );
  const tunnelPortOptions =
    tunnelContainerOptions.find(
      (container) => container.containerName === tunnelState.containerName,
    )?.ports ?? [];
  const isTunnelContextReady =
    Boolean(selectedService) &&
    Boolean(selectedContext) &&
    tunnelState.serviceName === selectedService?.serviceName;
  const isTunnelFormDisabled =
    tunnelState.loading || Boolean(serviceContextState?.loading) || !isTunnelContextReady;
  const canStartTunnel =
    !isTunnelFormDisabled &&
    Boolean(tunnelState.taskArn) &&
    Boolean(tunnelState.containerName) &&
    Boolean(tunnelState.targetPort);
  const tunnelRuntimeLocalEndpoint = tunnelState.runtime
    ? tunnelState.runtime.bindPort > 0
      ? `${tunnelState.runtime.bindAddress}:${tunnelState.runtime.bindPort}`
      : "자동 할당 중..."
    : null;
  const tunnelRuntimeRemoteEndpoint = tunnelState.runtime
    ? `127.0.0.1:${tunnelState.targetPort || "-"}`
    : null;
  const shellTaskOptions = shellPickerState.serviceName
    ? serviceContexts[shellPickerState.serviceName]?.data?.runningTasks ?? []
    : [];
  const shellContainerOptions = getContainersForTask(
    shellPickerState.serviceName
      ? serviceContexts[shellPickerState.serviceName]?.data ?? null
      : null,
    shellPickerState.taskArn,
    { requireExec: true },
  );
  const ssoActionError = ssoLoginActionState.error ? (
    <p className="text-[0.86rem] font-semibold text-[var(--danger-text)]">
      {ssoLoginActionState.error}
    </p>
  ) : null;
  const progressSsoAction = canOpenSsoLoginFromProgress ? (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={ssoLoginActionState.loading}
        onClick={() => {
          void openAwsSsoLogin();
        }}
      >
        {ssoLoginActionState.loading ? "브라우저 여는 중..." : "브라우저 다시 열기"}
      </Button>
      {ssoActionError}
    </div>
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
      {!logsFocusModeActive ? (
        <Toolbar className="justify-between gap-4 rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-[1.15rem] py-[1.1rem]">
          <div>
            <div className="flex flex-wrap gap-2 text-[0.9rem] text-[var(--text-soft)]">
              <span>{getHostBadgeLabel(host)}</span>
              <span>{getHostSubtitle(host)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={tab.isLoading}
              onClick={() => {
                void onRefresh(host.id);
              }}
            >
              {tab.isLoading ? "불러오는 중..." : "Refresh"}
            </Button>
          </div>
        </Toolbar>
      ) : null}

      {tab.errorMessage ? (
        <NoticeCard tone="danger" role="alert">
          <p>{tab.errorMessage}</p>
          {canRecoverSsoError ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={ssoLoginActionState.loading}
                onClick={() => {
                  void openAwsSsoLogin({ refreshAfterLogin: true });
                }}
              >
                {ssoLoginActionState.loading
                  ? "브라우저 여는 중..."
                  : "브라우저에서 로그인"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={tab.isLoading || ssoLoginActionState.loading}
                onClick={() => {
                  void onRefresh(host.id);
                }}
              >
                다시 시도
              </Button>
              {ssoActionError}
            </div>
          ) : null}
        </NoticeCard>
      ) : null}

      {tab.ecsMetricsWarning ? (
        <NoticeCard tone="warning" title="Metrics warning">
          <p>{tab.ecsMetricsWarning}</p>
        </NoticeCard>
      ) : null}

      {snapshot && tab.isLoading && tab.connectionProgress ? (
        <NoticeCard tone="info" title={progressTitle}>
          <p>{progressMessage}</p>
          {progressSsoAction}
        </NoticeCard>
      ) : null}

      {tab.isLoading && !snapshot ? (
        <NoticeCard tone="info" title={progressTitle} className="max-w-[620px]">
          <p>{progressMessage}</p>
          {progressSsoAction}
        </NoticeCard>
      ) : null}

      {snapshot ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            logsFocusModeActive ? "gap-2" : "gap-[0.95rem]",
          )}
        >
          {!logsFocusModeActive ? (
            <div
              className="grid shrink-0 gap-[0.9rem] lg:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]"
              data-testid="ecs-summary-cards"
            >
              <Card className="items-start">
                <CardMain>
                  <CardTitleRow>
                    <strong>{snapshot.cluster.clusterName}</strong>
                    <StatusBadge tone={getRolloutTone(snapshot.cluster.status)}>
                      {snapshot.cluster.status}
                    </StatusBadge>
                  </CardTitleRow>
                  <CardMeta>
                    <span>{snapshot.profileName}</span>
                    <span>{snapshot.region}</span>
                    <span>마지막 갱신 {formatLoadedAt(snapshot.loadedAt)}</span>
                  </CardMeta>
                </CardMain>
              </Card>

              <Card className="items-start">
                <CardMain>
                  <CardTitleRow>
                    <strong>Services</strong>
                  </CardTitleRow>
                  <CardMeta className="mt-1">
                    <span>Active {snapshot.cluster.activeServicesCount}</span>
                    <span>Running {snapshot.cluster.runningTasksCount}</span>
                    <span>Pending {snapshot.cluster.pendingTasksCount}</span>
                  </CardMeta>
                </CardMain>
              </Card>
            </div>
          ) : null}

          <div
            className={cn(
              "grid min-h-0 flex-1",
              logsFocusModeActive
                ? "gap-0"
                : "gap-4 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]",
            )}
            data-testid={logsFocusModeActive ? "ecs-logs-focus-layout" : undefined}
          >
            {!logsFocusModeActive ? (
              <aside
                className="flex min-h-0 flex-col gap-4 overflow-hidden rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.15rem]"
                data-testid="ecs-services-sidebar"
              >
                <div className="flex items-center justify-between gap-3">
                  <strong>Services</strong>
                  <span>{services.length}</span>
                </div>

                {services.length === 0 ? (
                  <EmptyState title="이 클러스터에는 표시할 서비스가 없습니다." />
                ) : (
                  <div className="flex min-h-0 flex-col gap-[0.55rem] overflow-y-auto pr-px">
                    {services.map((service) => {
                      const isSelected = service.serviceName === selectedService?.serviceName;
                      return (
                        <article
                          key={service.serviceArn}
                          data-testid="ecs-service-row"
                          className={cn(
                            "shrink-0 overflow-hidden rounded-[18px] border bg-[color-mix(in_srgb,var(--surface)_92%,transparent_8%)] shadow-none transition-[border-color,background-color] duration-150",
                            "border-[var(--border)]",
                            isSelected
                              ? "border-[var(--selection-border)] bg-[var(--selection-tint)]"
                              : "",
                          )}
                        >
                          <button
                            type="button"
                            className="grid w-full min-w-0 content-start gap-[0.34rem] border-0 bg-transparent px-[0.95rem] py-[0.72rem] text-left text-inherit"
                            onClick={() => {
                              handleSelectService(service.serviceName);
                            }}
                          >
                            <strong className="block min-w-0 overflow-wrap-anywhere leading-[1.35]">
                              {service.serviceName}
                            </strong>
                            <div className="flex flex-wrap gap-[0.45rem]">
                              <StatusBadge
                                tone={getServiceStatusTone(service)}
                                className="min-h-[1.55rem] px-[0.62rem] py-[0.14rem] text-[0.72rem]"
                              >
                                {service.status}
                              </StatusBadge>
                              {service.rolloutState ? (
                                <StatusBadge
                                  tone={getRolloutTone(service.rolloutState)}
                                  className="min-h-[1.55rem] px-[0.62rem] py-[0.14rem] text-[0.72rem]"
                                >
                                  {service.rolloutState}
                                </StatusBadge>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-[0.55rem_0.8rem] text-[0.84rem] text-[var(--text-soft)]">
                              <span>CPU {formatPercent(service.cpuUtilizationPercent)}</span>
                              <span>
                                Memory {formatPercent(service.memoryUtilizationPercent)}
                              </span>
                            </div>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </aside>
            ) : null}

            <section
              className={cn(
                "flex min-h-0 flex-col overflow-hidden border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)]",
                logsFocusModeActive
                  ? "gap-2 rounded-[20px] p-[0.8rem]"
                  : isLogsPanel
                    ? "gap-3 rounded-[24px] p-[0.95rem]"
                    : "gap-4 rounded-[24px] p-[1.15rem]",
              )}
            >
              {selectedService ? (
                <>
                  <div
                    className={cn(
                      "shrink-0",
                      logsFocusModeActive
                        ? "flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-muted)_70%,transparent_30%)] px-3 py-2"
                        : "grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_auto]",
                    )}
                  >
                    <div
                      className={cn(
                        "min-w-0",
                        logsFocusModeActive
                          ? "flex flex-wrap items-center gap-2"
                          : "",
                      )}
                    >
                      <CardTitleRow>
                        <h3>{selectedService.serviceName}</h3>
                        <StatusBadge tone={getServiceStatusTone(selectedService)}>
                          {selectedService.status}
                        </StatusBadge>
                        {selectedService.rolloutState ? (
                          <StatusBadge tone={getRolloutTone(selectedService.rolloutState)}>
                            {selectedService.rolloutState}
                          </StatusBadge>
                        ) : null}
                      </CardTitleRow>
                      {!logsFocusModeActive ? (
                        <CardMeta>
                          <span>{selectedService.capacityProviderSummary || selectedService.launchType || "Launch type unavailable"}</span>
                          <span>
                            Task def{" "}
                            {selectedService.taskDefinitionRevision
                              ? String(selectedService.taskDefinitionRevision)
                              : selectedService.taskDefinitionArn || "-"}
                          </span>
                          {formatServicePorts(selectedService) ? (
                            <span>{formatServicePorts(selectedService)}</span>
                          ) : null}
                          {getExposureBadgeLabels(selectedService.exposureKinds).map((label) => (
                            <Badge
                              key={`${selectedService.serviceArn}:${label}`}
                              tone="neutral"
                              className="min-h-[1.42rem] border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)] px-[0.48rem] py-[0.04rem] text-[0.74rem] font-semibold text-[var(--text-soft)]"
                            >
                              {label}
                            </Badge>
                          ))}
                        </CardMeta>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "flex shrink-0 items-end justify-end self-start",
                        logsFocusModeActive
                          ? "flex-wrap gap-2"
                          : "flex-col gap-3 max-[980px]:w-full max-[980px]:items-start",
                      )}
                    >
                      {logsFocusModeActive ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              void handleOpenShell(selectedService.serviceName);
                            }}
                          >
                            쉘 접속
                          </Button>
                          {isLogsPanel ? (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => {
                                setLogsFocusMode((current) => !current);
                              }}
                            >
                              일반 보기
                            </Button>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <div
                            className="flex flex-wrap justify-end gap-2 max-[980px]:justify-start"
                            data-testid="ecs-service-action-controls"
                          >
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                void handleOpenShell(selectedService.serviceName);
                              }}
                            >
                              쉘 접속
                            </Button>
                          </div>
                          <div
                            className="flex w-full flex-wrap items-center justify-end gap-3 max-[980px]:justify-start"
                            data-testid="ecs-panel-switcher-row"
                          >
                            <Tabs
                              role="tablist"
                              aria-label="ECS 서비스 상세 패널"
                              className={cn(
                                ecsDetailTabsClass,
                                "min-w-0 max-[980px]:overflow-x-auto",
                              )}
                            >
                              {(
                                [
                                  ["overview", "Overview"],
                                  ["logs", "Logs"],
                                  ["metrics", "Metrics"],
                                  ["tunnel", "Tunnel"],
                                ] as Array<[EcsDetailPanel, string]>
                              ).map(([panel, label]) => (
                                <TabButton
                                  key={panel}
                                  role="tab"
                                  aria-selected={activePanel === panel}
                                  active={activePanel === panel}
                                  className={cn(
                                    ecsDetailTabButtonBaseClass,
                                    activePanel === panel
                                      ? ecsDetailTabButtonActiveClass
                                      : ecsDetailTabButtonInactiveClass,
                                  )}
                                  onClick={() => {
                                    if (onSetPanel) {
                                      onSetPanel(host.id, panel);
                                      return;
                                    }
                                    setLocalActivePanel(panel);
                                  }}
                                >
                                  {label}
                                </TabButton>
                              ))}
                            </Tabs>
                            {isLogsPanel ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  setLogsFocusMode((current) => !current);
                                }}
                              >
                                로그 크게 보기
                              </Button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      "flex min-h-0 flex-1 flex-col",
                      logsFocusModeActive ? "gap-2" : "gap-[0.9rem]",
                    )}
                  >
                    {activePanel === "overview" ? (
                      <div className="flex min-h-0 flex-1 flex-col gap-[0.9rem] overflow-y-auto pr-[0.1rem]">
                        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[1180px]:grid-cols-1">
                          <section className={ecsSectionCardClass}>
                            <div className="flex items-center justify-between gap-3">
                              <h3 className="m-0 text-[1rem] font-semibold text-[var(--text)]">
                                서비스 요약
                              </h3>
                            </div>
                            <dl className={ecsFactsGridClass}>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>CPU</dt>
                                <dd className={ecsFactsValueClass}>
                                  {formatPercent(selectedService.cpuUtilizationPercent)}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Memory</dt>
                                <dd className={ecsFactsValueClass}>
                                  {formatPercent(selectedService.memoryUtilizationPercent)}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Tasks</dt>
                                <dd className={ecsFactsValueClass}>
                                  {selectedService.runningCount} / {selectedService.desiredCount}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Pending</dt>
                                <dd className={ecsFactsValueClass}>
                                  {selectedService.pendingCount}
                                </dd>
                              </div>
                            </dl>
                          </section>

                          <section className={ecsSectionCardClass}>
                            <div className="flex items-center justify-between gap-3">
                              <h3 className="m-0 text-[1rem] font-semibold text-[var(--text)]">
                                배포 정보
                              </h3>
                            </div>
                            <dl className={ecsFactsGridClass}>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Launch</dt>
                                <dd className={ecsFactsValueClass}>
                                  {selectedService.launchType || "-"}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Capacity</dt>
                                <dd className={ecsFactsValueClass}>
                                  {selectedService.capacityProviderSummary || "-"}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Ports</dt>
                                <dd className={ecsFactsValueClass}>
                                  {formatServicePorts(selectedService) || "-"}
                                </dd>
                              </div>
                              <div className={ecsFactsItemClass}>
                                <dt className={ecsFactsLabelClass}>Task def</dt>
                                <dd className={ecsFactsValueClass}>
                                  {selectedService.taskDefinitionRevision
                                    ? `rev ${selectedService.taskDefinitionRevision}`
                                    : "-"}
                                </dd>
                              </div>
                            </dl>
                          </section>
                        </div>

                        <section className={ecsSectionCardClass}>
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="m-0 text-[1rem] font-semibold text-[var(--text)]">
                              Deployments
                            </h3>
                          </div>
                          {selectedService.deployments?.length ? (
                            <div className={ecsTimelineClass}>
                              {selectedService.deployments.map((deployment) => (
                                <article key={deployment.id} className={ecsTimelineItemClass}>
                                  <CardTitleRow>
                                    <strong>{deployment.status}</strong>
                                    {deployment.rolloutState ? (
                                      <StatusBadge tone={getRolloutTone(deployment.rolloutState)}>
                                        {deployment.rolloutState}
                                      </StatusBadge>
                                    ) : null}
                                  </CardTitleRow>
                                  <CardMeta>
                                    <span>
                                      {deployment.runningCount ?? 0} /{" "}
                                      {deployment.desiredCount ?? 0}
                                    </span>
                                    <span>Pending {deployment.pendingCount ?? 0}</span>
                                    <span>
                                      Task def{" "}
                                      {deployment.taskDefinitionRevision
                                        ? deployment.taskDefinitionRevision
                                        : "-"}
                                    </span>
                                    {deployment.updatedAt ? (
                                      <span>{formatLoadedAt(deployment.updatedAt)}</span>
                                    ) : null}
                                  </CardMeta>
                                  {deployment.rolloutStateReason ? (
                                    <CardMessage>
                                      {deployment.rolloutStateReason}
                                    </CardMessage>
                                  ) : null}
                                </article>
                              ))}
                            </div>
                          ) : (
                            <div className={ecsEmptyDetailClass}>
                              표시할 deployment 정보가 없습니다.
                            </div>
                          )}
                        </section>

                        <section className={ecsSectionCardClass}>
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="m-0 text-[1rem] font-semibold text-[var(--text)]">
                              Recent events
                            </h3>
                          </div>
                          {selectedService.events?.length ? (
                            <div className={ecsTimelineClass}>
                              {selectedService.events.map((event) => (
                                <article key={event.id} className={ecsTimelineItemClass}>
                                  <CardMeta>
                                    {event.createdAt ? (
                                      <span>{formatLoadedAt(event.createdAt)}</span>
                                    ) : null}
                                  </CardMeta>
                                  <CardMessage>{event.message}</CardMessage>
                                </article>
                              ))}
                            </div>
                          ) : (
                            <div className={ecsEmptyDetailClass}>
                              표시할 최근 이벤트가 없습니다.
                            </div>
                          )}
                        </section>
                      </div>
                    ) : null}

                    {activePanel === "logs" ? (
                      <div
                        className={cn(
                          "grid min-h-0 flex-1 grid-rows-[auto_auto_auto_auto_1fr]",
                          logsFocusModeActive ? "gap-[0.45rem]" : "gap-[0.9rem]",
                        )}
                      >
                        <FilterRow
                          className={cn(
                            "items-center justify-between",
                            logsFocusModeActive ? "gap-2 rounded-[16px]" : "",
                          )}
                          style={logsFocusModeActive ? { padding: "0.55rem" } : undefined}
                        >
                          <ToggleSwitch
                            checked={logsState.follow}
                            label="Follow"
                            className="w-auto max-w-max"
                            onClick={() => {
                              handleToggleLogsFollow();
                            }}
                            disabled={logsState.loading}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            active={logsRangeMode === "absolute"}
                            aria-label="로그 범위"
                            className="max-w-[min(360px,100%)] overflow-hidden text-ellipsis whitespace-nowrap"
                            onClick={() => {
                              setLogsRangePickerOpen(true);
                            }}
                            disabled={logsState.loading}
                          >
                            {logsRangeLabel}
                          </Button>
                          <FieldGroup label="Task" compact>
                            <SelectField
                              value={logsState.taskArn ?? ""}
                              disabled={logsState.loading}
                              onChange={(event) => {
                                const nextTaskArn = event.target.value || null;
                                const rangeArgs = buildLogsRangeArgs();
                                void loadLogs({
                                  serviceName: selectedService.serviceName,
                                  taskArn: nextTaskArn,
                                  containerName: logsState.containerName,
                                  followCursor: rangeArgs.followCursor,
                                  startTime: rangeArgs.startTime,
                                  endTime: rangeArgs.endTime,
                                });
                              }}
                            >
                              <option value="">All tasks</option>
                              {(logsState.snapshot?.taskOptions ?? []).map((task) => (
                                <option key={task.taskArn} value={task.taskArn}>
                                  {task.taskId}
                                </option>
                              ))}
                            </SelectField>
                          </FieldGroup>
                          <FieldGroup label="Container" compact>
                            <SelectField
                              value={logsState.containerName ?? ""}
                              disabled={logsState.loading}
                              onChange={(event) => {
                                const nextContainer = event.target.value || null;
                                const rangeArgs = buildLogsRangeArgs();
                                void loadLogs({
                                  serviceName: selectedService.serviceName,
                                  taskArn: logsState.taskArn,
                                  containerName: nextContainer,
                                  followCursor: rangeArgs.followCursor,
                                  startTime: rangeArgs.startTime,
                                  endTime: rangeArgs.endTime,
                                });
                              }}
                            >
                              <option value="">All containers</option>
                              {(logsState.snapshot?.containerOptions ?? []).map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </SelectField>
                          </FieldGroup>
                          <div className="flex min-w-[18rem] flex-1 flex-wrap items-center gap-3">
                            <Input
                              type="search"
                              className="min-w-[14rem] flex-1"
                              aria-label="로그 검색"
                              value={logsState.query}
                              placeholder="로그 검색"
                              onChange={(event) => {
                                setLogsState((previous) => ({
                                  ...previous,
                                  query: event.target.value,
                                }));
                              }}
                            />
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={logsState.loading}
                            onClick={() => {
                              const rangeArgs = buildLogsRangeArgs();
                              void loadLogs({
                                serviceName: selectedService.serviceName,
                                taskArn: logsState.taskArn,
                                containerName: logsState.containerName,
                                followCursor: rangeArgs.followCursor,
                                startTime: rangeArgs.startTime,
                                endTime: rangeArgs.endTime,
                              });
                            }}
                          >
                            {logsState.loading ? "불러오는 중..." : "다시 불러오기"}
                          </Button>
                        </FilterRow>

                        {trimmedLogsSearchQuery ? (
                          <div className="text-[0.84rem] text-[var(--text-soft)]">
                            현재 버퍼에서 {logMatchCount}건 일치
                          </div>
                        ) : null}

                        {logsState.loading && !logsState.snapshot ? (
                          <NoticeCard title="서비스 로그를 불러오는 중입니다." />
                        ) : null}

                        {logsState.error ? (
                          <NoticeCard tone="danger" role="alert">
                            {logsState.error}
                          </NoticeCard>
                        ) : null}

                        {logsState.snapshot?.unsupportedReason ? (
                          <NoticeCard title={logsState.snapshot.unsupportedReason} />
                        ) : null}

                        {logsState.snapshot && !logsState.snapshot.unsupportedReason ? (
                          <>
                            <CardMeta className={ecsLogsMetaClass}>
                              <span>마지막 갱신 {formatLoadedAt(logsState.snapshot.loadedAt)}</span>
                              <span>{logsRangeLabel}</span>
                              <span>{filteredLogs.length} lines</span>
                            </CardMeta>
                            {localFindOpen ? (
                              <LogLocalFindBar
                                inputRef={localFindInputRef}
                                query={localFindQuery}
                                matchCount={ecsLocalFind.matchCount}
                                activeMatchIndex={activeLocalFindMatchIndex}
                                onQueryChange={(query) => {
                                  setLocalFindQuery(query);
                                  setActiveLocalFindMatchIndex(0);
                                }}
                                onPrevious={() => moveLocalFindMatch(-1)}
                                onNext={() => moveLocalFindMatch(1)}
                                onClose={closeLocalFind}
                              />
                            ) : null}
                            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                              {logsState.refreshing ? (
                                <div
                                  className={ecsLogsOverlayChipClass}
                                  data-testid="ecs-logs-loading-chip"
                                >
                                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--accent-strong)]" />
                                  갱신 중...
                                </div>
                              ) : null}
                              <div
                                ref={logsOutputRef}
                                className={ecsLogsOutputClass}
                                data-testid="ecs-logs-output"
                                onScroll={handleLogsScroll}
                              >
                                {filteredLogs.length === 0 ? (
                                  <div className={ecsEmptyDetailClass}>
                                    {trimmedLogsSearchQuery
                                      ? "검색 결과가 없습니다."
                                      : "표시할 로그가 없습니다."}
                                  </div>
                                ) : (
                                  ecsLocalFind.rows.map((row) => (
                                    <div
                                      key={row.entry.id}
                                      className="grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-[0.9rem]"
                                    >
                                      <span
                                        className="whitespace-nowrap text-[rgba(163,181,214,0.82)]"
                                        title={row.entry.timestamp}
                                      >
                                        {
                                          renderLocalFindHighlightedText(
                                            row.timestampText,
                                            trimmedLocalFindQuery,
                                            {
                                              activeMatchIndex:
                                                activeLocalFindMatchIndex,
                                              matchIndexOffset:
                                                row.matchIndexOffset,
                                              registerMatchRef:
                                                registerLocalFindMatchRef,
                                              keyPrefix: `ecs-log:${row.entry.id}:timestamp`,
                                            },
                                          ).nodes
                                        }
                                      </span>
                                      <span className="min-w-0 break-words whitespace-pre-wrap">
                                        {row.prefixText ? (
                                          <span className="text-[rgba(163,181,214,0.82)]">
                                            {
                                              renderLocalFindHighlightedText(
                                                row.prefixText,
                                                trimmedLocalFindQuery,
                                                {
                                                  activeMatchIndex:
                                                    activeLocalFindMatchIndex,
                                                  matchIndexOffset:
                                                    row.matchIndexOffset +
                                                    row.timestampMatchCount,
                                                  registerMatchRef:
                                                    registerLocalFindMatchRef,
                                                  keyPrefix: `ecs-log:${row.entry.id}:prefix`,
                                                },
                                              ).nodes
                                            }{" "}
                                          </span>
                                        ) : null}
                                        {
                                          renderLocalFindHighlightedText(
                                            row.entry.message,
                                            trimmedLocalFindQuery,
                                            {
                                              activeMatchIndex:
                                                activeLocalFindMatchIndex,
                                              matchIndexOffset:
                                                row.matchIndexOffset +
                                                row.timestampMatchCount +
                                                row.prefixMatchCount,
                                              registerMatchRef:
                                                registerLocalFindMatchRef,
                                              keyPrefix: `ecs-log:${row.entry.id}:message`,
                                            },
                                          ).nodes
                                        }
                                      </span>
                                    </div>
                                  ))
                                )}
                                <div
                                  ref={logsBottomRef}
                                  className="h-px w-full"
                                  aria-hidden="true"
                                />
                              </div>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}

                    {activePanel === "metrics" ? (
                      <MetricsPanel
                        service={selectedService}
                        history={selectedServiceHistory}
                      />
                    ) : null}

                    {activePanel === "tunnel" ? (
                      <div className="flex min-h-0 flex-1 flex-col gap-[0.9rem] overflow-y-auto pr-[0.1rem]">
                        {serviceContextState?.loading && !selectedContext ? (
                          <NoticeCard title="터널 대상을 준비하는 중입니다." />
                        ) : null}

                        {serviceContextState?.error ? (
                          <NoticeCard tone="danger" role="alert">
                            <p>{serviceContextState.error}</p>
                            <div className="mt-2 flex justify-start">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  void handleRetryTunnelContext();
                                }}
                              >
                                다시 시도
                              </Button>
                            </div>
                          </NoticeCard>
                        ) : null}

                        <div className={ecsTunnelFormClass}>
                          <FieldGroup label="Task">
                            <SelectField
                              value={tunnelState.taskArn ?? ""}
                              disabled={isTunnelFormDisabled}
                              onChange={(event) => {
                                const nextTaskArn = event.target.value || null;
                                const nextContainers = getContainersForTask(
                                  selectedContext,
                                  nextTaskArn,
                                  { requirePorts: true },
                                );
                                const nextContainerName =
                                  nextContainers[0]?.containerName ?? null;
                                const nextTargetPort =
                                  nextContainers[0]?.ports[0]
                                    ? String(nextContainers[0].ports[0].port)
                                    : "";
                                setTunnelState((previous) => ({
                                  ...previous,
                                  taskArn: nextTaskArn,
                                  containerName: nextContainerName,
                                  targetPort: nextTargetPort,
                                }));
                              }}
                            >
                              {tunnelTaskOptions.length === 0 ? (
                                <option value="">실행 중인 task 없음</option>
                              ) : null}
                              {tunnelTaskOptions.map((task) => (
                                <option key={task.taskArn} value={task.taskArn}>
                                  {getTaskLabel(task)}
                                </option>
                              ))}
                            </SelectField>
                          </FieldGroup>
                          <FieldGroup label="Container">
                            <SelectField
                              value={tunnelState.containerName ?? ""}
                              disabled={isTunnelFormDisabled}
                              onChange={(event) => {
                                const nextContainerName = event.target.value || null;
                                const nextTargetPort =
                                  tunnelContainerOptions.find(
                                    (container) =>
                                      container.containerName === nextContainerName,
                                  )?.ports[0]?.port ?? "";
                                setTunnelState((previous) => ({
                                  ...previous,
                                  containerName: nextContainerName,
                                  targetPort: nextTargetPort
                                    ? String(nextTargetPort)
                                    : "",
                                }));
                              }}
                            >
                              {tunnelContainerOptions.length === 0 ? (
                                <option value="">선택 가능한 컨테이너 없음</option>
                              ) : null}
                              {tunnelContainerOptions.map((container) => (
                                <option
                                  key={container.containerName}
                                  value={container.containerName}
                                >
                                  {container.containerName}
                                </option>
                              ))}
                            </SelectField>
                          </FieldGroup>
                          <FieldGroup label="Port">
                            <SelectField
                              value={tunnelState.targetPort}
                              disabled={
                                isTunnelFormDisabled || tunnelPortOptions.length === 0
                              }
                              onChange={(event) => {
                                setTunnelState((previous) => ({
                                  ...previous,
                                  targetPort: event.target.value,
                                }));
                              }}
                            >
                              {tunnelPortOptions.length === 0 ? (
                                <option value="">포트 없음</option>
                              ) : null}
                              {tunnelPortOptions.map((port) => (
                                <option
                                  key={`${port.port}/${port.protocol}`}
                                  value={String(port.port)}
                                >
                                  {port.port}/{port.protocol}
                                </option>
                              ))}
                            </SelectField>
                          </FieldGroup>
                          <FieldGroup label="Local port">
                            <div className="grid gap-3">
                              <ToggleSwitch
                                checked={tunnelState.autoLocalPort}
                                label="Auto (random)"
                                description="사용 가능한 로컬 포트를 자동으로 할당합니다."
                                disabled={isTunnelFormDisabled}
                                onClick={() => {
                                  setTunnelState((previous) => ({
                                    ...previous,
                                    autoLocalPort: !previous.autoLocalPort,
                                    bindPort: previous.autoLocalPort
                                      ? previous.bindPort || "9000"
                                      : "",
                                  }));
                                }}
                              />
                              <Input
                                type="number"
                                className="min-h-[2.35rem] rounded-[12px] bg-[var(--surface)] px-[0.7rem] py-[0.45rem]"
                                value={tunnelState.bindPort}
                                placeholder="0"
                                disabled={
                                  isTunnelFormDisabled || tunnelState.autoLocalPort
                                }
                                onChange={(event) => {
                                  setTunnelState((previous) => ({
                                    ...previous,
                                    bindPort: event.target.value,
                                  }));
                                }}
                              />
                            </div>
                          </FieldGroup>
                        </div>

                        {tunnelState.runtime ? (
                          <div className={ecsTunnelRuntimeCardClass}>
                            <div className="flex items-center justify-between gap-3">
                              <strong>터널 상태</strong>
                              <StatusBadge tone={tunnelState.runtime.status}>
                                {tunnelState.runtime.status === "running"
                                  ? "Running"
                                  : tunnelState.runtime.status}
                              </StatusBadge>
                            </div>
                            <div className={ecsTunnelRuntimeGridClass}>
                              <div className="grid gap-[0.22rem]">
                                <span className="text-[0.76rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]">
                                  Local
                                </span>
                                <strong className="break-words text-[1rem] leading-[1.35] text-[var(--text)]">
                                  {tunnelRuntimeLocalEndpoint}
                                </strong>
                              </div>
                              <div className="grid gap-[0.22rem]">
                                <span className="text-[0.76rem] font-semibold uppercase tracking-[0.02em] text-[var(--text-soft)]">
                                  Remote
                                </span>
                                <strong className="break-words text-[1rem] leading-[1.35] text-[var(--text)]">
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
                            <Button
                              variant="secondary"
                              disabled={tunnelState.loading}
                              onClick={() => {
                                void handleStopTunnel();
                              }}
                            >
                              {tunnelState.loading ? "정지 중..." : "Stop"}
                            </Button>
                          ) : (
                            <Button
                              variant="primary"
                              disabled={!canStartTunnel}
                              onClick={() => {
                                void handleStartTunnel();
                              }}
                            >
                              {tunnelState.loading ? "시작 중..." : "Start tunnel"}
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <EmptyState title="선택된 서비스가 없습니다." />
              )}
            </section>
          </div>

          <LogsRangePickerDialog
            open={logsRangePickerOpen}
            mode={logsRangeMode}
            absoluteValue={logsAbsoluteRange}
            relativeValue={logsRelativeRange}
            onClose={() => {
              setLogsRangePickerOpen(false);
            }}
            onApply={handleApplyLogsRange}
          />

          {shellPickerState.open ? (
            <div
              className="fixed inset-0 z-[8] grid place-items-center bg-[rgba(12,20,32,0.32)]"
              role="presentation"
            >
              <ModalShell
                size="md"
                role="dialog"
                aria-modal="true"
                aria-label="ECS shell picker"
              >
                <ModalHeader>
                  <div>
                    <h3 className="m-0">쉘 접속</h3>
                    <p className="mt-2 text-[var(--text-soft)]">
                      실행 중인 task와 컨테이너를 고른 뒤 ECS Exec 세션을 엽니다.
                    </p>
                  </div>
                </ModalHeader>

                {shellPickerState.error ? (
                  <div className="px-6 pt-4">
                    <NoticeCard tone="danger" role="alert">
                      {shellPickerState.error}
                    </NoticeCard>
                  </div>
                ) : null}

                <ModalBody className="grid gap-4">
                  <FieldGroup label="Task">
                    <SelectField
                      value={shellPickerState.taskArn ?? ""}
                      disabled={shellPickerState.loading}
                      onChange={(event) => {
                        const nextTaskArn = event.target.value || null;
                        const nextContainers = getContainersForTask(
                          shellPickerState.serviceName
                            ? serviceContexts[shellPickerState.serviceName]?.data ?? null
                            : null,
                          nextTaskArn,
                          { requireExec: true },
                        );
                        setShellPickerState((previous) => ({
                          ...previous,
                          taskArn: nextTaskArn,
                          containerName: nextContainers[0]?.containerName ?? null,
                        }));
                      }}
                    >
                      {shellTaskOptions.length === 0 ? (
                        <option value="">실행 중인 task 없음</option>
                      ) : null}
                      {shellTaskOptions.map((task) => (
                        <option key={task.taskArn} value={task.taskArn}>
                          {getTaskLabel(task)}
                        </option>
                      ))}
                    </SelectField>
                  </FieldGroup>
                  <FieldGroup label="Container">
                    <SelectField
                      value={shellPickerState.containerName ?? ""}
                      disabled={shellPickerState.loading}
                      onChange={(event) => {
                        setShellPickerState((previous) => ({
                          ...previous,
                          containerName: event.target.value || null,
                        }));
                      }}
                    >
                      {shellContainerOptions.length === 0 ? (
                        <option value="">선택 가능한 컨테이너 없음</option>
                      ) : null}
                      {shellContainerOptions.map((container) => (
                        <option
                          key={container.containerName}
                          value={container.containerName}
                        >
                          {container.containerName}
                        </option>
                      ))}
                    </SelectField>
                  </FieldGroup>
                </ModalBody>

                <ModalFooter>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShellPickerState(createEmptyShellPickerState());
                    }}
                  >
                    취소
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      shellPickerState.loading ||
                      shellPickerState.submitting ||
                      !shellPickerState.taskArn ||
                      !shellPickerState.containerName
                    }
                    onClick={() => {
                      void handleSubmitShell();
                    }}
                  >
                    {shellPickerState.submitting ? "연결 중..." : "쉘 접속"}
                  </Button>
                </ModalFooter>
              </ModalShell>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
