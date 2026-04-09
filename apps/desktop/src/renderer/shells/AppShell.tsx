import { useEffect, useState } from 'react';
import type { AuthState, DesktopWindowState, UpdateState } from '@shared';
import { AppTitleBar } from '../components/AppTitleBar';
import type { SecretEditDialogRequest } from '../components/SecretEditDialog';
import type { useLoginController } from '../controllers/useLoginController';
import type {
  useAppModalViewModel,
  useAppSettingsViewModel,
  useContainersViewModel,
  useHomeViewModel,
  useSessionWorkspaceViewModel,
  useSftpViewModel,
} from '../view-models/appViewModels';
import { AppModals } from './AppModals';
import { ContainersShell } from './ContainersShell';
import { HomeShell } from './HomeShell';
import { SessionShell } from './SessionShell';
import { SftpShell } from './SftpShell';
import {
  type DraggedSessionPayload,
  workspaceContainsSession,
} from './appShellUtils';

interface AppShellProps {
  authState: AuthState & { session: NonNullable<AuthState['session']> };
  offlineLeaseExpiryLabel: string | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  prefersDark: boolean;
  updateState: UpdateState;
  windowState: DesktopWindowState;
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  sessionViewModel: ReturnType<typeof useSessionWorkspaceViewModel>;
  containersViewModel: ReturnType<typeof useContainersViewModel>;
  sftpViewModel: ReturnType<typeof useSftpViewModel>;
  settingsViewModel: ReturnType<typeof useAppSettingsViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
}

export function AppShell({
  authState,
  offlineLeaseExpiryLabel,
  desktopPlatform,
  prefersDark,
  updateState,
  windowState,
  homeViewModel,
  sessionViewModel,
  containersViewModel,
  sftpViewModel,
  settingsViewModel,
  modalViewModel,
  loginController,
}: AppShellProps) {
  const [draggedSession, setDraggedSession] = useState<DraggedSessionPayload | null>(
    null,
  );
  const [isUpdateInstallConfirmOpen, setIsUpdateInstallConfirmOpen] =
    useState(false);
  const [secretEditRequest, setSecretEditRequest] =
    useState<SecretEditDialogRequest | null>(null);

  const isHomeActive = homeViewModel.activeWorkspaceTab === 'home';
  const isSftpActive = homeViewModel.activeWorkspaceTab === 'sftp';
  const isContainersActive = homeViewModel.activeWorkspaceTab === 'containers';
  const isSessionViewActive =
    !isHomeActive && !isSftpActive && !isContainersActive;
  const hasActiveTransfers = sftpViewModel.sftp.transfers.some(
    (job) => job.status === 'queued' || job.status === 'running',
  );
  const hasActivePortForwards = homeViewModel.portForwardRuntimes.some(
    (runtime) => runtime.status === 'starting' || runtime.status === 'running',
  );
  const hasBlockingUpdateInstall =
    sessionViewModel.tabs.length > 0 ||
    hasActiveTransfers ||
    hasActivePortForwards;

  useEffect(() => {
    if (modalViewModel.pendingHostKeyPrompt?.sessionId) {
      const owningWorkspace = sessionViewModel.workspaces.find((workspace) =>
        workspaceContainsSession(
          workspace,
          modalViewModel.pendingHostKeyPrompt?.sessionId as string,
        ),
      );
      if (owningWorkspace) {
        if (
          homeViewModel.activeWorkspaceTab === `workspace:${owningWorkspace.id}` &&
          owningWorkspace.activeSessionId ===
            modalViewModel.pendingHostKeyPrompt.sessionId
        ) {
          return;
        }
        sessionViewModel.focusWorkspaceSession(
          owningWorkspace.id,
          modalViewModel.pendingHostKeyPrompt.sessionId,
        );
        return;
      }
      if (
        homeViewModel.activeWorkspaceTab ===
        `session:${modalViewModel.pendingHostKeyPrompt.sessionId}`
      ) {
        return;
      }
      sessionViewModel.activateSession(
        modalViewModel.pendingHostKeyPrompt.sessionId,
      );
    }
  }, [
    homeViewModel.activeWorkspaceTab,
    modalViewModel.pendingHostKeyPrompt?.sessionId,
    sessionViewModel,
  ]);

  useEffect(() => {
    if (modalViewModel.pendingCredentialRetry?.sessionId) {
      const owningWorkspace = sessionViewModel.workspaces.find((workspace) =>
        workspaceContainsSession(
          workspace,
          modalViewModel.pendingCredentialRetry?.sessionId as string,
        ),
      );
      if (owningWorkspace) {
        if (
          homeViewModel.activeWorkspaceTab === `workspace:${owningWorkspace.id}` &&
          owningWorkspace.activeSessionId ===
            modalViewModel.pendingCredentialRetry.sessionId
        ) {
          return;
        }
        sessionViewModel.focusWorkspaceSession(
          owningWorkspace.id,
          modalViewModel.pendingCredentialRetry.sessionId,
        );
        return;
      }
      if (
        homeViewModel.activeWorkspaceTab ===
        `session:${modalViewModel.pendingCredentialRetry.sessionId}`
      ) {
        return;
      }
      sessionViewModel.activateSession(
        modalViewModel.pendingCredentialRetry.sessionId,
      );
    }
  }, [
    homeViewModel.activeWorkspaceTab,
    modalViewModel.pendingCredentialRetry?.sessionId,
    sessionViewModel,
  ]);

  async function handleInstallUpdate() {
    if (hasBlockingUpdateInstall) {
      setIsUpdateInstallConfirmOpen(true);
      return;
    }
    await loginController.installUpdateAndRestart();
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--accent-strong)_10%,transparent),transparent_24%),radial-gradient(circle_at_top_right,rgba(255,255,255,0.3),transparent_24%),linear-gradient(180deg,color-mix(in_srgb,var(--app-bg)_97%,white_3%),var(--app-bg))]">
      <AppTitleBar
        desktopPlatform={desktopPlatform}
        tabs={sessionViewModel.tabs}
        workspaces={sessionViewModel.workspaces}
        tabStrip={sessionViewModel.tabStrip}
        activeWorkspaceTab={homeViewModel.activeWorkspaceTab}
        draggedSession={draggedSession}
        updateState={updateState}
        windowState={windowState}
        onSelectHome={homeViewModel.activateHome}
        onSelectSftp={sftpViewModel.activateSftp}
        onSelectContainers={containersViewModel.activateContainers}
        onSelectSession={sessionViewModel.activateSession}
        onSelectWorkspace={sessionViewModel.activateWorkspace}
        onCloseSession={sessionViewModel.disconnectTab}
        onCloseWorkspace={sessionViewModel.closeWorkspace}
        onStartSessionDrag={(sessionId) => {
          setDraggedSession({ sessionId, source: 'standalone-tab' });
        }}
        onEndSessionDrag={() => {
          setDraggedSession(null);
        }}
        onDetachSessionToStandalone={sessionViewModel.detachSessionFromWorkspace}
        onReorderDynamicTab={sessionViewModel.reorderDynamicTab}
        onCheckForUpdates={loginController.checkForUpdates}
        onDownloadUpdate={loginController.downloadUpdate}
        onInstallUpdate={handleInstallUpdate}
        onDismissUpdate={loginController.dismissAvailableUpdate}
        onOpenReleasePage={async (url) => {
          await loginController.runUpdaterAction(() =>
            loginController.openExternalUrl(url),
          );
        }}
        onMinimizeWindow={loginController.minimizeWindow}
        onMaximizeWindow={loginController.maximizeWindow}
        onRestoreWindow={loginController.restoreWindow}
        onCloseWindow={loginController.closeWindow}
      />

      <div className="relative flex-1 min-h-0">
        <HomeShell
          active={isHomeActive}
          authState={authState}
          offlineLeaseExpiryLabel={offlineLeaseExpiryLabel}
          desktopPlatform={desktopPlatform}
          homeViewModel={homeViewModel}
          containersViewModel={containersViewModel}
          modalViewModel={modalViewModel}
          loginController={loginController}
          onRequestSecretEditor={setSecretEditRequest}
        />

        <SftpShell
          active={isSftpActive}
          authState={authState}
          offlineLeaseExpiryLabel={offlineLeaseExpiryLabel}
          desktopPlatform={desktopPlatform}
          homeViewModel={homeViewModel}
          sftpViewModel={sftpViewModel}
          settingsViewModel={settingsViewModel}
          modalViewModel={modalViewModel}
          loginController={loginController}
        />

        <ContainersShell
          active={isContainersActive}
          authState={authState}
          offlineLeaseExpiryLabel={offlineLeaseExpiryLabel}
          homeViewModel={homeViewModel}
          containersViewModel={containersViewModel}
          modalViewModel={modalViewModel}
          loginController={loginController}
        />

        <SessionShell
          active={isSessionViewActive}
          authState={authState}
          offlineLeaseExpiryLabel={offlineLeaseExpiryLabel}
          prefersDark={prefersDark}
          homeViewModel={homeViewModel}
          sessionViewModel={sessionViewModel}
          settingsViewModel={settingsViewModel}
          modalViewModel={modalViewModel}
          loginController={loginController}
          draggedSession={draggedSession}
          onStartSessionDrag={setDraggedSession}
          onEndSessionDrag={() => {
            setDraggedSession(null);
          }}
        />
      </div>

      <AppModals
        hosts={homeViewModel.hosts}
        modalViewModel={modalViewModel}
        settingsViewModel={settingsViewModel}
        secretEditRequest={secretEditRequest}
        onCloseSecretEditor={() => setSecretEditRequest(null)}
        onSubmitSecretEditor={async (input) => {
          if (input.mode === 'update-shared') {
            await settingsViewModel.updateKeychainSecret(
              input.secretRef,
              input.secrets,
            );
            return;
          }
          if (!input.hostId) {
            throw new Error('대상 호스트를 선택해 주세요.');
          }
          await settingsViewModel.cloneKeychainSecretForHost(
            input.hostId,
            input.secretRef,
            input.secrets,
          );
        }}
        isUpdateInstallConfirmOpen={isUpdateInstallConfirmOpen}
        onCloseUpdateInstallConfirm={() => setIsUpdateInstallConfirmOpen(false)}
        onConfirmInstallUpdate={async () => {
          setIsUpdateInstallConfirmOpen(false);
          await loginController.installUpdateAndRestart();
        }}
      />
    </div>
  );
}
