import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, PortForwardLifecycleLogMetadata, SessionLifecycleLogMetadata, SftpLifecycleLogMetadata } from '@shared';
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

describe('LogsPanel', () => {
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
            disconnectReason: 'session-manager-plugin failed',
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
    expect(screen.getByText('session-manager-plugin failed')).toBeInTheDocument();
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
});
