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
        title="새 SSH 키 생성·설치"
        initialLabel={`${hostDisplayName} SSH Key`}
        initialComment={
          sshHost ? `${sshHost.username}@${sshHost.hostname}` : hostDisplayName
        }
        submitLabel="생성 후 설치"
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
                : 'SSH 키를 설치하지 못했습니다.',
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
        throw new Error(failed.message ?? 'SSH 공개 키를 설치하지 못했습니다.');
      }
      setMessage({
        tone: 'success',
        text: ec2Host
          ? 'EC2 인스턴스의 authorized_keys에 공개 키를 설치했습니다.'
          : '호스트에 공개 키를 설치하고 이 키로 접속하도록 전환했습니다.',
      });
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof Error && error.message.trim()
            ? error.message
            : 'SSH 키를 설치하지 못했습니다.',
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
          <h3 id="ssh-key-install-title">공개 키 설치</h3>
        </ModalHeader>
        <ModalBody className="grid gap-[0.9rem]">
          <p className="m-0 text-[0.85rem] leading-[1.5] text-[var(--text-soft)]">
            {ec2Host
              ? 'SSH-over-SSM(EC2 Instance Connect)으로 접속해 authorized_keys에 공개 키를 등록합니다. 기존 키를 올리거나 새 키를 생성해 설치할 수 있습니다.'
              : '호스트의 현재 로그인 방식(예: 비밀번호)으로 접속해 공개 키를 등록하고, 이후 그 키로 접속하도록 전환합니다. 기존 키를 올리거나 새 키를 생성해 설치할 수 있습니다.'}
          </p>

          {/* ① 기존 키 설치 — 키체인의 관리형 키 중 선택 */}
          <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--border)] p-3">
            <span className="text-[0.85rem] font-medium text-[var(--text)]">기존 키 설치</span>
            {installableKeys.length === 0 ? (
              <p className="m-0 text-[0.82rem] leading-[1.5] text-[var(--text-soft)]">
                등록된 관리형 SSH 키가 없습니다. 아래에서 새 키를 생성·설치하세요.
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
                  aria-label="설치할 SSH 키"
                  disabled={busy}
                >
                  {installableKeys.map((key) => (
                    <option key={key.secretRef} value={key.secretRef}>
                      {key.label}
                      {key.keyAlgorithm ? ` · ${key.keyAlgorithm}` : ''}
                      {key.secretRef === hostSecretRef ? ' (현재 사용 중)' : ''}
                    </option>
                  ))}
                </SelectField>
                {needsPassphrase ? (
                  <Input
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    placeholder="암호화된 개인키의 패스프레이즈"
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
                    {busy ? '설치 중...' : '설치'}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* ② 새 키 생성·설치 */}
          <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--border)] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.85rem] font-medium text-[var(--text)]">새 키 생성·설치</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setGenerateError(null);
                  setMode('generate');
                }}
              >
                생성
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
