import { useEffect, useState } from 'react';
import type { HostDraft, HostRecord } from '@keyterm/shared';

const defaultDraft: HostDraft = {
  label: '',
  hostname: '',
  port: 22,
  username: '',
  authType: 'password',
  privateKeyPath: '',
  secretRef: null,
  groupName: ''
};

function createDraft(defaultGroupPath?: string | null): HostDraft {
  return {
    ...defaultDraft,
    groupName: defaultGroupPath ?? ''
  };
}

interface HostFormProps {
  host: HostRecord | null;
  defaultGroupPath?: string | null;
  hideTitle?: boolean;
  onSubmit: (draft: HostDraft, secrets?: { password?: string; passphrase?: string }) => Promise<void>;
  onDelete?: () => Promise<void>;
}

export function HostForm({ host, defaultGroupPath = null, hideTitle = false, onSubmit, onDelete }: HostFormProps) {
  const [draft, setDraft] = useState<HostDraft>(createDraft(defaultGroupPath));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    if (!host) {
      setDraft(createDraft(defaultGroupPath));
      setPassword('');
      setPassphrase('');
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
      groupName: host.groupName ?? ''
    });
    setPassword('');
    setPassphrase('');
  }, [defaultGroupPath, host]);

  async function pickPrivateKey(): Promise<void> {
    const selected = await window.keyterm.shell.pickPrivateKey();
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
        await onSubmit(draft, {
          password: password || undefined,
          passphrase: passphrase || undefined
        });
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

      {draft.authType === 'password' ? (
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={host ? 'Leave blank to keep' : ''} />
        </label>
      ) : (
        <>
          <label>
            Private key
            <div className="file-input-row">
              <input
                value={draft.privateKeyPath ?? ''}
                onChange={(event) => setDraft({ ...draft, privateKeyPath: event.target.value })}
                placeholder="/Users/.../.ssh/id_ed25519"
                required
              />
              <button type="button" className="secondary-button" onClick={pickPrivateKey}>
                Browse
              </button>
            </div>
          </label>
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={host ? 'Leave blank to keep' : ''}
            />
          </label>
        </>
      )}

      <div className="form-actions">
        <button type="submit">{host ? 'Save host' : 'Create host'}</button>
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
