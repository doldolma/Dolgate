import type { TailnetPayload } from '@dolssh/shared-core';
import { normalizeServerUrl } from '@dolssh/shared-core';

import {
  getEngine,
  type EngineTailnetConfig,
  type EngineTailnetEvent,
  type EngineTailnetRoute,
  type EngineTailnetStatus,
} from '../engine';

export type SyncedTailnetRouteResolution =
  | { kind: 'direct' }
  | { kind: 'missing'; tailnetId: string }
  | ({ kind: 'tailnet'; configSignature: string } & EngineTailnetRoute);

let runtimeGeneration = 0;
let runtimeTask: Promise<void> = Promise.resolve();
let appliedSignature: string | null = null;
let appliedScope: string | null = null;
let appliedConfigSignatures = new Map<string, string>();
let requestedConfigSignatures = new Map<string, string>();
let requestedConfigSnapshotKnown = false;
const latestStatuses = new Map<string, EngineTailnetStatus>();
const requestStatusHandlers = new Map<
  string,
  {
    tailnetId: string;
    onStatus?: (status: EngineTailnetStatus) => void;
  }
>();

export class SyncedTailnetStartError extends Error {
  readonly status?: EngineTailnetStatus;
  readonly cause?: unknown;

  constructor(cause: unknown, status?: EngineTailnetStatus) {
    super(
      cause instanceof Error
        ? cause.message
        : 'The Tailnet could not be prepared.',
    );
    this.name = 'SyncedTailnetStartError';
    this.status = status;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function dispatchTailnetEvent(event: EngineTailnetEvent): void {
  if (event.type === 'tailnetSnapshot') {
    latestStatuses.clear();
    for (const status of event.payload.statuses) {
      latestStatuses.set(status.id, status);
    }
    return;
  }

  latestStatuses.set(event.payload.id, event.payload);
  if (!event.requestId) {
    return;
  }

  const request = requestStatusHandlers.get(event.requestId);
  if (!request || request.tailnetId !== event.payload.id) {
    return;
  }
  request.onStatus?.(event.payload);
}

function enqueueRuntimeOperation(
  operation: () => Promise<void>,
): Promise<void> {
  const next = runtimeTask.catch(() => undefined).then(operation);
  runtimeTask = next.catch(() => undefined);
  return next;
}

export function buildTailnetRuntimeScope(
  serverUrl: string,
  userId: string,
): string {
  return `${normalizeServerUrl(serverUrl)}\n${userId.trim()}`;
}

export function buildEngineTailnetConfigs(
  tailnets: TailnetPayload[],
): EngineTailnetConfig[] {
  return tailnets.map(buildEngineTailnetConfig);
}

function buildEngineTailnetConfig(
  tailnet: TailnetPayload,
): EngineTailnetConfig {
  return {
    id: tailnet.id,
    ...(tailnet.controlUrl?.trim()
      ? { controlUrl: tailnet.controlUrl.trim() }
      : {}),
    ...(tailnet.authKey?.trim() ? { authKey: tailnet.authKey.trim() } : {}),
    // Desktop uses the same rule. Requesting ephemeral here would remove a
    // node on shutdown and break one-use auth keys on the next launch.
    ephemeral: false,
  };
}

export function buildSyncedTailnetConfigSignature(
  tailnet: TailnetPayload,
): string {
  return JSON.stringify({
    config: buildEngineTailnetConfig(tailnet),
    tailnetName: tailnet.tailnetName?.trim() || '',
  });
}

export function isSyncedTailnetConfigCurrent(
  tailnetId: string,
  configSignature: string,
): boolean {
  return (
    !requestedConfigSnapshotKnown ||
    requestedConfigSignatures.get(tailnetId) === configSignature
  );
}

/**
 * Resolves a host's synced Tailnet reference without ever falling back to the
 * public network when the referenced configuration is missing.
 */
export function resolveSyncedTailnetRoute(
  host: { tailnetId?: string | null },
  tailnets: TailnetPayload[],
): SyncedTailnetRouteResolution {
  const tailnetId = host.tailnetId?.trim();
  if (!tailnetId) {
    return { kind: 'direct' };
  }

  const tailnet = tailnets.find(record => record.id === tailnetId);
  if (!tailnet) {
    return { kind: 'missing', tailnetId };
  }

  const tailnetName = tailnet.tailnetName?.trim();
  return {
    kind: 'tailnet',
    tailnetId,
    configSignature: buildSyncedTailnetConfigSignature(tailnet),
    ...(tailnetName ? { tailnetName } : {}),
  };
}

export function configureSyncedTailnets(input: {
  serverUrl: string;
  userId: string;
  tailnets: TailnetPayload[];
}): Promise<void> {
  const requestedGeneration = ++runtimeGeneration;
  const scope = buildTailnetRuntimeScope(input.serverUrl, input.userId);
  const configs = buildEngineTailnetConfigs(input.tailnets);
  const configSignatures = new Map(
    input.tailnets.map(tailnet => [
      tailnet.id,
      buildSyncedTailnetConfigSignature(tailnet),
    ]),
  );
  const signature = JSON.stringify({
    scope,
    configs,
    routeSignatures: [...configSignatures].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
  // Publish the desired generation before the queued native operation begins.
  // Cancelling an in-flight start can wake its caller before configure returns;
  // that caller must already see its route as stale in this interval.
  requestedConfigSignatures = configSignatures;
  requestedConfigSnapshotKnown = true;

  return enqueueRuntimeOperation(async () => {
    if (requestedGeneration !== runtimeGeneration) {
      return;
    }
    if (appliedSignature === signature) {
      return;
    }
    const changedIds = new Set<string>();
    if (appliedScope !== null && appliedScope !== scope) {
      for (const id of appliedConfigSignatures.keys()) {
        changedIds.add(id);
      }
    } else {
      for (const [id, previous] of appliedConfigSignatures) {
        if (configSignatures.get(id) !== previous) {
          changedIds.add(id);
        }
      }
      for (const [id, next] of configSignatures) {
        if (appliedConfigSignatures.get(id) !== next) {
          changedIds.add(id);
        }
      }
    }
    await cancelActiveTailnetStarts(changedIds);
    await getEngine().configureTailnets(scope, configs, dispatchTailnetEvent);
    if (requestedGeneration === runtimeGeneration) {
      appliedSignature = signature;
      appliedScope = scope;
      appliedConfigSignatures = configSignatures;
    }
  });
}

/**
 * Brings up one synced Tailnet before an SSH/SFTP connection starts. The Go
 * service owns authentication retries and readiness decisions; this wrapper
 * only routes progress for the caller that initiated the connection.
 */
export async function startSyncedTailnet(input: {
  requestId: string;
  tailnetId: string;
  tailnets: TailnetPayload[];
  timeoutMs?: number;
  onStatus?: (status: EngineTailnetStatus) => void;
}): Promise<EngineTailnetStatus | undefined> {
  const tailnet = input.tailnets.find(record => record.id === input.tailnetId);
  if (!tailnet) {
    throw new Error(`Synced Tailnet ${input.tailnetId} is unavailable.`);
  }

  let latestStatus: EngineTailnetStatus | undefined;
  requestStatusHandlers.set(input.requestId, {
    tailnetId: input.tailnetId,
    onStatus: status => {
      latestStatus = status;
      input.onStatus?.(status);
    },
  });

  try {
    await getEngine().startTailnet(
      input.requestId,
      buildEngineTailnetConfig(tailnet),
      input.timeoutMs,
    );
    return latestStatus ?? latestStatuses.get(input.tailnetId);
  } catch (error) {
    throw new SyncedTailnetStartError(
      error,
      latestStatus ?? latestStatuses.get(input.tailnetId),
    );
  } finally {
    requestStatusHandlers.delete(input.requestId);
  }
}

export async function cancelSyncedTailnetStart(
  requestId: string,
  tailnetId: string,
): Promise<void> {
  await getEngine().cancelTailnet(requestId, tailnetId);
}

async function cancelActiveTailnetStarts(ids?: ReadonlySet<string>): Promise<void> {
  const requestsByTailnet = new Map<string, string>();
  for (const [requestId, request] of requestStatusHandlers) {
    if (ids && !ids.has(request.tailnetId)) {
      continue;
    }
    if (!requestsByTailnet.has(request.tailnetId)) {
      requestsByTailnet.set(request.tailnetId, requestId);
    }
  }
  await Promise.allSettled(
    [...requestsByTailnet].map(([tailnetId, requestId]) =>
      cancelSyncedTailnetStart(requestId, tailnetId),
    ),
  );
}

export function closeSyncedTailnets(): Promise<void> {
  const requestedGeneration = ++runtimeGeneration;
  requestedConfigSignatures.clear();
  requestedConfigSnapshotKnown = true;
  return enqueueRuntimeOperation(async () => {
    if (requestedGeneration !== runtimeGeneration) {
      return;
    }
    await cancelActiveTailnetStarts();
    appliedSignature = null;
    appliedScope = null;
    appliedConfigSignatures.clear();
    latestStatuses.clear();
    await getEngine().closeTailnets();
  });
}

/**
 * Removes account-owned Tailnet identities. This is intentionally separate
 * from close: normal logout/server switching preserves identities, while
 * account deletion explicitly removes them from local storage and the control
 * plane.
 */
export function forgetSyncedTailnets(tailnets: TailnetPayload[]): Promise<void> {
  const ids = [...new Set(tailnets.map(tailnet => tailnet.id.trim()).filter(Boolean))];
  return enqueueRuntimeOperation(async () => {
    await cancelActiveTailnetStarts();
    const results = await Promise.allSettled(
      ids.map(id => getEngine().forgetTailnet(id)),
    );
    latestStatuses.clear();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      throw failure.reason;
    }
  });
}

export function resetSyncedTailnetRuntimeForTests(): void {
  runtimeGeneration += 1;
  runtimeTask = Promise.resolve();
  appliedSignature = null;
  appliedScope = null;
  appliedConfigSignatures.clear();
  requestedConfigSignatures.clear();
  requestedConfigSnapshotKnown = false;
  latestStatuses.clear();
  requestStatusHandlers.clear();
}
