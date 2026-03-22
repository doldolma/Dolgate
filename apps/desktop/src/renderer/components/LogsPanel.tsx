import { useMemo, useState } from 'react';
import type { ActivityLogCategory, ActivityLogLevel, ActivityLogRecord } from '@shared';

interface LogsPanelProps {
  logs: ActivityLogRecord[];
  onClear: () => Promise<void>;
}

export function LogsPanel({ logs, onClear }: LogsPanelProps) {
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
          <p>터미널 출력은 저장하지 않고, 연결과 전송 같은 앱 활동 이벤트만 보관합니다.</p>
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
            <option value="ssh">SSH</option>
            <option value="sftp">SFTP</option>
            <option value="forwarding">Forwarding</option>
            <option value="known_hosts">Known Hosts</option>
            <option value="keychain">Keychain</option>
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
            <p>연결, 전송, known host 승인 같은 동작을 하면 여기에 기록됩니다.</p>
          </div>
        ) : (
          visibleLogs.map((log) => (
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
                  <span>{new Date(log.createdAt).toLocaleString('ko-KR')}</span>
                </div>
                {log.metadata ? (
                  <details className="log-details">
                    <summary>Metadata</summary>
                    <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
