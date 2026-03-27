import { useEffect, useState } from 'react';
import type { HostDraft, WarpgateConnectionInfo, WarpgateTargetSummary } from '@shared';
import { DialogBackdrop } from './DialogBackdrop';

interface WarpgateImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImport: (draft: HostDraft) => Promise<void>;
}

function normalizeBaseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
}

export function WarpgateImportDialog({ open, currentGroupPath, onClose, onImport }: WarpgateImportDialogProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [fallbackUsername, setFallbackUsername] = useState('');
  const [targets, setTargets] = useState<WarpgateTargetSummary[]>([]);
  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [savingTargetId, setSavingTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setBaseUrl('');
    setToken('');
    setFallbackUsername('');
    setTargets([]);
    setIsLoadingTargets(false);
    setIsValidating(false);
    setSavingTargetId(null);
    setError(null);
    setConnectionInfo(null);
  }, [open]);

  const [connectionInfo, setConnectionInfo] = useState<WarpgateConnectionInfo | null>(null);

  if (!open) {
    return null;
  }

  const resolvedUsername = connectionInfo?.username?.trim() || fallbackUsername.trim();

  return (
    <DialogBackdrop
      onDismiss={onClose}
      dismissDisabled={Boolean(savingTargetId)}
    >
      <div className="modal-card warpgate-import-dialog" role="dialog" aria-modal="true" aria-labelledby="warpgate-import-title">
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">Warpgate</div>
            <h3 id="warpgate-import-title">Import from Warpgate</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close Warpgate import dialog">
            ×
          </button>
        </div>

        <div className="modal-card__body">
          <div className="form-grid">
            <label className="form-field">
              <span>Warpgate URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://warpgate.example.com"
              />
            </label>
            <label className="form-field">
              <span>API Token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste your Warpgate API token"
              />
            </label>
          </div>

          {connectionInfo ? (
            <div className="form-note">
              SSH endpoint는 <code>{connectionInfo.sshHost}:{connectionInfo.sshPort}</code> 로 저장됩니다.
              {connectionInfo.username ? (
                <>
                  {' '}
                  현재 로그인 사용자는 <code>{connectionInfo.username}</code> 입니다.
                </>
              ) : (
                <> 이 토큰에서는 사용자명을 자동으로 확인하지 못해 직접 입력이 필요합니다.</>
              )}
            </div>
          ) : null}

          {connectionInfo && !connectionInfo.username ? (
            <label className="form-field">
              <span>Warpgate Username</span>
              <input
                value={fallbackUsername}
                onChange={(event) => {
                  setFallbackUsername(event.target.value);
                  if (error === 'Warpgate 사용자명을 입력해 주세요.') {
                    setError(null);
                  }
                }}
                placeholder="example.user"
              />
            </label>
          ) : null}

          {(isValidating || isLoadingTargets) ? (
            <div className="aws-import-dialog__loading">
              {isValidating ? 'Warpgate 연결을 확인하는 중입니다.' : 'Warpgate SSH target 목록을 불러오는 중입니다.'}
            </div>
          ) : null}

          <div className="modal-card__footer aws-import-dialog__inline-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!baseUrl.trim() || !token.trim() || isValidating || isLoadingTargets}
              onClick={async () => {
                setError(null);
                setTargets([]);
                setConnectionInfo(null);
                setFallbackUsername('');
                setIsValidating(true);
                try {
                  const nextConnectionInfo = await window.dolssh.warpgate.testConnection(baseUrl, token);
                  setConnectionInfo(nextConnectionInfo);
                  setIsValidating(false);
                  setIsLoadingTargets(true);
                  const nextTargets = await window.dolssh.warpgate.listSshTargets(baseUrl, token);
                  setTargets(nextTargets);
                } catch (loadError) {
                  setError(loadError instanceof Error ? loadError.message : 'Warpgate target 목록을 불러오지 못했습니다.');
                } finally {
                  setIsValidating(false);
                  setIsLoadingTargets(false);
                }
              }}
            >
              Load SSH Targets
            </button>
          </div>

          {error ? <div className="terminal-error-banner">{error}</div> : null}

          {targets.length === 0 && !isValidating && !isLoadingTargets ? (
            <div className="empty-callout">
              <strong>Warpgate 주소와 API 토큰을 입력한 뒤 SSH target 목록을 불러와 주세요.</strong>
            </div>
          ) : null}

          {targets.length > 0 ? (
            <div className="operations-list">
              {targets.map((target) => {
                return (
                  <article key={target.id} className="operations-card">
                    <div className="operations-card__main">
                      <div className="operations-card__title-row">
                        <strong>{target.name}</strong>
                        <span className="status-pill">SSH</span>
                      </div>
                      <div className="operations-card__meta">
                        <span>{target.id}</span>
                        {connectionInfo ? <span>{connectionInfo.sshHost}:{connectionInfo.sshPort}</span> : null}
                        {connectionInfo?.username ? <span>{connectionInfo.username}</span> : null}
                      </div>
                    </div>
                    <div className="operations-card__actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!connectionInfo || savingTargetId === target.id}
                        onClick={async () => {
                          if (!connectionInfo || !resolvedUsername) {
                            setError('Warpgate 사용자명을 입력해 주세요.');
                            return;
                          }
                          setError(null);
                          setSavingTargetId(target.id);
                          try {
                            await onImport({
                              kind: 'warpgate-ssh',
                              label: target.name,
                              groupName: currentGroupPath ?? '',
                              tags: [],
                              terminalThemeId: null,
                              warpgateBaseUrl: connectionInfo.baseUrl,
                              warpgateSshHost: connectionInfo.sshHost,
                              warpgateSshPort: connectionInfo.sshPort,
                              warpgateTargetId: target.id,
                              warpgateTargetName: target.name,
                              warpgateUsername: resolvedUsername
                            });
                            onClose();
                          } catch (importError) {
                            setError(importError instanceof Error ? importError.message : 'Warpgate host를 저장하지 못했습니다.');
                          } finally {
                            setSavingTargetId(null);
                          }
                        }}
                      >
                        {savingTargetId === target.id ? 'Adding...' : 'Add host'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </DialogBackdrop>
  );
}
