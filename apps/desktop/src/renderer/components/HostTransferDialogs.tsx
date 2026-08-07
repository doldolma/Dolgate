import { useEffect, useState } from 'react';
import type {
  DolgateImportFileSelection,
  DolgateImportPreview,
  DolgateImportResult,
  HostExportFormat,
  HostExportPreview,
  HostExportResult,
} from '@shared';
import {
  commitDolgateImport,
  discardDolgateImport,
  exportHostSelection,
  pickDolgateImportFile,
  previewHostExport,
  probeDolgateImport,
} from '../services/desktop/imports';
import { DialogBackdrop } from './DialogBackdrop';
import {
  Button,
  CloseIcon,
  FieldGroup,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from '../ui';
import { normalizeErrorMessage } from '../store/utils/errors-and-prompts';
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";

interface HostExportDialogProps {
  open: boolean;
  hostIds: string[];
  onClose: () => void;
  onExported: (result: HostExportResult) => void | Promise<void>;
}

const importCountLabels = {
  hosts: 'hostTransfer.kind.hosts',
  groups: 'hostTransfer.kind.groups',
  secrets: 'hostTransfer.kind.secrets',
  awsProfiles: 'hostTransfer.kind.awsProfiles',
  snippets: 'snippet',
  portForwards: 'hostTransfer.kind.portForwards',
  dnsOverrides: 'DNS override',
  knownHosts: 'known host',
  tailnets: 'hostTransfer.kind.tailnets',
} as const;

function formatImportCounts(
  counts: Record<keyof typeof importCountLabels, number>,
): string {
  return (Object.keys(importCountLabels) as Array<keyof typeof importCountLabels>)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => t('hostTransfer.counts', { label: t(importCountLabels[kind]), count: counts[kind] }))
    .join(', ');
}

function getReadyImportCounts(preview: DolgateImportPreview) {
  return {
    hosts: preview.hostCount,
    groups: preview.groupCount,
    secrets: preview.secretCount,
    awsProfiles: preview.awsProfileCount,
    snippets: preview.snippetCount,
    portForwards: preview.portForwardCount,
    dnsOverrides: preview.dnsOverrideCount,
    knownHosts: preview.knownHostCount,
    tailnets: preview.tailnetCount,
  };
}

export function HostExportDialog({
  open,
  hostIds,
  onClose,
  onExported,
}: HostExportDialogProps) {
  const { t: translate } = useTranslation();
  const [format, setFormat] = useState<HostExportFormat>('dolgate');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [preview, setPreview] = useState<HostExportPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setPasswordConfirm('');
      return;
    }
    let cancelled = false;
    setFormat('dolgate');
    setPassword('');
    setPasswordConfirm('');
    setPreview(null);
    setError(null);
    setIsLoading(true);
    void previewHostExport(hostIds)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(normalizeErrorMessage(loadError, translate('hostTransfer.export.previewFailed')));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hostIds, open]);

  if (!open) {
    return null;
  }

  const normalizedPasswordLength = Array.from(password.normalize('NFC')).length;
  const passwordValidationMessage = (() => {
    if (password.length === 0 && passwordConfirm.length === 0) {
      return { message: translate('hostTransfer.export.passphraseShort'), invalid: false };
    }
    if (normalizedPasswordLength < 4) {
      return { message: translate('hostTransfer.export.passphraseTooShort'), invalid: true };
    }
    if (passwordConfirm.length === 0) {
      return { message: translate('hostTransfer.export.confirmRequired'), invalid: true };
    }
    if (password !== passwordConfirm) {
      return { message: translate('hostTransfer.export.confirmMismatch'), invalid: true };
    }
    return { message: translate('hostTransfer.export.passphraseMatch'), invalid: false };
  })();
  const canExport =
    !isLoading &&
    !isExporting &&
    Boolean(preview) &&
    (format === 'openssh' ||
      (normalizedPasswordLength >= 4 && password === passwordConfirm)) &&
    (format !== 'openssh' || (preview?.opensshHostCount ?? 0) > 0);

  return (
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isExporting}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="host-export-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Export</SectionLabel>
            <h3 id="host-export-title">{translate('hostTransfer.export.title')}</h3>
          </div>
          <IconButton onClick={onClose} aria-label={translate('hostTransfer.export.close')} disabled={isExporting}>
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? <NoticeCard tone="info">{translate('hostTransfer.export.loading')}</NoticeCard> : null}
          {error ? <NoticeCard tone="danger" role="alert">{error}</NoticeCard> : null}

          <div className="grid gap-2">
            <label className="grid cursor-pointer grid-cols-[1.1rem_minmax(0,1fr)] gap-3 rounded-[8px] border border-[var(--border)] p-3">
              <input
                type="radio"
                name="host-export-format"
                value="dolgate"
                checked={format === 'dolgate'}
                onChange={() => setFormat('dolgate')}
                className="mt-1 h-4 w-4 accent-[var(--accent-strong)]"
              />
              <span>
                <strong className="block text-[0.95rem] text-[var(--text)]">{translate('hostTransfer.export.dolgateTitle')}</strong>
                <span className="mt-1 block text-[0.82rem] leading-5 text-[var(--text-soft)]">
                  {translate('hostTransfer.export.dolgateDescription')}
                  {preview
                    ? translate('hostTransfer.export.dolgateHostCount', {
                        count: preview.dolgateHostCount,
                      })
                    : ''}
                </span>
              </span>
            </label>
            <label className="grid cursor-pointer grid-cols-[1.1rem_minmax(0,1fr)] gap-3 rounded-[8px] border border-[var(--border)] p-3">
              <input
                type="radio"
                name="host-export-format"
                value="openssh"
                checked={format === 'openssh'}
                onChange={() => setFormat('openssh')}
                className="mt-1 h-4 w-4 accent-[var(--accent-strong)]"
              />
              <span>
                <strong className="block text-[0.95rem] text-[var(--text)]">OpenSSH config</strong>
                <span className="mt-1 block text-[0.82rem] leading-5 text-[var(--text-soft)]">
                  {translate('hostTransfer.export.opensshNoSecrets')}
                  {preview
                    ? translate('hostTransfer.export.opensshCount', {
                        count: preview.opensshHostCount,
                        jump:
                          preview.opensshDependencyCount > 0
                            ? translate('hostTransfer.export.opensshJump', {
                                count: preview.opensshDependencyCount,
                              })
                            : '',
                      })
                    : ''}
                </span>
              </span>
            </label>
          </div>

          {format === 'dolgate' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldGroup label={translate('hostTransfer.export.passphraseLabel')}>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  autoComplete="new-password"
                  autoFocus
                />
              </FieldGroup>
              <FieldGroup label={translate('hostTransfer.export.confirmLabel')}>
                <Input
                  type="password"
                  value={passwordConfirm}
                  onChange={(event) => {
                    setPasswordConfirm(event.target.value);
                    setError(null);
                  }}
                  autoComplete="new-password"
                />
              </FieldGroup>
              <div className="grid gap-1 text-[0.8rem] sm:col-span-2">
                <p
                  aria-live="polite"
                  className={passwordValidationMessage.invalid
                    ? 'text-[var(--danger-text)]'
                    : 'text-[var(--text-soft)]'}
                >
                  {passwordValidationMessage.message}
                </p>
                <p className="text-[var(--text-soft)]">
                  {translate('hostTransfer.export.passphraseWarning')}
                </p>
              </div>
            </div>
          ) : null}

          {format === 'openssh' && preview && preview.opensshSkippedCount > 0 ? (
            <NoticeCard tone="info">
              {translate('hostTransfer.export.opensshSkipped', { count: preview.opensshSkippedCount })}
              {preview.opensshWarnings[0] ? ` ${preview.opensshWarnings[0]}` : ''}
            </NoticeCard>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isExporting}>{translate('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canExport}
            onClick={async () => {
              setError(null);
              if (format === 'dolgate' && password !== passwordConfirm) {
                setError(translate('hostTransfer.export.confirmMismatchError'));
                return;
              }
              setIsExporting(true);
              try {
                const result = await exportHostSelection({
                  hostIds,
                  format,
                  password: format === 'dolgate' ? password : undefined,
                });
                if (!result.canceled) {
                  await onExported(result);
                  onClose();
                }
              } catch (exportError) {
                setError(normalizeErrorMessage(exportError, translate('hostTransfer.export.exportFailed')));
              } finally {
                setIsExporting(false);
              }
            }}
          >
            {translate(isExporting ? 'hostTransfer.export.exporting' : 'hostTransfer.export.submit')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

interface DolgateImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (result: DolgateImportResult) => void | Promise<void>;
}

export function DolgateImportDialog({ open, onClose, onImported }: DolgateImportDialogProps) {
  const { t: translate } = useTranslation();
  const [file, setFile] = useState<DolgateImportFileSelection | null>(null);
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<DolgateImportPreview | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setPassword('');
      setPreview(null);
      setError(null);
      setIsWorking(false);
    } else {
      setPassword('');
    }
  }, [open]);

  useEffect(() => {
    if (open || !preview?.snapshotId) {
      return;
    }
    void discardDolgateImport(preview.snapshotId);
  }, [open, preview?.snapshotId]);

  if (!open) {
    return null;
  }

  const close = () => {
    if (preview?.snapshotId) {
      void discardDolgateImport(preview.snapshotId);
    }
    onClose();
  };

  return (
    <DialogBackdrop onDismiss={close} dismissDisabled={isWorking}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="dolgate-import-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Import</SectionLabel>
            <h3 id="dolgate-import-title">{translate('hostTransfer.import.title')}</h3>
          </div>
          <IconButton onClick={close} aria-label={translate('hostTransfer.import.close')} disabled={isWorking}>
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {error ? <NoticeCard tone="danger" role="alert">{error}</NoticeCard> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={isWorking}
              onClick={async () => {
                setError(null);
                const selected = await pickDolgateImportFile();
                if (!selected) {
                  return;
                }
                if (preview?.snapshotId) {
                  await discardDolgateImport(preview.snapshotId);
                }
                setFile(selected);
                setPassword('');
                setPreview(null);
              }}
            >
              {translate('hostTransfer.import.pickFile')}
            </Button>
            <span className="min-w-0 truncate text-[0.88rem] text-[var(--text-soft)]">
              {file?.fileName ?? translate('hostTransfer.import.noFile')}
            </span>
          </div>

          {file && !preview ? (
            <FieldGroup label={translate('hostTransfer.import.passphraseLabel')}>
              <Input
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
                autoComplete="current-password"
                autoFocus
              />
            </FieldGroup>
          ) : null}

          {preview ? (
            <>
              <NoticeCard tone="info">
                <div className="grid gap-1">
                  <p>
                    {formatImportCounts(getReadyImportCounts(preview))
                      ? translate('hostTransfer.import.ready', {
                          summary: formatImportCounts(getReadyImportCounts(preview)),
                        })
                      : translate('hostTransfer.import.nothingNew')}
                  </p>
                  {preview.skippedCount > 0 ? (
                    <p>
                      {translate('hostTransfer.import.skipped', {
                        summary: formatImportCounts(preview.skippedCounts),
                      })}
                    </p>
                  ) : null}
                </div>
              </NoticeCard>
              {preview.warnings.length > 0 ? (
                <div className="grid gap-1 text-[0.82rem] leading-5 text-[var(--text-soft)]">
                  {preview.warnings.slice(0, 5).map((warning) => <p key={warning}>{warning}</p>)}
                </div>
              ) : null}
            </>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={close} disabled={isWorking}>{translate('common.cancel')}</Button>
          {!preview ? (
            <Button
              variant="primary"
              disabled={!file || password.length === 0 || isWorking}
              onClick={async () => {
                if (!file) {
                  return;
                }
                setIsWorking(true);
                setError(null);
                try {
                  setPreview(await probeDolgateImport(file.filePath, password));
                } catch (probeError) {
                  setError(normalizeErrorMessage(probeError, translate('hostTransfer.import.probeFailed')));
                } finally {
                  setIsWorking(false);
                }
              }}
            >
              {translate(isWorking ? 'hostTransfer.import.probing' : 'hostTransfer.import.probe')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={isWorking}
              onClick={async () => {
                setIsWorking(true);
                setError(null);
                try {
                  const result = await commitDolgateImport(preview.snapshotId);
                  await onImported(result);
                  onClose();
                } catch (importError) {
                  setError(normalizeErrorMessage(importError, translate('hostTransfer.import.importFailed')));
                } finally {
                  setIsWorking(false);
                }
              }}
            >
              {translate(isWorking ? 'hostTransfer.import.importing' : 'hostTransfer.import.submit')}
            </Button>
          )}
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
