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
import { t } from './i18n';
import { logMessage } from "./activity-log-message";

type ActivityLogWriter = Pick<ActivityLogRepository, 'upsert'>;
type HostLookup = Pick<HostRepository, 'getById'>;
type PortForwardLookup = Pick<PortForwardRepository, 'getById'>;

// 세션·SFTP·컨테이너 연결의 전송 계층으로 잠깐 열렸다 닫히는 내부 SSM 터널들의 runtimeId
// 접두사. 사용자가 만든 포워딩 규칙이 아니라 연결의 구현 세부라 활동 로그(감사)에는 남기지
// 않는다 — 안 그러면 EC2 SSH-over-SSM 연결마다 "내부 터널 + 세션" 2줄이 남고, 터널 줄은
// 매칭되는 규칙이 없어 합성 runtimeId 가 라벨로 노출된다. 사용자용 터널(container-service-tunnel:
// ·ecs-service-tunnel: 및 일반 SSH/SSM 규칙)은 그대로 로깅된다.
const INTERNAL_TRANSPORT_TUNNEL_PREFIXES = [
  'aws-ec2-ssh:', // EC2 SSH-over-SSM 전송 터널
  'aws-ec2-install-key:', // EC2 Instance Connect 임시 키 주입 터널
  'aws-sftp:', // AWS SFTP 전송 터널
  'aws-sftp-probe:', // AWS SFTP 프리플라이트 프로브 터널
  'aws-container-shell:', // 컨테이너 셸 전송 터널
  'aws-containers:', // 컨테이너 리소스 조회 터널
  // 원격 화면 세션의 전송 터널. `rdp:<sessionId>`(RDP over SSM)·`vnc:<sessionId>`(VNC over SSH
  // 터널)로 `ipc/rdp.ts`·`ipc/vnc.ts` 가 연결마다 열고 끊을 때 닫는다. 사용자가 만든 규칙은
  // randomUUID 라 이 접두사와 겹치지 않는다.
  'rdp:', // RDP-over-SSM 전송 터널
  'vnc:', // VNC-over-SSH 전송 터널
] as const;

function isInternalTransportTunnel(ruleId: string): boolean {
  return INTERNAL_TRANSPORT_TUNNEL_PREFIXES.some((prefix) => ruleId.startsWith(prefix));
}

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
    // 연결의 전송 계층으로 열리는 내부 터널은 감사 로그로 남기지 않는다(세션 로그만으로 충분).
    if (isInternalTransportTunnel(runtime.ruleId)) {
      return;
    }
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
      ...logMessage('misc.portForwardLog', { label: attempt.ruleLabel }),
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
    // 규칙이 없으면 대상을 알 방법이 없다 — 런타임 레코드에는 바인드 주소만 있다. 규칙 없이
    // 열리는 터널(컨테이너 서비스 포트)이거나, 실행 중에 규칙을 지운 경우다.
    //
    // 예전 문구가 'Target unavailable' 이었는데 그건 **대상에 못 닿았다는 말로 읽힌다** —
    // 멀쩡히 열렸다 닫힌 터널이 실패처럼 보였다. 모른다는 사실만 말한다.
    return runtime.mode === 'remote' ? 'Remote forward' : 'Target not recorded';
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
  isInternalTransportTunnel,
};
