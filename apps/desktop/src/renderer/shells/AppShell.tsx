import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuthState, DesktopWindowState, UpdateState } from '@shared';
import { AppTitleBar } from '../components/AppTitleBar';
import { cn } from '../lib/cn';
import { useAppStore } from '../store/appStore';
import { titleBarMode } from '../components/useTitleBarAutoHide';
import {
  resolveSpreadTarget,
  useRdpMonitorSpread,
} from '../components/rdp/useRdpMonitorSpread';
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
import { SessionShareChromeButton } from '../components/terminal-workspace/SessionShareChromeButton';
import {
  type DraggedSessionPayload,
  workspaceContainsSession,
} from './appShellUtils';
import { t } from '../i18n';

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
  // 세션 패널은 상단 바의 토글로만 열린다 — 상태는 창 단위(스토어)다.
  const sessionPanelOpen = useAppStore((state) => state.sessionPanelOpen);
  const toggleSessionPanel = useAppStore((state) => state.toggleSessionPanel);

  // 전체화면 + 멀티모니터 RDP 세션이면 원격 모니터를 물리 화면마다 펼친다. 창을 여는 일은
  // 메인 프로세스가 하고, 여기서는 언제 펼칠지만 정한다.
  useRdpMonitorSpread(
    resolveSpreadTarget({
      isFullScreen: windowState.isFullScreen,
      activeWorkspaceTab: sessionViewModel.activeWorkspaceTab,
      tabs: sessionViewModel.tabs,
      monitorCountBySession: (sessionId) =>
        sessionViewModel.tabs.find((tab) => tab.sessionId === sessionId)
          ?.rdpMonitorCount ?? 0,
    }),
  );

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

  // 신뢰 물음이 떠도 탭을 옮기지 않는다.
  //
  // 그 물음은 이제 자기 판 안에서 뜬다(TerminalHostKeyTrustCard). 여기서 화면을 끌고 가면
  // 연결을 여러 개 걸었을 때 탭이 계속 튕긴다 — 사용자가 보던 것을 빼앗는다.

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
      {/* Keep the native drag region outside scroll/composited shell ancestors. Electron can
          drop nested app-region hit targets after those layers scroll or repaint. */}
      {createPortal(
        <AppTitleBar
          desktopPlatform={desktopPlatform}
          tabs={sessionViewModel.tabs}
          workspaces={sessionViewModel.workspaces}
          tmuxGroups={sessionViewModel.tmuxGroups}
          hosts={homeViewModel.hosts}
          tabStrip={sessionViewModel.tabStrip}
          activeWorkspaceTab={homeViewModel.activeWorkspaceTab}
          sessionPanelOpen={sessionPanelOpen}
          onToggleSessionPanel={toggleSessionPanel}
          renderSessionShareAction={(sessionId) => (
            <SessionShareChromeButton sessionId={sessionId} />
          )}
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
          onToggleFullScreenWindow={loginController.toggleFullScreenWindow}
          onSetRdpMonitors={(sessionId, monitors) => {
            void sessionViewModel.setRdpMonitors(sessionId, monitors);
          }}
          resolveRdpMonitors={(sessionId) => {
            const hostId = sessionViewModel.tabs.find(
              (tab) => tab.sessionId === sessionId,
            )?.hostId;
            if (!hostId) {
              return null;
            }
            // 기기 로컬 설정에 있다. 호스트 레코드는 동기화되므로 모니터 선택을 담지 않는다.
            return settingsViewModel.settings.rdpMonitorsByHostId[hostId] ?? null;
          }}
          onCloseWindow={loginController.closeWindow}
        />,
        document.body,
      )}
      {/* 헤더는 fixed 라 이 스페이서가 그 자리를 대신 차지한다. 전체화면에서는 헤더가
          위로 접히므로 스페이서도 함께 접어야 화면을 온전히 쓴다 — 안 그러면 위쪽에
          아무것도 없는 띠가 남는다. */}
      <div
        aria-hidden
        className={cn(
          'flex-none transition-[height] duration-150',
          titleBarMode(windowState.isFullScreen, desktopPlatform) === 'visible'
            ? 'h-[2.95rem]'
            : 'h-0',
        )}
      />

      {/* 탭 아래 내용 영역. 원격 화면도 여기에 들어간다 — 접속할 때 이 크기로 붙어야 화면이
          뜨는 순간부터 창에 맞는다. 홈에서 원격을 열 때도 이 요소는 이미 있으므로 잴 수 있다. */}
      <div className="relative flex-1 min-h-0" data-rdp-viewport="">
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
              input.label,
            );
            return;
          }
          if (!input.hostId) {
            throw new Error(t('appShell.selectTargetHost'));
          }
          await settingsViewModel.cloneKeychainSecretForHost(
            input.hostId,
            input.secretRef,
            input.secrets,
            input.label,
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
