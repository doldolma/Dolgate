import { useState } from 'react';
import type {
  SecretMetadataRecord,
  SshHostRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from '@shared';
import { DialogBackdrop } from './DialogBackdrop';
import { SshKeyGenerateDialog } from './SshKeyGenerateDialog';
import { Button, Input, ModalBody, ModalHeader, ModalShell, SectionLabel } from '../ui';

interface SshKeyInstallDialogProps {
  host: SshHostRecord;
  /** 호스트가 쓰는 자격증명 메타(기존 키 설치 가능 여부·암호화/패스프레이즈 판단). */
  credential: SecretMetadataRecord | null;
  onGenerateAndInstallSshKey: (hostId: string, input: SshKeyGenerateInput) => Promise<void>;
  onInstallSshPublicKey: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
  onClose: () => void;
}

// Quick Actions의 "Upload public key" 진입점. ① 호스트가 이미 관리형 개인키를 가진 경우 그
// 공개키를 설치, ② 또는 새 SSH 키를 생성해 설치(기존 SshKeyGenerateDialog 재사용).
export function SshKeyInstallDialog({
  host,
  credential,
  onGenerateAndInstallSshKey,
  onInstallSshPublicKey,
  onClose,
}: SshKeyInstallDialogProps) {
  const [mode, setMode] = useState<'menu' | 'generate'>('menu');
  const [busy, setBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const hasManagedKey = Boolean(host.secretRef && credential?.hasManagedPrivateKey);
  const needsPassphrase = Boolean(credential?.privateKeyEncrypted && !credential.passphraseSaved);

  if (mode === 'generate') {
    return (
      <SshKeyGenerateDialog
        title="새 SSH 키 생성·설치"
        initialLabel={`${host.label || `${host.username}@${host.hostname}`} SSH Key`}
        initialComment={`${host.username}@${host.hostname}`}
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
    if (!host.secretRef) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await onInstallSshPublicKey({
        secretRef: host.secretRef,
        hostIds: [host.id],
        mode: 'installAndUse',
        passphraseOverride: needsPassphrase ? passphrase : undefined,
      });
      const failed = result?.results.find((entry) => entry.status === 'failed');
      if (failed) {
        throw new Error(failed.message ?? 'SSH 공개 키를 설치하지 못했습니다.');
      }
      setMessage({ tone: 'success', text: '호스트에 공개 키를 설치했습니다.' });
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
            새 SSH 키를 생성해 설치하거나, 이 호스트가 이미 가진 키의 공개 키를 설치합니다.
          </p>

          {hasManagedKey ? (
            <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--border)] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[0.85rem] font-medium text-[var(--text)]">기존 키 설치</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || (needsPassphrase && passphrase.trim().length === 0)}
                  onClick={installExistingKey}
                >
                  {busy ? '설치 중...' : '설치'}
                </Button>
              </div>
              {needsPassphrase ? (
                <Input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  placeholder="암호화된 개인키의 패스프레이즈"
                  aria-label="Key passphrase"
                />
              ) : null}
            </div>
          ) : null}

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
