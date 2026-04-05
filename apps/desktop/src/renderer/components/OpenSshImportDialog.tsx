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
          <strong>{source.origin === 'default-ssh-dir' ? '기본' : '파일'}</strong>{' '}
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
          <IconButton onClick={onClose} aria-label="Import OpenSSH 닫기">
            x
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? (
            <NoticeCard tone="info">
              기본 OpenSSH 설정에서 호스트를 찾는 중입니다.
            </NoticeCard>
          ) : null}
          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          <div className="text-[0.9rem] leading-[1.6] text-[var(--text-soft)]">
            <strong>대상 그룹</strong>{' '}
            <span>{currentGroupPath ?? '미분류'}</span>
          </div>

          {probe ? renderSourceList(probe.sources) : null}
          {probe ? renderWarningList(probe.warnings) : null}

          {probe ? (
            <>
              <FilterRow>
                <FieldGroup label="검색" className="flex-1">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="별칭, 호스트, 사용자 또는 키 경로 검색"
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
                            : '선택한 OpenSSH 파일을 추가하지 못했습니다.',
                        );
                      } finally {
                        setIsAddingFile(false);
                      }
                    }}
                  >
                    {isAddingFile ? '파일 불러오는 중...' : '파일 불러오기'}
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
                    보이는 항목 모두 선택
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setSelectedHostKeys([])}
                    disabled={selectedHostKeys.length === 0}
                  >
                    선택 해제
                  </Button>
                </div>
              </FilterRow>

              <div className="flex flex-wrap items-center gap-3 text-[0.84rem] font-medium text-[var(--text-soft)]">
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

              <section className="grid min-h-0 gap-3">
                <h4>호스트</h4>
                {visibleHosts.length === 0 ? (
                  <EmptyState
                    title="가져올 수 있는 OpenSSH 호스트가 없습니다."
                    description={
                      <>
                        기본 설정에서 자동 감지된 호스트가 여기에 표시됩니다. 다른
                        설정 파일은 <strong>파일 불러오기</strong>로 추가할 수 있습니다.
                      </>
                    }
                  />
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
                                event.target.checked
                                  ? Array.from(new Set([...current, host.key]))
                                  : current.filter((value) => value !== host.key),
                              );
                            }}
                          />
                          <div className="min-w-0">
                            <strong>{host.alias}</strong>
                            <span className="block truncate text-[0.8rem] text-[var(--text-soft)]">
                              {host.username}@{host.hostname}:{host.port}
                            </span>
                            {host.identityFilePath ? (
                              <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">{host.identityFilePath}</small>
                            ) : (
                              <small className="block text-[0.8rem] text-[var(--text-soft)]">비밀번호 인증</small>
                            )}
                            <small className="block truncate text-[0.8rem] text-[var(--text-soft)]">
                              {host.sourceFilePath}:{host.sourceLine}
                            </small>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge>
                              {host.authType === 'privateKey' ? '키' : '비밀번호'}
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
            취소
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
                    : '선택한 OpenSSH 호스트를 가져오지 못했습니다.',
                );
              } finally {
                setIsImporting(false);
              }
            }}
          >
            {isImporting ? '가져오는 중...' : '가져오기'}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
