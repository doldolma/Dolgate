import { useMemo } from 'react';
import type { AuthState } from '@shared';
import { TerminalWorkspace } from '../components/TerminalWorkspace';
import type { useLoginController } from '../controllers/useLoginController';
import { openOwnerChatWindow } from '../services/desktop/session-shares';
import type {
  useAppModalViewModel,
  useAppSettingsViewModel,
  useHomeViewModel,
  useSessionWorkspaceViewModel,
} from '../view-models/appViewModels';
import {
  resolveAdjacentTabCandidate,
  type DraggedSessionPayload,
} from './appShellUtils';
import { OfflineModeBanner } from './OfflineModeBanner';

interface SessionShellProps {
  active: boolean;
  authState: AuthState & { session: NonNullable<AuthState['session']> };
  offlineLeaseExpiryLabel: string | null;
  prefersDark: boolean;
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  sessionViewModel: ReturnType<typeof useSessionWorkspaceViewModel>;
  settingsViewModel: ReturnType<typeof useAppSettingsViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
  draggedSession: DraggedSessionPayload | null;
  onStartSessionDrag: (payload: DraggedSessionPayload) => void;
  onEndSessionDrag: () => void;
}

export function SessionShell({
  active,
  authState,
  offlineLeaseExpiryLabel,
  prefersDark,
  homeViewModel,
  sessionViewModel,
  settingsViewModel,
  modalViewModel,
  loginController,
  draggedSession,
  onStartSessionDrag,
  onEndSessionDrag,
}: SessionShellProps) {
  const activeSessionId = homeViewModel.activeWorkspaceTab.startsWith('session:')
    ? homeViewModel.activeWorkspaceTab.slice('session:'.length)
    : null;
  const activeWorkspace = homeViewModel.activeWorkspaceTab.startsWith('workspace:')
    ? sessionViewModel.workspaces.find(
        (workspace) =>
          workspace.id ===
          homeViewModel.activeWorkspaceTab.slice('workspace:'.length),
      ) ?? null
    : null;
  const sessionViewActivationKey =
    homeViewModel.activeWorkspaceTab === 'home' ||
    homeViewModel.activeWorkspaceTab === 'sftp' ||
    homeViewModel.activeWorkspaceTab === 'containers'
      ? null
      : homeViewModel.activeWorkspaceTab;
  const canDropDraggedSession = useMemo(() => {
    if (draggedSession?.source !== 'standalone-tab') {
      return false;
    }

    return Boolean(
      resolveAdjacentTabCandidate(
        sessionViewModel.tabStrip,
        sessionViewModel.workspaces,
        draggedSession.sessionId,
      ),
    );
  }, [draggedSession, sessionViewModel.tabStrip, sessionViewModel.workspaces]);

  return (
    <section className={`session-shell ${active ? 'active' : 'hidden'}`}>
      {authState.status === 'offline-authenticated' && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}
      <div className="session-shell__content">
        <TerminalWorkspace
          tabs={sessionViewModel.tabs}
          hosts={homeViewModel.hosts}
          settings={settingsViewModel.settings}
          prefersDark={prefersDark}
          activeSessionId={activeSessionId}
          activeWorkspace={activeWorkspace}
          viewActivationKey={sessionViewActivationKey}
          draggedSession={draggedSession}
          canDropDraggedSession={canDropDraggedSession}
          onCloseSession={sessionViewModel.disconnectTab}
          onRetryConnection={sessionViewModel.retrySessionConnection}
          onStartSessionShare={sessionViewModel.startSessionShare}
          onUpdateSessionShareSnapshot={sessionViewModel.updateSessionShareSnapshot}
          onSetSessionShareInputEnabled={
            sessionViewModel.setSessionShareInputEnabled
          }
          onStopSessionShare={sessionViewModel.stopSessionShare}
          onOpenSessionShareChatWindow={openOwnerChatWindow}
          onStartPaneDrag={(workspaceId, sessionId) => {
            onStartSessionDrag({
              sessionId,
              source: 'workspace-pane',
              workspaceId,
            });
          }}
          onEndSessionDrag={onEndSessionDrag}
          onSplitSessionDrop={(sessionId, direction, targetSessionId) =>
            sessionViewModel.splitSessionIntoWorkspace(
              sessionId,
              direction,
              targetSessionId,
            )
          }
          onMoveWorkspaceSession={(workspaceId, sessionId, direction, targetSessionId) =>
            sessionViewModel.moveWorkspaceSession(
              workspaceId,
              sessionId,
              direction,
              targetSessionId,
            )
          }
          onFocusWorkspaceSession={sessionViewModel.focusWorkspaceSession}
          onToggleWorkspaceBroadcast={sessionViewModel.toggleWorkspaceBroadcast}
          onResizeWorkspaceSplit={sessionViewModel.resizeWorkspaceSplit}
        />
      </div>
    </section>
  );
}
