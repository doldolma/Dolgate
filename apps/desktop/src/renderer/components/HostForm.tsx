import { useEffect, useState } from 'react';
import type { HostDraft, HostRecord, SecretMetadataRecord, TerminalThemeId } from '@shared';
import { terminalThemePresets } from '../lib/terminal-presets';

const defaultDraft: HostDraft = {
  label: '',
  hostname: '',
  port: 22,
  username: '',
  authType: 'password',
  privateKeyPath: '',
  secretRef: null,
  groupName: '',
  terminalThemeId: null
};

function createDraft(defaultGroupPath?: string | null): HostDraft {
  return {
    ...defaultDraft,
    groupName: defaultGroupPath ?? ''
  };
}

interface HostFormProps {
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  defaultGroupPath?: string | null;
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: { password?: string; passphrase?: string }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onEditExistingSecret?: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
}

export function HostForm({
  host,
  keychainEntries,
  defaultGroupPath = null,
  hideTitle = false,
  onSubmit,
  onDelete,
  onEditExistingSecret
}: HostFormProps) {
  const [draft, setDraft] = useState<HostDraft>(createDraft(defaultGroupPath));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [credentialMode, setCredentialMode] = useState<'new' | 'existing' | 'none'>('new');
  const [selectedSecretRef, setSelectedSecretRef] = useState('');

  const reusableEntries = keychainEntries.filter((entry) =>
    draft.authType === 'password' ? entry.hasPassword : entry.hasManagedPrivateKey || entry.hasPassphrase
  );

  useEffect(() => {
    if (!host) {
      setDraft(createDraft(defaultGroupPath));
      setPassword('');
      setPassphrase('');
      setSelectedSecretRef('');
      setCredentialMode('new');
      return;
    }
    setDraft({
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
      privateKeyPath: host.privateKeyPath ?? '',
      secretRef: host.secretRef,
      groupName: host.groupName ?? '',
      terminalThemeId: host.terminalThemeId ?? null
    });
    setPassword('');
    setPassphrase('');
    setSelectedSecretRef(host.secretRef ?? '');
    setCredentialMode(host.secretRef ? 'existing' : host.authType === 'password' ? 'new' : 'none');
  }, [defaultGroupPath, host]);

  useEffect(() => {
    if (draft.authType === 'password' && credentialMode === 'none') {
      setCredentialMode('new');
    }

    if (credentialMode === 'existing' && selectedSecretRef && !reusableEntries.some((entry) => entry.secretRef === selectedSecretRef)) {
      setSelectedSecretRef('');
      setCredentialMode(draft.authType === 'password' ? 'new' : 'none');
    }
  }, [credentialMode, draft.authType, reusableEntries, selectedSecretRef]);

  async function pickPrivateKey(): Promise<void> {
    const selected = await window.dolssh.shell.pickPrivateKey();
    if (!selected) {
      return;
    }
    setDraft((current) => ({ ...current, privateKeyPath: selected }));
  }

  return (
    <form
      className="host-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const nextDraft: HostDraft = {
          ...draft,
          secretRef: credentialMode === 'existing' ? selectedSecretRef || null : null
        };
        await onSubmit(
          nextDraft,
          credentialMode === 'new'
            ? {
                password: password || undefined,
                passphrase: passphrase || undefined
              }
            : undefined
        );
      }}
    >
      {hideTitle ? null : <div className="section-title">Host Editor</div>}
      <label>
        Label
        <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Production API" required />
      </label>
      <label>
        Group
        <input value={draft.groupName ?? ''} onChange={(event) => setDraft({ ...draft, groupName: event.target.value })} placeholder="Servers" />
      </label>
      <label>
        Hostname
        <input value={draft.hostname} onChange={(event) => setDraft({ ...draft, hostname: event.target.value })} placeholder="prod.example.com" required />
      </label>
      <div className="row two-col">
        <label>
          Port
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) || 22 })}
            required
          />
        </label>
        <label>
          Username
          <input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="ubuntu" required />
        </label>
      </div>
      <label>
        Auth Type
        <select
          value={draft.authType}
          onChange={(event) =>
            setDraft({
              ...draft,
              authType: event.target.value === 'privateKey' ? 'privateKey' : 'password'
            })
          }
        >
          <option value="password">Password</option>
          <option value="privateKey">Private key</option>
        </select>
      </label>

      <label>
        Terminal Theme
        <select
          value={draft.terminalThemeId ?? ''}
          onChange={(event) =>
            setDraft({
              ...draft,
              terminalThemeId: event.target.value ? (event.target.value as TerminalThemeId) : null
            })
          }
        >
          <option value="">Use global theme</option>
          {terminalThemePresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.title}
            </option>
          ))}
        </select>
      </label>

      <label>
        Keychain
        <select
          value={credentialMode === 'existing' ? `existing:${selectedSecretRef}` : credentialMode}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'new' || value === 'none') {
              setCredentialMode(value);
              setSelectedSecretRef('');
              return;
            }
            if (value.startsWith('existing:')) {
              setCredentialMode('existing');
              setSelectedSecretRef(value.slice('existing:'.length));
            }
          }}
        >
          {draft.authType === 'privateKey' ? <option value="none">사용 안 함</option> : null}
          <option value="new">새 키체인 생성</option>
          {reusableEntries.map((entry) => (
            <option key={entry.secretRef} value={`existing:${entry.secretRef}`}>
              {entry.label} ({entry.linkedHostCount}개 호스트)
            </option>
          ))}
        </select>
      </label>

      {draft.authType === 'password' && credentialMode === 'new' ? (
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={host ? 'Leave blank to keep' : ''} />
        </label>
      ) : null}

      {credentialMode === 'existing' ? (
        <>
          <p className="form-note">선택한 키체인을 이 호스트와 공유합니다. 이 호스트를 삭제해도 키체인 항목은 유지됩니다.</p>
          {host && selectedSecretRef && host.secretRef === selectedSecretRef && onEditExistingSecret ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onEditExistingSecret(selectedSecretRef, draft.authType === 'password' ? 'password' : 'passphrase')}
            >
              {draft.authType === 'password' ? '비밀번호 변경' : 'Passphrase 변경'}
            </button>
          ) : null}
        </>
      ) : null}

      {draft.authType === 'privateKey' ? (
        <>
          <label>
            Private key file
            <div className="file-input-row">
              <input
                value={draft.privateKeyPath ?? ''}
                onChange={(event) => setDraft({ ...draft, privateKeyPath: event.target.value })}
                placeholder="/Users/.../.ssh/id_ed25519"
              />
              <button type="button" className="secondary-button" onClick={pickPrivateKey}>
                Import
              </button>
            </div>
          </label>
          {credentialMode === 'new' ? (
            <label>
              Passphrase
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder={host ? 'Leave blank to keep' : ''}
              />
            </label>
          ) : null}
        </>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="host-form__submit">
          {host ? 'Save host' : 'Create host'}
        </button>
        {host && onDelete ? (
          <button
            type="button"
            className="danger-button"
            onClick={async () => {
              await onDelete();
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}
