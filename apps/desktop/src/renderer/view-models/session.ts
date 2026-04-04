import { useAppStore } from '../store/appStore';

export function useSessionWorkspaceViewModel() {
  const tabs = useAppStore((state) => state.tabs);
  const workspaces = useAppStore((state) => state.workspaces);
  const tabStrip = useAppStore((state) => state.tabStrip);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const activateSession = useAppStore((state) => state.activateSession);
  const activateWorkspace = useAppStore((state) => state.activateWorkspace);
  const retrySessionConnection = useAppStore((state) => state.retrySessionConnection);
  const startSessionShare = useAppStore((state) => state.startSessionShare);
  const updateSessionShareSnapshot = useAppStore(
    (state) => state.updateSessionShareSnapshot,
  );
  const setSessionShareInputEnabled = useAppStore(
    (state) => state.setSessionShareInputEnabled,
  );
  const stopSessionShare = useAppStore((state) => state.stopSessionShare);
  const disconnectTab = useAppStore((state) => state.disconnectTab);
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
  const toggleWorkspaceBroadcast = useAppStore(
    (state) => state.toggleWorkspaceBroadcast,
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
    tabStrip,
    activeWorkspaceTab,
    activateSession,
    activateWorkspace,
    retrySessionConnection,
    startSessionShare,
    updateSessionShareSnapshot,
    setSessionShareInputEnabled,
    stopSessionShare,
    disconnectTab,
    closeWorkspace,
    splitSessionIntoWorkspace,
    moveWorkspaceSession,
    detachSessionFromWorkspace,
    reorderDynamicTab,
    focusWorkspaceSession,
    toggleWorkspaceBroadcast,
    resizeWorkspaceSplit,
    handleSessionShareEvent,
    handleSessionShareChatEvent,
  };
}
