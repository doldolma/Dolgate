import { randomUUID } from 'node:crypto';
import type {
  ActivityLogRecord,
  HostRecord,
  PortForwardLifecycleLogMetadata,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  PortForwardRuleRecord,
  PortForwardTransport,
} from '@shared';
import type { ActivityLogRepository, HostRepository, PortForwardRepository } from './database';

type ActivityLogWriter = Pick<ActivityLogRepository, 'upsert'>;
type HostLookup = Pick<HostRepository, 'getById'>;
type PortForwardLookup = Pick<PortForwardRepository, 'getById'>;

interface ActivePortForwardLifecycleAttempt {
  logId: string;
  ruleId: string;
  ruleLabel: string;
  hostId: string;
  hostLabel: string;
  transport: PortForwardTransport;
  mode: PortForwardLifecycleLogMetadata['mode'];
  bindAddress: string;
  bindPort: number;
  targetSummary: string;
  startedAt: string;
}

export class PortForwardLifecycleLogger {
  private readonly activeAttempts = new Map<string, ActivePortForwardLifecycleAttempt>();

  constructor(
    private readonly activityLogs: ActivityLogWriter,
    private readonly portForwards: PortForwardLookup,
    private readonly hosts: HostLookup,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  handleEvent(event: PortForwardRuntimeEvent): void {
    const runtime = event.runtime;
    if (runtime.status === 'starting') {
      this.ensureAttempt(runtime);
      return;
    }

    if (runtime.status === 'running') {
      const attempt = this.ensureAttempt(runtime);
      this.upsertLifecycleRecord(attempt, runtime, 'running', null);
      return;
    }

    const attempt = this.activeAttempts.get(runtime.ruleId);
    if (!attempt) {
      return;
    }

    this.upsertLifecycleRecord(
      attempt,
      runtime,
      runtime.status === 'error' ? 'error' : 'closed',
      runtime.message ?? null,
    );
    this.activeAttempts.delete(runtime.ruleId);
  }

  private ensureAttempt(runtime: PortForwardRuntimeRecord): ActivePortForwardLifecycleAttempt {
    const existing = this.activeAttempts.get(runtime.ruleId);
    if (existing) {
      const next = this.applyRuntimeToAttempt(existing, runtime);
      this.activeAttempts.set(runtime.ruleId, next);
      return next;
    }

    const rule = this.portForwards.getById(runtime.ruleId);
    const host = this.hosts.getById(runtime.hostId);
    const attempt: ActivePortForwardLifecycleAttempt = {
      logId: `port-forward:${runtime.ruleId}:${randomUUID()}`,
      ruleId: runtime.ruleId,
      ruleLabel: rule?.label ?? runtime.ruleId,
      hostId: runtime.hostId,
      hostLabel: host?.label ?? runtime.hostId,
      transport: runtime.transport,
      mode: resolvePortForwardMode(rule, runtime),
      bindAddress: runtime.bindAddress,
      bindPort: runtime.bindPort,
      targetSummary: summarizePortForwardTarget(rule, runtime),
      startedAt: runtime.startedAt ?? runtime.updatedAt ?? this.now(),
    };
    this.activeAttempts.set(runtime.ruleId, attempt);
    return attempt;
  }

  private applyRuntimeToAttempt(
    attempt: ActivePortForwardLifecycleAttempt,
    runtime: PortForwardRuntimeRecord,
  ): ActivePortForwardLifecycleAttempt {
    const rule = this.portForwards.getById(runtime.ruleId);
    const host = this.hosts.getById(runtime.hostId);
    return {
      ...attempt,
      ruleLabel: rule?.label ?? attempt.ruleLabel,
      hostId: runtime.hostId,
      hostLabel: host?.label ?? attempt.hostLabel,
      transport: runtime.transport,
      mode: resolvePortForwardMode(rule, runtime),
      bindAddress: runtime.bindAddress,
      bindPort: runtime.bindPort,
      targetSummary: summarizePortForwardTarget(rule, runtime),
      startedAt: attempt.startedAt || runtime.startedAt || runtime.updatedAt || this.now(),
    };
  }

  private upsertLifecycleRecord(
    attempt: ActivePortForwardLifecycleAttempt,
    runtime: PortForwardRuntimeRecord,
    status: PortForwardLifecycleLogMetadata['status'],
    endReason: string | null,
  ): void {
    const stoppedAt = status === 'running' ? null : runtime.updatedAt ?? this.now();
    const durationMs =
      stoppedAt == null
        ? null
        : Math.max(0, new Date(stoppedAt).getTime() - new Date(attempt.startedAt).getTime());
    const metadata: PortForwardLifecycleLogMetadata = {
      ruleId: attempt.ruleId,
      ruleLabel: attempt.ruleLabel,
      hostId: attempt.hostId,
      hostLabel: attempt.hostLabel,
      transport: attempt.transport,
      mode: attempt.mode,
      bindAddress: attempt.bindAddress,
      bindPort: attempt.bindPort,
      targetSummary: attempt.targetSummary,
      startedAt: attempt.startedAt,
      stoppedAt,
      durationMs,
      status,
      endReason,
    };
    const record: ActivityLogRecord = {
      id: attempt.logId,
      level: status === 'error' ? 'error' : 'info',
      category: 'audit',
      kind: 'port-forward-lifecycle',
      message: `${attempt.ruleLabel} 포트 포워딩`,
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: attempt.startedAt,
      updatedAt: stoppedAt ?? runtime.updatedAt ?? this.now(),
    };
    this.activityLogs.upsert(record);
  }
}

function summarizePortForwardTarget(
  rule: PortForwardRuleRecord | null,
  runtime: PortForwardRuntimeRecord,
): string {
  if (!rule) {
    if (runtime.mode === 'dynamic') {
      return 'SOCKS proxy';
    }
    return runtime.mode === 'remote' ? 'Remote forward' : 'Target unavailable';
  }

  if (rule.transport === 'ssh') {
    if (rule.mode === 'dynamic') {
      return 'SOCKS proxy';
    }
    const targetHost = rule.targetHost?.trim() || '127.0.0.1';
    const targetPort = rule.targetPort ?? 0;
    return rule.mode === 'remote'
      ? `Remote target ${targetHost}:${targetPort}`
      : `Target ${targetHost}:${targetPort}`;
  }

  if (rule.transport === 'aws-ssm') {
    if (rule.targetKind === 'remote-host') {
      return `Remote host ${(rule.remoteHost?.trim() || '127.0.0.1')}:${rule.targetPort}`;
    }
    return `Instance port ${rule.targetPort}`;
  }

  if (rule.transport === 'ecs-task') {
    return `${rule.serviceName} / ${rule.containerName} · ${rule.targetPort}`;
  }

  return `${rule.containerName} (${rule.containerRuntime}) · ${rule.targetPort}`;
}

function resolvePortForwardMode(
  rule: PortForwardRuleRecord | null,
  runtime: PortForwardRuntimeRecord,
): PortForwardLifecycleLogMetadata['mode'] {
  if (runtime.mode) {
    return runtime.mode;
  }
  if (rule?.transport === 'ssh') {
    return rule.mode;
  }
  return 'local';
}

export const __testOnly = {
  resolvePortForwardMode,
  summarizePortForwardTarget,
};
