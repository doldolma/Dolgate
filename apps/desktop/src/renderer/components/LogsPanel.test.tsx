import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, ContainerActionLogMetadata, ContainerLifecycleLogMetadata, PortForwardLifecycleLogMetadata, SessionLifecycleLogMetadata, SftpLifecycleLogMetadata } from '@shared';
import { LogsPanel } from './LogsPanel';

function createLifecycleLog(
  metadata: SessionLifecycleLogMetadata,
  overrides: Partial<ActivityLogRecord> = {}
): ActivityLogRecord {
  return {
    id: `session:${metadata.sessionId}`,
    level: metadata.status === 'error' ? 'error' : 'info',
    category: 'session',
    kind: 'session-lifecycle',
    message: '세션',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.connectedAt,
    updatedAt: metadata.disconnectedAt ?? metadata.connectedAt,
    ...overrides
  };
}

function createPortForwardLifecycleLog(
  metadata: PortForwardLifecycleLogMetadata,
  overrides: Partial<ActivityLogRecord> = {}
): ActivityLogRecord {
  return {
    id: `port-forward:${metadata.ruleId}:attempt-1`,
    level: metadata.status === 'error' ? 'error' : 'info',
    category: 'audit',
    kind: 'port-forward-lifecycle',
    message: `${metadata.ruleLabel} 포트 포워딩`,
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.startedAt,
    updatedAt: metadata.stoppedAt ?? metadata.startedAt,
    ...overrides
  };
}

function createSftpLifecycleLog(
  metadata: SftpLifecycleLogMetadata,
  overrides: Partial<ActivityLogRecord> = {}
): ActivityLogRecord {
  return {
    id: `sftp:${metadata.endpointId}`,
    level: metadata.status === 'error' || metadata.errorCount > 0 ? 'error' : 'info',
    category: 'session',
    kind: 'sftp-lifecycle',
    message: 'SFTP 세션',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.startedAt,
    updatedAt: metadata.endedAt ?? metadata.startedAt,
    ...overrides
  };
}

function createContainerLifecycleLog(metadata: ContainerLifecycleLogMetadata): ActivityLogRecord {
  return {
    id: `container:${metadata.lifecycleId}`,
    level: metadata.status === 'error' ? 'error' : 'info',
    category: 'session',
    kind: 'container-lifecycle',
    message: 'Containers 연결',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.startedAt,
    updatedAt: metadata.endedAt ?? metadata.startedAt,
  };
}

function createContainerActionLog(metadata: ContainerActionLogMetadata): ActivityLogRecord {
  return {
    id: `container-action:${metadata.actionId}`,
    level: metadata.status === 'error' ? 'error' : 'warn',
    category: 'audit',
    kind: 'container-action',
    message: '컨테이너 삭제',
    metadata: metadata as unknown as Record<string, unknown>,
    createdAt: metadata.startedAt,
    updatedAt: metadata.completedAt,
  };
}

describe('LogsPanel', () => {
  it.each([
    ['ssh-over-ssm', true, 'SSH over SSM (tmux)'],
    ['ssm-shell', false, 'SSM Shell'],
    [undefined, false, 'AWS SSM'],
  ] as const)('labels EC2 logs with actual transport %s', (awsTransport, tmux, label) => {
    render(<LogsPanel onClear={vi.fn()} onOpenReplay={vi.fn()} logs={[createLifecycleLog({
      sessionId: 'ec2', hostId: 'host', hostLabel: 'EC2', title: 'EC2',
      connectionKind: 'aws-ssm', awsTransport, tmux,
      connectedAt: '2026-06-18T00:00:00.000Z', status: 'connected',
    })]} />);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });
  it('renders a container lifecycle summary card', () => {
    render(
      <LogsPanel
        logs={[
          createContainerLifecycleLog({
            lifecycleId: 'lifecycle-1',
            hostId: 'host-1',
            hostLabel: 'Prod Docker',
            workspaceKind: 'host-runtime',
            transport: 'aws-ssm',
            runtime: 'docker',
            startedAt: '2026-06-18T00:00:00.000Z',
            connectedAt: '2026-06-18T00:00:01.000Z',
            status: 'connected',
            refreshCount: 2,
            errorCount: 1,
            resourceCount: 4,
            lastError: 'refresh failed',
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId('logs-container-lifecycle-card')).toBeInTheDocument();
    expect(screen.getByText('Prod Docker')).toBeInTheDocument();
    expect(screen.getByText('AWS SSM')).toBeInTheDocument();
    expect(screen.getByText('DOCKER')).toBeInTheDocument();
    expect(screen.getByText('컨테이너 4개')).toBeInTheDocument();
    expect(screen.getByText('새로고침 2회')).toBeInTheDocument();
    expect(screen.getByText('오류 1회')).toBeInTheDocument();
    expect(screen.getByText('refresh failed')).toBeInTheDocument();
  });

  it('renders container actions in the audit category', () => {
    render(
      <LogsPanel
        logs={[
          createContainerActionLog({
            actionId: 'action-1',
            hostId: 'host-1',
            hostLabel: 'Prod Docker',
            containerId: 'abc123',
            containerName: 'api',
            runtime: 'podman',
            action: 'remove',
            status: 'success',
            startedAt: '2026-06-18T00:00:00.000Z',
            completedAt: '2026-06-18T00:00:01.000Z',
            durationMs: 1000,
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId('logs-container-action-card')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
    expect(screen.getByText('PODMAN')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  it('renders remote session lifecycle rows with host label, kind badge, and connected state', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'ssh-session-1',
            hostId: 'host-1',
            hostLabel: 'nas',
            title: 'Production NAS',
            connectionDetails: 'doldolma.com · 22 · doyoung',
            connectionKind: 'warpgate',
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('nas')).toBeInTheDocument();
    expect(screen.getByText('doldolma.com · 22 · doyoung')).toBeInTheDocument();
    expect(screen.getByText('Warpgate')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('연결 중')).toBeInTheDocument();
  });

  it('renders an RDP lifecycle row with its own kind badge and duration', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'rdp-session-1',
            hostId: 'host-2',
            hostLabel: 'work-pc',
            title: 'work-pc',
            connectionDetails: '10.0.0.5 · 3389 · admin',
            connectionKind: 'rdp',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:01:00.000Z',
            durationMs: 60000,
            status: 'closed',
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('work-pc')).toBeInTheDocument();
    // 라벨 폴백이 'SSH' 라서, 케이스가 빠지면 RDP 행이 SSH 로 표시된다.
    expect(screen.getByText('RDP')).toBeInTheDocument();
    expect(screen.getByText('1분 0초')).toBeInTheDocument();
  });

  it('renders a VNC lifecycle row with its own kind badge', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'vnc-session-1',
            hostId: 'host-3',
            hostLabel: 'lab-console',
            title: 'lab-console',
            // SSH 터널을 경유하면 붙는 주소가 로컬 끝단이다 — 그래서 배지 말고는 종류를 알
            // 방법이 없다.
            connectionDetails: '127.0.0.1 · 5901',
            connectionKind: 'vnc',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:00:45.000Z',
            durationMs: 45000,
            status: 'closed',
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('lab-console')).toBeInTheDocument();
    // 라벨 폴백이 'SSH' 라서, 케이스가 빠지면 VNC 행이 SSH 로 표시된다(실제로 그랬다).
    expect(screen.getByText('VNC')).toBeInTheDocument();
    expect(screen.queryByText('SSH')).not.toBeInTheDocument();
  });

  it('renders a local terminal lifecycle row with replay access', () => {
    const onOpenReplay = vi.fn().mockResolvedValue(undefined);
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'local-session-1',
            hostId: 'local-terminal',
            hostLabel: 'Local Terminal',
            title: 'Terminal 2',
            connectionKind: 'local',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:01:00.000Z',
            durationMs: 60000,
            status: 'closed',
            recordingId: 'local-recording-1',
            hasReplay: true,
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={onOpenReplay}
      />
    );

    expect(screen.getByText('Local Terminal')).toBeInTheDocument();
    expect(screen.getByText('Terminal 2')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('1분 0초')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(onOpenReplay).toHaveBeenCalledWith('local-recording-1');
  });

  it('renders ECS Exec lifecycle metadata with the AWS ECS Exec badge', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'ecs-session-1',
            hostId: 'ecs-host-1',
            hostLabel: 'prod',
            title: 'prod · api · web',
            connectionDetails: 'api · web · task-1',
            connectionKind: 'aws-ecs-exec',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:00:30.000Z',
            durationMs: 30000,
            status: 'closed',
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('prod')).toBeInTheDocument();
    expect(screen.getByText('api · web · task-1')).toBeInTheDocument();
    expect(screen.getByText('AWS ECS Exec')).toBeInTheDocument();
  });

  it('hides duplicate lifecycle subtitles when host label and title are the same', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'ssh-session-duplicate',
            hostId: 'host-4',
            hostLabel: 'nas',
            title: 'nas',
            connectionDetails: 'doldolma.com · 22 · doyoung',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('nas')).toBeInTheDocument();
    expect(screen.queryAllByText('nas')).toHaveLength(1);
    expect(screen.getByText('doldolma.com · 22 · doyoung')).toBeInTheDocument();
  });

  it('labels tmux SSH lifecycle sessions in the connection badge', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'tmux-session-1',
            hostId: 'host-tmux',
            hostLabel: 'tmux host',
            title: 'tmux host',
            connectionKind: 'ssh',
            tmux: true,
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected',
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('SSH (tmux)')).toBeInTheDocument();
  });

  it('renders disconnected lifecycle rows with duration and disconnect reason', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'aws-session-1',
            hostId: 'host-2',
            hostLabel: 'bastion',
            title: 'AWS Bastion',
            connectionDetails: 'default · ap-northeast-2 · i-1234567890',
            connectionKind: 'aws-ssm',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:05:12.000Z',
            durationMs: 312000,
            status: 'error',
            disconnectReason: 'opening SSM data channel: websocket: bad handshake',
            recordingId: 'recording-1',
            hasReplay: true,
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const lifecycleCard = screen.getByText('bastion').closest('article');
    expect(lifecycleCard).not.toBeNull();
    expect(screen.getByText('AWS SSM')).toBeInTheDocument();
    expect(screen.getByText('default · ap-northeast-2 · i-1234567890')).toBeInTheDocument();
    expect(within(lifecycleCard as HTMLElement).getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('5분 12초')).toBeInTheDocument();
    expect(screen.getByText('opening SSM data channel: websocket: bad handshake')).toBeInTheDocument();
  });

  it('keeps generic logs rendering metadata details', () => {
    render(
      <LogsPanel
        logs={[
          {
            id: 'generic-1',
            level: 'warn',
            category: 'audit',
            kind: 'generic',
            message: '설정이 변경되었습니다.',
            metadata: { field: 'theme' },
            createdAt: '2026-03-29T00:00:00.000Z',
            updatedAt: '2026-03-29T00:00:00.000Z'
          }
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('설정이 변경되었습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Metadata'));
    expect(screen.getByText(/"field": "theme"/)).toBeInTheDocument();
  });

  it('renders port forward lifecycle rows as a single lifecycle card', () => {
    render(
      <LogsPanel
        logs={[
          createPortForwardLifecycleLog({
            ruleId: 'rule-1',
            ruleLabel: 'RDS tunnel',
            hostId: 'host-1',
            hostLabel: 'bastion',
            transport: 'aws-ssm',
            mode: 'local',
            bindAddress: '127.0.0.1',
            bindPort: 15432,
            targetSummary: 'Remote host db.internal:5432',
            startedAt: '2026-03-29T00:00:00.000Z',
            stoppedAt: '2026-03-29T00:05:00.000Z',
            durationMs: 300000,
            status: 'closed'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const lifecycleCard = screen.getByText('RDS tunnel').closest('article');
    expect(lifecycleCard).not.toBeNull();
    expect(screen.getByText('bastion')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:15432 -> Remote host db.internal:5432')).toBeInTheDocument();
    expect(screen.getByText('AWS SSM')).toBeInTheDocument();
    expect(within(lifecycleCard as HTMLElement).getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('포워딩 중')).not.toBeInTheDocument();
    expect(screen.getByText('5분 0초')).toBeInTheDocument();
  });

  it('renders SFTP lifecycle rows as a single summary card', () => {
    render(
      <LogsPanel
        logs={[
          createSftpLifecycleLog({
            endpointId: 'endpoint-1',
            hostId: 'host-1',
            hostLabel: 'Synology',
            title: 'Synology',
            startedAt: '2026-03-29T00:00:00.000Z',
            connectedAt: '2026-03-29T00:00:01.000Z',
            endedAt: '2026-03-29T00:03:01.000Z',
            durationMs: 180000,
            status: 'closed',
            uploadedCount: 1,
            downloadedCount: 3,
            remoteCopyCount: 1,
            uploadedBytes: 2048,
            downloadedBytes: 4096,
            remoteCopyBytes: 1024,
            mkdirCount: 1,
            renameCount: 1,
            chmodCount: 2,
            chownCount: 0,
            deleteCount: 2,
            errorCount: 1,
            visitedPathCount: 4,
            lastPath: '/volume1/logs',
            endReason: 'client requested disconnect',
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const lifecycleCard = screen.getByText('Synology').closest('article');
    expect(lifecycleCard).not.toBeNull();
    expect(screen.getByText('SFTP')).toBeInTheDocument();
    expect(within(lifecycleCard as HTMLElement).getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('3분 0초')).toBeInTheDocument();
    expect(screen.getByText('다운로드 3개 · 4KB')).toBeInTheDocument();
    expect(screen.getByText('업로드 1개 · 2KB')).toBeInTheDocument();
    expect(screen.getByText('원격 복사 1개 · 1KB')).toBeInTheDocument();
    expect(screen.getByText('삭제 2개')).toBeInTheDocument();
    expect(screen.getByText('폴더 생성 1개')).toBeInTheDocument();
    expect(screen.getByText('이름 변경 1개')).toBeInTheDocument();
    expect(screen.getByText('권한 변경 2개')).toBeInTheDocument();
    expect(screen.getByText('경로 탐색 4개')).toBeInTheDocument();
    expect(screen.getByText('오류 1개')).toBeInTheDocument();
    expect(screen.getByText('마지막 경로: /volume1/logs')).toBeInTheDocument();
    expect(screen.getByText('client requested disconnect')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replay' })).not.toBeInTheDocument();
  });

  it('keeps empty SFTP lifecycle rows compact without noisy summary chips', () => {
    render(
      <LogsPanel
        logs={[
          createSftpLifecycleLog({
            endpointId: 'endpoint-empty',
            hostId: 'host-empty',
            hostLabel: 'Empty SFTP',
            title: 'Empty SFTP',
            startedAt: '2026-03-29T00:00:00.000Z',
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected',
            uploadedCount: 0,
            downloadedCount: 0,
            remoteCopyCount: 0,
            uploadedBytes: 0,
            downloadedBytes: 0,
            remoteCopyBytes: 0,
            mkdirCount: 0,
            renameCount: 0,
            chmodCount: 0,
            chownCount: 0,
            deleteCount: 0,
            errorCount: 0,
            visitedPathCount: 1,
            lastPath: '/home/user',
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('Empty SFTP')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('연결 중')).toBeInTheDocument();
    expect(screen.queryByText(/다운로드/)).not.toBeInTheDocument();
    expect(screen.queryByText(/경로 탐색/)).not.toBeInTheDocument();
  });

  it('keeps category and level filters working for lifecycle rows', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'ssh-session-2',
            hostId: 'host-3',
            hostLabel: 'ssh-host',
            title: 'SSH Host',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:01:00.000Z',
            durationMs: 60000,
            status: 'closed'
          }),
          {
            id: 'audit-2',
            level: 'info',
            category: 'audit',
            kind: 'generic',
            message: 'known_hosts가 갱신되었습니다.',
            metadata: null,
            createdAt: '2026-03-29T00:02:00.000Z',
            updatedAt: '2026-03-29T00:02:00.000Z'
          }
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'session' }
    });
    expect(screen.getByText('ssh-host')).toBeInTheDocument();
    expect(
      screen.queryByText('known_hosts가 갱신되었습니다.')
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Level'), {
      target: { value: 'error' }
    });
    expect(screen.getByText('조건에 맞는 로그가 없습니다.')).toBeInTheDocument();
  });

  it('shows Replay only for ended sessions with a recording and opens it', () => {
    const onOpenReplay = vi.fn().mockResolvedValue(undefined);
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'ended-session',
            hostId: 'host-9',
            hostLabel: 'nas',
            title: 'NAS',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:00:00.000Z',
            disconnectedAt: '2026-03-29T00:01:00.000Z',
            durationMs: 60000,
            status: 'closed',
            recordingId: 'recording-9',
            hasReplay: true,
          }),
          createLifecycleLog({
            sessionId: 'active-session',
            hostId: 'host-10',
            hostLabel: 'warp',
            title: 'Warp',
            connectionKind: 'warpgate',
            connectedAt: '2026-03-29T00:02:00.000Z',
            status: 'connected',
            recordingId: 'recording-10',
            hasReplay: true,
          }),
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={onOpenReplay}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    expect(onOpenReplay).toHaveBeenCalledWith('recording-9');
    expect(screen.queryAllByRole('button', { name: 'Replay' })).toHaveLength(1);
  });

  it('keeps audit category filters working for port forward lifecycle rows', () => {
    render(
      <LogsPanel
        logs={[
          createPortForwardLifecycleLog({
            ruleId: 'rule-2',
            ruleLabel: 'Kafka tunnel',
            hostId: 'host-2',
            hostLabel: 'broker-host',
            transport: 'ssh',
            mode: 'local',
            bindAddress: '127.0.0.2',
            bindPort: 19092,
            targetSummary: 'Target kafka.internal:9092',
            startedAt: '2026-03-29T00:00:00.000Z',
            status: 'running'
          }),
          createLifecycleLog({
            sessionId: 'ssh-session-3',
            hostId: 'host-3',
            hostLabel: 'ssh-host',
            title: 'SSH Host',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:01:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'audit' }
    });
    expect(screen.getByText('Kafka tunnel')).toBeInTheDocument();
    expect(screen.queryByText('ssh-host')).not.toBeInTheDocument();
  });

  /**
   * 카드 여섯 종류 중 다섯은 번역된 메시지를 안 쓰고 메타데이터에서 직접 그린다. 저장된
   * message 만 훑는 검색은 화면에 보이는 글자의 대부분을 못 찾는다 — 그 배선을 지킨다.
   */
  it('searches the text the cards actually render, not the stored message', () => {
    render(
      <LogsPanel
        logs={[
          createPortForwardLifecycleLog({
            ruleId: 'rule-7',
            ruleLabel: 'Kafka tunnel',
            hostId: 'host-7',
            hostLabel: 'broker-host',
            transport: 'ssh',
            mode: 'local',
            bindAddress: '127.0.0.1',
            bindPort: 19092,
            targetSummary: 'kafka.internal:9092',
            startedAt: '2026-03-29T00:00:00.000Z',
            status: 'running'
          }),
          createLifecycleLog({
            sessionId: 'ssh-session-7',
            hostId: 'host-8',
            hostLabel: 'ssh-host',
            title: 'SSH Host',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:01:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // 포트는 메타데이터에만 있고 message 에는 없다.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '19092' } });
    expect(screen.getByText('Kafka tunnel')).toBeInTheDocument();
    expect(screen.queryByText('ssh-host')).not.toBeInTheDocument();

    // 전달 대상 주소도 마찬가지.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'kafka.internal' } });
    expect(screen.getByText('Kafka tunnel')).toBeInTheDocument();
  });

  it('matches host names case-insensitively and clears back to the full list', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'a',
            hostId: 'host-a',
            hostLabel: 'prod-web-01',
            title: 'prod-web-01',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected'
          }),
          createLifecycleLog({
            sessionId: 'b',
            hostId: 'host-b',
            hostLabel: 'db-replica',
            title: 'db-replica',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:01:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'PROD-WEB' } });
    expect(screen.getByText('prod-web-01')).toBeInTheDocument();
    expect(screen.queryByText('db-replica')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '   ' } });
    expect(screen.getByText('prod-web-01')).toBeInTheDocument();
    expect(screen.getByText('db-replica')).toBeInTheDocument();
  });

  /** 호스트 검색과 같은 규칙. 같은 앱 안에서 검색 동작이 갈리면 안 된다. */
  it('finds Hangul host names typed on a QWERTY layout', () => {
    render(
      <LogsPanel
        logs={[
          createLifecycleLog({
            sessionId: 'kr',
            hostId: 'host-kr',
            hostLabel: '서버-01',
            title: '서버-01',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:00:00.000Z',
            status: 'connected'
          }),
          createLifecycleLog({
            sessionId: 'en',
            hostId: 'host-en',
            hostLabel: 'bastion',
            title: 'bastion',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:01:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'tjqj' } });
    expect(screen.getByText('서버-01')).toBeInTheDocument();
    expect(screen.queryByText('bastion')).not.toBeInTheDocument();
  });

  it('narrows together with the category and level filters', () => {
    render(
      <LogsPanel
        logs={[
          createContainerActionLog({
            actionId: 'act-1',
            hostId: 'host-c',
            hostLabel: 'docker-host',
            containerId: 'abc123',
            containerName: 'redis-cache',
            action: 'restart',
            status: 'success',
            startedAt: '2026-03-29T00:00:00.000Z',
            completedAt: '2026-03-29T00:00:02.000Z',
            durationMs: 2000,
          }),
          createLifecycleLog({
            sessionId: 'sess-c',
            hostId: 'host-d',
            hostLabel: 'redis-box',
            title: 'redis-box',
            connectionKind: 'ssh',
            connectedAt: '2026-03-29T00:01:00.000Z',
            status: 'connected'
          })
        ]}
        onClear={vi.fn().mockResolvedValue(undefined)}
        onOpenReplay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'redis' } });
    expect(screen.getByText('redis-cache')).toBeInTheDocument();
    expect(screen.getByText('redis-box')).toBeInTheDocument();

    // 컨테이너 액션은 audit, 세션은 session 이다.
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'audit' } });
    expect(screen.getByText('redis-cache')).toBeInTheDocument();
    expect(screen.queryByText('redis-box')).not.toBeInTheDocument();

    // 걸리는 것이 없으면 빈 상태 문구가 나온다(로그가 아예 없다는 뜻이 아니다).
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('조건에 맞는 로그가 없습니다.')).toBeInTheDocument();
  });
});
