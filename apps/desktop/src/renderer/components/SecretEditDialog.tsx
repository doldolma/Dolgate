import { useEffect, useState } from 'react';
import type { HostSecretInput, LinkedHostSummary, SshCertificateInfo } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { describeCertificateInfo } from '../lib/certificate-info';
import { loadSavedCredential } from '../services/desktop/settings';
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
  SectionLabel,
  SelectField,
  Textarea,
} from '../ui';

export type SecretEditMode = 'update-shared' | 'clone-for-host';

export interface SecretEditDialogRequest {
  source: 'host' | 'keychain';
  secretRef: string;
  label: string;
  linkedHosts: LinkedHostSummary[];
  initialMode: SecretEditMode;
  initialHostId?: string | null;
}

interface SecretEditDialogProps {
  request: SecretEditDialogRequest | null;
  onClose: () => void;
  onSubmit: (input: {
    mode: SecretEditMode;
    secretRef: string;
    hostId: string | null;
    secrets: HostSecretInput;
  }) => Promise<void>;
}

type SecretAuthType = 'password' | 'privateKey' | 'certificate';

function hasNonWhitespaceText(value: string): boolean {
  return value.trim().length > 0;
}

function deriveSecretAuthType(input: {
  privateKeyPem?: string;
  certificateText?: string;
}): SecretAuthType {
  if (hasNonWhitespaceText(input.certificateText ?? '')) {
    return 'certificate';
  }
  if (hasNonWhitespaceText(input.privateKeyPem ?? '')) {
    return 'privateKey';
  }
  return 'password';
}

export function SecretEditDialog({
  request,
  onClose,
  onSubmit,
}: SecretEditDialogProps) {
  const { pickPrivateKey, pickSshCertificate } = useHostFormController();
  const [mode, setMode] = useState<SecretEditMode>('update-shared');
  const [targetHostId, setTargetHostId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [authType, setAuthType] = useState<SecretAuthType>('password');

  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [certificate, setCertificate] = useState('');
  const [certificateInfo, setCertificateInfo] =
    useState<SshCertificateInfo | null>(null);
  const [privateKeyFileName, setPrivateKeyFileName] = useState('');
  const [certificateFileName, setCertificateFileName] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function hydrateSecret() {
      if (!request) {
        setMode('update-shared');
        setTargetHostId('');
        setLoading(false);
        setLoadError(null);
        setSubmitError(null);
        setAuthType('password');
        setPassword('');
        setPassphrase('');
        setPrivateKey('');
        setCertificate('');
        setCertificateInfo(null);
        setPrivateKeyFileName('');
        setCertificateFileName('');
        return;
      }

      setMode(request.initialMode);
      setTargetHostId(request.initialHostId ?? request.linkedHosts[0]?.id ?? '');
      setLoading(true);
      setLoadError(null);
      setSubmitError(null);
      setPrivateKeyFileName('');
      setCertificateFileName('');

      try {
        const loaded = await loadSavedCredential(request.secretRef);
        if (cancelled) {
          return;
        }
        if (!loaded) {
          throw new Error('저장된 인증 정보를 불러오지 못했습니다.');
        }

        const nextPassword = loaded.password ?? '';
        const nextPassphrase = loaded.passphrase ?? '';
        const nextPrivateKey = loaded.privateKeyPem ?? '';
        const nextCertificate = loaded.certificateText ?? '';

        setAuthType(
          deriveSecretAuthType({
            privateKeyPem: nextPrivateKey,
            certificateText: nextCertificate,
          }),
        );
        setPassword(nextPassword);
        setPassphrase(nextPassphrase);
        setPrivateKey(nextPrivateKey);
        setCertificate(nextCertificate);
        setCertificateInfo(loaded.certificateInfo ?? null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadError(
          error instanceof Error
            ? error.message
            : '저장된 인증 정보를 불러오지 못했습니다.',
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void hydrateSecret();

    return () => {
      cancelled = true;
    };
  }, [request]);

  if (!request) {
    return null;
  }

  const activeRequest = request;

  const linkedHostCount = activeRequest.linkedHosts.length;
  const certificateSummary =
    authType === 'certificate'
      ? describeCertificateInfo(certificateInfo)
      : null;
  const needsHostPicker =
    mode === 'clone-for-host' &&
    activeRequest.source === 'keychain' &&
    linkedHostCount > 1;

  const replacementSecrets: HostSecretInput = {
    password: authType === 'password' ? password : undefined,
    passphrase:
      authType === 'privateKey' || authType === 'certificate'
        ? passphrase || undefined
        : undefined,
    privateKeyPem:
      authType === 'privateKey' || authType === 'certificate'
        ? privateKey || undefined
        : undefined,
    certificateText:
      authType === 'certificate' ? certificate || undefined : undefined,
  };

  function validateSecrets(): string | null {
    if (authType === 'password' && !password) {
      return '비밀번호를 입력해 주세요.';
    }
    if ((authType === 'privateKey' || authType === 'certificate') && !hasNonWhitespaceText(privateKey)) {
      return '개인키 내용을 입력하거나 파일을 가져와 주세요.';
    }
    if (authType === 'certificate' && !hasNonWhitespaceText(certificate)) {
      return 'SSH 인증서 내용을 입력하거나 파일을 가져와 주세요.';
    }
    if (mode === 'clone-for-host' && activeRequest.source === 'keychain' && !targetHostId) {
      return '분리할 호스트를 선택해 주세요.';
    }
    return null;
  }

  const validationError = validateSecrets();

  async function importPrivateKey(): Promise<void> {
    const selected = await pickPrivateKey();
    if (!selected) {
      return;
    }
    setPrivateKey(selected.content);
    setPrivateKeyFileName(selected.name);
    setSubmitError(null);
  }

  async function importCertificate(): Promise<void> {
    const selected = await pickSshCertificate();
    if (!selected) {
      return;
    }
    setCertificate(selected.content);
    setCertificateInfo(null);
    setCertificateFileName(selected.name);
    setSubmitError(null);
  }

  return (
    <DialogBackdrop onDismiss={onClose} dismissDisabled={isSubmitting}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="secret-edit-title" size="lg">
        <ModalHeader>
          <div>
            <SectionLabel>Saved Credentials</SectionLabel>
            <h3 id="secret-edit-title">저장된 인증 정보 편집</h3>
          </div>
          <IconButton type="button" onClick={onClose} aria-label="Close saved credentials editor">
            <CloseIcon />
          </IconButton>
        </ModalHeader>
        <ModalBody>
          <p className="text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">
            <strong>{activeRequest.label}</strong> 저장된 인증 정보 전체를 수정합니다.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" active={mode === 'clone-for-host'} onClick={() => setMode('clone-for-host')}>
              이 호스트만 새 인증 정보로 분리
            </Button>
            <Button variant="secondary" active={mode === 'update-shared'} onClick={() => setMode('update-shared')}>
              연결된 호스트 전체 변경
            </Button>
          </div>

          {mode === 'update-shared' ? (
            <p className="text-[var(--text-soft)] leading-[1.5]">
              이 저장된 인증 정보를 쓰는 {linkedHostCount}개 호스트가 모두 같은 변경 내용을 사용합니다.
            </p>
          ) : null}

          {mode === 'clone-for-host' && activeRequest.source === 'host' && activeRequest.initialHostId ? (
            <p className="text-[var(--text-soft)] leading-[1.5]">
              현재 편집 중인 호스트만 새 인증 정보로 분리하고, 다른 호스트들은 기존 인증 정보를 유지합니다.
            </p>
          ) : null}

          {needsHostPicker ? (
            <FieldGroup label="분리할 호스트">
              <SelectField value={targetHostId} onChange={(event) => setTargetHostId(event.target.value)}>
                {activeRequest.linkedHosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label} ({host.username}@{host.hostname})
                  </option>
                ))}
              </SelectField>
            </FieldGroup>
          ) : null}

          {loading ? <p className="text-[var(--text-soft)]">저장된 인증 정보를 불러오는 중입니다.</p> : null}
          {loadError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{loadError}</p> : null}

          {!loading && !loadError ? (
            <div className="grid gap-[1rem]">
              <label className="grid gap-[0.45rem] text-[var(--text)]">
                <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                  Auth Type
                </span>
                <SelectField
                  aria-label="Auth Type"
                  value={authType}
                  onChange={(event) => {
                    const nextAuthType =
                      event.target.value === 'privateKey'
                        ? 'privateKey'
                        : event.target.value === 'certificate'
                          ? 'certificate'
                          : 'password';
                    setAuthType(nextAuthType);
                    setSubmitError(null);
                  }}
                >
                  <option value="password">Password</option>
                  <option value="privateKey">Private key</option>
                  <option value="certificate">Certificate</option>
                </SelectField>
              </label>

              {certificateSummary ? (
                <div
                  className={`rounded-[16px] border px-[1rem] py-[0.9rem] text-[0.95rem] leading-[1.6] ${
                    certificateSummary.tone === 'danger'
                      ? 'border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))] bg-[var(--danger-bg)] text-[var(--danger-text)]'
                      : certificateSummary.tone === 'warning'
                        ? 'border-[color-mix(in_srgb,var(--accent)_22%,var(--border))] bg-[var(--selection-soft)] text-[var(--text-soft)]'
                        : 'border-[var(--border-subtle)] bg-[var(--surface-secondary)] text-[var(--text-soft)]'
                  }`}
                >
                  <p className="font-semibold">{certificateSummary.title}</p>
                  {certificateSummary.detail ? <p>{certificateSummary.detail}</p> : null}
                </div>
              ) : null}

              {authType === 'password' ? (
                <label className="grid gap-[0.45rem] text-[var(--text)]">
                  <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                    Password
                  </span>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setSubmitError(null);
                    }}
                    placeholder="비밀번호를 입력하세요"
                  />
                </label>
              ) : null}

              {authType === 'privateKey' || authType === 'certificate' ? (
                <>
                  <label className="grid gap-[0.45rem] text-[var(--text)]">
                    <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                      Private key
                    </span>
                    <div className="flex gap-[0.75rem]">
                      <Input readOnly value={privateKeyFileName} placeholder="파일을 가져오면 이름이 표시됩니다" />
                      <Button variant="secondary" onClick={() => void importPrivateKey()}>
                        Import
                      </Button>
                    </div>
                    <Textarea
                      aria-label="Private key"
                      rows={8}
                      value={privateKey}
                      onChange={(event) => {
                        setPrivateKey(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  </label>

                  {authType === 'certificate' ? (
                    <label className="grid gap-[0.45rem] text-[var(--text)]">
                      <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                        SSH certificate
                      </span>
                      <div className="flex gap-[0.75rem]">
                        <Input readOnly value={certificateFileName} placeholder="파일을 가져오면 이름이 표시됩니다" />
                        <Button variant="secondary" onClick={() => void importCertificate()}>
                          Import
                        </Button>
                      </div>
                      <Textarea
                        aria-label="SSH certificate"
                        rows={5}
                        value={certificate}
                        onChange={(event) => {
                          setCertificate(event.target.value);
                          setCertificateInfo(null);
                          setSubmitError(null);
                        }}
                        placeholder="ssh-ed25519-cert-v01@openssh.com ..."
                      />
                    </label>
                  ) : null}

                  <label className="grid gap-[0.45rem] text-[var(--text)]">
                    <span className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]">
                      Passphrase
                    </span>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder="패스프레이즈를 입력하세요"
                    />
                  </label>
                </>
              ) : null}
            </div>
          ) : null}

          {submitError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{submitError}</p> : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={loading || Boolean(loadError) || isSubmitting || Boolean(validationError)}
            onClick={async () => {
              const nextValidationError = validateSecrets();
              if (nextValidationError) {
                setSubmitError(nextValidationError);
                return;
              }

              setIsSubmitting(true);
              setSubmitError(null);
              try {
                await onSubmit({
                  mode,
                  secretRef: activeRequest.secretRef,
                  hostId: mode === 'clone-for-host' ? activeRequest.initialHostId ?? targetHostId : null,
                  secrets: replacementSecrets,
                });
                onClose();
              } catch (error) {
                setSubmitError(
                  error instanceof Error
                    ? error.message
                    : '저장된 인증 정보를 수정하는 중 오류가 발생했습니다.',
                );
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            {mode === 'update-shared' ? '공유 인증 정보 저장' : '호스트 전용 인증 정보 생성'}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
