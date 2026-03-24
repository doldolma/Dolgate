import { useEffect, useMemo, useState } from 'react';
import { getGroupLabel, isGroupWithinPath } from '@shared';
import type {
  TermiusImportGroupPreview,
  TermiusImportHostPreview,
  TermiusImportResult,
  TermiusImportWarning,
  TermiusProbeResult
} from '@shared';

interface TermiusImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: TermiusImportResult) => Promise<void> | void;
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterTermiusImportGroups(groups: TermiusImportGroupPreview[], query: string): TermiusImportGroupPreview[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return groups;
  }

  return groups.filter((group) => [group.name, group.path].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}

export function filterTermiusImportHosts(hosts: TermiusImportHostPreview[], query: string): TermiusImportHostPreview[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return hosts;
  }

  return hosts.filter((host) =>
    [host.name, host.address ?? '', host.groupPath ?? '', host.username ?? '', host.identityName ?? '']
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  );
}

export function countEffectiveSelectedTermiusHosts(
  hosts: TermiusImportHostPreview[],
  selectedGroupPaths: string[],
  selectedHostKeys: string[]
): number {
  const selectedGroups = new Set(selectedGroupPaths.map((value) => value.trim()).filter(Boolean));
  const selectedHosts = new Set(selectedHostKeys);

  return hosts.filter((host) => {
    if (selectedHosts.has(host.key)) {
      return true;
    }
    const groupPath = host.groupPath ?? null;
    return [...selectedGroups].some((candidatePath) => isGroupWithinPath(groupPath, candidatePath));
  }).length;
}

function renderWarningList(warnings: TermiusImportWarning[]) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div className="termius-import-dialog__warnings">
      {warnings.map((warning, index) => (
        <div key={`${warning.code ?? 'warning'}:${index}`} className="form-note">
          {warning.message}
        </div>
      ))}
    </div>
  );
}

export function TermiusImportDialog({ open, onClose, onImported }: TermiusImportDialogProps) {
  const [probe, setProbe] = useState<TermiusProbeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
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

    void window.dolssh.termius
      .probeLocal()
      .then((result) => {
        if (cancelled) {
          if (result.snapshotId) {
            void window.dolssh.termius.discardSnapshot(result.snapshotId);
          }
          return;
        }
        setProbe(result);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Termius 데이터를 불러오지 못했습니다.');
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

    void window.dolssh.termius.discardSnapshot(probe.snapshotId);
  }, [open, probe?.snapshotId]);

  const visibleGroups = useMemo(() => filterTermiusImportGroups(probe?.groups ?? [], searchQuery), [probe?.groups, searchQuery]);
  const visibleHosts = useMemo(() => filterTermiusImportHosts(probe?.hosts ?? [], searchQuery), [probe?.hosts, searchQuery]);
  const effectiveSelectedHostCount = useMemo(
    () => countEffectiveSelectedTermiusHosts(probe?.hosts ?? [], selectedGroupPaths, selectedHostKeys),
    [probe?.hosts, selectedGroupPaths, selectedHostKeys]
  );
  const isReady = probe?.status === 'ready' && Boolean(probe.snapshotId);
  const canImport = isReady && (selectedGroupPaths.length > 0 || selectedHostKeys.length > 0);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card termius-import-dialog" role="dialog" aria-modal="true" aria-labelledby="termius-import-title">
        <div className="modal-card__header">
          <div>
            <div className="section-kicker">Termius</div>
            <h3 id="termius-import-title">Import from Termius</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close Termius import dialog">
            ×
          </button>
        </div>

        <div className="modal-card__body">
          {isLoading ? <div className="aws-import-dialog__loading">로컬 Termius 데이터를 읽는 중입니다.</div> : null}
          {error ? <div className="terminal-error-banner">{error}</div> : null}

          {probe?.meta ? (
            <div className="form-note">
              Groups {probe.meta.counts.groups} · Hosts {probe.meta.counts.hosts} · Identities {probe.meta.counts.identities}
              {probe.meta.termiusDataDir ? (
                <>
                  {' '}
                  · <code>{probe.meta.termiusDataDir}</code>
                </>
              ) : null}
            </div>
          ) : null}

          {probe?.message ? (
            <div className={probe.status === 'ready' ? 'form-note' : 'empty-callout'}>
              <strong>{probe.message}</strong>
            </div>
          ) : null}

          {probe?.meta?.warnings ? renderWarningList(probe.meta.warnings) : null}

          {probe && probe.status === 'ready' ? (
            <>
              <div className="termius-import-dialog__controls">
                <label className="form-field">
                  <span>Search</span>
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search groups or hosts"
                  />
                </label>

                <div className="termius-import-dialog__selection-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setSelectedGroupPaths((current) => Array.from(new Set([...current, ...visibleGroups.map((group) => group.path)])));
                      setSelectedHostKeys((current) => Array.from(new Set([...current, ...visibleHosts.map((host) => host.key)])));
                    }}
                  >
                    Select all visible
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setSelectedGroupPaths([]);
                      setSelectedHostKeys([]);
                    }}
                  >
                    Clear selection
                  </button>
                </div>
              </div>

              <div className="termius-import-dialog__summary">
                <span>Selected groups {selectedGroupPaths.length}</span>
                <span>Selected hosts {selectedHostKeys.length}</span>
                <span>Effective hosts {effectiveSelectedHostCount}</span>
              </div>

              <div className="termius-import-dialog__list">
                <section className="termius-import-dialog__section">
                  <h4>Groups</h4>
                  {visibleGroups.length === 0 ? (
                    <div className="form-note">검색에 맞는 그룹이 없습니다.</div>
                  ) : (
                    <div className="termius-import-dialog__items">
                      {visibleGroups.map((group) => {
                        const checked = selectedGroupPaths.includes(group.path);
                        return (
                          <label key={group.path} className="termius-import-dialog__item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedGroupPaths((current) =>
                                  event.target.checked ? Array.from(new Set([...current, group.path])) : current.filter((value) => value !== group.path)
                                );
                              }}
                            />
                            <div className="termius-import-dialog__item-body">
                              <strong>{group.name}</strong>
                              <span>{group.path}</span>
                            </div>
                            <small>{group.hostCount} hosts</small>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="termius-import-dialog__section">
                  <h4>Hosts</h4>
                  {visibleHosts.length === 0 ? (
                    <div className="form-note">검색에 맞는 호스트가 없습니다.</div>
                  ) : (
                    <div className="termius-import-dialog__items">
                      {visibleHosts.map((host) => {
                        const checked = selectedHostKeys.includes(host.key);
                        return (
                          <label key={host.key} className="termius-import-dialog__item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedHostKeys((current) =>
                                  event.target.checked ? Array.from(new Set([...current, host.key])) : current.filter((value) => value !== host.key)
                                );
                              }}
                            />
                            <div className="termius-import-dialog__item-body">
                              <strong>{host.name}</strong>
                              <span>
                                {host.address ?? 'Unknown address'}
                                {host.port ? `:${host.port}` : ''}
                                {host.username ? ` · ${host.username}` : ''}
                              </span>
                              {host.groupPath ? <small>{host.groupPath}</small> : null}
                            </div>
                            <div className="termius-import-dialog__badges">
                              {host.hasPrivateKey ? <small className="status-pill">Key</small> : null}
                              {!host.hasPrivateKey && host.hasPassword ? <small className="status-pill">Password</small> : null}
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
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canImport || isImporting}
            onClick={async () => {
              if (!probe?.snapshotId) {
                return;
              }
              setError(null);
              setIsImporting(true);
              try {
                const result = await window.dolssh.termius.importSelection({
                  snapshotId: probe.snapshotId,
                  selectedGroupPaths,
                  selectedHostKeys
                });
                await onImported(result);
                onClose();
              } catch (importError) {
                setError(importError instanceof Error ? importError.message : 'Termius 데이터를 가져오지 못했습니다.');
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {isImporting ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
