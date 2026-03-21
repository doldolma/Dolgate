import type { SecretMetadataRecord } from '@dolssh/shared';

interface KeychainPanelProps {
  entries: SecretMetadataRecord[];
  onRemoveSecret: (hostId: string) => Promise<void>;
}

export function KeychainPanel({ entries, onRemoveSecret }: KeychainPanelProps) {
  return (
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Secrets</div>
          <h2>Keychain</h2>
          <p>원문 비밀번호와 패스프레이즈는 표시하지 않고, 저장 여부와 삭제만 관리합니다.</p>
        </div>
      </div>

      <div className="operations-list">
        {entries.length === 0 ? (
          <div className="empty-callout">
            <strong>저장된 secret이 없습니다.</strong>
            <p>호스트 저장 시 비밀번호 또는 passphrase를 입력하면 이 목록에 표시됩니다.</p>
          </div>
        ) : (
          entries.map((entry) => (
            <article key={entry.hostId} className="operations-card">
              <div className="operations-card__main">
                <div className="operations-card__title-row">
                  <strong>{entry.hostLabel}</strong>
                  <span className="status-pill status-pill--running">{entry.source}</span>
                </div>
                <div className="operations-card__meta">
                  <span>
                    {entry.username}@{entry.hostname}
                  </span>
                  <span>{entry.hasPassword ? 'Password saved' : 'No password'}</span>
                  <span>{entry.hasPassphrase ? 'Passphrase saved' : 'No passphrase'}</span>
                  <span>{new Date(entry.updatedAt).toLocaleString('ko-KR')}</span>
                </div>
              </div>
              <div className="operations-card__actions">
                <button type="button" className="secondary-button danger" onClick={() => void onRemoveSecret(entry.hostId)}>
                  Delete secret
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
