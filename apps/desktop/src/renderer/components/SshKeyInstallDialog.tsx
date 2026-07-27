import { useMemo, useState } from 'react';
import { isAwsEc2HostRecord } from '@shared';
import type {
  AwsEc2HostRecord,
  SecretMetadataRecord,
  SshHostRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from '@shared';
import { DialogBackdrop } from './DialogBackdrop';
import { SshKeyGenerateDialog } from './SshKeyGenerateDialog';
import { Button, Input, ModalBody, ModalHeader, ModalShell, SectionLabel, SelectField } from '../ui';
import { useTranslation } from 'react-i18next';

interface SshKeyInstallDialogProps {
  host: SshHostRecord | AwsEc2HostRecord;
  /** 키체인의 관리형 SSH 키 목록 — 이 중에서 호스트에 올릴 공개 키를 고른다. */
  keychainEntries: SecretMetadataRecord[];
  onGenerateAndInstallSshKey: (hostId: string, input: SshKeyGenerateInput) => Promise<void>;
  onInstallSshPublicKey: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
  onClose: () => void;
}

// Quick Actions의 "Upload public key" 진입점.
// 핵심: SSH 호스트는 "현재 로그인 방식"(주로 비밀번호)으로 접속해 authorized_keys에 공개 키를
// 추가하는 부트스트랩이다(키가 아직 없어도 비밀번호로 올릴 수 있음). EC2 호스트는 SSH-over-SSM
// (EC2 Instance Connect)으로 접속해 설치만 한다 — 매 연결 임시 키를 쓰므로 "이 키로 전환"은 없다.
// ① 키체인의 기존 관리형 키를 골라 설치하거나, ② 새 키를 생성해 설치한다.
export function SshKeyInstallDialog({
  host,
  keychainEntries,
  onGenerateAndInstallSshKey,
  onInstallSshPublicKey,
  onClose,
}: SshKeyInstallDialogProps) {
  const { t: translate } = useTranslation();
  const installableKeys = useMemo(
    () => keychainEntries.filter((entry) => entry.hasManagedPrivateKey),
    [keychainEntries],
  );
  // EC2 hosts install over SSH-over-SSM (EIC) and always connect with an ephemeral
  // key, so there is no auth to "switch to" — install-only, no host secretRef.
  const ec2Host = isAwsEc2HostRecord(host) ? host : null;
  const sshHost = isAwsEc2HostRecord(host) ? null : host;
  const hostSecretRef = sshHost?.secretRef ?? null;
  const hostDisplayName =
    host.label ||
    (sshHost
      ? `${sshHost.username}@${sshHost.hostname}`
      : ec2Host?.awsInstanceName?.trim() || ec2Host?.awsInstanceId || host.id);
  const [mode, setMode] = useState<'menu' | 'generate'>('menu');
  const [busy, setBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  // 기본 선택: 호스트가 이미 관리형 키를 쓰면 그 키, 아니면 첫 번째 설치 가능한 키.
  const [selectedKeyRef, setSelectedKeyRef] = useState(
    () =>
      (hostSecretRef &&
      installableKeys.some((key) => key.secretRef === hostSecretRef)
        ? hostSecretRef
        : installableKeys[0]?.secretRef) ?? '',
  );
  const [passphrase, setPassphrase] = useState('');

  const selectedKey = installableKeys.find((key) => key.secretRef === selectedKeyRef) ?? null;
  const needsPassphrase = Boolean(selectedKey?.privateKeyEncrypted && !selectedKey.passphraseSaved);

  if (mode === 'generate') {
    return (
      <SshKeyGenerateDialog
        title={translate('sshKeyInstall.generateTitle')}
        initialLabel={`${hostDisplayName} SSH Key`}
        initialComment={
          sshHost ? `${sshHost.username}@${sshHost.hostname}` : hostDisplayName
        }
        submitLabel={translate('sshKeyInstall.generateSubmit')}
        busy={busy}
        error={generateError}
        onDismiss={() => {
          if (busy) {
            return;
          }
          setMode('menu');
          setGenerateError(null);
        }}
        onSubmit={async (input) => {
          setBusy(true);
          setGenerateError(null);
          try {
            await onGenerateAndInstallSshKey(host.id, input);
            onClose();
          } catch (error) {
            setGenerateError(
              error instanceof Error && error.message.trim()
                ? error.message
                : translate('sshKeyInstall.installFailed'),
            );
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  async function installExistingKey() {
    if (!selectedKey) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await onInstallSshPublicKey({
        secretRef: selectedKey.secretRef,
        hostIds: [host.id],
        mode: ec2Host ? 'installOnly' : 'installAndUse',
        passphraseOverride: needsPassphrase ? passphrase : undefined,
      });
      const failed = result?.results.find((entry) => entry.status === 'failed');
      if (failed) {
        throw new Error(failed.message ?? translate('sshKeyInstall.publicKeyInstallFailed'));
      }
      setMessage({
        tone: 'success',
        text: ec2Host
          ? translate('sshKeyInstall.installedEc2')
          : translate('sshKeyInstall.installedHost'),
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof Error && error.message.trim()
            ? error.message
            : translate('sshKeyInstall.installFailed'),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogBackdrop
      onDismiss={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="ssh-key-install-title">
        <ModalHeader className="block">
          <SectionLabel>SSH Key</SectionLabel>
          <h3 id="ssh-key-install-title">{translate('sshKeyInstall.title')}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-[0.9rem]">
          <p className="m-0 text-[0.85rem] leading-[1.5] text-[var(--text-soft)]">
            {ec2Host
              ? translate('sshKeyInstall.descriptionAws')
              : translate('sshKeyInstall.description')}
          </p>

          {/* ① 기존 키 설치 — 키체인의 관리형 키 중 선택 */}
          <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--border)] p-3">
            <span className="text-[0.85rem] font-medium text-[var(--text)]">{translate('sshKeyInstall.existingHeading')}</span>
            {installableKeys.length === 0 ? (
              <p className="m-0 text-[0.82rem] leading-[1.5] text-[var(--text-soft)]">
                {translate('sshKeyInstall.noManagedKeys')}
              </p>
            ) : (
              <>
                <SelectField
                  value={selectedKeyRef}
                  onChange={(event) => {
                    setSelectedKeyRef(event.target.value);
                    setPassphrase('');
                    setMessage(null);
                  }}
                  aria-label={translate('sshKeyInstall.selectKeyAria')}
                  disabled={busy}
                >
                  {installableKeys.map((key) => (
                    <option key={key.secretRef} value={key.secretRef}>
                      {key.label}
                      {key.keyAlgorithm ? ` · ${key.keyAlgorithm}` : ''}
                      {key.secretRef === hostSecretRef ? translate('sshKeyInstall.currentlyUsed') : ''}
                    </option>
                  ))}
                </SelectField>
                {needsPassphrase ? (
                  <Input
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder={translate('sshKeyInstall.passphrasePlaceholder')}
                    aria-label="Key passphrase"
                  />
                ) : null}
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      busy || !selectedKey || (needsPassphrase && passphrase.trim().length === 0)
                    }
                    onClick={installExistingKey}
                  >
                    {translate(busy ? 'sshKeyInstall.installing' : 'sshKeyInstall.install')}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* ② 새 키 생성·설치 */}
          <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--border)] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.85rem] font-medium text-[var(--text)]">{translate('sshKeyInstall.newKeyHeading')}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setGenerateError(null);
                  setMode('generate');
                }}
              >
                {translate('sshKeyInstall.generate')}
              </Button>
            </div>
          </div>

          {message ? (
            <p
              className={
                message.tone === 'danger'
                  ? 'm-0 text-sm text-[var(--danger-text)]'
                  : 'm-0 text-sm text-[var(--success-text)]'
              }
            >
              {message.text}
            </p>
          ) : null}
        </ModalBody>
      </ModalShell>
    </DialogBackdrop>
  );
}
