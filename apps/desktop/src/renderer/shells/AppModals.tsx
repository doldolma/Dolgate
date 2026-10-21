import type { HostRecord } from '@shared';
import { AwsSftpConfigRetryDialog } from '../components/AwsSftpConfigRetryDialog';
import { CredentialRetryDialog } from '../components/CredentialRetryDialog';
import { KnownHostPromptDialog } from '../components/KnownHostPromptDialog';
import { MissingUsernameDialog } from '../components/MissingUsernameDialog';
import { PortForwardEditorHost } from '../components/PortForwardEditorHost';
import { SnippetVariablesDialog } from '../components/terminal-workspace/SnippetVariablesDialog';
import {
  SecretEditDialog,
  type SecretEditDialogRequest,
} from '../components/SecretEditDialog';
import { UpdateInstallConfirmDialog } from '../components/UpdateInstallConfirmDialog';
import { JoinTeamDialogHost } from '../components/teams/JoinTeamDialogHost';
import type { useAppModalViewModel, useAppSettingsViewModel } from '../view-models/appViewModels';
import { credentialRetryDialogRequest, findHost } from './appShellUtils';
import { useTranslation } from 'react-i18next';

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
    secrets: {
      password?: string;
      passphrase?: string;
      privateKeyPem?: string;
      certificateText?: string;
    };
    label?: string;
  }) => Promise<void>;
  isUpdateInstallConfirmOpen: boolean;
  onCloseUpdateInstallConfirm: () => void;
  onConfirmInstallUpdate: () => Promise<void>;
  /** 계정 없이 쓰는 사람이 초대 링크를 열었을 때 로그인 창을 연다. */
  onRequestLogin: () => void;
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
  onRequestLogin,
}: AppModalsProps) {
  const { t: translate } = useTranslation();
  return (
    <>
      {/* 포트 포워딩 편집기. 포트 화면과 세션 패널이 같은 한 벌을 여기서 나눠 쓴다. */}
      <PortForwardEditorHost />
      <KnownHostPromptDialog
        pending={modalViewModel.unownedHostKeyPrompt}
        onAccept={modalViewModel.acceptPendingHostKeyPrompt}
        onCancel={modalViewModel.dismissPendingHostKeyPrompt}
        onOpenSecuritySettings={() => {
          modalViewModel.dismissPendingHostKeyPrompt();
          settingsViewModel.openSettingsSection('security');
        }}
      />

      <CredentialRetryDialog
        request={credentialRetryDialogRequest(hosts, modalViewModel.pendingCredentialRetry)}
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
                teamHost: modalViewModel.pendingMissingUsernameTeamHost,
              }
            : null
        }
        onClose={modalViewModel.dismissPendingMissingUsernamePrompt}
        onSubmit={modalViewModel.submitMissingUsernamePrompt}
      />

      <SnippetVariablesDialog
        pending={modalViewModel.pendingStartupCommandPrompt}
        title={translate('appModals.startupVarsTitle')}
        confirmLabel={translate('appModals.startupVarsConfirm')}
        onConfirm={(values) => {
          void modalViewModel.confirmStartupCommandPrompt(values);
        }}
        onCancel={modalViewModel.cancelStartupCommandPrompt}
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

      {/* 초대 링크의 참여 카드. 링크 페이지에서 넘어왔거나 Teams 탭에 붙여 넣은 링크다. */}
      <JoinTeamDialogHost onRequestLogin={onRequestLogin} />
    </>
  );
}
