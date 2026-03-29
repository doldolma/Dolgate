import { useMemo, useState } from 'react';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  SessionConnectionKind,
  SessionLifecycleLogMetadata
} from '@shared';

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
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Diagnostics</div>
          <h2>Logs</h2>
        </div>
        <button type="button" className="secondary-button" onClick={() => void onClear()}>
          Clear logs
        </button>
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
          <div className="empty-callout">
            <strong>조건에 맞는 로그가 없습니다.</strong>
            <p>세션 연결 기록과 보안·설정 변경 기록만 여기에 남습니다.</p>
          </div>
        ) : (
          visibleLogs.map((log) => {
            const lifecycleMetadata =
              log.kind === 'session-lifecycle' && isSessionLifecycleMetadata(log.metadata)
                ? log.metadata
                : null;
            const replayRecordingId =
              lifecycleMetadata != null &&
              lifecycleMetadata.hasReplay === true &&
              typeof lifecycleMetadata.recordingId === 'string'
                ? lifecycleMetadata.recordingId
                : null;

            return lifecycleMetadata ? (
              <article key={log.id} className="operations-card logs-lifecycle-card">
                <div className="operations-card__main">
                  <div className="operations-card__title-row logs-lifecycle-card__header">
                    <div>
                      <strong>{lifecycleMetadata.hostLabel}</strong>
                      {getSessionLifecycleSubtitle(lifecycleMetadata) ? (
                        <div className="logs-lifecycle-card__title">{getSessionLifecycleSubtitle(lifecycleMetadata)}</div>
                      ) : null}
                    </div>
                    <div className="logs-lifecycle-card__badges">
                      {lifecycleMetadata.status !== 'connected' && replayRecordingId ? (
                        <button
                          type="button"
                          className="secondary-button secondary-button--compact"
                          onClick={() => void onOpenReplay(replayRecordingId)}
                        >
                          Replay
                        </button>
                      ) : null}
                      <span className={`status-pill status-pill--${getConnectionKindTone(lifecycleMetadata.connectionKind)}`}>
                        {getConnectionKindLabel(lifecycleMetadata.connectionKind)}
                      </span>
                      <span className={`status-pill status-pill--${getLifecycleStatusTone(lifecycleMetadata.status)}`}>
                        {getLifecycleStatusLabel(lifecycleMetadata.status)}
                      </span>
                    </div>
                  </div>
                  <div className="logs-lifecycle-card__timeline">
                    <div className="logs-lifecycle-card__item">
                      <span>연결 시작</span>
                      <strong>{formatLogTimestamp(lifecycleMetadata.connectedAt)}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>연결 종료</span>
                      <strong>{lifecycleMetadata.disconnectedAt ? formatLogTimestamp(lifecycleMetadata.disconnectedAt) : '연결 중'}</strong>
                    </div>
                    <div className="logs-lifecycle-card__item">
                      <span>연결 시간</span>
                      <strong>{formatSessionLifecycleDuration(lifecycleMetadata.durationMs)}</strong>
                    </div>
                  </div>
                  {lifecycleMetadata.disconnectReason ? (
                    <div className="logs-lifecycle-card__reason">{lifecycleMetadata.disconnectReason}</div>
                  ) : null}
                </div>
              </article>
            ) : (
              <article key={log.id} className="operations-card">
                <div className="operations-card__main">
                  <div className="operations-card__title-row">
                    <strong>{log.message}</strong>
                    <span className={`status-pill status-pill--${log.level === 'error' ? 'error' : log.level === 'warn' ? 'starting' : 'running'}`}>
                      {log.level.toUpperCase()}
                    </span>
                  </div>
                  <div className="operations-card__meta">
                    <span>{log.category}</span>
                    <span>{formatLogTimestamp(log.createdAt)}</span>
                  </div>
                  {log.metadata ? (
                    <details className="log-details">
                      <summary>Metadata</summary>
                      <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
