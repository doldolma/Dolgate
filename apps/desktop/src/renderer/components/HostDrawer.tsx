import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { getUnusedLocalSecretsAfterHostDeletion } from '../lib/host-secret-cleanup';
import { HostForm, type HostFormActionState, type HostFormHandle, type HostFormProps } from './HostForm';
import { HostDeleteConfirmDialog } from './HostDeleteConfirmDialog';
import { cn } from '../lib/cn';
import { Button, CloseIcon, IconButton, SectionLabel } from '../ui';

interface HostDrawerProps {
  open: boolean;
  mode: 'create' | 'edit';
  host: HostRecord | null;
  allHosts: HostRecord[];
  keychainEntries: SecretMetadataRecord[];
  groupOptions: Array<{ value: string | null; label: string }>;
  defaultGroupPath?: string | null;
  onClose: () => void;
  onSubmit: HostFormProps['onSubmit'];
  onConnect?: HostFormProps['onConnect'];
  onDelete?: () => Promise<void>;
  onRemoveSecret?: (secretRef: string) => Promise<void>;
  onEditExistingSecret?: (secretRef: string, credentialKind: 'password' | 'passphrase') => void;
  onOpenSecrets?: () => void;
}

export function HostDrawer({
  open,
  mode,
  host,
  allHosts,
  keychainEntries,
  groupOptions,
  defaultGroupPath = null,
  onClose,
  onSubmit,
  onConnect,
  onDelete,
  onRemoveSecret,
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
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [removeUnusedSecretsOnDelete, setRemoveUnusedSecretsOnDelete] = useState(true);
  const [deleteTargetHost, setDeleteTargetHost] = useState<HostRecord | null>(null);
  const [deleteTargetSecretRefs, setDeleteTargetSecretRefs] = useState<string[]>([]);
  const isFooterBusy = isActionInFlight || formActionState.saveInFlight;
  const unusedLocalSecretRefs = useMemo(
    () =>
      host
        ? getUnusedLocalSecretsAfterHostDeletion(allHosts, keychainEntries, [host.id])
        : [],
    [allHosts, host, keychainEntries],
  );
  const formHost = host ?? deleteTargetHost;

  useEffect(() => {
    if (!open || mode !== 'edit' || isDeleteConfirmOpen) {
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
  }, [isDeleteConfirmOpen, mode, onClose, open]);

  useEffect(() => {
    setRemoveUnusedSecretsOnDelete(unusedLocalSecretRefs.length > 0);
  }, [host?.id, unusedLocalSecretRefs.length]);

  useEffect(() => {
    if (!open) {
      setIsDeleteConfirmOpen(false);
      setDeleteError(null);
      setDeleteTargetHost(null);
      setDeleteTargetSecretRefs([]);
    }
  }, [open]);

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

  async function handleDeleteAction() {
    if (!onDelete) {
      return;
    }
    setIsActionInFlight(true);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '호스트를 삭제하지 못했습니다.');
      return;
    }

    try {
      if (removeUnusedSecretsOnDelete && onRemoveSecret) {
        for (const secretRef of deleteTargetSecretRefs) {
          await onRemoveSecret(secretRef);
        }
      }
      setDeleteError(null);
      setIsDeleteConfirmOpen(false);
      setDeleteTargetHost(null);
      setDeleteTargetSecretRefs([]);
      onClose();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '사용하지 않는 secret을 삭제하지 못했습니다.');
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
        <IconButton onClick={onClose} aria-label="Close host drawer">
          <CloseIcon />
        </IconButton>
      </div>

      <div
        data-testid="host-drawer-scroll-body"
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
        data-testid="host-drawer-footer"
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
          {mode === 'edit' && onDelete ? (
            <Button
              variant="danger"
              disabled={isFooterBusy}
              onClick={() => {
                if (!host) {
                  return;
                }
                setDeleteError(null);
                setRemoveUnusedSecretsOnDelete(unusedLocalSecretRefs.length > 0);
                setDeleteTargetHost(host);
                setDeleteTargetSecretRefs(unusedLocalSecretRefs);
                setIsDeleteConfirmOpen(true);
              }}
            >
              Delete
            </Button>
          ) : null}
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

      {mode === 'edit' && deleteTargetHost && onDelete ? (
        <HostDeleteConfirmDialog
          open={isDeleteConfirmOpen}
          title={`${deleteTargetHost.label} 호스트를 삭제할까요?`}
          unusedLocalSecretCount={onRemoveSecret ? deleteTargetSecretRefs.length : 0}
          removeUnusedSecrets={removeUnusedSecretsOnDelete}
          onToggleRemoveUnusedSecrets={setRemoveUnusedSecretsOnDelete}
          errorMessage={deleteError}
          isDeleting={isActionInFlight}
          onClose={() => {
            if (isActionInFlight) {
              return;
            }
            const shouldCloseDrawer = !host && Boolean(deleteTargetHost);
            setIsDeleteConfirmOpen(false);
            setDeleteError(null);
            setDeleteTargetHost(null);
            setDeleteTargetSecretRefs([]);
            if (shouldCloseDrawer) {
              onClose();
            }
          }}
          onConfirm={handleDeleteAction}
        />
      ) : null}
    </aside>
  );
}
