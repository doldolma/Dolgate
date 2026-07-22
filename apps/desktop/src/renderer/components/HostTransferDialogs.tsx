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

interface HostExportDialogProps {
  open: boolean;
  hostIds: string[];
  onClose: () => void;
  onExported: (result: HostExportResult) => void | Promise<void>;
}

const importCountLabels = {
  hosts: '호스트',
  groups: '그룹',
  secrets: '자격증명',
  awsProfiles: 'AWS 프로필',
  snippets: 'snippet',
  portForwards: '포트 포워딩',
  dnsOverrides: 'DNS override',
  knownHosts: 'known host',
} as const;

function formatImportCounts(
  counts: Record<keyof typeof importCountLabels, number>,
): string {
  return (Object.keys(importCountLabels) as Array<keyof typeof importCountLabels>)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${importCountLabels[kind]} ${counts[kind]}개`)
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
  };
}

export function HostExportDialog({
  open,
  hostIds,
  onClose,
  onExported,
}: HostExportDialogProps) {
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
          setError(normalizeErrorMessage(loadError, '내보내기 항목을 확인하지 못했습니다.'));
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
      return { message: '4자 이상 입력해 주세요.', invalid: false };
    }
    if (normalizedPasswordLength < 4) {
      return { message: '암호는 4자 이상이어야 합니다.', invalid: true };
    }
    if (passwordConfirm.length === 0) {
      return { message: '암호 확인을 입력해 주세요.', invalid: true };
    }
    if (password !== passwordConfirm) {
      return { message: '암호와 암호 확인이 일치하지 않습니다.', invalid: true };
    }
    return { message: '암호가 일치합니다.', invalid: false };
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
            <h3 id="host-export-title">선택한 호스트 내보내기</h3>
          </div>
          <IconButton onClick={onClose} aria-label="내보내기 닫기" disabled={isExporting}>
            <CloseIcon />
          </IconButton>
        </ModalHeader>

        <ModalBody className="grid gap-4">
          {isLoading ? <NoticeCard tone="info">연결된 항목을 확인하는 중입니다.</NoticeCard> : null}
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
                <strong className="block text-[0.95rem] text-[var(--text)]">Dolgate 파일</strong>
                <span className="mt-1 block text-[0.82rem] leading-5 text-[var(--text-soft)]">
                  선택한 호스트와 연결에 필요한 자격증명 및 설정을 암호화해 저장합니다.
                  {preview ? ` 총 ${preview.dolgateHostCount}개 호스트가 포함됩니다.` : ''}
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
                  자격증명은 제외됩니다.
                  {preview
                    ? ` ${preview.opensshHostCount}개 호스트${preview.opensshDependencyCount > 0 ? `와 점프 호스트 ${preview.opensshDependencyCount}개` : ''}를 내보낼 수 있습니다.`
                    : ''}
                </span>
              </span>
            </label>
          </div>

          {format === 'dolgate' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldGroup label="암호">
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
              <FieldGroup label="암호 확인">
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
                  이 암호는 복구할 수 없으며 가져올 때 동일한 암호가 필요합니다.
                </p>
              </div>
            </div>
          ) : null}

          {format === 'openssh' && preview && preview.opensshSkippedCount > 0 ? (
            <NoticeCard tone="info">
              OpenSSH로 표현할 수 없는 호스트 {preview.opensshSkippedCount}개는 제외됩니다.
              {preview.opensshWarnings[0] ? ` ${preview.opensshWarnings[0]}` : ''}
            </NoticeCard>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isExporting}>취소</Button>
          <Button
            variant="primary"
            disabled={!canExport}
            onClick={async () => {
              setError(null);
              if (format === 'dolgate' && password !== passwordConfirm) {
                setError('암호 확인이 일치하지 않습니다.');
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
                setError(normalizeErrorMessage(exportError, '호스트를 내보내지 못했습니다.'));
              } finally {
                setIsExporting(false);
              }
            }}
          >
            {isExporting ? '내보내는 중..' : '내보내기'}
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
            <h3 id="dolgate-import-title">Dolgate 파일 가져오기</h3>
          </div>
          <IconButton onClick={close} aria-label="Dolgate 가져오기 닫기" disabled={isWorking}>
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
              파일 선택
            </Button>
            <span className="min-w-0 truncate text-[0.88rem] text-[var(--text-soft)]">
              {file?.fileName ?? '선택된 파일 없음'}
            </span>
          </div>

          {file && !preview ? (
            <FieldGroup label="내보내기 암호">
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
                      ? `${formatImportCounts(getReadyImportCounts(preview))}를 가져올 준비가 됐습니다.`
                      : '가져올 새 항목이 없습니다.'}
                  </p>
                  {preview.skippedCount > 0 ? (
                    <p>
                      이미 존재하여 제외: {formatImportCounts(preview.skippedCounts)}.
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
          <Button variant="secondary" onClick={close} disabled={isWorking}>취소</Button>
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
                  setError(normalizeErrorMessage(probeError, 'Dolgate 파일을 열지 못했습니다.'));
                } finally {
                  setIsWorking(false);
                }
              }}
            >
              {isWorking ? '확인하는 중..' : '내용 확인'}
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
                  setError(normalizeErrorMessage(importError, 'Dolgate 파일을 가져오지 못했습니다.'));
                } finally {
                  setIsWorking(false);
                }
              }}
            >
              {isWorking ? '가져오는 중..' : '가져오기'}
            </Button>
          )}
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
