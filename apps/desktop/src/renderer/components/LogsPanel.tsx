import { useMemo, useState } from 'react';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  PortForwardLifecycleLogMetadata,
  SessionConnectionKind,
  SessionLifecycleLogMetadata,
  PortForwardTransport,
} from '@shared';
import { Badge, Button, Card, CardMain, EmptyState, SectionLabel } from '../ui';

interface LogsPanelProps {
  logs: ActivityLogRecord[];
  onClear: () => Promise<void>;
  onOpenReplay: (recordingId: string) => Promise<void>;
}

function isSessionLifecycleMetadata(value: Record<string, unknown> | null): value is SessionLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.sessionId === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.title === 'string' &&
      typeof value.connectionKind === 'string' &&
      typeof value.connectedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function isPortForwardLifecycleMetadata(value: Record<string, unknown> | null): value is PortForwardLifecycleLogMetadata & Record<string, unknown> {
  return Boolean(
    value &&
      typeof value.ruleId === 'string' &&
      typeof value.ruleLabel === 'string' &&
      typeof value.hostId === 'string' &&
      typeof value.hostLabel === 'string' &&
      typeof value.transport === 'string' &&
      typeof value.mode === 'string' &&
      typeof value.bindAddress === 'string' &&
      typeof value.bindPort === 'number' &&
      typeof value.targetSummary === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.status === 'string'
  );
}

function getConnectionKindLabel(kind: SessionConnectionKind): string {
  if (kind === 'aws-ssm') {
    return 'AWS SSM';
  }
  if (kind === 'aws-ecs-exec') {
    return 'AWS ECS Exec';
  }
  if (kind === 'warpgate') {
    return 'Warpgate';
  }
  return 'SSH';
}

function getConnectionKindTone(kind: SessionConnectionKind): 'running' | 'starting' | 'paused' {
  if (kind === 'aws-ssm') {
    return 'starting';
  }
  if (kind === 'aws-ecs-exec') {
    return 'starting';
  }
  if (kind === 'warpgate') {
    return 'paused';
  }
  return 'running';
}

function getPortForwardTransportLabel(transport: PortForwardTransport): string {
  if (transport === 'aws-ssm') {
    return 'AWS SSM';
  }
  if (transport === 'ecs-task') {
    return 'ECS Task';
  }
  if (transport === 'container') {
    return 'Container';
  }
  return 'SSH';
}

function getPortForwardTransportTone(transport: PortForwardTransport): 'running' | 'starting' | 'paused' {
  if (transport === 'aws-ssm' || transport === 'ecs-task') {
    return 'starting';
  }
  return 'running';
}

function getLifecycleStatusLabel(status: SessionLifecycleLogMetadata['status']): string {
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getLifecycleStatusTone(status: SessionLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'connected') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function getPortForwardStatusLabel(status: PortForwardLifecycleLogMetadata['status']): string {
  if (status === 'running') {
    return 'Running';
  }
  if (status === 'error') {
    return 'Error';
  }
  return 'Closed';
}

function getPortForwardStatusTone(status: PortForwardLifecycleLogMetadata['status']): 'running' | 'error' | 'stopped' {
  if (status === 'running') {
    return 'running';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'stopped';
}

function formatLogTimestamp(value: string): string {
  return new Date(value).toLocaleString('ko-KR');
}

export function formatSessionLifecycleDuration(durationMs?: number | null): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return '0초';
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }
  return `${seconds}초`;
}

function getSessionLifecycleSubtitle(metadata: SessionLifecycleLogMetadata): string | null {
  const connectionDetails = metadata.connectionDetails?.trim();
  if (connectionDetails) {
    return connectionDetails;
  }
  const title = metadata.title.trim();
  const hostLabel = metadata.hostLabel.trim();
  if (!title || title === hostLabel) {
    return null;
  }
  return title;
}

export function LogsPanel({ logs, onClear, onOpenReplay }: LogsPanelProps) {
  const [category, setCategory] = useState<'all' | ActivityLogCategory>('all');
  const [level, setLevel] = useState<'all' | ActivityLogLevel>('all');

  const visibleLogs = useMemo(
    () =>
      logs.filter((log) => {
        if (category !== 'all' && log.category !== category) {
          return false;
        }
        if (level !== 'all' && log.level !== level) {
          return false;
        }
        return true;
      }),
    [category, level, logs]
  );

  return (
    <div className="flex flex-col gap-[1.05rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <SectionLabel>Diagnostics</SectionLabel>
          <h2 className="m-0">Logs</h2>
        </div>
        <Button variant="secondary" onClick={() => void onClear()}>
          Clear logs
        </Button>
      </div>

      <div className="logs-toolbar">
        <label className="form-field form-field--compact">
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as 'all' | ActivityLogCategory)}>
            <option value="all">All</option>
            <option value="session">Session</option>
            <option value="audit">Audit</option>
          </select>
        </label>

        <label className="form-field form-field--compact">
          <span>Level</span>
          <select value={level} onChange={(event) => setLevel(event.target.value as 'all' | ActivityLogLevel)}>
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
      </div>

      <div className="operations-list">
        {visibleLogs.length === 0 ? (
          <EmptyState
            title="조건에 맞는 로그가 없습니다."
            description="세션 연결 기록과 보안·설정 변경 기록만 여기에 남습니다."
          />
        ) : (
          visibleLogs.map((log) => {
            const sessionLifecycleMetadata =
              log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const portForwardLifecycleMetadata =
              log.kind === 'port-forward-lifecycle' && isPortForwardLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const replayRecordingId =
              sessionLifecycleMetadata != null &&
              sessionLifecycleMetadata.hasReplay === true &&
              typeof sessionLifecycleMetadata.recordingId === 'string'
                ? sessionLifecycleMetadata.recordingId
                : null;

            return sessionLifecycleMetadata ? (
              <Card key={log.id} className="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem] logs-lifecycle-card__header">
                    <div>
                      <strong>{sessionLifecycleMetadata.hostLabel}</strong>
                      {getSessionLifecycleSubtitle(sessionLifecycleMetadata) ? (
                        <div className="logs-lifecycle-card__title">{getSessionLifecycleSubtitle(sessionLifecycleMetadata)}</div>
                      ) : null}
                    </div>
                    <div className="logs-lifecycle-card__badges">
                      {sessionLifecycleMetadata.status !== 'connected' && replayRecordingId ? (
                        <Button variant="secondary" size="sm" onClick={() => void onOpenReplay(replayRecordingId)}>
                          Replay
                        </Button>
                      ) : null}
                      <Badge tone={getConnectionKindTone(sessionLifecycleMetadata.connectionKind)}>
                        {getConnectionKindLabel(sessionLifecycleMetadata.connectionKind)}
                      </Badge>
                      <Badge tone={getLifecycleStatusTone(sessionLifecycleMetadata.status)}>
                        {getLifecycleStatusLabel(sessionLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="logs-lifecycle-card__timeline">
                    <div className="logs-lifecycle-card__item">
                      <span>연결 시작</span>
                      <strong>{formatLogTimestamp(sessionLifecycleMetadata.connectedAt)}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>연결 종료</span>
                      <strong>{sessionLifecycleMetadata.disconnectedAt ? formatLogTimestamp(sessionLifecycleMetadata.disconnectedAt) : '연결 중'}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>연결 시간</span>
                      <strong>{formatSessionLifecycleDuration(sessionLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {sessionLifecycleMetadata.disconnectReason ? (
                    <div className="logs-lifecycle-card__reason">{sessionLifecycleMetadata.disconnectReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : portForwardLifecycleMetadata ? (
              <Card key={log.id} className="logs-lifecycle-card">
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem] logs-lifecycle-card__header">
                    <div>
                      <strong>{portForwardLifecycleMetadata.ruleLabel}</strong>
                      <div className="logs-lifecycle-card__title">{portForwardLifecycleMetadata.hostLabel}</div>
                      <div className="logs-lifecycle-card__title">
                        {`${portForwardLifecycleMetadata.bindAddress}:${portForwardLifecycleMetadata.bindPort} -> ${portForwardLifecycleMetadata.targetSummary}`}
                      </div>
                    </div>
                    <div className="logs-lifecycle-card__badges">
                      <Badge tone={getPortForwardTransportTone(portForwardLifecycleMetadata.transport)}>
                        {getPortForwardTransportLabel(portForwardLifecycleMetadata.transport)}
                      </Badge>
                      <Badge tone={getPortForwardStatusTone(portForwardLifecycleMetadata.status)}>
                        {getPortForwardStatusLabel(portForwardLifecycleMetadata.status)}
                      </Badge>
                    </div>
                  </div>
                  <div className="logs-lifecycle-card__timeline">
                    <div className="logs-lifecycle-card__item">
                      <span>포워딩 시작</span>
                      <strong>{formatLogTimestamp(portForwardLifecycleMetadata.startedAt)}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>포워딩 종료</span>
                      <strong>{portForwardLifecycleMetadata.stoppedAt ? formatLogTimestamp(portForwardLifecycleMetadata.stoppedAt) : '포워딩 중'}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>유지 시간</span>
                      <strong>{formatSessionLifecycleDuration(portForwardLifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {portForwardLifecycleMetadata.endReason ? (
                    <div className="logs-lifecycle-card__reason">{portForwardLifecycleMetadata.endReason}</div>
                  ) : null}
                </CardMain>
              </Card>
            ) : (
              <Card key={log.id}>
                <CardMain>
                  <div className="flex flex-wrap items-center gap-[0.7rem]">
                    <strong>{log.message}</strong>
                    <Badge tone={log.level === 'error' ? 'error' : log.level === 'warn' ? 'starting' : 'running'}>
                      {log.level.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="mt-[0.45rem] flex flex-wrap gap-[0.8rem] text-[0.92rem] text-[var(--text-soft)]">
                    <span>{log.category}</span>
                    <span>{formatLogTimestamp(log.createdAt)}</span>
                  </div>
                  {log.metadata ? (
                    <details className="log-details">
                      <summary>Metadata</summary>
                      <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </CardMain>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
