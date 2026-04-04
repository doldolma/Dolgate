import {
  isAwsEcsHostRecord,
} from "@shared";
import type {
  AwsEcsClusterSnapshot,
  AwsEcsClusterUtilizationSnapshot,
  HostRecord,
} from "@shared";

export function buildContainersEndpointId(hostId: string): string {
  return `containers:${hostId}`;
}

export function buildContainersTabTitle(host: HostRecord): string {
  if (isAwsEcsHostRecord(host)) {
    return `${host.label} · ECS`;
  }
  return `${host.label} · Containers`;
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

export function clearEcsServiceUtilization(
  snapshot: AwsEcsClusterSnapshot,
): AwsEcsClusterSnapshot {
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
