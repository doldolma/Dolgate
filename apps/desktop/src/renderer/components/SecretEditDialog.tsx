import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HostSecretInput, LinkedHostSummary, SshCertificateInfo } from '@shared';
import { useHostFormController } from '../controllers/useHostFormController';
import { Pencil } from 'lucide-react';
import { cn } from '../lib/cn';
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
  OptionCard,
  SectionLabel,
  SelectField,
  Textarea,
} from '../ui';
import { useTranslation } from 'react-i18next';

export type SecretEditMode = 'update-shared' | 'clone-for-host';

/** 칩으로 이름을 보여 주는 최대 호스트 수. 넘는 만큼은 "외 N개" 로 접는다. */
const MAX_AFFECTED_HOST_CHIPS = 3;

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
    /** 표시 이름. 자동 생성된 이름(가져오기의 "Termius • ubuntu" 등)을 고칠 수 있게 함께 보낸다. */
    label: string;
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
  const { t: translate } = useTranslation();
  const { pickPrivateKey, pickSshCertificate } = useHostFormController();
  const [mode, setMode] = useState<SecretEditMode>('update-shared');
  // 이름은 폼 필드로 세우지 않는다. 자격증명당 한 번 고치는 값이라, 비밀번호·키처럼 자주 바뀌는
  // 칸들과 같은 줄에 두면 매번 시선을 나눠 먹는다. 헤더의 이름 자리를 그대로 편집한다.
  const [label, setLabel] = useState('');
  const [labelEditing, setLabelEditing] = useState(false);
  const [targetHostId, setTargetHostId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [authType, setAuthType] = useState<SecretAuthType>('password');
  /**
   * 이 자격증명이 어느 프로토콜용인가.
   *
   * **저장할 때 그대로 되돌려 보내야 한다.** 예전에는 이 화면이 kind·계정을 싣지 않아서, RDP
   * 자격증명을 한 번 편집하면 종류가 SSH 로 강등되고 계정이 지워졌다(그러면 RDP 폼 목록에서
   * 사라지고 접속도 계정 없이 시도한다).
   */
  const [secretKind, setSecretKind] = useState<'ssh' | 'rdp' | 'vnc' | null>(null);
  const [username, setUsername] = useState('');
  const [domain, setDomain] = useState('');

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
        setSecretKind(null);
        setUsername('');
        setDomain('');
        setPassword('');
        setPassphrase('');
        setPrivateKey('');
        setCertificate('');
        setCertificateInfo(null);
        setPrivateKeyFileName('');
        setCertificateFileName('');
        setLabelEditing(false);
        return;
      }

      setMode(request.initialMode);
      setLabel(request.label);
      setLabelEditing(false);
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
          throw new Error(translate('secretEdit.loadFailed'));
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
        setSecretKind(
          loaded.kind === 'rdp' || loaded.kind === 'vnc' || loaded.kind === 'ssh'
            ? loaded.kind
            : null,
        );
        setUsername(loaded.username ?? '');
        setDomain(loaded.domain ?? '');
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
            : translate('secretEdit.loadFailed'),
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
  // 함께 바뀌는 호스트는 공유 카드 **안에** 둔다. 밖에 따로 두면 어느 선택지에 딸린 설명인지
  // 눈으로 이어야 하고, 라벨 한 줄이 더 붙는다.
  const affectedHosts =
    linkedHostCount > 1 ? (
      <span className="mt-[0.35rem] flex flex-wrap gap-[0.3rem]">
        {activeRequest.linkedHosts.slice(0, MAX_AFFECTED_HOST_CHIPS).map((host) => (
          <span
            key={host.id}
            title={`${host.username}@${host.hostname}`}
            className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] px-[0.5rem] py-[0.1rem] text-[0.78rem] text-[var(--text-soft)]"
          >
            {host.label}
          </span>
        ))}
        {linkedHostCount > MAX_AFFECTED_HOST_CHIPS ? (
          <span className="px-[0.15rem] py-[0.1rem] text-[0.78rem] text-[var(--text-soft)]">
            {translate('secretEdit.affectedHostsMore', {
              count: linkedHostCount - MAX_AFFECTED_HOST_CHIPS,
            })}
          </span>
        ) : null}
      </span>
    ) : null;

  const modeOptions: Array<{
    value: SecretEditMode;
    title: string;
    description: ReactNode;
  }> = [
    {
      value: 'clone-for-host',
      title: translate('secretEdit.mode.detach'),
      // 설정에서 열면 "현재 편집 중인 호스트" 가 없다 — 아래 피커에서 고른 호스트가 대상이다.
      description: translate(
        activeRequest.source === 'host'
          ? 'secretEdit.mode.detachHint'
          : 'secretEdit.mode.detachHintPick',
      ),
    },
    {
      value: 'update-shared',
      title: translate('secretEdit.mode.shared'),
      description: (
        <>
          {linkedHostCount > 0
            ? translate('secretEdit.mode.sharedHint', { count: linkedHostCount })
            : translate('secretEdit.mode.sharedHintNone')}
          {affectedHosts}
        </>
      ),
    },
  ];
  const certificateSummary =
    authType === 'certificate'
      ? describeCertificateInfo(certificateInfo)
      : null;
  const needsHostPicker =
    mode === 'clone-for-host' &&
    activeRequest.source === 'keychain' &&
    linkedHostCount > 1;

  /**
   * 원격 화면(RDP·VNC)용 자격증명인가.
   *
   * 이 둘은 **비밀번호 하나 + 계정**뿐이다. SSH 의 키·인증서·authType 을 보여주면 쓸 수 없는 칸이
   * 늘고, 그 칸을 건드리면 접속에 못 쓰는 자격증명이 만들어진다.
   */
  const isRemoteScreenSecret = secretKind === 'rdp' || secretKind === 'vnc';

  const replacementSecrets: HostSecretInput = isRemoteScreenSecret
    ? {
        // 종류·계정을 **그대로 되돌려 보낸다.** 빠뜨리면 저장하는 순간 SSH 로 강등된다.
        kind: secretKind ?? undefined,
        username: username.trim() || undefined,
        // 도메인은 RDP 만 쓴다(VNC 에는 개념이 없다).
        domain: secretKind === 'rdp' ? domain.trim() || undefined : undefined,
        password,
      }
    : {
        kind: secretKind ?? undefined,
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
    if (isRemoteScreenSecret) {
      // 비밀번호 없는 자격증명은 인증에 쓸 수 없다. RDP 는 계정도 있어야 한다.
      if (!password) {
        return translate('secretEdit.validation.password');
      }
      if (secretKind === 'rdp' && !username.trim()) {
        return translate('secretEdit.validation.account');
      }
      return null;
    }
    if (authType === 'password' && !password) {
      return translate('secretEdit.validation.password');
    }
    if ((authType === 'privateKey' || authType === 'certificate') && !hasNonWhitespaceText(privateKey)) {
      return translate('secretEdit.validation.privateKey');
    }
    if (authType === 'certificate' && !hasNonWhitespaceText(certificate)) {
      return translate('secretEdit.validation.certificate');
    }
    if (mode === 'clone-for-host' && activeRequest.source === 'keychain' && !targetHostId) {
      return translate('secretEdit.validation.detachHost');
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
            <h3 id="secret-edit-title">{translate('secretEdit.title')}</h3>
            {labelEditing ? (
              <Input
                autoFocus
                className="mt-[0.15rem] h-[1.9rem] max-w-[18rem] text-[0.85rem]"
                value={label}
                aria-label={translate('secretEdit.renameLabel')}
                placeholder={activeRequest.label}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setLabelEditing(false);
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    // 취소는 편집 전 이름으로 되돌린다 — 저장 전이라 아직 아무것도 안 바뀌었다.
                    setLabel(activeRequest.label);
                    setLabelEditing(false);
                  }
                }}
                onBlur={() => setLabelEditing(false)}
              />
            ) : (
              <p className="mt-[0.15rem] flex items-center gap-[0.35rem] text-[0.85rem] text-[var(--text-soft)]">
                <span className="truncate">{label || activeRequest.label}</span>
                <button
                  type="button"
                  aria-label={translate('secretEdit.renameLabel')}
                  className="shrink-0 rounded-[6px] p-[0.15rem] text-[var(--text-muted)] transition-colors duration-140 hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                  onClick={() => setLabelEditing(true)}
                >
                  <Pencil className="h-[0.85rem] w-[0.85rem]" />
                </button>
              </p>
            )}
          </div>
          <IconButton type="button" onClick={onClose} aria-label={translate('secretEdit.closeLabel')}>
            <CloseIcon />
          </IconButton>
        </ModalHeader>
        <ModalBody className="grid gap-4">
          {/* 이건 라디오다. 버튼 두 개를 나란히 두면 "누르면 실행된다" 로 읽힌다. 카드는
              하우스 프리미티브(OptionCard)를 그대로 쓴다 — 선택 색과 포커스 링이 제품의 다른
              선택 화면과 같아야 "뭐가 선택된 건지" 를 배우지 않아도 안다. 점은 그 위에 얹는
              최소한의 표시다(색만으로는 대비가 약하고 색각 이상에서 사라진다). */}
          <div className="grid gap-[0.45rem]">
            <SectionLabel className="mb-0">{translate('secretEdit.modeLabel')}</SectionLabel>
            <div
              role="radiogroup"
              aria-label={translate('secretEdit.modeLabel')}
              className="grid gap-[0.55rem] sm:grid-cols-2"
            >
              {modeOptions.map((option) => (
                <OptionCard
                  key={option.value}
                  role="radio"
                  aria-checked={mode === option.value}
                  active={mode === option.value}
                  className="min-h-0"
                  onClick={() => setMode(option.value)}
                  // 라디오는 방향키로 옮기는 것이 기본 동작이다. 선택지가 둘이라 어느 방향키든
                  // 반대쪽으로 넘긴다(Tab 은 그대로 두 카드를 지나간다).
                  onKeyDown={(event) => {
                    if (
                      event.key === 'ArrowLeft' ||
                      event.key === 'ArrowRight' ||
                      event.key === 'ArrowUp' ||
                      event.key === 'ArrowDown'
                    ) {
                      event.preventDefault();
                      setMode(
                        option.value === 'update-shared' ? 'clone-for-host' : 'update-shared',
                      );
                    }
                  }}
                  title={
                    <span className="flex items-center gap-[0.5rem]">
                      <span
                        aria-hidden
                        className={cn(
                          'grid h-[0.95rem] w-[0.95rem] shrink-0 place-items-center rounded-full border',
                          mode === option.value
                            ? 'border-[var(--accent-strong)]'
                            : 'border-[var(--border)]',
                        )}
                      >
                        {mode === option.value ? (
                          <span className="h-[0.45rem] w-[0.45rem] rounded-full bg-[var(--accent-strong)]" />
                        ) : null}
                      </span>
                      {option.title}
                    </span>
                  }
                  description={option.description}
                />
              ))}
            </div>
          </div>

          {needsHostPicker ? (
            <FieldGroup label={translate('secretEdit.detachHostLabel')}>
              <SelectField value={targetHostId} onChange={(event) => setTargetHostId(event.target.value)}>
                {activeRequest.linkedHosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.label} ({host.username}@{host.hostname})
                  </option>
                ))}
              </SelectField>
            </FieldGroup>
          ) : null}

          {loading ? <p className="text-[var(--text-soft)]">{translate('secretEdit.loading')}</p> : null}
          {loadError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{loadError}</p> : null}

          {!loading && !loadError ? (
            <div className="grid gap-[0.9rem]">
              {/* 원격 화면(RDP·VNC) 자격증명은 비밀번호 하나 + 계정뿐이다. SSH 의 인증 방식·키·
                  인증서 칸을 보여주면 쓸 수 없는 칸이 늘고, 그 칸을 건드리면 접속에 못 쓰는
                  자격증명이 만들어진다. */}
              {isRemoteScreenSecret ? (
                <>
                  <FieldGroup label={translate('secretEdit.account')}>
                    <Input
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder={
                        secretKind === 'rdp'
                          ? translate('secretEdit.accountPlaceholderRdp')
                          : translate('secretEdit.accountPlaceholderVnc')
                      }
                    />
                  </FieldGroup>
                  {/* 도메인은 RDP 만 쓴다 — VNC 에는 개념이 없다. */}
                  {secretKind === 'rdp' ? (
                    <FieldGroup label={translate('secretEdit.domain')}>
                      <Input
                        value={domain}
                        onChange={(event) => {
                          setDomain(event.target.value);
                          setSubmitError(null);
                        }}
                        placeholder={translate('secretEdit.domainPlaceholder')}
                      />
                    </FieldGroup>
                  ) : null}
                  <FieldGroup label={translate('secretEdit.fields.password')}>
                    <Input
                      type="password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder={translate('secretEdit.passwordPlaceholder')}
                    />
                  </FieldGroup>
                </>
              ) : null}

              {isRemoteScreenSecret ? null : (
              <FieldGroup label={translate('secretEdit.fields.authType')}>
                <SelectField
                  aria-label={translate('secretEdit.fields.authType')}
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
                  <option value="password">{translate('secretEdit.authTypeOption.password')}</option>
                  <option value="privateKey">{translate('secretEdit.authTypeOption.privateKey')}</option>
                  <option value="certificate">{translate('secretEdit.authTypeOption.certificate')}</option>
                </SelectField>
              </FieldGroup>
              )}

              {certificateSummary ? (
                <div
                  className={`rounded-[10px] border px-[0.9rem] py-[0.9rem] text-[0.9rem] leading-[1.6] ${
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

              {!isRemoteScreenSecret && authType === 'password' ? (
                <FieldGroup label={translate('secretEdit.fields.password')}>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setSubmitError(null);
                    }}
                    placeholder={translate('secretEdit.passwordPlaceholder')}
                  />
                </FieldGroup>
              ) : null}

              {authType === 'privateKey' || authType === 'certificate' ? (
                <>
                  <FieldGroup label={translate('secretEdit.fields.privateKey')}>
                    <div className="flex gap-[0.7rem]">
                      <Input
                        readOnly
                        value={privateKeyFileName}
                        placeholder={translate('secretEdit.filePlaceholder')}
                      />
                      <Button variant="secondary" onClick={() => void importPrivateKey()}>
                        {translate('secretEdit.importFile')}
                      </Button>
                    </div>
                    <Textarea
                      aria-label={translate('secretEdit.fields.privateKey')}
                      rows={8}
                      value={privateKey}
                      onChange={(event) => {
                        setPrivateKey(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  </FieldGroup>

                  {authType === 'certificate' ? (
                    <FieldGroup label={translate('secretEdit.fields.certificate')}>
                      <div className="flex gap-[0.7rem]">
                        <Input
                          readOnly
                          value={certificateFileName}
                          placeholder={translate('secretEdit.filePlaceholder')}
                        />
                        <Button variant="secondary" onClick={() => void importCertificate()}>
                          {translate('secretEdit.importFile')}
                        </Button>
                      </div>
                      <Textarea
                        aria-label={translate('secretEdit.fields.certificate')}
                        rows={5}
                        value={certificate}
                        onChange={(event) => {
                          setCertificate(event.target.value);
                          setCertificateInfo(null);
                          setSubmitError(null);
                        }}
                        placeholder="ssh-ed25519-cert-v01@openssh.com ..."
                      />
                    </FieldGroup>
                  ) : null}

                  <FieldGroup label={translate('secretEdit.fields.passphrase')}>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => {
                        setPassphrase(event.target.value);
                        setSubmitError(null);
                      }}
                      placeholder={translate('secretEdit.passphrasePlaceholder')}
                    />
                  </FieldGroup>
                </>
              ) : null}
            </div>
          ) : null}

          {submitError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{submitError}</p> : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {translate('common.cancel')}
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
                  label: label.trim() || activeRequest.label,
                  secretRef: activeRequest.secretRef,
                  hostId: mode === 'clone-for-host' ? activeRequest.initialHostId ?? targetHostId : null,
                  secrets: replacementSecrets,
                });
                onClose();
              } catch (error) {
                setSubmitError(
                  error instanceof Error
                    ? error.message
                    : translate('secretEdit.saveFailed'),
                );
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            {mode === 'clone-for-host'
              ? translate('secretEdit.submitDetach')
              : linkedHostCount > 1
                ? translate('secretEdit.submitSharedCount', { count: linkedHostCount })
                : translate('secretEdit.submitShared')}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
