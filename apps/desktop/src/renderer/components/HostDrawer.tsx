import { useEffect, useRef, useState } from 'react';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { HostForm, type HostFormActionState, type HostFormHandle, type HostFormProps } from './HostForm';
import { cn } from '../lib/cn';
import { Button, CloseIcon, IconButton, SectionLabel } from '../ui';

interface HostDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  host: HostRecord | null;
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  defaultGroupPath?: string | null;
  onClose: () => void;
  onSubmit: HostFormProps['onSubmit'];
  onConnect?: HostFormProps['onConnect'];
  onEditExistingSecret?: (secretRef: string) => void;
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
  onEditExistingSecret,
  onOpenSecrets
}: HostDrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const hostFormRef = useRef<HostFormHandle | null>(null);
  const [isActionInFlight, setIsActionInFlight] = useState(false);
  const [formActionState, setFormActionState] = useState<HostFormActionState>({
    saveInFlight: false,
    saveStatusText: null,
  });
  const isFooterBusy = isActionInFlight || formActionState.saveInFlight;
  const formHost = host;

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

  async function handlePrimaryAction() {
    if (!hostFormRef.current) {
      return;
    }
    setIsActionInFlight(true);
    try {
      if (mode === 'create') {
        await hostFormRef.current.submitCreate();
        return;
      }
      await hostFormRef.current.submitAndConnect();
    } finally {
      setIsActionInFlight(false);
    }
  }

  return (
    <aside
      ref={drawerRef}
      className={cn(
        'flex min-w-0 min-h-0 h-full flex-col overflow-hidden border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-strong)_96%,transparent_4%)] opacity-0 translate-x-[18px] transition-[opacity,transform] duration-180',
        open && 'opacity-100 translate-x-0',
      )}
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-[1.4rem] pb-[1rem] pt-[1.4rem]">
        <div>
          <SectionLabel>{mode === 'create' ? 'Create' : 'Edit'}</SectionLabel>
          <h2>{mode === 'create' ? 'New Host' : formHost?.label ?? 'Host'}</h2>
        </div>
        <IconButton onClick={onClose} aria-label="Close host editor">
          <CloseIcon />
        </IconButton>
      </div>

      <div
        data-testid="drawer-scroll-body"
        className="min-h-0 flex-1 overflow-y-auto px-[1.4rem] pb-[1.25rem] pt-[1.2rem]"
      >
        <HostForm
          ref={hostFormRef}
          hideTitle
          host={formHost}
          keychainEntries={keychainEntries}
          groupOptions={groupOptions}
          defaultGroupPath={defaultGroupPath}
          onSubmit={onSubmit}
          onConnect={onConnect}
          onEditExistingSecret={onEditExistingSecret}
          onOpenSecrets={onOpenSecrets}
          onActionStateChange={setFormActionState}
        />
      </div>

      <div
        data-testid="drawer-footer"
        className="shrink-0 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-strong)_98%,transparent_2%)] px-[1.4rem] pb-[1.3rem] pt-[1rem]"
      >
        <div className="flex gap-[0.75rem]">
          <Button
            variant="primary"
            className="flex-1 rounded-[16px] border border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border)_72%)] bg-[color-mix(in_srgb,var(--surface-elevated)_90%,var(--accent-strong)_10%)] px-[1.1rem] py-[0.95rem] font-[650] text-[var(--text)] shadow-none transition-[border-color,background-color,color] duration-160 hover:border-[color-mix(in_srgb,var(--accent-strong)_40%,var(--border)_60%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_84%,var(--accent-strong)_16%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-strong)_60%,white_40%)] focus-visible:ring-offset-2"
            disabled={isFooterBusy}
            onClick={async () => {
              await handlePrimaryAction();
            }}
          >
            {mode === 'create' ? 'Create Host' : 'Connect'}
          </Button>
        </div>
        {mode === 'edit' && formActionState.saveStatusText ? (
          <div
            className={cn(
              'mt-[0.55rem] text-[0.86rem] leading-[1.4] text-[var(--text-soft)]',
              formActionState.saveStatusText === "Couldn't save changes" &&
                'text-[color-mix(in_srgb,var(--danger)_82%,white_18%)]',
            )}
          >
            {formActionState.saveStatusText}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
