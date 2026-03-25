import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostForm } from './HostForm';

interface HostDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  defaultGroupPath?: string | null;
  onClose: () => void;
  onSubmit: Parameters<typeof HostForm>[0]['onSubmit'];
  onConnect?: Parameters<typeof HostForm>[0]['onConnect'];
  onDelete?: () => Promise<void>;
  onEditExistingSecret?: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
  onOpenSecrets?: () => void;
}

export function HostDrawer({
  open,
  mode,
  host,
  keychainEntries,
  groupOptions,
  defaultGroupPath = null,
  onClose,
  onSubmit,
  onConnect,
  onDelete,
  onEditExistingSecret,
  onOpenSecrets
}: HostDrawerProps) {
  return (
    <aside className={`host-drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="host-drawer__header">
        <div>
          <div className="eyebrow">{mode === 'create' ? 'Create' : 'Edit'}</div>
          <h2>{mode === 'create' ? 'New Host' : host?.label ?? 'Host'}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close host drawer">
          ×
        </button>
      </div>

      <div className="host-drawer__body">
        <HostForm
          hideTitle
          host={host}
          keychainEntries={keychainEntries}
          groupOptions={groupOptions}
          defaultGroupPath={defaultGroupPath}
          onSubmit={onSubmit}
          onConnect={onConnect}
          onDelete={onDelete}
          onEditExistingSecret={onEditExistingSecret}
          onOpenSecrets={onOpenSecrets}
        />
      </div>
    </aside>
  );
}
