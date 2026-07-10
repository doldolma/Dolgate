import { useEffect, useMemo, useState } from 'react';
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

  // 끌던 pane 헤더가 drop 전에 unmount 되면(드래그 중 세션 종료 등) 그 노드의 onDragEnd 가
  // 오지 않아 draggedSession 이 영구히 남고, titlebar 탭 영역이 no-drag 로 고착돼 창 드래그가
  // 먹통이 된다(AppTitleBar 의 isTabDragging 워치독과 같은 병). document 레벨 dragend/drop 과
  // window blur 로 확실히 리셋한다 — drop 핸들러들이 먼저 실행된 뒤 도달하므로 중복 clear 는 무해.
  useEffect(() => {
    if (!draggedSession) {
      return;
    }
    const reset = () => setDraggedSession(null);
    document.addEventListener('dragend', reset);
    document.addEventListener('drop', reset);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('dragend', reset);
      document.removeEventListener('drop', reset);
      window.removeEventListener('blur', reset);
    };
  }, [draggedSession]);

  const [isUpdateInstallConfirmOpen, setIsUpdateInstallConfirmOpen] =
    useState(false);
  const [secretEditRequest, setSecretEditRequest] =
    useState<SecretEditDialogRequest | null>(null);

  const isHomeActive = homeViewModel.activeWorkspaceTab === 'home';
  const isSftpActive = homeViewModel.activeWorkspaceTab === 'sftp';
  const isContainersActive = homeViewModel.activeWorkspaceTab === 'containers';
  const isSessionViewActive =
    !isHomeActive && !isSftpActive && !isContainersActive;
  const hasActiveTransfers = sftpViewModel.transfers.some(
    (job) =>
      job.status === 'queued' ||
      job.status === 'running' ||
      job.status === 'cancelling',
  );
  const hasActivePortForwards = homeViewModel.portForwardRuntimes.some(
    (runtime) => runtime.status === 'starting' || runtime.status === 'running',
  );
  const hasBlockingUpdateInstall =
    sessionViewModel.tabs.length > 0 ||
    hasActiveTransfers ||
    hasActivePortForwards;

  // tmux 조작은 tmux 표준 프리픽스(Ctrl-b, useTerminalSessionViewController)와
  // 윈도우 바/pane 분할 버튼으로 한다. 혼란을 주던 전역 Cmd-T/Cmd-D 단축키는 제거했다.

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
    <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--shell-background)]">
      <AppTitleBar
        desktopPlatform={desktopPlatform}
        tabs={sessionViewModel.tabs}
        workspaces={sessionViewModel.workspaces}
        tmuxGroups={sessionViewModel.tmuxGroups}
        hosts={homeViewModel.hosts}
        tabStrip={sessionViewModel.tabStrip}
        activeWorkspaceTab={homeViewModel.activeWorkspaceTab}
        draggedSession={draggedSession}
        updateState={updateState}
        windowState={windowState}
        onSelectHome={homeViewModel.activateHome}
        onSelectSftp={sftpViewModel.activateSftp}
        onSelectContainers={containersViewModel.activateContainers}
        hasOpenContainers={containersViewModel.containerTabs.length > 0}
        onSelectSession={sessionViewModel.activateSession}
        onSelectWorkspace={sessionViewModel.activateWorkspace}
        onCloseSession={sessionViewModel.disconnectTab}
        onCloseWorkspace={sessionViewModel.closeWorkspace}
        onSelectTmuxGroup={sessionViewModel.activateTmuxGroup}
        onCloseTmuxGroup={(tmuxGroupId) => {
          const group = sessionViewModel.tmuxGroups.find(
            (item) => item.id === tmuxGroupId,
          );
          if (group) {
            void sessionViewModel.detachTmuxWorkspace(group.activeWorkspaceId);
          }
        }}
        onNewTmuxWindow={sessionViewModel.tmuxNewWindowInWorkspace}
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
