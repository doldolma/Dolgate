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
  EcsServiceLogsViewState,
  EcsTunnelTabState,
  HostContainersTabState,
  LogsAbsoluteRangeValue,
  LogsRangeMode,
  LogsRelativePresetKey,
  LogsRelativeRangeValue,
  LogsRelativeUnit,
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
  IconButton,
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

interface AwsEcsWorkspaceProps {
  host: HostRecord;
  tab: HostContainersTabState;
  isActive: boolean;
  onRefresh: (hostId: string) => Promise<void>;
  onRefreshUtilization: (hostId: string) => Promise<void>;
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
    state: EcsServiceLogsViewState | null,
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
type LogsStateUpdater =
  | LogsPanelState
  | ((previous: LogsPanelState) => LogsPanelState);

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

const RANGE_WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const RELATIVE_RANGE_PRESET_OPTIONS: Array<{
  key: LogsRelativePresetKey;
  label: string;
  amount: number;
  unit: LogsRelativeUnit;
}> = [
  { key: "30m", label: "30분 전부터", amount: 30, unit: "minute" },
  { key: "1h", label: "1시간 전부터", amount: 1, unit: "hour" },
  { key: "6h", label: "6시간 전부터", amount: 6, unit: "hour" },
  { key: "1d", label: "1일 전부터", amount: 1, unit: "day" },
  { key: "3d", label: "3일 전부터", amount: 3, unit: "day" },
  { key: "1w", label: "1주 전부터", amount: 1, unit: "week" },
];
const RELATIVE_RANGE_UNIT_OPTIONS: Array<{
  value: LogsRelativeUnit;
  label: string;
}> = [
  { value: "second", label: "초" },
  { value: "minute", label: "분" },
  { value: "hour", label: "시간" },
  { value: "day", label: "일" },
  { value: "week", label: "주" },
  { value: "month", label: "월" },
  { value: "year", label: "년" },
];

const ecsSummaryCardClass =
  "grid gap-[0.35rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent_10%)] px-[1rem] py-[0.95rem]";
const ecsSectionCardClass =
  "grid gap-[0.8rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface)_92%,transparent_8%)] px-[1rem] py-[0.95rem] shadow-[var(--shadow)]";
const ecsEmptyDetailClass =
  "rounded-[16px] bg-[color-mix(in_srgb,var(--surface)_82%,transparent_18%)] px-4 py-4 text-[var(--text-soft)]";
const ecsLogsOutputClass =
  "grid min-h-0 flex-1 content-start gap-[0.35rem] overflow-auto rounded-[18px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[rgba(7,13,24,0.88)] px-[1.05rem] py-4 text-[rgba(226,234,255,0.92)]";
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
  "grid gap-[0.85rem] rounded-[18px] border border-[color-mix(in_srgb,var(--accent-strong)_20%,var(--border)_80%)] bg-[color-mix(in_srgb,var(--accent-strong)_8%,var(--surface)_92%)] px-[1rem] py-[0.9rem] shadow-[var(--shadow)]";
const ecsTunnelRuntimeGridClass =
  "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[0.9rem] max-[760px]:grid-cols-1";
const ecsDetailTabsClass =
  "gap-[0.55rem] rounded-[18px] border border-[color-mix(in_srgb,var(--border)_84%,white_16%)] bg-[color-mix(in_srgb,var(--surface-muted)_82%,transparent_18%)] p-[0.35rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";
const ecsDetailTabButtonBaseClass =
  "min-w-[5.75rem] border border-transparent bg-[color-mix(in_srgb,var(--surface)_18%,transparent_82%)] text-[color-mix(in_srgb,var(--text-soft)_90%,black_10%)] shadow-none";
const ecsDetailTabButtonActiveClass =
  "border-[color-mix(in_srgb,var(--accent-strong)_46%,var(--border)_54%)] bg-[color-mix(in_srgb,var(--accent-strong)_18%,var(--surface-elevated)_82%)] text-[var(--text)] shadow-[0_10px_22px_rgba(15,23,38,0.14)] ring-1 ring-[color-mix(in_srgb,var(--accent-strong)_24%,transparent_76%)]";
const ecsDetailTabButtonInactiveClass =
  "hover:border-[color-mix(in_srgb,var(--border)_80%,white_20%)] hover:bg-[color-mix(in_srgb,var(--surface)_56%,transparent_44%)] hover:text-[var(--text)]";

function padRangeValue(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${padRangeValue(date.getMonth() + 1)}-${padRangeValue(date.getDate())}`;
}

function formatLocalTimeInputValue(date: Date): string {
  return `${padRangeValue(date.getHours())}:${padRangeValue(date.getMinutes())}:${padRangeValue(date.getSeconds())}`;
}

function parseLocalDateTime(
  dateValue: string,
  timeValue: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue.trim());
  if (!dateMatch) {
    return null;
  }
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue.trim());
  if (!timeMatch) {
    return null;
  }

  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0"),
    0,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createDefaultLogsAbsoluteRange(): LogsAbsoluteRangeValue {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  return {
    startDate: formatLocalDateInputValue(start),
    startTime: formatLocalTimeInputValue(start),
    endDate: formatLocalDateInputValue(end),
    endTime: formatLocalTimeInputValue(end),
  };
}

function createDefaultLogsRelativeRange(): LogsRelativeRangeValue {
  return {
    presetKey: "30m",
    amount: "30",
    unit: "minute",
  };
}

function subtractLogsRelativeRange(
  end: Date,
  amount: number,
  unit: LogsRelativeUnit,
): Date {
  const start = new Date(end);
  if (unit === "second") {
    start.setSeconds(start.getSeconds() - amount);
  } else if (unit === "minute") {
    start.setMinutes(start.getMinutes() - amount);
  } else if (unit === "hour") {
    start.setHours(start.getHours() - amount);
  } else if (unit === "day") {
    start.setDate(start.getDate() - amount);
  } else if (unit === "week") {
    start.setDate(start.getDate() - amount * 7);
  } else if (unit === "month") {
    start.setMonth(start.getMonth() - amount);
  } else if (unit === "year") {
    start.setFullYear(start.getFullYear() - amount);
  }
  return start;
}

function normalizeLogsRelativeRange(
  value: LogsRelativeRangeValue | null,
  now = new Date(),
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const preset = RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === value.presetKey,
  );
  const resolvedAmount =
    value.presetKey === "custom"
      ? Number(value.amount)
      : preset?.amount ?? Number.NaN;
  const resolvedUnit =
    value.presetKey === "custom" ? value.unit : preset?.unit ?? value.unit;
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    return null;
  }
  const end = new Date(now);
  const start = subtractLogsRelativeRange(end, resolvedAmount, resolvedUnit);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

function normalizeLogsAbsoluteRange(
  value: LogsAbsoluteRangeValue | null,
): { startTime: string; endTime: string } | null {
  if (!value) {
    return null;
  }
  const start = parseLocalDateTime(value.startDate, value.startTime);
  const end = parseLocalDateTime(value.endDate, value.endTime);
  if (!start || !end || end.getTime() < start.getTime()) {
    return null;
  }
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

function formatLogsRangeLabel(
  mode: LogsRangeMode,
  absoluteValue: LogsAbsoluteRangeValue | null,
  relativeValue: LogsRelativeRangeValue | null,
): string {
  if (mode === "absolute" && absoluteValue) {
    return `${absoluteValue.startDate.replace(/-/g, "/")} ${absoluteValue.startTime.slice(0, 5)} - ${absoluteValue.endDate.replace(/-/g, "/")} ${absoluteValue.endTime.slice(0, 5)}`;
  }
  const preset = RELATIVE_RANGE_PRESET_OPTIONS.find(
    (option) => option.key === relativeValue?.presetKey,
  );
  if (relativeValue?.presetKey === "custom") {
    return `최근 ${relativeValue.amount || "0"}${RELATIVE_RANGE_UNIT_OPTIONS.find((option) => option.value === relativeValue.unit)?.label ?? ""}`;
  }
  return preset ? `최근 ${preset.label.replace(" 전부터", "")}` : "최근 30분";
}

function startOfRangeMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addRangeMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function buildRangeCalendarDays(month: Date): Date[] {
  const firstDay = startOfRangeMonth(month);
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const next = new Date(gridStart);
    next.setDate(gridStart.getDate() + index);
    return next;
  });
}

function formatRangeMonthLabel(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function formatRangeDayValue(date: Date): string {
  return formatLocalDateInputValue(date);
}

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

function getServiceAttentionTone(
  service: AwsEcsServiceSummary,
): "neutral" | "warning" | "error" {
  const rolloutTone = getRolloutTone(service.rolloutState);
  if (isStatusIssue(service) || rolloutTone === "error") {
    return "error";
  }
  if (isRolloutIssue(service) || hasPendingTasks(service)) {
    return "warning";
  }
  return "neutral";
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

function LogsRangePickerDialog({
  open,
  mode,
  absoluteValue,
  relativeValue,
  onClose,
  onApply,
}: {
  open: boolean;
  mode: LogsRangeMode;
  absoluteValue: LogsAbsoluteRangeValue | null;
  relativeValue: LogsRelativeRangeValue | null;
  onClose: () => void;
  onApply: (
    nextMode: LogsRangeMode,
    nextAbsoluteValue: LogsAbsoluteRangeValue | null,
    nextRelativeValue: LogsRelativeRangeValue | null,
  ) => void;
}) {
  const [draftMode, setDraftMode] = useState<LogsRangeMode>(mode);
  const [draftAbsoluteValue, setDraftAbsoluteValue] = useState<LogsAbsoluteRangeValue>(
    absoluteValue ?? createDefaultLogsAbsoluteRange(),
  );
  const [draftRelativeValue, setDraftRelativeValue] = useState<LogsRelativeRangeValue>(
    relativeValue ?? createDefaultLogsRelativeRange(),
  );
  const [anchorMonth, setAnchorMonth] = useState<Date>(() => {
    const baseDate =
      parseLocalDateTime(
        (absoluteValue ?? createDefaultLogsAbsoluteRange()).startDate,
        "00:00:00",
      ) ?? new Date();
    return startOfRangeMonth(baseDate);
  });
  const [selectionCursor, setSelectionCursor] = useState<"start" | "end">(
    "start",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextAbsoluteValue = absoluteValue ?? createDefaultLogsAbsoluteRange();
    setDraftMode(mode);
    setDraftAbsoluteValue(nextAbsoluteValue);
    setDraftRelativeValue(relativeValue ?? createDefaultLogsRelativeRange());
    setAnchorMonth(
      startOfRangeMonth(
        parseLocalDateTime(nextAbsoluteValue.startDate, "00:00:00") ?? new Date(),
      ),
    );
    setSelectionCursor("start");
    setError(null);
  }, [absoluteValue, mode, open, relativeValue]);

  const normalizedDraftAbsolute = normalizeLogsAbsoluteRange(draftAbsoluteValue);
  const startDateValue = draftAbsoluteValue.startDate;
  const endDateValue = draftAbsoluteValue.endDate;

  const handleSelectDay = useCallback((dateValue: string) => {
    setDraftMode("absolute");
    setError(null);
    setDraftAbsoluteValue((previous) => {
      if (selectionCursor === "start") {
        return {
          ...previous,
          startDate: dateValue,
          endDate: previous.endDate < dateValue ? dateValue : previous.endDate,
        };
      }
      if (dateValue < previous.startDate) {
        return {
          ...previous,
          startDate: dateValue,
          endDate: previous.startDate,
        };
      }
      return {
        ...previous,
        endDate: dateValue,
      };
    });
    setSelectionCursor((previous) => (previous === "start" ? "end" : "start"));
  }, [selectionCursor]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[8] grid place-items-center bg-[rgba(12,20,32,0.32)]"
      role="presentation"
      onClick={() => {
        onClose();
      }}
    >
      <ModalShell
        size="lg"
        role="dialog"
        aria-modal="true"
        aria-label="로그 범위 선택"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <ModalHeader>
          <Tabs role="tablist" aria-label="로그 범위 모드">
            <TabButton
              role="tab"
              active={draftMode === "recent"}
              aria-selected={draftMode === "recent"}
              onClick={() => {
                setDraftMode("recent");
                setError(null);
              }}
            >
              상대 범위
            </TabButton>
            <TabButton
              role="tab"
              active={draftMode === "absolute"}
              aria-selected={draftMode === "absolute"}
              onClick={() => {
                setDraftMode("absolute");
                setError(null);
              }}
            >
              절대 범위
            </TabButton>
          </Tabs>
        </ModalHeader>

        {draftMode === "absolute" ? (
          <ModalBody className="w-[min(1040px,100%)]">
            <div className="grid items-start gap-[0.9rem] lg:grid-cols-[auto_minmax(0,1fr)_auto]">
              <IconButton
                size="sm"
                aria-label="이전 달"
                onClick={() => {
                  setAnchorMonth((previous) => addRangeMonths(previous, -1));
                }}
              >
                {"<"}
              </IconButton>
              <div className="grid gap-4 lg:grid-cols-2">
                {[anchorMonth, addRangeMonths(anchorMonth, 1)].map((month) => {
                  const monthKey = `${month.getFullYear()}-${month.getMonth()}`;
                  const monthValue = month.getMonth();
                  return (
                    <section
                      key={monthKey}
                      className="grid gap-3"
                    >
                      <header className="flex min-h-8 items-center justify-center">
                        <strong>{formatRangeMonthLabel(month)}</strong>
                      </header>
                      <div className="grid grid-cols-7 gap-[0.35rem] text-center text-[0.82rem] font-semibold text-[var(--text-soft)]">
                        {RANGE_WEEKDAY_LABELS.map((label) => (
                          <span key={`${monthKey}:${label}`}>{label}</span>
                        ))}
                      </div>
                      <div className="grid grid-cols-7 gap-[0.28rem]">
                        {buildRangeCalendarDays(month).map((day) => {
                          const dayValue = formatRangeDayValue(day);
                          const isCurrentMonth = day.getMonth() === monthValue;
                          const isStart = dayValue === startDateValue;
                          const isEnd = dayValue === endDateValue;
                          const isInRange =
                            dayValue >= startDateValue && dayValue <= endDateValue;
                          return (
                            <button
                              key={`${monthKey}:${dayValue}`}
                              type="button"
                              className={cn(
                                "min-h-[2.6rem] rounded-[12px] border border-transparent bg-transparent font-semibold text-[var(--text)] transition-[background,border-color,color] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border)_70%)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)]",
                                !isCurrentMonth
                                  ? "text-[color-mix(in_srgb,var(--text-soft)_78%,transparent_22%)]"
                                  : "",
                                isInRange
                                  ? "border-[color-mix(in_srgb,var(--accent-strong)_36%,var(--border)_64%)] bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)]"
                                  : "",
                                isStart || isEnd
                                  ? "border-[color-mix(in_srgb,var(--accent-strong)_68%,var(--border)_32%)] bg-[var(--accent-strong)] text-white"
                                  : "",
                              )}
                              onClick={() => {
                                handleSelectDay(dayValue);
                              }}
                            >
                              {day.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
              <IconButton
                size="sm"
                aria-label="다음 달"
                onClick={() => {
                  setAnchorMonth((previous) => addRangeMonths(previous, 1));
                }}
              >
                {">"}
              </IconButton>
            </div>

            <div className="mt-4 grid gap-[0.85rem_0.9rem] md:grid-cols-2 xl:grid-cols-4">
              <FieldGroup label="시작 날짜">
                <Input
                  type="date"
                  value={draftAbsoluteValue.startDate}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      startDate: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="시작 시간">
                <Input
                  type="time"
                  step="1"
                  value={draftAbsoluteValue.startTime}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      startTime: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="종료 날짜">
                <Input
                  type="date"
                  value={draftAbsoluteValue.endDate}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      endDate: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="종료 시간">
                <Input
                  type="time"
                  step="1"
                  value={draftAbsoluteValue.endTime}
                  onChange={(event) => {
                    setDraftAbsoluteValue((previous) => ({
                      ...previous,
                      endTime: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
            </div>
            <p className="mt-3 text-[0.84rem] leading-[1.6] text-[var(--text-soft)]">
              날짜는 로컬 시간대로 적용됩니다. 절대 범위를 적용하면 Follow는 자동으로 꺼집니다.
            </p>
          </ModalBody>
        ) : (
          <ModalBody className="grid items-start gap-5 lg:grid-cols-[13.5rem_minmax(20rem,24rem)]">
            <div className="grid content-start gap-[0.55rem]">
              {RELATIVE_RANGE_PRESET_OPTIONS.map((option) => (
                <label
                  key={option.key}
                  className="grid min-h-[2.25rem] grid-cols-[1rem_minmax(0,1fr)] items-center gap-[0.85rem] text-[0.98rem] font-semibold text-[var(--text)]"
                >
                  <input
                    type="radio"
                    name="ecs-logs-relative-range"
                    className="m-0 h-4 w-4 justify-self-center accent-[var(--accent-strong)]"
                    checked={draftRelativeValue.presetKey === option.key}
                    onChange={() => {
                      setDraftRelativeValue({
                        presetKey: option.key,
                        amount: String(option.amount),
                        unit: option.unit,
                      });
                    }}
                  />
                  <span className="whitespace-nowrap leading-none">{option.label}</span>
                </label>
              ))}
              <label className="mt-1 grid min-h-[2.25rem] grid-cols-[1rem_minmax(0,1fr)] items-center gap-[0.85rem] text-[0.98rem] font-semibold text-[var(--text)]">
                <input
                  type="radio"
                  name="ecs-logs-relative-range"
                  className="m-0 h-4 w-4 justify-self-center accent-[var(--accent-strong)]"
                  checked={draftRelativeValue.presetKey === "custom"}
                  onChange={() => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                    }));
                  }}
                />
                <span className="whitespace-nowrap leading-none">사용자 지정 범위</span>
              </label>
            </div>
            <div className="grid max-w-[24rem] items-end gap-[0.9rem] lg:grid-cols-[minmax(0,1fr)_11.25rem]">
              <FieldGroup label="기간">
                <Input
                  type="number"
                  min="1"
                  value={draftRelativeValue.amount}
                  disabled={draftRelativeValue.presetKey !== "custom"}
                  onChange={(event) => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                      amount: event.target.value,
                    }));
                  }}
                />
              </FieldGroup>
              <FieldGroup label="단위">
                <SelectField
                  value={draftRelativeValue.unit}
                  disabled={draftRelativeValue.presetKey !== "custom"}
                  onChange={(event) => {
                    setDraftRelativeValue((previous) => ({
                      ...previous,
                      presetKey: "custom",
                      unit: event.target.value as LogsRelativeUnit,
                    }));
                  }}
                >
                  {RELATIVE_RANGE_UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectField>
              </FieldGroup>
            </div>
            <p className="text-[0.84rem] leading-[1.6] text-[var(--text-soft)] lg:col-span-2">
              상대 범위를 적용하면 현재 시점을 기준으로 범위를 계산해 다시 조회합니다.
            </p>
          </ModalBody>
        )}

        {error ? (
          <div className="px-6 pb-2">
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          </div>
        ) : null}

        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
            }}
          >
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (draftMode === "absolute" && !normalizedDraftAbsolute) {
                setError("시작 시간과 종료 시간을 확인해 주세요.");
                return;
              }
              if (
                draftMode === "recent" &&
                !normalizeLogsRelativeRange(draftRelativeValue)
              ) {
                setError("상대 범위 값을 확인해 주세요.");
                return;
              }
              onApply(
                draftMode,
                draftMode === "absolute" ? draftAbsoluteValue : null,
                draftMode === "recent" ? draftRelativeValue : null,
              );
            }}
          >
            적용
          </Button>
        </ModalFooter>
      </ModalShell>
    </div>
  );
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
  const ecsLogsByServiceNameRef = useRef(ecsLogsByServiceName);
  const latestLogsRequestIdRef = useRef<Record<string, number>>({});
  const logsOutputRef = useRef<HTMLDivElement | null>(null);
  const logsBottomRef = useRef<HTMLDivElement | null>(null);
  const previousPanelRef = useRef<EcsDetailPanel>(tab.ecsActivePanel);
  const previousLogsTargetRef = useRef<string | null>(null);
  const logsAutoLoadKeyRef = useRef<string | null>(null);
  const hasInitializedLogsViewRef = useRef(false);
  const suppressLogsScrollRef = useRef(false);
  const releaseLogsScrollFrameRef = useRef<number | null>(null);

  useEffect(() => {
    serviceContextsRef.current = serviceContexts;
  }, [serviceContexts]);

  useEffect(() => {
    ecsLogsByServiceNameRef.current = ecsLogsByServiceName;
  }, [ecsLogsByServiceName]);

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
  const setServiceLogsState = useCallback(
    (serviceName: string, updater: LogsStateUpdater) => {
      if (onSetLogsState) {
        const previous =
          ecsLogsByServiceNameRef.current[serviceName] ?? createEmptyLogsState();
        const next =
          typeof updater === "function" ? updater(previous) : updater;
        onSetLogsState(host.id, serviceName, next);
        return;
      }
      setLocalEcsLogsByServiceName((previous) => {
        const current = previous[serviceName] ?? createEmptyLogsState();
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
    ? ecsLogsByServiceName[selectedService.serviceName] ?? createEmptyLogsState()
    : createEmptyLogsState();
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
      if (!input.silent) {
        setServiceLogsState(input.serviceName, (previous) => ({
          ...previous,
          loading: true,
          error: null,
          taskArn: requestedTaskArn,
          containerName: requestedContainerName,
        }));
      }
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

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
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

      {tab.errorMessage ? (
        <NoticeCard tone="danger" role="alert">
          {tab.errorMessage}
        </NoticeCard>
      ) : null}

      {tab.ecsMetricsWarning ? (
        <NoticeCard tone="warning" title="Metrics warning">
          <p>{tab.ecsMetricsWarning}</p>
        </NoticeCard>
      ) : null}

      {tab.isLoading && !snapshot ? (
        <EmptyState
          className="max-w-[620px]"
          title="클러스터 정보를 불러오는 중입니다."
          description="AWS ECS 서비스 스냅샷과 현재 사용량 지표를 가져오고 있습니다."
        />
      ) : null}

      {snapshot ? (
        <div className="flex min-h-0 flex-1 flex-col gap-[0.95rem]">
          <div className="grid shrink-0 gap-[0.9rem] lg:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
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

          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col gap-4 overflow-hidden rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.15rem]">
              <div className="flex items-center justify-between gap-3">
                <strong>Services</strong>
                <span>{services.length}</span>
              </div>

              {services.length === 0 ? (
                <EmptyState title="이 클러스터에는 표시할 서비스가 없습니다." />
              ) : (
                <div className="flex min-h-0 flex-col gap-[0.55rem] overflow-y-auto pr-px">
                  {services.map((service) => {
                    const tone = getServiceAttentionTone(service);
                    const isSelected = service.serviceName === selectedService?.serviceName;
                    return (
                      <article
                        key={service.serviceArn}
                        data-testid="ecs-service-row"
                        className={cn(
                          "shrink-0 overflow-hidden rounded-[18px] border bg-[color-mix(in_srgb,var(--surface)_92%,transparent_8%)] shadow-[var(--shadow)] transition-[border-color,background-color,box-shadow,transform] duration-150",
                          tone === "warning"
                            ? "border-[color-mix(in_srgb,var(--warning,#d9a441)_30%,var(--border)_70%)]"
                            : tone === "error"
                              ? "border-[color-mix(in_srgb,var(--danger)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--danger)_5%,var(--surface)_95%)]"
                              : "border-[color-mix(in_srgb,var(--border)_82%,white_18%)]",
                          isSelected
                            ? "border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--accent-strong)_8%,var(--surface)_92%)] shadow-[var(--shadow),inset_0_1px_0_color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)]"
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

            <section className="flex min-h-0 flex-col gap-4 overflow-hidden rounded-[24px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] p-[1.15rem]">
              {selectedService ? (
                <>
                  <div className="grid shrink-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
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
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 self-start max-[980px]:w-full max-[980px]:justify-start">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          void handleOpenShell(selectedService.serviceName);
                        }}
                      >
                        쉘 접속
                      </Button>
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
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col gap-[0.9rem]">
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
                      <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_auto_auto_1fr] gap-[0.9rem]">
                        <FilterRow className="items-center justify-between">
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
                                    : logsRangeMode === "absolute"
                                      ? "선택한 범위에 로그가 없습니다."
                                      : "최근 30분 기준 로그가 없습니다."}
                                </div>
                              ) : (
                                filteredLogs.map((entry) => (
                                  <div
                                    key={entry.id}
                                    className="grid grid-cols-[max-content_minmax(0,1fr)] items-start gap-[0.9rem]"
                                  >
                                    <span
                                      className="whitespace-nowrap text-[rgba(163,181,214,0.82)]"
                                      title={entry.timestamp}
                                    >
                                      {formatLoadedAt(entry.timestamp)}
                                    </span>
                                    <span className="min-w-0 break-words whitespace-pre-wrap">
                                      {entry.containerName || entry.taskId ? (
                                        <span className="text-[rgba(163,181,214,0.82)]">
                                          {[entry.containerName, entry.taskId]
                                            .filter(Boolean)
                                            .join(" · ")}{" "}
                                        </span>
                                      ) : null}
                                      {entry.message}
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
