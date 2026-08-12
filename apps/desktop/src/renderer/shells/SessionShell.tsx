import { useMemo } from 'react';
import { isSplittablePaneKind, type AuthState } from '@shared';
import { TerminalWorkspace } from '../components/TerminalWorkspace';
import { TmuxWindowBar } from '../components/terminal-workspace/TmuxWindowBar';
import { TerminalHostStatusBar } from '../components/terminal-workspace/TerminalHostStatusBar';
import { listWorkspaceSessionIds } from '../components/terminal-workspace/terminalWorkspaceLayout';
import { useHostMetrics } from '../controllers/useHostMetrics';
import { useAppStore } from '../store/appStore';
import { TmuxSessionFooter } from '../components/terminal-workspace/TmuxSessionFooter';
import { statusBarStack } from '../components/terminal-workspace/terminalStatusBarChrome';
import { TmuxCommandPrompt } from '../components/terminal-workspace/TmuxCommandPrompt';
import { TerminalTransferToastRegion } from '../components/TerminalTransferToastRegion';
import type { useLoginController } from '../controllers/useLoginController';
import { openOwnerChatWindow } from '../services/desktop/session-shares';
import { refreshTmuxSessions } from '../services/desktop/terminal';
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
  const activeTabId = homeViewModel.activeWorkspaceTab;
  const activeSessionId = activeTabId.startsWith('session:')
    ? activeTabId.slice('session:'.length)
    : null;
  // tmuxgrp: 탭이면 그룹을 직접 찾는다.
  const groupFromTab = activeTabId.startsWith('tmuxgrp:')
    ? sessionViewModel.tmuxGroups.find(
        (group) => group.id === activeTabId.slice('tmuxgrp:'.length),
      ) ?? null
    : null;
  // workspace: 탭이 가리키는 워크스페이스(있다면).
  const workspaceFromTab = activeTabId.startsWith('workspace:')
    ? sessionViewModel.workspaces.find(
        (workspace) => workspace.id === activeTabId.slice('workspace:'.length),
      ) ?? null
    : null;
  // tmux 세션 그룹: tmuxgrp: 탭에서 직접 얻거나, workspace: 탭이 tmux 윈도우면 그
  // controlSessionId 로 도출한다(activeWorkspaceTab 이 workspace: 든 tmuxgrp: 든 윈도우
  // 바가 항상 뜨도록 — pane 이 보이는데 바가 안 뜨는 일이 없게).
  const activeTmuxGroup =
    groupFromTab ??
    (workspaceFromTab?.tmux
      ? sessionViewModel.tmuxGroups.find(
          (group) =>
            group.controlSessionId === workspaceFromTab.tmux?.controlSessionId,
        ) ?? null
      : null);
  // 활성 워크스페이스: tmux 면 그룹의 activeWorkspaceId 를 단일 진실원으로 삼아
  // (activeWorkspaceTab 이 어쩌다 workspace: 여도) 윈도우 바 강조와 보이는 화면을
  // 일치시킨다. 비-tmux 면 workspace: 탭의 워크스페이스를 그대로 쓴다.
  const activeWorkspace = activeTmuxGroup
    ? sessionViewModel.workspaces.find(
        (workspace) => workspace.id === activeTmuxGroup.activeWorkspaceId,
      ) ?? null
    : workspaceFromTab;
  // tmux 그룹의 자원바는 pane 이 아니라 여기 하단에서 한 번만 그린다(pane 쪽은 enabled 를
  // 끈다). 샘플링 대상 세션은 레이아웃 순서상 첫 pane 으로 고정한다 — 활성 pane 을 따라가면
  // 포커스를 옮길 때마다 sessionId 가 바뀌고, 훅이 차분 기준을 버려서 NET·DISK 가 매번
  // 깜빡인다. 같은 그룹이면 어느 pane 이든 호스트가 같으므로 고정해도 값은 동일하다.
  const hostMetricsEnabled = useAppStore(
    (state) => state.settings?.hostMetricsEnabled ?? false,
  );
  const tmuxMetricsSessionId =
    activeTmuxGroup && activeWorkspace
      ? listWorkspaceSessionIds(activeWorkspace.layout)[0] ?? null
      : null;
  const tmuxMetricsTab = tmuxMetricsSessionId
    ? sessionViewModel.tabs.find((tab) => tab.sessionId === tmuxMetricsSessionId)
    : undefined;
  const tmuxHostMetrics = useHostMetrics({
    sessionId: tmuxMetricsSessionId,
    enabled:
      hostMetricsEnabled &&
      tmuxMetricsTab?.source === 'host' &&
      tmuxMetricsTab?.status === 'connected',
    visible: active,
  });
  // 그룹의 윈도우 목록(같은 control 세션) — index 순 정렬, 윈도우 바에 표시.
  const tmuxWindows = activeTmuxGroup
    ? sessionViewModel.workspaces
        .filter(
          (workspace) =>
            workspace.tmux?.controlSessionId ===
            activeTmuxGroup.controlSessionId,
        )
        .sort((a, b) => (a.tmux?.index ?? 0) - (b.tmux?.index ?? 0))
    : [];
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
    // 원격 화면(RDP·VNC)은 분할에 참여하지 않는다. **끌고 있는 쪽에서 먼저 막는다** — 여기서
    // 걸러야 드롭 안내선이 아예 뜨지 않는다(안내선을 보여주고 아무 일도 안 하면 고장으로 보인다).
    const dragged = sessionViewModel.tabs.find(
      (tab) => tab.sessionId === draggedSession.sessionId,
    );
    if (!isSplittablePaneKind(dragged?.paneKind)) {
      return false;
    }

    const candidate = resolveAdjacentTabCandidate(
      sessionViewModel.tabStrip,
      sessionViewModel.workspaces,
      draggedSession.sessionId,
    );
    if (!candidate) {
      return false;
    }
    // 받는 쪽도 본다. SSH 탭을 VNC 탭 위로 끌면 그 분할 안에 원격 화면이 들어간다.
    if (candidate.kind === 'session') {
      const target = sessionViewModel.tabs.find(
        (tab) => tab.sessionId === candidate.sessionId,
      );
      return isSplittablePaneKind(target?.paneKind);
    }
    return true;
  }, [
    draggedSession,
    sessionViewModel.tabs,
    sessionViewModel.tabStrip,
    sessionViewModel.workspaces,
  ]);

  const workspaceEl = (
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
      onCancelReconnect={sessionViewModel.cancelSessionReconnect}
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
      onMoveWorkspaceSession={(
        workspaceId,
        sessionId,
        direction,
        targetSessionId,
      ) =>
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
  );

  return (
    <section
      className={
        active
          ? 'absolute inset-0 flex min-h-0 flex-col gap-4 opacity-100 pointer-events-auto transition-[opacity,transform] duration-180 scale-100'
          : 'absolute inset-0 flex min-h-0 flex-col gap-4 opacity-0 pointer-events-none transition-[opacity,transform] duration-180 scale-[0.995]'
      }
    >
      {authState.status === 'offline-authenticated' && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}
      {/*
        workspaceEl(=TerminalWorkspace)을 항상 동일한 트리 위치(아래 flex-col 의
        가운데 자식)에 둔다. tmux 세션 탭을 드나들며 activeTmuxGroup 이 토글돼도
        workspaceEl 이 다른 위치로 이동/remount 되지 않아야 — 그래야 모든 터미널이
        keep-mounted 되고, dispose 된 터미널의 큐잉된 resize 태스크가 xterm
        IdleTaskQueue 에서 크래시(handleResize undefined)하지 않는다. 윈도우 바/푸터는
        조건부 형제로만 끼운다(워크스페이스 위치는 불변).
      */}
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTmuxGroup ? (
          <TmuxWindowBar
            windows={tmuxWindows}
            activeWorkspaceId={activeTmuxGroup.activeWorkspaceId}
            onSelect={sessionViewModel.selectTmuxWindow}
            onNewWindow={() => {
              if (activeWorkspace) {
                sessionViewModel.tmuxNewWindowInWorkspace(activeWorkspace.id);
              }
            }}
            onClose={(workspaceId) => {
              void sessionViewModel.closeWorkspace(workspaceId);
            }}
            onRename={sessionViewModel.renameTmuxWindow}
            onSplitHorizontal={() => {
              if (activeWorkspace) {
                sessionViewModel.splitSessionIntoWorkspace(
                  activeWorkspace.activeSessionId,
                  'right',
                );
              }
            }}
            onSplitVertical={() => {
              if (activeWorkspace) {
                sessionViewModel.splitSessionIntoWorkspace(
                  activeWorkspace.activeSessionId,
                  'bottom',
                );
              }
            }}
          />
        ) : null}
        <div className="relative min-h-0 flex-1">
          {workspaceEl}
          <TerminalTransferToastRegion />
          <TmuxCommandPrompt />
        </div>
        {/* tmux 그룹의 하단 바는 pane 바깥에 붙지만, pane 안쪽(TerminalSessionPane)과
            같은 statusBarStack 으로 감싼다 — 컨테이너가 갈리면 같은 바가 연결 방식에
            따라 다른 간격으로 놓여 "tmux 와 ssh 의 UI 가 다르다"로 보인다. */}
        {activeTmuxGroup ? (
          <div className={statusBarStack}>
            <TerminalHostStatusBar
              status={tmuxHostMetrics.status}
              metrics={tmuxHostMetrics.metrics}
              onRetry={tmuxHostMetrics.retry}
            />
            <TmuxSessionFooter
              sessionName={activeTmuxGroup.sessionName}
              sessions={activeTmuxGroup.sessions ?? []}
              onCreateSession={(name) => {
                const hostId = activeTmuxGroup.hostId;
                if (!hostId) {
                  return;
                }
                // 새 세션 = 새 그룹 탭(replaceSessionId 없음 — 현재 tmux 유지). strict new.
                const quoted = `'${name.replace(/'/g, "'\\''")}'`;
                void sessionViewModel.connectHost(
                  hostId,
                  120,
                  32,
                  undefined,
                  true,
                  `tmux -CC new-session -s ${quoted}`,
                  undefined,
                  undefined,
                  activeTmuxGroup.tmuxVersion ?? undefined,
                );
              }}
              onSelectSession={(name) => {
                const hostId = activeTmuxGroup.hostId;
                if (!hostId) {
                  return;
                }
                // 다른 세션 전환 = 새 그룹 탭으로 attach(현재 세션 유지).
                const quoted = `'${name.replace(/'/g, "'\\''")}'`;
                void sessionViewModel.connectHost(
                  hostId,
                  120,
                  32,
                  undefined,
                  true,
                  `tmux -CC attach -t ${quoted}`,
                  undefined,
                  undefined,
                  activeTmuxGroup.tmuxVersion ?? undefined,
                );
              }}
              onKillSession={(name) => {
                if (activeWorkspace) {
                  sessionViewModel.killTmuxSession(
                    activeWorkspace.activeSessionId,
                    name,
                  );
                }
              }}
              onDetach={() => {
                if (activeWorkspace) {
                  void sessionViewModel.detachTmuxWorkspace(activeWorkspace.id);
                }
              }}
              onRefresh={() => {
                if (activeWorkspace) {
                  // 드롭다운 열 때 세션 목록 즉시 재조회(다른 SSH 연결의 새 세션 반영).
                  void refreshTmuxSessions(activeWorkspace.activeSessionId);
                }
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
