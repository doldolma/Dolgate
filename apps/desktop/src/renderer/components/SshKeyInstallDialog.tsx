import { useEffect, useMemo, useState } from 'react';
import { isAwsEc2HostRecord, keyInstallCorrelationId } from '@shared';
import type {
  AwsEc2HostRecord,
  SecretMetadataRecord,
  SshHostRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from '@shared';
import { ConnectionProgressModal } from './ConnectionProgressModal';
import { DialogBackdrop } from './DialogBackdrop';
import { SshKeyGenerateDialog } from './SshKeyGenerateDialog';
import { Button, Input, ModalBody, ModalHeader, ModalShell, SectionLabel, SelectField } from '../ui';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { formatInteractiveHop } from '../store/utils';
import type { PendingKeyInstallInteractiveAuth } from '../store/types';

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
  // 진행 팝업을 띄울지. 설치를 시작할 때 켜고, 끝나면 끈다.
  const [installing, setInstalling] = useState(false);
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
    setInstalling(true);
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
      setInstalling(false);
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

          {/*
            설치가 어디까지 갔는지 — tailnet·점프·호스트 키·SSH 를 터미널과 같은 화면으로 보여준다.
            결과만 떨어지던 시절에는 실패해도 붉은 한 줄이 전부였다.
          */}
          {installing ? (
            <ConnectionProgressModal
              connectionKey={keyInstallCorrelationId(host.id)}
              host={host}
              title={translate('sshKeyInstall.title')}
              onClose={() => setInstalling(false)}
            />
          ) : null}

          {/*
            설치 도중 호스트가 묻는 인증(OTP·비밀번호).

            설치는 탭을 만들지 않아서 이 카드가 없으면 물음을 보여 줄 자리가 없다 — 코어는 물을
            곳이 없다고 판단해 그냥 실패시켰고, 대화상자에는 "keyboard-interactive responder is
            not configured" 만 남았다.
          */}
          <KeyInstallAuthCard hostId={host.id} />

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

/**
 * 설치 도중 호스트가 묻는 인증을 받는 카드.
 *
 * 여기 있는 이유: 설치는 세션도 엔드포인트도 만들지 않아서 기존 오버레이가 붙을 자리가 없다.
 * 코어는 물음을 올릴 곳이 없으면 아예 묻지 않으므로(그게 옳다 — 아무도 답할 수 없는 대기는 정지다),
 * OTP 나 비밀번호를 요구하는 호스트에는 키를 올릴 방법 자체가 없었다.
 *
 * 스토어를 직접 읽는다. 이 대화상자는 설정·호스트 화면 여러 곳에서 열리는데, 그 전부에 인증
 * props 를 뚫으면 경로마다 빠뜨릴 자리가 생긴다(VncTunnelAuthOverlay 와 같은 이유).
 */
function KeyInstallAuthCard({ hostId }: { hostId: string }) {
  const { t: translate } = useTranslation();
  const auth = useAppStore((state) =>
    state.pendingInteractiveAuths.find(
      (pending): pending is PendingKeyInstallInteractiveAuth =>
        pending.source === 'keyInstall' && pending.hostId === hostId,
    ) ?? null,
  );
  const hosts = useAppStore((state) => state.hosts);
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const clearPendingInteractiveAuth = useAppStore(
    (state) => state.clearPendingInteractiveAuth,
  );
  const [responses, setResponses] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);

  // 새 물음이 오면 앞의 입력을 비운다 — 1 라운드 비밀번호가 2 라운드 코드 칸에 남으면 안 된다.
  const challengeId = auth?.challengeId ?? null;
  useEffect(() => {
    setResponses({});
  }, [challengeId]);

  if (!auth) {
    return null;
  }

  // 다른 인증 카드와 같은 형식이다 — 이름을 앞에, 주소를 뒤에.
  const hopLabel = formatInteractiveHop(auth.hop, hosts) || null;

  return (
    <div className="grid gap-[0.55rem] rounded-[10px] border border-[var(--accent)] p-3">
      <SectionLabel>{translate('authOverlay.extraAuthTitle')}</SectionLabel>
      {hopLabel ? (
        <p className="m-0 text-[0.8rem] text-[var(--text-muted)]">
          {translate('authOverlay.hopLabel')} · {hopLabel}
        </p>
      ) : null}
      {auth.instruction.trim() ? (
        <p className="m-0 whitespace-pre-wrap text-[0.8rem] text-[var(--text-muted)]">
          {auth.instruction.trim()}
        </p>
      ) : null}
      {auth.prompts.map((prompt, index) => (
        <label key={`${auth.challengeId}-${index}`} className="grid gap-1">
          <span className="text-[0.8rem] text-[var(--text)]">{prompt.label}</span>
          <Input
            // 마스킹 여부는 코어가 홉마다 판정해 보낸다 — 인증 코드는 가리지 않는다.
            type={prompt.masked ? 'password' : 'text'}
            value={responses[index] ?? ''}
            autoFocus={index === 0}
            onChange={(event) =>
              setResponses((current) => ({ ...current, [index]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
      ))}
      {auth.deliveryError ? (
        <p className="m-0 text-sm text-[var(--danger-text)]">{auth.deliveryError}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={sending}
          onClick={() => clearPendingInteractiveAuth(auth.challengeId)}
        >
          {translate('common.cancel')}
        </Button>
        <Button size="sm" disabled={sending} onClick={() => void submit()}>
          {translate('authOverlay.sendResponse')}
        </Button>
      </div>
    </div>
  );

  async function submit() {
    if (!auth || sending) {
      return;
    }
    setSending(true);
    try {
      await respondInteractiveAuth(
        auth.challengeId,
        auth.prompts.map((_, index) => responses[index] ?? ''),
      );
    } finally {
      setSending(false);
    }
  }
}
