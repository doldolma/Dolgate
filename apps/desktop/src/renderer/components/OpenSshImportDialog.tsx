import { useEffect, useMemo, useState } from 'react';
import type {
  OpenSshHostPreview,
  OpenSshImportResult,
  OpenSshImportWarning,
  OpenSshProbeResult,
  OpenSshSourceSummary,
} from '@shared';
import { useOpenSshImportController } from '../controllers/useImportControllers';
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
import { Trans, useTranslation } from 'react-i18next';
import { t } from "../i18n";

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

function renderSourceList(sources: OpenSshSourceSummary[]) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {sources.map((source) => (
        <p key={source.id} className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
          <strong>{t(source.origin === 'default-ssh-dir' ? 'opensshImport.source.default' : 'opensshImport.source.file')}</strong>{' '}
          <code>{source.label}</code>
        </p>
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
  const { t: translate } = useTranslation();
  const {
    addOpenSshFileToSnapshot,
    discardOpenSshSnapshot,
    importOpenSshSelection,
    pickOpenSshConfig,
    probeOpenSshDefault,
  } = useOpenSshImportController();
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

    void probeOpenSshDefault()
      .then((result) => {
        if (cancelled) {
          void discardOpenSshSnapshot(result.snapshotId);
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
            : translate('opensshImport.error.defaultReadFailed'),
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

    void discardOpenSshSnapshot(probe.snapshotId);
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
    <DialogBackdrop
      onDismiss={onClose}
      dismissDisabled={isAddingFile || isImporting}
    >
      <ModalShell
        role="dialog"
        aria-modal="true"
        aria-labelledby="openssh-import-title"
        size="xl"
      >
        <ModalHeader>
          <div>
            <SectionLabel>OpenSSH</SectionLabel>
            <h3 id="openssh-import-title">Import OpenSSH</h3>
          </div>
          <IconButton onClick={onClose} aria-label={translate('opensshImport.dialog.close')}>
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? (
            <NoticeCard tone="info">
              {translate('opensshImport.dialog.scanning')}
            </NoticeCard>
          ) : null}
          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            <strong>{translate('opensshImport.dialog.targetGroup')}</strong>{' '}
            <span>{currentGroupPath ?? translate('opensshImport.dialog.ungrouped')}</span>
          </div>

          {probe ? renderSourceList(probe.sources) : null}
          {probe ? renderWarningList(probe.warnings) : null}

          {probe ? (
            <>
              <FilterRow>
                <FieldGroup label={translate('opensshImport.dialog.searchLabel')} className="flex-1">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={translate('opensshImport.dialog.searchPlaceholder')}
                    disabled={isLoading || isAddingFile}
                  />
                </FieldGroup>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    disabled={isLoading || isAddingFile}
                    onClick={async () => {
                      setError(null);
                      const filePath = await pickOpenSshConfig();
                      if (!filePath || !probe?.snapshotId) {
                        return;
                      }

                      setIsAddingFile(true);
                      try {
                        const nextProbe =
                          await addOpenSshFileToSnapshot({
                            snapshotId: probe.snapshotId,
                            filePath,
                          });
                        setProbe(nextProbe);
                      } catch (loadError) {
                        setError(
                          loadError instanceof Error
                            ? loadError.message
                            : translate('opensshImport.error.addFileFailed'),
                        );
                      } finally {
                        setIsAddingFile(false);
                      }
                    }}
                  >
                    {translate(isAddingFile ? 'opensshImport.dialog.addingFile' : 'opensshImport.dialog.addFile')}
                  </Button>
                  <Button
                    variant="secondary"
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
                    {translate('opensshImport.dialog.selectVisible')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setSelectedHostKeys([])}
                    disabled={selectedHostKeys.length === 0}
                  >
                    {translate('opensshImport.dialog.deselectAll')}
                  </Button>
                </div>
              </FilterRow>

              <div className="flex flex-wrap items-center gap-3 text-[0.82rem] font-medium text-[var(--text-soft)]">
                <span>{translate('opensshImport.dialog.statSources', { count: probe.sources.length })}</span>
                <span>{translate('opensshImport.dialog.statHosts', { count: probe.hosts.length })}</span>
                <span>{translate('opensshImport.dialog.statSelected', { count: selectedHostKeys.length })}</span>
                {probe.skippedExistingHostCount > 0 ? (
                  <span>
                    {translate('opensshImport.dialog.statSkippedExisting', {
                      count: probe.skippedExistingHostCount,
                    })}
                  </span>
                ) : null}
                {probe.skippedDuplicateHostCount > 0 ? (
                  <span>
                    {translate('opensshImport.dialog.statSkippedDuplicate', {
                      count: probe.skippedDuplicateHostCount,
                    })}
                  </span>
                ) : null}
              </div>

              <section className="grid min-h-0 gap-3">
                <h4>{translate('opensshImport.dialog.hostsHeading')}</h4>
                {visibleHosts.length === 0 ? (
                  <EmptyState
                    title={translate('opensshImport.dialog.emptyTitle')}
                    description={
                      <>
                        <Trans
                          i18nKey="opensshImport.dialog.emptyDescription"
                          components={{ strong: <strong /> }}
                        />
                      </>
                    }
                  />
                ) : (
                  <div className="grid min-h-0 gap-2 overflow-y-auto rounded-[12px] border border-[var(--border)] bg-[var(--dialog-surface-muted)] p-2">
                    {visibleHosts.map((host) => {
                      const checked = selectedHostKeys.includes(host.key);
                      return (
                        <label
                          key={host.key}
                          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface)] px-[0.9rem] py-[0.7rem]"
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
                          <div className="min-w-0">
                            <strong>{host.alias}</strong>
                            <span className="block truncate text-[0.82rem] text-[var(--text-soft)]">
                              {host.username}@{host.hostname}:{host.port}
                            </span>
                            {host.identityFilePath ? (
                              <small className="block truncate text-[0.82rem] text-[var(--text-soft)]">{host.identityFilePath}</small>
                            ) : (
                              <small className="block text-[0.82rem] text-[var(--text-soft)]">{translate('opensshImport.dialog.passwordAuth')}</small>
                            )}
                            <small className="block truncate text-[0.82rem] text-[var(--text-soft)]">
                              {host.sourceFilePath}:{host.sourceLine}
                            </small>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge>
                              {translate(host.authType === 'privateKey' ? 'opensshImport.dialog.key' : 'opensshImport.dialog.password')}
                            </StatusBadge>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isImporting}>
            {translate('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!canImport}
            onClick={async () => {
              if (!probe?.snapshotId) {
                return;
              }
              setError(null);
              setIsImporting(true);
              try {
                const result = await importOpenSshSelection({
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
                    : translate('opensshImport.error.importFailed'),
                );
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {translate(isImporting ? 'opensshImport.dialog.importing' : 'opensshImport.dialog.import')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
