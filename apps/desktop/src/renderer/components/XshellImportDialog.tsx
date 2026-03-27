import { useEffect, useMemo, useState } from 'react';
import { isGroupWithinPath, type XshellImportGroupPreview, type XshellImportHostPreview, type XshellImportResult, type XshellImportWarning, type XshellProbeResult, type XshellSourceSummary } from '@shared';
import { DialogBackdrop } from './DialogBackdrop';

interface XshellImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: XshellImportResult) => Promise<void> | void;
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterXshellImportGroups(groups: XshellImportGroupPreview[], query: string): XshellImportGroupPreview[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return groups;
  }

  return groups.filter((group) => [group.name, group.path].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}

export function filterXshellImportHosts(hosts: XshellImportHostPreview[], query: string): XshellImportHostPreview[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return hosts;
  }

  return hosts.filter((host) =>
    [host.label, host.hostname, host.username, host.groupPath ?? '', host.privateKeyPath ?? '', host.sourceFilePath]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  );
}

export function countEffectiveSelectedXshellHosts(
  hosts: XshellImportHostPreview[],
  selectedGroupPaths: string[],
  selectedHostKeys: string[]
): number {
  const selectedGroups = new Set(selectedGroupPaths.map((value) => value.trim()).filter(Boolean));
  const selectedHosts = new Set(selectedHostKeys);

  return hosts.filter((host) => {
    if (selectedHosts.has(host.key)) {
      return true;
    }
    return [...selectedGroups].some((groupPath) => isGroupWithinPath(host.groupPath ?? null, groupPath));
  }).length;
}

function renderWarningList(warnings: XshellImportWarning[]) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="xshell-import-dialog__warnings">
      {warnings.map((warning, index) => (
        <div key={`${warning.code ?? 'warning'}:${index}`} className="form-note">
          {warning.message}
        </div>
      ))}
    </div>
  );
}

function renderSourceList(sources: XshellSourceSummary[]) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="xshell-import-dialog__sources">
      {sources.map((source) => (
        <div key={source.id} className="form-note">
          <strong>{source.origin === 'default-session-dir' ? '기본 경로' : '추가 폴더'}</strong>{' '}
          <code>{source.folderPath}</code>
        </div>
      ))}
    </div>
  );
}

export function XshellImportDialog({ open, onClose, onImported }: XshellImportDialogProps) {
  const [probe, setProbe] = useState<XshellProbeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroupPaths, setSelectedGroupPaths] = useState<string[]>([]);
  const [selectedHostKeys, setSelectedHostKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setProbe(null);
    setSearchQuery('');
    setSelectedGroupPaths([]);
    setSelectedHostKeys([]);
    setError(null);
    setIsLoading(true);

    void window.dolssh.xshell
      .probeDefault()
      .then((result) => {
        if (cancelled) {
          void window.dolssh.xshell.discardSnapshot(result.snapshotId);
          return;
        }
        setProbe(result);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : '로컬 Xshell 세션을 불러오지 못했습니다.');
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

    void window.dolssh.xshell.discardSnapshot(probe.snapshotId);
  }, [open, probe?.snapshotId]);

  const visibleGroups = useMemo(() => filterXshellImportGroups(probe?.groups ?? [], searchQuery), [probe?.groups, searchQuery]);
  const visibleHosts = useMemo(() => filterXshellImportHosts(probe?.hosts ?? [], searchQuery), [probe?.hosts, searchQuery]);
  const effectiveSelectedHostCount = useMemo(
    () => countEffectiveSelectedXshellHosts(probe?.hosts ?? [], selectedGroupPaths, selectedHostKeys),
    [probe?.hosts, selectedGroupPaths, selectedHostKeys]
  );
  const canImport = Boolean(probe?.snapshotId) && (selectedGroupPaths.length > 0 || selectedHostKeys.length > 0) && !isImporting;

  if (!open) {
    return null;
  }

  return (
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isAddingFolder || isImporting}>
      <div className="modal-card xshell-import-dialog" role="dialog" aria-modal="true" aria-labelledby="xshell-import-title">
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">Xshell</div>
            <h3 id="xshell-import-title">Xshell 가져오기</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Xshell 가져오기 대화상자 닫기">
            x
          </button>
        </div>

        <div className="modal-card__body">
          {isLoading ? <div className="aws-import-dialog__loading">로컬 Xshell 세션을 불러오는 중입니다.</div> : null}
          {error ? <div className="terminal-error-banner">{error}</div> : null}

          {probe ? renderSourceList(probe.sources) : null}
          {probe ? renderWarningList(probe.warnings) : null}

          {probe ? (
            <>
              <div className="xshell-import-dialog__controls">
                <label className="form-field">
                  <span>검색</span>
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="그룹, 호스트, 사용자명, 키 경로 검색"
                    disabled={isLoading || isAddingFolder}
                  />
                </label>

                <div className="xshell-import-dialog__selection-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isLoading || isAddingFolder}
                    onClick={async () => {
                      setError(null);
                      const folderPath = await window.dolssh.shell.pickXshellSessionFolder();
                      if (!folderPath || !probe.snapshotId) {
                        return;
                      }

                      setIsAddingFolder(true);
                      try {
                        const nextProbe = await window.dolssh.xshell.addFolderToSnapshot({
                          snapshotId: probe.snapshotId,
                          folderPath
                        });
                        setProbe(nextProbe);
                      } catch (loadError) {
                        setError(loadError instanceof Error ? loadError.message : '선택한 Xshell 세션 폴더를 추가하지 못했습니다.');
                      } finally {
                        setIsAddingFolder(false);
                      }
                    }}
                  >
                    {isAddingFolder ? '폴더를 불러오는 중...' : '세션 폴더 선택'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setSelectedGroupPaths((current) => Array.from(new Set([...current, ...visibleGroups.map((group) => group.path)])));
                      setSelectedHostKeys((current) => Array.from(new Set([...current, ...visibleHosts.map((host) => host.key)])));
                    }}
                    disabled={visibleGroups.length === 0 && visibleHosts.length === 0}
                  >
                    보이는 항목 모두 선택
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setSelectedGroupPaths([]);
                      setSelectedHostKeys([]);
                    }}
                    disabled={selectedGroupPaths.length === 0 && selectedHostKeys.length === 0}
                  >
                    선택 해제
                  </button>
                </div>
              </div>

              <div className="xshell-import-dialog__summary">
                <span>소스 {probe.sources.length}</span>
                <span>그룹 {probe.groups.length}</span>
                <span>호스트 {probe.hosts.length}</span>
                <span>선택한 그룹 {selectedGroupPaths.length}</span>
                <span>선택한 호스트 {selectedHostKeys.length}</span>
                <span>실제 가져올 호스트 {effectiveSelectedHostCount}</span>
                {probe.skippedExistingHostCount > 0 ? <span>기존 중복 제외 {probe.skippedExistingHostCount}</span> : null}
                {probe.skippedDuplicateHostCount > 0 ? <span>세션 중복 제외 {probe.skippedDuplicateHostCount}</span> : null}
              </div>

              <div className="xshell-import-dialog__list">
                <section className="xshell-import-dialog__section">
                  <h4>그룹</h4>
                  {visibleGroups.length === 0 ? (
                    <div className="form-note">검색 결과와 일치하는 그룹이 없습니다.</div>
                  ) : (
                    <div className="xshell-import-dialog__items">
                      {visibleGroups.map((group) => {
                        const checked = selectedGroupPaths.includes(group.path);
                        return (
                          <label key={group.path} className="xshell-import-dialog__item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedGroupPaths((current) =>
                                  event.target.checked ? Array.from(new Set([...current, group.path])) : current.filter((value) => value !== group.path)
                                );
                              }}
                            />
                            <div className="xshell-import-dialog__item-body">
                              <strong>{group.name}</strong>
                              <span>{group.path}</span>
                            </div>
                            <small>호스트 {group.hostCount}개</small>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="xshell-import-dialog__section">
                  <h4>호스트</h4>
                  {visibleHosts.length === 0 ? (
                    <div className="empty-callout xshell-import-dialog__empty">
                      <strong>현재 조건과 일치하는 Xshell 호스트가 없습니다.</strong>
                      <p>다른 세션 폴더를 선택하거나 검색어를 변경해보세요.</p>
                    </div>
                  ) : (
                    <div className="xshell-import-dialog__items">
                      {visibleHosts.map((host) => {
                        const checked = selectedHostKeys.includes(host.key);
                        return (
                          <label key={host.key} className="xshell-import-dialog__item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedHostKeys((current) =>
                                  event.target.checked ? Array.from(new Set([...current, host.key])) : current.filter((value) => value !== host.key)
                                );
                              }}
                            />
                            <div className="xshell-import-dialog__item-body">
                              <strong>{host.label}</strong>
                              <span>
                                {host.username}@{host.hostname}:{host.port}
                              </span>
                              {host.groupPath ? <small>{host.groupPath}</small> : <small>루트</small>}
                              <small>{host.sourceFilePath}</small>
                              {host.privateKeyPath ? <small>{host.privateKeyPath}</small> : null}
                            </div>
                            <div className="xshell-import-dialog__badges">
                              <small className="status-pill">{host.authType === 'privateKey' ? '개인키' : '비밀번호'}</small>
                              {host.hasPasswordHint ? <small className="status-pill">저장된 비밀번호</small> : null}
                              {host.hasAuthProfile ? <small className="status-pill">인증 프로필</small> : null}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-card__footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={isImporting}>
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
                const result = await window.dolssh.xshell.importSelection({
                  snapshotId: probe.snapshotId,
                  selectedGroupPaths,
                  selectedHostKeys
                });
                await onImported(result);
                onClose();
              } catch (importError) {
                setError(importError instanceof Error ? importError.message : 'Xshell 데이터를 가져오지 못했습니다.');
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {isImporting ? '가져오는 중...' : '가져오기'}
          </button>
        </div>
      </div>
    </DialogBackdrop>
  );
}
