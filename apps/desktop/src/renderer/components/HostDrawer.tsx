import { useEffect, useRef } from 'react';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostForm } from './HostForm';
import { cn } from '../lib/cn';
import { CloseIcon, IconButton, SectionLabel } from '../ui';

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
    <aside
      ref={drawerRef}
      className={cn(
        'min-w-0 min-h-0 h-full overflow-hidden border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-strong)_96%,transparent_4%)] opacity-0 translate-x-[18px] transition-[opacity,transform] duration-180',
        open && 'opacity-100 translate-x-0',
      )}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-[1.4rem] pb-[1rem] pt-[1.4rem]">
        <div>
          <SectionLabel>{mode === 'create' ? 'Create' : 'Edit'}</SectionLabel>
          <h2>{mode === 'create' ? 'New Host' : host?.label ?? 'Host'}</h2>
        </div>
        <IconButton onClick={onClose} aria-label="Close host drawer">
          <CloseIcon />
        </IconButton>
      </div>

      <div className="h-[calc(100%-88px)] overflow-auto px-[1.4rem] pb-[1.5rem] pt-[1.2rem]">
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
