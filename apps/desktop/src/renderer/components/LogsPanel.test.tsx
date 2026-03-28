import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityLogRecord, SessionLifecycleLogMetadata } from '@shared';
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
});
