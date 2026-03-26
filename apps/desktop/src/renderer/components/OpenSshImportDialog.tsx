import { useEffect, useMemo, useState } from 'react';
import type {
  OpenSshHostPreview,
  OpenSshImportResult,
  OpenSshImportWarning,
  OpenSshProbeResult,
  OpenSshSourceSummary,
} from '@shared';

interface OpenSshImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImported: (result: OpenSshImportResult) => Promise<void> | void;
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterOpenSshImportHosts(
  hosts: OpenSshHostPreview[],
  query: string,
): OpenSshHostPreview[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return hosts;
  }

  return hosts.filter((host) =>
    [
      host.alias,
      host.hostname,
      host.username,
      host.identityFilePath ?? '',
      host.sourceFilePath,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

function renderWarningList(warnings: OpenSshImportWarning[]) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="openssh-import-dialog__warnings">
      {warnings.map((warning, index) => (
        <div key={`${warning.code ?? 'warning'}:${index}`} className="form-note">
          {warning.message}
        </div>
      ))}
    </div>
  );
}

function renderSourceList(sources: OpenSshSourceSummary[]) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="openssh-import-dialog__sources">
      {sources.map((source) => (
        <div key={source.id} className="form-note">
          <strong>{source.origin === 'default-ssh-dir' ? '기본' : '파일'}</strong>{' '}
          <code>{source.label}</code>
        </div>
      ))}
    </div>
  );
}

export function OpenSshImportDialog({
  open,
  currentGroupPath,
  onClose,
  onImported,
}: OpenSshImportDialogProps) {
  const [probe, setProbe] = useState<OpenSshProbeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAddingFile, setIsAddingFile] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedHostKeys, setSelectedHostKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setProbe(null);
    setSearchQuery('');
    setSelectedHostKeys([]);
    setError(null);
    setIsLoading(true);

    void window.dolssh.openssh
      .probeDefault()
      .then((result) => {
        if (cancelled) {
          void window.dolssh.openssh.discardSnapshot(result.snapshotId);
          return;
        }
        setProbe(result);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : '기본 OpenSSH 설정을 읽지 못했습니다.',
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open || !probe?.snapshotId) {
      return;
    }

    void window.dolssh.openssh.discardSnapshot(probe.snapshotId);
  }, [open, probe?.snapshotId]);

  const visibleHosts = useMemo(
    () => filterOpenSshImportHosts(probe?.hosts ?? [], searchQuery),
    [probe?.hosts, searchQuery],
  );
  const canImport =
    Boolean(probe?.snapshotId) && selectedHostKeys.length > 0 && !isImporting;

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card openssh-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openssh-import-title"
      >
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">OpenSSH</div>
            <h3 id="openssh-import-title">Import OpenSSH</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Import OpenSSH 닫기"
          >
            x
          </button>
        </div>

        <div className="modal-card__body">
          {isLoading ? (
            <div className="aws-import-dialog__loading">
              기본 OpenSSH 설정에서 호스트를 찾는 중입니다.
            </div>
          ) : null}
          {error ? <div className="terminal-error-banner">{error}</div> : null}

          <div className="form-note">
            <strong>대상 그룹</strong>{' '}
            <span>{currentGroupPath ?? '미분류'}</span>
          </div>

          {probe ? renderSourceList(probe.sources) : null}
          {probe ? renderWarningList(probe.warnings) : null}

          {probe ? (
            <>
              <div className="openssh-import-dialog__controls">
                <label className="form-field">
                  <span>검색</span>
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="별칭, 호스트, 사용자 또는 키 경로 검색"
                    disabled={isLoading || isAddingFile}
                  />
                </label>

                <div className="openssh-import-dialog__selection-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isLoading || isAddingFile}
                    onClick={async () => {
                      setError(null);
                      const filePath = await window.dolssh.shell.pickOpenSshConfig();
                      if (!filePath || !probe?.snapshotId) {
                        return;
                      }

                      setIsAddingFile(true);
                      try {
                        const nextProbe =
                          await window.dolssh.openssh.addFileToSnapshot({
                            snapshotId: probe.snapshotId,
                            filePath,
                          });
                        setProbe(nextProbe);
                      } catch (loadError) {
                        setError(
                          loadError instanceof Error
                            ? loadError.message
                            : '선택한 OpenSSH 파일을 추가하지 못했습니다.',
                        );
                      } finally {
                        setIsAddingFile(false);
                      }
                    }}
                  >
                    {isAddingFile ? '파일 불러오는 중...' : '파일 불러오기'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setSelectedHostKeys((current) =>
                        Array.from(
                          new Set([
                            ...current,
                            ...visibleHosts.map((host) => host.key),
                          ]),
                        ),
                      );
                    }}
                    disabled={visibleHosts.length === 0 || isLoading || isAddingFile}
                  >
                    보이는 항목 모두 선택
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSelectedHostKeys([])}
                    disabled={selectedHostKeys.length === 0}
                  >
                    선택 해제
                  </button>
                </div>
              </div>

              <div className="openssh-import-dialog__summary">
                <span>소스 {probe.sources.length}</span>
                <span>가져올 호스트 {probe.hosts.length}</span>
                <span>선택한 호스트 {selectedHostKeys.length}</span>
                {probe.skippedExistingHostCount > 0 ? (
                  <span>기존 호스트 생략 {probe.skippedExistingHostCount}</span>
                ) : null}
                {probe.skippedDuplicateHostCount > 0 ? (
                  <span>중복 호스트 생략 {probe.skippedDuplicateHostCount}</span>
                ) : null}
              </div>

              <section className="openssh-import-dialog__section">
                <h4>호스트</h4>
                {visibleHosts.length === 0 ? (
                  <div className="empty-callout openssh-import-dialog__empty">
                    <strong>가져올 수 있는 OpenSSH 호스트가 없습니다.</strong>
                    <p>
                      기본 설정에서 자동 감지된 호스트가 여기에 표시됩니다. 다른
                      설정 파일은 <strong>파일 불러오기</strong>로 추가할 수 있습니다.
                    </p>
                  </div>
                ) : (
                  <div className="openssh-import-dialog__items">
                    {visibleHosts.map((host) => {
                      const checked = selectedHostKeys.includes(host.key);
                      return (
                        <label
                          key={host.key}
                          className="openssh-import-dialog__item"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              setSelectedHostKeys((current) =>
                                event.target.checked
                                  ? Array.from(new Set([...current, host.key]))
                                  : current.filter((value) => value !== host.key),
                              );
                            }}
                          />
                          <div className="openssh-import-dialog__item-body">
                            <strong>{host.alias}</strong>
                            <span>
                              {host.username}@{host.hostname}:{host.port}
                            </span>
                            {host.identityFilePath ? (
                              <small>{host.identityFilePath}</small>
                            ) : (
                              <small>비밀번호 인증</small>
                            )}
                            <small>
                              {host.sourceFilePath}:{host.sourceLine}
                            </small>
                          </div>
                          <div className="openssh-import-dialog__badges">
                            <small className="status-pill">
                              {host.authType === 'privateKey' ? '키' : '비밀번호'}
                            </small>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>

        <div className="modal-card__footer">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isImporting}
          >
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canImport}
            onClick={async () => {
              if (!probe?.snapshotId) {
                return;
              }
              setError(null);
              setIsImporting(true);
              try {
                const result = await window.dolssh.openssh.importSelection({
                  snapshotId: probe.snapshotId,
                  selectedHostKeys,
                  groupPath: currentGroupPath,
                });
                await onImported(result);
                onClose();
              } catch (importError) {
                setError(
                  importError instanceof Error
                    ? importError.message
                    : '선택한 OpenSSH 호스트를 가져오지 못했습니다.',
                );
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {isImporting ? '가져오는 중...' : '가져오기'}
          </button>
        </div>
      </div>
    </div>
  );
}
