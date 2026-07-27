import { useMemo, useState } from 'react';
import {
  getHostSearchText,
  getHostSecretRef,
  isAwsEc2HostRecord,
  isSshHostRecord,
} from '@shared';
import type {
  HostRecord,
  SecretMetadataRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
  SshKeyMaterialResult,
} from '@shared';
import {
  Button,
  Card,
  CardActions,
  CardMain,
  CardMeta,
  CardTitleRow,
  EmptyState,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  PanelSection,
  SectionLabel,
  SelectField,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { SshKeyGenerateDialog } from './SshKeyGenerateDialog';
import { describeSecretType } from '../lib/secret-display';
import { matchesKeyboardLayoutQuery } from '../lib/keyboard-layout-search';
import { copySavedCredentialPassword } from '../services/desktop/settings';
import { useTranslation } from 'react-i18next';
import { getFormatLocale, t } from '../i18n';

interface KeychainPanelProps {
  entries: SecretMetadataRecord[];
  hosts: HostRecord[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onEditSecret: (secretRef: string) => void;
  onGenerateSshKey: (input: SshKeyGenerateInput) => Promise<SshKeyMaterialResult>;
  onCopySshPublicKey: (secretRef: string) => Promise<void>;
  onInstallSshPublicKey: (input: SshKeyInstallInput) => Promise<SshKeyInstallResult>;
}

function getCopyErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return t('keychain.copyFailed');
}

function buildKeychainEntrySearchText(
  entry: SecretMetadataRecord,
  linkedHosts: HostRecord[],
): string {
  return [
    entry.label,
    describeSecretType(entry),
    entry.secretRef,
    ...linkedHosts.flatMap((host) => getHostSearchText(host)),
  ].join(' ');
}

export function KeychainPanel({
  entries,
  hosts,
  searchQuery,
  onSearchQueryChange,
  onRemoveSecret,
  onEditSecret,
  onGenerateSshKey,
  onCopySshPublicKey,
  onInstallSshPublicKey,
}: KeychainPanelProps) {
  const { t: translate } = useTranslation();
  const [copyingSecretRef, setCopyingSecretRef] = useState<string | null>(null);
  const [copyingPublicKeyRef, setCopyingPublicKeyRef] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{
    tone: 'success' | 'danger';
    message: string;
  } | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [installTargetRef, setInstallTargetRef] = useState<string | null>(null);
  const [installMode, setInstallMode] = useState<SshKeyInstallInput['mode']>('installOnly');
  const [selectedInstallHostIds, setSelectedInstallHostIds] = useState<string[]>([]);
  const [installHostSearchQuery, setInstallHostSearchQuery] = useState('');
  const [installPassphrase, setInstallPassphrase] = useState('');
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<SshKeyInstallResult | null>(null);

  const handleCopyPassword = async (secretRef: string) => {
    setCopyingSecretRef(secretRef);
    setCopyStatus(null);
    try {
      await copySavedCredentialPassword(secretRef);
      setCopyStatus({
        tone: 'success',
        message: translate('keychain.copied'),
      });
    } catch (error) {
      setCopyStatus({
        tone: 'danger',
        message: getCopyErrorMessage(error),
      });
    } finally {
      setCopyingSecretRef(null);
    }
  };

  const handleCopyPublicKey = async (secretRef: string) => {
    setCopyingPublicKeyRef(secretRef);
    setCopyStatus(null);
    try {
      await onCopySshPublicKey(secretRef);
      setCopyStatus({
        tone: 'success',
        message: translate('keychain.publicKeyCopied'),
      });
    } catch (error) {
      setCopyStatus({
        tone: 'danger',
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : translate('keychain.publicKeyCopyFailed'),
      });
    } finally {
      setCopyingPublicKeyRef(null);
    }
  };

  const hostsBySecretRef = useMemo(() => {
    const nextHostsBySecretRef = new Map<string, HostRecord[]>();
    hosts.forEach((host) => {
      const secretRef = getHostSecretRef(host);
      if (!secretRef) {
        return;
      }
      const linkedHosts = nextHostsBySecretRef.get(secretRef) ?? [];
      linkedHosts.push(host);
      nextHostsBySecretRef.set(secretRef, linkedHosts);
    });
    return nextHostsBySecretRef;
  }, [hosts]);

  const visibleEntries = useMemo(() => {
    if (searchQuery.trim().length === 0) {
      return entries;
    }

    return entries.filter((entry) =>
      matchesKeyboardLayoutQuery(
        buildKeychainEntrySearchText(entry, hostsBySecretRef.get(entry.secretRef) ?? []),
        searchQuery,
      ),
    );
  }, [entries, hostsBySecretRef, searchQuery]);

  const installableHosts = useMemo(
    () =>
      hosts.filter((host) => isSshHostRecord(host) || isAwsEc2HostRecord(host)),
    [hosts],
  );
  const installTarget = entries.find((entry) => entry.secretRef === installTargetRef) ?? null;
  const visibleInstallHosts = useMemo(() => {
    const query = installHostSearchQuery.trim();
    if (!query) {
      return installableHosts;
    }
    return installableHosts.filter((host) =>
      matchesKeyboardLayoutQuery(getHostSearchText(host).join(' '), query),
    );
  }, [installHostSearchQuery, installableHosts]);
  const selectedInstallHosts = useMemo(
    () => installableHosts.filter((host) => selectedInstallHostIds.includes(host.id)),
    [selectedInstallHostIds, installableHosts],
  );

  const openInstallDialog = (secretRef: string) => {
    setInstallTargetRef(secretRef);
    setInstallMode('installOnly');
    setSelectedInstallHostIds([]);
    setInstallHostSearchQuery('');
    setInstallPassphrase('');
    setInstallError(null);
    setInstallResult(null);
  };

  const toggleInstallHost = (hostId: string) => {
    setSelectedInstallHostIds((current) =>
      current.includes(hostId)
        ? current.filter((id) => id !== hostId)
        : [...current, hostId],
    );
  };

  const closeGenerateDialog = () => {
    if (generateBusy) {
      return;
    }
    setGenerateOpen(false);
    setGenerateError(null);
  };

  const closeInstallDialog = () => {
    if (installBusy) {
      return;
    }
    setInstallTargetRef(null);
    setInstallPassphrase('');
    setInstallHostSearchQuery('');
    setInstallError(null);
    setInstallResult(null);
    setSelectedInstallHostIds([]);
  };

  return (
    <div className="flex flex-col gap-[1.1rem]">
      <div className="flex items-end justify-between gap-4 px-0 pt-1 pb-2">
        <div>
          <p className="m-0 max-w-[48rem] text-[var(--text-soft)]">
            {translate('keychain.intro')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setGenerateOpen(true)}>
          Generate SSH Key
        </Button>
      </div>

      {entries.length > 0 ? (
        <Input
          type="search"
          aria-label="Search saved credentials"
          placeholder="Search saved credentials"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
      ) : null}

      {copyStatus ? (
        <div
          role={copyStatus.tone === 'danger' ? 'alert' : 'status'}
          className={
            copyStatus.tone === 'danger'
              ? 'rounded-[10px] border border-[color-mix(in_srgb,var(--danger-text)_24%,var(--border))] bg-[var(--danger-bg)] px-4 py-3 text-sm font-semibold text-[var(--danger-text)]'
              : 'rounded-[10px] border border-[color-mix(in_srgb,var(--success-text)_24%,var(--border))] bg-[var(--success-bg)] px-4 py-3 text-sm font-semibold text-[var(--success-text)]'
          }
        >
          {copyStatus.message}
        </div>
      ) : null}

      <PanelSection>
        {entries.length === 0 ? (
          <EmptyState
            title={translate('keychain.empty.title')}
            description={translate('keychain.empty.description')}
          />
        ) : visibleEntries.length === 0 ? (
          <EmptyState
            title={translate('keychain.empty.searchTitle')}
            description={translate('keychain.empty.searchDescription')}
          />
        ) : (
          visibleEntries.map((entry) => (
            <Card key={entry.secretRef}>
              <CardMain>
                <CardTitleRow>
                  <strong>{entry.label}</strong>
                </CardTitleRow>
                <CardMeta>
                  <span>{describeSecretType(entry)}</span>
                  {entry.keyAlgorithm ? <span>{entry.keyAlgorithm}</span> : null}
                  {entry.privateKeyEncrypted ? (
                    <span>
                      {entry.passphraseSaved ? 'Encrypted · passphrase saved' : 'Encrypted'}
                    </span>
                  ) : null}
                  {entry.privateKeyCipher ? (
                    <span>
                      {entry.privateKeyCipher}
                      {entry.privateKeyKdfRounds
                        ? ` · ${entry.privateKeyKdfRounds} rounds`
                        : ''}
                    </span>
                  ) : null}
                  <span>{translate('keychain.linkedHosts', { count: entry.linkedHostCount })}</span>
                  <span>{new Date(entry.updatedAt).toLocaleString(getFormatLocale())}</span>
                </CardMeta>
              </CardMain>
              <CardActions>
                {entry.hasPassword ? (
                  <Button
                    variant="secondary"
                    disabled={copyingSecretRef === entry.secretRef}
                    onClick={() => void handleCopyPassword(entry.secretRef)}
                  >
                    {translate(copyingSecretRef === entry.secretRef ? 'keychain.action.copying' : 'keychain.action.copyPassword')}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => onEditSecret(entry.secretRef)}>
                  {translate('keychain.action.edit')}
                </Button>
                {entry.hasManagedPrivateKey ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={copyingPublicKeyRef === entry.secretRef}
                      onClick={() => void handleCopyPublicKey(entry.secretRef)}
                    >
                      {translate(copyingPublicKeyRef === entry.secretRef ? 'keychain.action.copying' : 'keychain.action.copyPublicKey')}
                    </Button>
                    <Button variant="secondary" onClick={() => openInstallDialog(entry.secretRef)}>
                      {translate('keychain.action.installOnHost')}
                    </Button>
                  </>
                ) : null}
                <Button variant="danger" onClick={() => void onRemoveSecret(entry.secretRef)}>
                  {translate('common.delete')}
                </Button>
              </CardActions>
            </Card>
          ))
        )}
      </PanelSection>

      {generateOpen ? (
        <SshKeyGenerateDialog
          busy={generateBusy}
          error={generateError}
          onDismiss={closeGenerateDialog}
          onSubmit={async (input) => {
            setGenerateBusy(true);
            setGenerateError(null);
            setCopyStatus(null);
            try {
              const result = await onGenerateSshKey(input);
              setCopyStatus({
                tone: 'success',
                message: translate('keychain.keyCreated', { label: result.label }),
              });
              setGenerateOpen(false);
            } catch (error) {
              setGenerateError(
                error instanceof Error && error.message.trim()
                  ? error.message
                  : translate('keychain.keyCreateFailed'),
              );
            } finally {
              setGenerateBusy(false);
            }
          }}
        />
      ) : null}

      {installTarget ? (
        <DialogBackdrop onDismiss={closeInstallDialog}>
          <ModalShell role="dialog" aria-modal="true" aria-labelledby="install-ssh-key-title" size="lg">
            <ModalHeader className="block">
              <SectionLabel>SSH Key</SectionLabel>
              <h3 id="install-ssh-key-title">Install to Hosts</h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-sm font-semibold">Mode</span>
                <SelectField
                  value={installMode}
                  onChange={(event) =>
                    setInstallMode(event.target.value === 'installAndUse' ? 'installAndUse' : 'installOnly')
                  }
                >
                  <option value="installOnly">Install public key only</option>
                  <option value="installAndUse">Install and use this key</option>
                </SelectField>
              </label>
              {installTarget.privateKeyEncrypted && !installTarget.passphraseSaved ? (
                <label className="grid gap-2">
                  <span className="text-sm font-semibold">Key passphrase</span>
                  <Input
                    type="password"
                    value={installPassphrase}
                    onChange={(event) => setInstallPassphrase(event.target.value)}
                    placeholder="Required for encrypted private key"
                  />
                </label>
              ) : null}
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">Hosts</span>
                  <span className="text-sm text-[var(--text-soft)]">
                    {selectedInstallHostIds.length} selected
                  </span>
                </div>
                <Input
                  type="search"
                  aria-label="Search install hosts"
                  placeholder="Search hosts"
                  value={installHostSearchQuery}
                  onChange={(event) => setInstallHostSearchQuery(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={visibleInstallHosts.length === 0}
                    onClick={() =>
                      setSelectedInstallHostIds((current) => [
                        ...new Set([
                          ...current,
                          ...visibleInstallHosts.map((host) => host.id),
                        ]),
                      ])
                    }
                  >
                    Select visible
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={selectedInstallHostIds.length === 0}
                    onClick={() => setSelectedInstallHostIds([])}
                  >
                    Clear
                  </Button>
                </div>
                <div className="grid max-h-[18rem] gap-2 overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-2">
                  {installableHosts.length === 0 ? (
                    <p className="m-0 rounded-[10px] border border-dashed border-[var(--border)] px-3 py-3 text-sm text-[var(--text-soft)]">
                      {translate('keychain.install.noHosts')}
                    </p>
                  ) : visibleInstallHosts.length === 0 ? (
                    <p className="m-0 rounded-[10px] border border-dashed border-[var(--border)] px-3 py-3 text-sm text-[var(--text-soft)]">
                      {translate('keychain.install.noResults')}
                    </p>
                  ) : (
                    visibleInstallHosts.map((host) => {
                      const checked = selectedInstallHostIds.includes(host.id);
                      return (
                        <label
                          key={host.id}
                          className={[
                            'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[10px] border px-3 py-2 text-sm transition-[border-color,background] duration-150',
                            checked
                              ? 'border-[color-mix(in_srgb,var(--accent-strong)_36%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-elevated))]'
                              : 'border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[color-mix(in_srgb,var(--accent-strong)_24%,var(--border))]',
                          ].join(' ')}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleInstallHost(host.id)}
                            className="h-4 w-4"
                          />
                          <span className="grid min-w-0 gap-1">
                            <strong className="truncate">{host.label}</strong>
                            <span className="truncate text-[var(--text-soft)]">
                              {isSshHostRecord(host)
                                ? `${host.username}@${host.hostname}:${host.port}`
                                : `EC2 · ${host.awsRegion} · ${host.awsInstanceId}`}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
                {selectedInstallHosts.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedInstallHosts.slice(0, 6).map((host) => (
                      <span
                        key={host.id}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-semibold text-[var(--text-soft)]"
                      >
                        {host.label}
                      </span>
                    ))}
                    {selectedInstallHosts.length > 6 ? (
                      <span className="rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-semibold text-[var(--text-soft)]">
                        +{selectedInstallHosts.length - 6}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {installError ? (
                <div role="alert" className="text-sm font-semibold text-[var(--danger-text)]">
                  {installError}
                </div>
              ) : null}
              {installResult ? (
                <div className="grid gap-2 rounded-[10px] border border-[var(--border)] p-3 text-sm">
                  {installResult.results.map((result) => (
                    <div key={result.hostId} className="flex justify-between gap-3">
                      <span>{result.hostLabel}</span>
                      <span className={result.status === 'failed' ? 'text-[var(--danger-text)]' : 'text-[var(--success-text)]'}>
                        {result.status === 'already-present'
                          ? 'already present'
                          : result.status === 'installed'
                            ? 'installed'
                            : result.message ?? 'failed'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" disabled={installBusy} onClick={closeInstallDialog}>
                Close
              </Button>
              <Button
                variant="primary"
                disabled={
                  installBusy ||
                  selectedInstallHostIds.length === 0 ||
                  (installTarget.privateKeyEncrypted &&
                    !installTarget.passphraseSaved &&
                    installPassphrase.trim().length === 0)
                }
                onClick={async () => {
                  setInstallBusy(true);
                  setInstallError(null);
                  setInstallResult(null);
                  try {
                    const result = await onInstallSshPublicKey({
                      secretRef: installTarget.secretRef,
                      hostIds: selectedInstallHostIds,
                      mode: installMode,
                      passphraseOverride:
                        installTarget.privateKeyEncrypted && !installTarget.passphraseSaved
                          ? installPassphrase
                          : undefined,
                    });
                    setInstallResult(result);
                  } catch (error) {
                    setInstallError(
                      error instanceof Error && error.message.trim()
                        ? error.message
                        : translate('keychain.install.failed'),
                    );
                  } finally {
                    setInstallBusy(false);
                  }
                }}
              >
                {installBusy ? translate('keychain.install.busy') : 'Install'}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}
    </div>
  );
}
