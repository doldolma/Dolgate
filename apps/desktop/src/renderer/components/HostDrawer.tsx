import { useEffect, useRef } from 'react';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostForm } from './HostForm';
import { IconButton, SectionLabel } from '../ui';

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
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || mode !== 'edit') {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (drawerRef.current?.contains(target)) {
        return;
      }
      onClose();
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [mode, onClose, open]);

  return (
    <aside ref={drawerRef} className={`host-drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="host-drawer__header">
        <div>
          <SectionLabel>{mode === 'create' ? 'Create' : 'Edit'}</SectionLabel>
          <h2>{mode === 'create' ? 'New Host' : host?.label ?? 'Host'}</h2>
        </div>
        <IconButton onClick={onClose} aria-label="Close host drawer">
          ×
        </IconButton>
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
