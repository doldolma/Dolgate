import { useEffect, useMemo, useState } from 'react';
import { getGroupLabel, isGroupWithinPath } from '@shared';
import type {
  TermiusImportGroupPreview,
  TermiusImportHostPreview,
  TermiusImportResult,
  TermiusImportWarning,
  TermiusProbeResult
} from '@shared';
import { useTermiusImportController } from '../controllers/useImportControllers';
import { DialogBackdrop } from './DialogBackdrop';
import {
  Button,
  CloseIcon,
  EmptyState,
  FieldGroup,
  FilterRow,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
} from '../ui';

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
    <div className="grid gap-2">
      {warnings.map((warning, index) => (
        <p
          key={`${warning.code ?? 'warning'}:${index}`}
          className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]"
        >
          {warning.message}
        </p>
      ))}
    </div>
  );
}

export function TermiusImportDialog({ open, onClose, onImported }: TermiusImportDialogProps) {
  const { discardTermiusSnapshot, importTermiusSelection, probeTermiusLocal } =
    useTermiusImportController();
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

    void probeTermiusLocal()
      .then((result) => {
        if (cancelled) {
          if (result.snapshotId) {
            void discardTermiusSnapshot(result.snapshotId);
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

    void discardTermiusSnapshot(probe.snapshotId);
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
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isImporting}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="termius-import-title" size="xl">
        <ModalHeader>
          <div>
            <SectionLabel>Termius</SectionLabel>
            <h3 id="termius-import-title">Import from Termius</h3>
          </div>
          <IconButton onClick={onClose} aria-label="Close Termius import dialog">
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? (
            <NoticeCard tone="info">로컬 Termius 데이터를 읽는 중입니다.</NoticeCard>
          ) : null}
          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {probe?.meta ? (
            <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
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
            probe.status === 'ready' ? (
              <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
                <strong>{probe.message}</strong>
              </div>
            ) : (
              <NoticeCard title={probe.message} />
            )
          ) : null}

          {probe?.meta?.warnings ? renderWarningList(probe.meta.warnings) : null}

          {probe && probe.status === 'ready' ? (
            <>
              <FilterRow>
                <FieldGroup label="Search" className="flex-1">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search groups or hosts"
                  />
                </FieldGroup>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelectedGroupPaths((current) => Array.from(new Set([...current, ...visibleGroups.map((group) => group.path)])));
                      setSelectedHostKeys((current) => Array.from(new Set([...current, ...visibleHosts.map((host) => host.key)])));
                    }}
                  >
                    Select all visible
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelectedGroupPaths([]);
                      setSelectedHostKeys([]);
                    }}
                  >
                    Clear selection
                  </Button>
                </div>
              </FilterRow>

              <div className="flex flex-wrap items-center gap-3 text-[0.84rem] font-medium text-[var(--text-soft)]">
                <span>Selected groups {selectedGroupPaths.length}</span>
                <span>Selected hosts {selectedHostKeys.length}</span>
                <span>Effective hosts {effectiveSelectedHostCount}</span>
              </div>

              <div className="grid min-h-0 gap-4 lg:grid-cols-2">
                <section className="grid min-h-0 gap-3">
                  <h4>Groups</h4>
                  {visibleGroups.length === 0 ? (
                    <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">검색에 맞는 그룹이 없습니다.</div>
                  ) : (
                    <div className="grid min-h-0 gap-2 overflow-y-auto rounded-[18px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] p-2">
                      {visibleGroups.map((group) => {
                        const checked = selectedGroupPaths.includes(group.path);
                        return (
                          <label
                            key={group.path}
                            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--dialog-surface)] px-[0.8rem] py-[0.75rem]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedGroupPaths((current) =>
                                  event.target.checked ? Array.from(new Set([...current, group.path])) : current.filter((value) => value !== group.path)
                                );
                              }}
                            />
                            <div className="min-w-0">
                              <strong>{group.name}</strong>
                              <span className="block text-[0.8rem] text-[var(--text-soft)]">{group.path}</span>
                            </div>
                            <small className="text-[0.8rem] text-[var(--text-soft)]">{group.hostCount} hosts</small>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="grid min-h-0 gap-3">
                  <h4>Hosts</h4>
                  {visibleHosts.length === 0 ? (
                    <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">검색에 맞는 호스트가 없습니다.</div>
                  ) : (
                    <div className="grid min-h-0 gap-2 overflow-y-auto rounded-[18px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] p-2">
                      {visibleHosts.map((host) => {
                        const checked = selectedHostKeys.includes(host.key);
                        return (
                          <label
                            key={host.key}
                            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--dialog-surface)] px-[0.8rem] py-[0.75rem]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSelectedHostKeys((current) =>
                                  event.target.checked ? Array.from(new Set([...current, host.key])) : current.filter((value) => value !== host.key)
                                );
                              }}
                            />
                            <div className="min-w-0">
                              <strong>{host.name}</strong>
                              <span className="block truncate text-[0.8rem] text-[var(--text-soft)]">
                                {host.address ?? 'Unknown address'}
                                {host.port ? `:${host.port}` : ''}
                                {host.username ? ` · ${host.username}` : ''}
                              </span>
                              {host.groupPath ? <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">{host.groupPath}</small> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                              {host.hasPrivateKey ? <StatusBadge>Key</StatusBadge> : null}
                              {!host.hasPrivateKey && host.hasPassword ? <StatusBadge>Password</StatusBadge> : null}
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
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isImporting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canImport || isImporting}
            onClick={async () => {
              if (!probe?.snapshotId) {
                return;
              }
              setError(null);
              setIsImporting(true);
              try {
                const result = await importTermiusSelection({
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
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
