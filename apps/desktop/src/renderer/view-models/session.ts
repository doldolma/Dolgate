import { useAppStore } from '../store/appStore';

export function useSessionWorkspaceViewModel() {
  const tabs = useAppStore((state) => state.tabs);
  const workspaces = useAppStore((state) => state.workspaces);
  const tmuxGroups = useAppStore((state) => state.tmuxGroups);
  const tabStrip = useAppStore((state) => state.tabStrip);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const activateSession = useAppStore((state) => state.activateSession);
  const activateWorkspace = useAppStore((state) => state.activateWorkspace);
  const activateTmuxGroup = useAppStore((state) => state.activateTmuxGroup);
  const selectTmuxWindow = useAppStore((state) => state.selectTmuxWindow);
  const renameTmuxWindow = useAppStore((state) => state.renameTmuxWindow);
  const killTmuxSession = useAppStore((state) => state.killTmuxSession);
  const connectHost = useAppStore((state) => state.connectHost);
  const retrySessionConnection = useAppStore((state) => state.retrySessionConnection);
  const cancelSessionReconnect = useAppStore(
    (state) => state.cancelSessionReconnect,
  );
  const startSessionShare = useAppStore((state) => state.startSessionShare);
  const updateSessionShareSnapshot = useAppStore(
    (state) => state.updateSessionShareSnapshot,
  );
  const setSessionShareInputEnabled = useAppStore(
    (state) => state.setSessionShareInputEnabled,
  );
  const stopSessionShare = useAppStore((state) => state.stopSessionShare);
  const disconnectTab = useAppStore((state) => state.disconnectTab);
  const setRdpMonitors = useAppStore(
    (state) => state.setRdpMonitors,
  );
  const closeWorkspace = useAppStore((state) => state.closeWorkspace);
  const splitSessionIntoWorkspace = useAppStore(
    (state) => state.splitSessionIntoWorkspace,
  );
  const moveWorkspaceSession = useAppStore((state) => state.moveWorkspaceSession);
  const detachSessionFromWorkspace = useAppStore(
    (state) => state.detachSessionFromWorkspace,
  );
  const reorderDynamicTab = useAppStore((state) => state.reorderDynamicTab);
  const focusWorkspaceSession = useAppStore((state) => state.focusWorkspaceSession);
  const tmuxNewWindowInWorkspace = useAppStore(
    (state) => state.tmuxNewWindowInWorkspace,
  );
  const detachTmuxWorkspace = useAppStore(
    (state) => state.detachTmuxWorkspace,
  );
  const toggleWorkspaceZoom = useAppStore((state) => state.toggleWorkspaceZoom);
  const toggleSessionBroadcast = useAppStore(
    (state) => state.toggleSessionBroadcast,
  );
  const resizeWorkspaceSplit = useAppStore((state) => state.resizeWorkspaceSplit);
  const handleSessionShareEvent = useAppStore(
    (state) => state.handleSessionShareEvent,
  );
  const handleSessionShareChatEvent = useAppStore(
    (state) => state.handleSessionShareChatEvent,
  );

  return {
    tabs,
    workspaces,
    tmuxGroups,
    tabStrip,
    activeWorkspaceTab,
    activateSession,
    activateWorkspace,
    activateTmuxGroup,
    selectTmuxWindow,
    renameTmuxWindow,
    killTmuxSession,
    connectHost,
    retrySessionConnection,
    cancelSessionReconnect,
    startSessionShare,
    updateSessionShareSnapshot,
    setSessionShareInputEnabled,
    stopSessionShare,
    disconnectTab,
    setRdpMonitors,
    closeWorkspace,
    splitSessionIntoWorkspace,
    moveWorkspaceSession,
    detachSessionFromWorkspace,
    reorderDynamicTab,
    focusWorkspaceSession,
    tmuxNewWindowInWorkspace,
    detachTmuxWorkspace,
    toggleSessionBroadcast,
    toggleWorkspaceZoom,
    resizeWorkspaceSplit,
    handleSessionShareEvent,
    handleSessionShareChatEvent,
  };
}
