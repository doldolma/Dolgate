import { describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, HostRecord, PortForwardRuntimeEvent, PortForwardRuleRecord } from '@shared';
import { PortForwardLifecycleLogger, __testOnly } from './port-forward-lifecycle-logger';

function createRule(overrides: Partial<PortForwardRuleRecord> = {}): PortForwardRuleRecord {
  return {
    id: 'rule-1',
    label: 'RDS tunnel',
    hostId: 'host-1',
    transport: 'aws-ssm',
    bindAddress: '127.0.0.1',
    bindPort: 15432,
    targetKind: 'remote-host',
    targetPort: 5432,
    remoteHost: 'db.internal',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    ...overrides,
  } as PortForwardRuleRecord;
}

function createEvent(
  status: PortForwardRuntimeEvent['runtime']['status'],
  overrides: Partial<PortForwardRuntimeEvent['runtime']> = {},
): PortForwardRuntimeEvent {
  return {
    runtime: {
      ruleId: 'rule-1',
      hostId: 'host-1',
      transport: 'aws-ssm',
      mode: 'local',
      method: 'ssm-remote-host',
      bindAddress: '127.0.0.1',
      bindPort: 15432,
      status,
      updatedAt: '2026-04-03T00:00:00.000Z',
      ...overrides,
    },
  };
}

function createHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: 'host',
    hostname: 'example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    ...overrides,
  } as HostRecord;
}

describe('PortForwardLifecycleLogger', () => {
  it('upserts one lifecycle row for running and stopped events in the same attempt', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => createRule()) },
      { getById: vi.fn(() => createHost({ kind: 'aws-ec2', label: 'bastion' })) },
      () => '2026-04-03T00:00:00.000Z',
    );

    logger.handleEvent(createEvent('starting', { updatedAt: '2026-04-03T00:00:00.000Z' }));
    logger.handleEvent(
      createEvent('running', {
        updatedAt: '2026-04-03T00:00:05.000Z',
        startedAt: '2026-04-03T00:00:00.000Z',
      }),
    );
    logger.handleEvent(
      createEvent('stopped', {
        updatedAt: '2026-04-03T00:05:05.000Z',
      }),
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    const [runningRecord, stoppedRecord] = upsert.mock.calls.map(([record]) => record);
    expect(runningRecord.id).toBe(stoppedRecord.id);
    expect(runningRecord.kind).toBe('port-forward-lifecycle');
    expect(runningRecord.metadata).toMatchObject({
      ruleLabel: 'RDS tunnel',
      hostLabel: 'bastion',
      targetSummary: 'Remote host db.internal:5432',
      status: 'running',
    });
    expect(stoppedRecord.metadata).toMatchObject({
      stoppedAt: '2026-04-03T00:05:05.000Z',
      durationMs: 305000,
      status: 'closed',
    });
  });

  it('records starting to error as a single lifecycle row', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => createRule({ transport: 'ssh', mode: 'dynamic', bindPort: 1080 })) },
      { getById: vi.fn(() => createHost({ label: 'ssh-host' })) },
      () => '2026-04-03T00:00:00.000Z',
    );

    logger.handleEvent(
      createEvent('starting', {
        transport: 'ssh',
        mode: 'dynamic',
        bindPort: 1080,
        updatedAt: '2026-04-03T00:00:00.000Z',
      }),
    );
    logger.handleEvent(
      createEvent('error', {
        transport: 'ssh',
        mode: 'dynamic',
        bindPort: 1080,
        updatedAt: '2026-04-03T00:00:03.000Z',
        message: 'failed',
      }),
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      level: 'error',
      kind: 'port-forward-lifecycle',
      metadata: {
        hostLabel: 'ssh-host',
        bindPort: 1080,
        targetSummary: 'SOCKS proxy',
        status: 'error',
        endReason: 'failed',
      },
    });
  });

  it('creates a new row for each new port forward attempt', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => createRule({ transport: 'container', containerName: 'web', containerRuntime: 'docker', networkName: 'bridge', targetPort: 8080 })) },
      { getById: vi.fn(() => createHost({ label: 'docker-host' })) },
      () => '2026-04-03T00:00:00.000Z',
    );

    logger.handleEvent(createEvent('starting', { transport: 'container', updatedAt: '2026-04-03T00:00:00.000Z' }));
    logger.handleEvent(createEvent('running', { transport: 'container', updatedAt: '2026-04-03T00:00:01.000Z' }));
    logger.handleEvent(createEvent('stopped', { transport: 'container', updatedAt: '2026-04-03T00:00:10.000Z' }));

    logger.handleEvent(createEvent('starting', { transport: 'container', updatedAt: '2026-04-03T00:01:00.000Z' }));
    logger.handleEvent(createEvent('running', { transport: 'container', updatedAt: '2026-04-03T00:01:01.000Z' }));
    logger.handleEvent(createEvent('stopped', { transport: 'container', updatedAt: '2026-04-03T00:01:10.000Z' }));

    const lifecycleRecords = upsert.mock.calls.map(([record]) => record);
    expect(lifecycleRecords).toHaveLength(4);
    expect(lifecycleRecords[0]?.id).not.toBe(lifecycleRecords[2]?.id);
    expect(lifecycleRecords[1]?.metadata).toMatchObject({ status: 'closed' });
    expect(lifecycleRecords[3]?.metadata).toMatchObject({ status: 'closed' });
  });

  it('labels rule-less container tunnels with the runtime label, not the rule id', () => {
    const upsert = vi
      .fn<(record: ActivityLogRecord) => ActivityLogRecord>()
      .mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn() },
      { getById: vi.fn(() => createHost({ label: 'docker-host' })) },
      () => '2026-04-03T00:00:00.000Z',
    );
    const tunnelEvent = (
      status: PortForwardRuntimeEvent['runtime']['status'],
      overrides: Partial<PortForwardRuntimeEvent['runtime']> = {},
    ) =>
      createEvent(status, {
        ruleId: 'container-service-tunnel:uuid-1',
        transport: 'container',
        bindPort: 18080,
        ...overrides,
      });

    // 첫 "starting" 에는 아직 컨테이너 이름이 없고, 라벨은 뒤 이벤트로 도착한다.
    logger.handleEvent(tunnelEvent('starting', { updatedAt: '2026-04-03T00:00:01.000Z' }));
    logger.handleEvent(
      tunnelEvent('running', {
        label: 'web:8080',
        updatedAt: '2026-04-03T00:00:02.000Z',
      }),
    );
    logger.handleEvent(tunnelEvent('stopped', { updatedAt: '2026-04-03T00:00:03.000Z' }));

    const records = upsert.mock.calls.map(([record]) => record);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.messageKey).toBe('misc.portForwardLog');
      expect(record.messageParams).toMatchObject({ label: 'web:8080' });
    }
  });

  it('closes an existing lifecycle row when shutdown emits a synthetic stopped event', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => createRule({ transport: 'ssh', mode: 'local' })) },
      { getById: vi.fn(() => createHost({ label: 'ssh-host' })) },
      () => '2026-04-03T00:00:00.000Z',
    );

    logger.handleEvent(
      createEvent('starting', {
        transport: 'ssh',
        updatedAt: '2026-04-03T00:00:00.000Z',
      }),
    );
    logger.handleEvent(
      createEvent('running', {
        transport: 'ssh',
        updatedAt: '2026-04-03T00:00:02.000Z',
        startedAt: '2026-04-03T00:00:00.000Z',
      }),
    );
    logger.handleEvent(
      createEvent('stopped', {
        transport: 'ssh',
        updatedAt: '2026-04-03T00:00:10.000Z',
      }),
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    const [runningRecord, stoppedRecord] = upsert.mock.calls.map(([record]) => record);
    expect(stoppedRecord.id).toBe(runningRecord.id);
    expect(stoppedRecord.metadata).toMatchObject({
      status: 'closed',
      stoppedAt: '2026-04-03T00:00:10.000Z',
      endReason: null,
    });
  });

  it('does not log internal transport tunnels (EC2 SSH-over-SSM, SFTP, container shells)', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => null) },
      { getById: vi.fn(() => createHost({ kind: 'aws-ec2', label: 'bastion' })) },
      () => '2026-04-03T00:00:00.000Z',
    );

    // EC2 SSH-over-SSM 전송 터널의 전체 라이프사이클을 흘려도 감사 로그가 남지 않는다.
    for (const prefix of [
      'aws-ec2-ssh:host-1:abc',
      'aws-ec2-install-key:host-1:def',
      'aws-sftp:endpoint-1',
      'aws-sftp-probe:host-1:ghi',
      'aws-container-shell:host-1:jkl',
      'aws-containers:endpoint-1',
      // 원격 화면 세션의 전송 터널. 이게 남으면 한 번 접속할 때마다 감사 로그가 두 줄
      // 생기고, 대응하는 규칙이 없어 라벨은 'vnc:pending:<uuid>' 로, 대상은 "모름" 으로 뜬다.
      'rdp:pending:mno',
      'vnc:pending:pqr',
    ]) {
      logger.handleEvent(createEvent('starting', { ruleId: prefix, updatedAt: '2026-04-03T00:00:00.000Z' }));
      logger.handleEvent(createEvent('running', { ruleId: prefix, startedAt: '2026-04-03T00:00:00.000Z' }));
      logger.handleEvent(createEvent('stopped', { ruleId: prefix, updatedAt: '2026-04-03T00:00:10.000Z' }));
    }

    expect(upsert).not.toHaveBeenCalled();
  });

  it('still logs user-facing container/ecs tunnels and plain rules', () => {
    const upsert = vi.fn<(record: ActivityLogRecord) => ActivityLogRecord>().mockImplementation((record) => record);
    const logger = new PortForwardLifecycleLogger(
      { upsert },
      { getById: vi.fn(() => null) },
      { getById: vi.fn(() => createHost()) },
      () => '2026-04-03T00:00:00.000Z',
    );

    // container-service-tunnel: / ecs-service-tunnel: 는 사용자용이라 그대로 기록된다.
    logger.handleEvent(
      createEvent('running', {
        ruleId: 'container-service-tunnel:xyz',
        transport: 'container',
        startedAt: '2026-04-03T00:00:00.000Z',
      }),
    );
    logger.handleEvent(
      createEvent('running', {
        ruleId: 'ecs-service-tunnel:xyz',
        transport: 'ecs-task',
        startedAt: '2026-04-03T00:00:00.000Z',
      }),
    );

    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe('summarizePortForwardTarget', () => {
  // 규칙이 없으면 대상을 알 수 없다. 옛 문구('Target unavailable')는 대상에 못 닿았다는 말로
  // 읽혀서, 멀쩡히 열렸다 닫힌 터널이 실패처럼 보였다.
  it('규칙이 없는 로컬 포워딩은 실패로 읽히지 않게 적는다', () => {
    const summary = __testOnly.summarizePortForwardTarget(
      null,
      createEvent('running', { ruleId: 'container-service-tunnel:xyz' }).runtime,
    );
    expect(summary).toBe('Target not recorded');
    expect(summary).not.toMatch(/unavailable|failed|error/iu);
  });

  it('규칙이 있으면 대상을 그대로 적는다', () => {
    expect(
      __testOnly.summarizePortForwardTarget(createRule(), createEvent('running').runtime),
    ).toBe('Remote host db.internal:5432');
  });
});

describe('isInternalTransportTunnel', () => {
  it('matches internal transport prefixes but not user rules', () => {
    expect(__testOnly.isInternalTransportTunnel('aws-ec2-ssh:host:uuid')).toBe(true);
    expect(__testOnly.isInternalTransportTunnel('aws-container-shell:host:uuid')).toBe(true);
    expect(__testOnly.isInternalTransportTunnel('rdp:pending:uuid')).toBe(true);
    expect(__testOnly.isInternalTransportTunnel('vnc:pending:uuid')).toBe(true);
    expect(__testOnly.isInternalTransportTunnel('container-service-tunnel:uuid')).toBe(false);
    expect(__testOnly.isInternalTransportTunnel('ecs-service-tunnel:uuid')).toBe(false);
    expect(__testOnly.isInternalTransportTunnel('rule-1')).toBe(false);
  });
});
