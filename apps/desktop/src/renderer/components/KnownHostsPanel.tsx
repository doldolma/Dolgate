import type { KnownHostRecord } from '@shared';

interface KnownHostsPanelProps {
  records: KnownHostRecord[];
  onRemove: (id: string) => Promise<void>;
}

export function KnownHostsPanel({ records, onRemove }: KnownHostsPanelProps) {
  return (
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Security</div>
          <h2>Known Hosts</h2>
          <p>신뢰한 호스트 키 목록입니다. 새 연결은 이 목록과 정확히 일치해야만 진행됩니다.</p>
        </div>
      </div>

      <div className="operations-list">
        {records.length === 0 ? (
          <div className="empty-callout">
            <strong>아직 저장된 known host가 없습니다.</strong>
            <p>처음 연결하는 서버의 지문을 승인하면 이 목록에 자동으로 추가됩니다.</p>
          </div>
        ) : (
          records.map((record) => (
            <article key={record.id} className="operations-card">
              <div className="operations-card__main">
                <div className="operations-card__title-row">
                  <strong>
                    {record.host}:{record.port}
                  </strong>
                  <span className="status-pill status-pill--running">{record.algorithm}</span>
                </div>
                <div className="operations-card__meta">
                  <span>{record.fingerprintSha256}</span>
                  <span>Last seen {new Date(record.lastSeenAt).toLocaleString('ko-KR')}</span>
                </div>
              </div>
              <div className="operations-card__actions">
                <button type="button" className="secondary-button danger" onClick={() => void onRemove(record.id)}>
                  Remove
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
