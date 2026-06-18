import { isAwsEcsHostRecord } from "@shared";
import type {
  AwsEcsClusterSnapshot,
  AwsEcsClusterUtilizationSnapshot,
  AwsMetricHistoryPoint,
  ConnectionProgressStage,
  ContainerConnectionProgressEvent,
  HostContainerStatsSample,
  HostRecord,
} from "@shared";
import { createDefaultLogsRelativeRange } from "../../lib/log-range";
import type {
  AppState,
  ContainerLogsLoadState,
  ContainerTunnelTabState,
  EcsServiceLogsViewState,
  EcsServiceUtilizationHistoryState,
  EcsTunnelTabState,
  HostContainersTabState,
} from "../types";
import { arePortForwardRuntimeRecordsEqual } from "./network";

export function mergeContainerLogLines(
  existingLines: string[],
  incomingLines: string[],
): string[] {
  if (existingLines.length === 0) {
    return incomingLines;
  }
  if (incomingLines.length === 0) {
    return existingLines;
  }

  const maxOverlap = Math.min(existingLines.length, incomingLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        existingLines[existingLines.length - overlap + index] !==
        incomingLines[index]
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return [...existingLines, ...incomingLines.slice(overlap)];
    }
  }

  return [...existingLines, ...incomingLines];
}

export function areEcsTunnelTabStatesEqual(
  left: EcsTunnelTabState | null | undefined,
  right: EcsTunnelTabState | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.serviceName === right.serviceName &&
    left.taskArn === right.taskArn &&
    left.containerName === right.containerName &&
    left.targetPort === right.targetPort &&
    left.bindPort === right.bindPort &&
    left.autoLocalPort === right.autoLocalPort &&
    left.loading === right.loading &&
    left.error === right.error &&
    arePortForwardRuntimeRecordsEqual(left.runtime, right.runtime)
  );
}

export function areContainerTunnelTabStatesEqual(
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

export function normalizeContainerTunnelTabStateForPersistence(
  tunnelState: ContainerTunnelTabState | null | undefined,
): ContainerTunnelTabState | null {
  if (!tunnelState) {
    return null;
  }
  return {
    ...tunnelState,
    loading: false,
    error: null,
  };
}

export function resolveContainersHostIdByEndpoint(
  endpointId: string,
): string | null {
  if (!endpointId.startsWith("containers:")) {
    return null;
  }
  const remainder = endpointId.slice("containers:".length);
  const hostId = remainder.split(":")[0]?.trim();
  return hostId || null;
}

export function createContainerConnectionProgress(
  hostId: string,
  endpointId: string,
  stage: ConnectionProgressStage,
  message: string,
): ContainerConnectionProgressEvent {
  return {
    hostId,
    endpointId,
    stage,
    message,
  };
}

export function buildContainersEndpointId(hostId: string): string {
  return `containers:${hostId}`;
}

export function buildContainersTabTitle(host: HostRecord): string {
  if (isAwsEcsHostRecord(host)) {
    return `${host.label} · ECS`;
  }
  return `${host.label} · Containers`;
}

export const DEFAULT_CONTAINER_LOGS_TAIL_WINDOW = 200;
export const CONTAINER_LOGS_TAIL_INCREMENT = 1000;
export const MAX_CONTAINER_LOGS_TAIL_WINDOW = 20000;
export const MAX_CONTAINER_METRICS_SAMPLES = 720;
export const ECS_UTILIZATION_HISTORY_WINDOW_MS = 10 * 60 * 1000;

export function classifyContainerLogsErrorMessage(
  message: string,
): ContainerLogsLoadState {
  return message.startsWith("Invalid containersLogs response:")
    ? "malformed"
    : "error";
}

export function trimContainerMetricsSamples(
  samples: HostContainerStatsSample[],
): HostContainerStatsSample[] {
  if (samples.length <= MAX_CONTAINER_METRICS_SAMPLES) {
    return samples;
  }
  return samples.slice(samples.length - MAX_CONTAINER_METRICS_SAMPLES);
}

export function createEmptyContainersTabState(host: HostRecord): HostContainersTabState {
  return {
    kind: isAwsEcsHostRecord(host) ? "ecs-cluster" : "host-containers",
    hostId: host.id,
    lifecycleId: null,
    title: buildContainersTabTitle(host),
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
    logsTailWindow: DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
    logsRangeMode: "recent",
    logsRelativeRange: createDefaultLogsRelativeRange(),
    logsAbsoluteRange: null,
    logsSearchQuery: "",
    logsSearchMode: null,
    logsSearchLoading: false,
    logsSearchError: undefined,
    logsSearchResult: null,
    metricsSamples: [],
    metricsState: "idle",
    metricsLoading: false,
    metricsError: undefined,
    pendingAction: null,
    actionError: undefined,
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

export function createEmptyEcsServiceLogsViewState(): EcsServiceLogsViewState {
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

export function clearEcsServiceUtilization(snapshot: AwsEcsClusterSnapshot): AwsEcsClusterSnapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => ({
      ...service,
      cpuUtilizationPercent: null,
      memoryUtilizationPercent: null,
    })),
  };
}

export function mergeEcsClusterUtilizationSnapshot(
  snapshot: AwsEcsClusterSnapshot,
  utilization: AwsEcsClusterUtilizationSnapshot,
): AwsEcsClusterSnapshot {
  const metricsByServiceName = new Map(
    utilization.services.map((service) => [service.serviceName, service]),
  );
  return {
    ...snapshot,
    services: snapshot.services.map((service) => {
      const nextMetrics = metricsByServiceName.get(service.serviceName);
      return {
        ...service,
        cpuUtilizationPercent: nextMetrics?.cpuUtilizationPercent ?? null,
        memoryUtilizationPercent: nextMetrics?.memoryUtilizationPercent ?? null,
      };
    }),
  };
}

export function createEcsUtilizationHistoryState(
  utilization: AwsEcsClusterUtilizationSnapshot,
): Record<string, EcsServiceUtilizationHistoryState> {
  return Object.fromEntries(
    utilization.services.map((service) => [
      service.serviceName,
      {
        cpuHistory: service.cpuHistory,
        memoryHistory: service.memoryHistory,
      } satisfies EcsServiceUtilizationHistoryState,
    ]),
  );
}

export function mergeMetricHistory(
  existing: AwsMetricHistoryPoint[],
  incoming: AwsMetricHistoryPoint[],
  loadedAt: string,
): AwsMetricHistoryPoint[] {
  const loadedAtMs = Date.parse(loadedAt);
  const cutoff = Number.isNaN(loadedAtMs)
    ? Number.NEGATIVE_INFINITY
    : loadedAtMs - ECS_UTILIZATION_HISTORY_WINDOW_MS;
  const merged = new Map<string, AwsMetricHistoryPoint>();

  for (const point of existing) {
    const timestampMs = Date.parse(point.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < cutoff) {
      continue;
    }
    merged.set(point.timestamp, point);
  }

  for (const point of incoming) {
    const timestampMs = Date.parse(point.timestamp);
    if (Number.isNaN(timestampMs) || timestampMs < cutoff) {
      continue;
    }
    merged.set(point.timestamp, point);
  }

  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

export function mergeEcsUtilizationHistoryState(
  existing: Record<string, EcsServiceUtilizationHistoryState>,
  utilization: AwsEcsClusterUtilizationSnapshot,
): Record<string, EcsServiceUtilizationHistoryState> {
  const nextEntries = utilization.services.map((service) => {
    const current = existing[service.serviceName];
    return [
      service.serviceName,
      {
        cpuHistory: mergeMetricHistory(
          current?.cpuHistory ?? [],
          service.cpuHistory,
          utilization.loadedAt,
        ),
        memoryHistory: mergeMetricHistory(
          current?.memoryHistory ?? [],
          service.memoryHistory,
          utilization.loadedAt,
        ),
      } satisfies EcsServiceUtilizationHistoryState,
    ] as const;
  });

  return Object.fromEntries(nextEntries);
}

export function upsertContainersTab(
  tabs: HostContainersTabState[],
  tab: HostContainersTabState,
): HostContainersTabState[] {
  const existingIndex = tabs.findIndex((item) => item.hostId === tab.hostId);
  if (existingIndex < 0) {
    return [...tabs, tab];
  }
  return tabs.map((item, index) => (index === existingIndex ? tab : item));
}

export function resolveNextContainerHostId(
  tabs: HostContainersTabState[],
  removedHostId: string,
): string | null {
  const removedIndex = tabs.findIndex((tab) => tab.hostId === removedHostId);
  const remainingTabs = tabs.filter((tab) => tab.hostId !== removedHostId);
  if (remainingTabs.length === 0) {
    return null;
  }
  const nextTab =
    remainingTabs[removedIndex] ??
    remainingTabs[removedIndex - 1] ??
    remainingTabs[0] ??
    null;
  return nextTab?.hostId ?? null;
}

export function findContainersTab(
  state: AppState,
  hostId: string,
): HostContainersTabState | null {
  return state.containerTabs.find((tab) => tab.hostId === hostId) ?? null;
}
