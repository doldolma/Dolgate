import type { HostRecord } from '@shared';
import { AwsSftpConfigRetryDialog } from '../components/AwsSftpConfigRetryDialog';
import { CredentialRetryDialog } from '../components/CredentialRetryDialog';
import { KnownHostPromptDialog } from '../components/KnownHostPromptDialog';
import { MissingUsernameDialog } from '../components/MissingUsernameDialog';
import {
  SecretEditDialog,
  type SecretEditDialogRequest,
} from '../components/SecretEditDialog';
import { UpdateInstallConfirmDialog } from '../components/UpdateInstallConfirmDialog';
import type { useAppModalViewModel, useAppSettingsViewModel } from '../view-models/appViewModels';
import { findHost } from './appShellUtils';

interface AppModalsProps {
  hosts: HostRecord[];
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  settingsViewModel: ReturnType<typeof useAppSettingsViewModel>;
  secretEditRequest: SecretEditDialogRequest | null;
  onCloseSecretEditor: () => void;
  onSubmitSecretEditor: (input: {
    mode: 'update-shared' | 'clone-for-host';
    secretRef: string;
    hostId: string | null;
    secrets: { password?: string; passphrase?: string };
  }) => Promise<void>;
  isUpdateInstallConfirmOpen: boolean;
  onCloseUpdateInstallConfirm: () => void;
  onConfirmInstallUpdate: () => Promise<void>;
}

export function AppModals({
  hosts,
  modalViewModel,
  settingsViewModel,
  secretEditRequest,
  onCloseSecretEditor,
  onSubmitSecretEditor,
  isUpdateInstallConfirmOpen,
  onCloseUpdateInstallConfirm,
  onConfirmInstallUpdate,
}: AppModalsProps) {
  return (
    <>
      <KnownHostPromptDialog
        pending={modalViewModel.pendingHostKeyPrompt}
        onAccept={modalViewModel.acceptPendingHostKeyPrompt}
        onCancel={modalViewModel.dismissPendingHostKeyPrompt}
        onOpenSecuritySettings={() => {
          modalViewModel.dismissPendingHostKeyPrompt();
          settingsViewModel.openSettingsSection('security');
        }}
      />

      <CredentialRetryDialog
        request={(() => {
          const pending = modalViewModel.pendingCredentialRetry;
          if (!pending) {
            return null;
          }
          const host = findHost(hosts, pending.hostId);
          if (!host || host.kind !== "ssh") {
            return null;
          }
          return {
            ...pending,
            hostLabel: host.label,
            hasStoredSecret: Boolean(host.secretRef),
            hasLegacyPrivateKeyPath: Boolean(host.privateKeyPath),
            hasLegacyCertificatePath: Boolean(host.certificatePath),
          };
        })()}
        onClose={modalViewModel.dismissPendingCredentialRetry}
        onSubmit={modalViewModel.submitCredentialRetry}
      />

      <AwsSftpConfigRetryDialog
        request={
          modalViewModel.pendingAwsSftpConfigRetry
            ? {
                hostLabel:
                  findHost(hosts, modalViewModel.pendingAwsSftpConfigRetry.hostId)?.label ?? 'AWS Host',
                message: modalViewModel.pendingAwsSftpConfigRetry.message,
                suggestedUsername:
                  modalViewModel.pendingAwsSftpConfigRetry.suggestedUsername,
                suggestedPort:
                  modalViewModel.pendingAwsSftpConfigRetry.suggestedPort,
              }
            : null
        }
        onClose={modalViewModel.dismissPendingAwsSftpConfigRetry}
        onSubmit={modalViewModel.submitAwsSftpConfigRetry}
      />

      <MissingUsernameDialog
        request={
          modalViewModel.pendingMissingUsernamePrompt
            ? {
                hostLabel:
                  findHost(hosts, modalViewModel.pendingMissingUsernamePrompt.hostId)?.label ?? 'SSH Host',
                source: modalViewModel.pendingMissingUsernamePrompt.source,
              }
            : null
        }
        onClose={modalViewModel.dismissPendingMissingUsernamePrompt}
        onSubmit={modalViewModel.submitMissingUsernamePrompt}
      />

      <SecretEditDialog
        request={secretEditRequest}
        onClose={onCloseSecretEditor}
        onSubmit={onSubmitSecretEditor}
      />

      <UpdateInstallConfirmDialog
        open={isUpdateInstallConfirmOpen}
        onClose={onCloseUpdateInstallConfirm}
        onConfirm={onConfirmInstallUpdate}
      />
    </>
  );
}
