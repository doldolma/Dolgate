import { useAppStore } from '../store/appStore';

export function useContainersViewModel() {
  const containerTabs = useAppStore((state) => state.containerTabs);
  const activeContainerHostId = useAppStore((state) => state.activeContainerHostId);
  const activateContainers = useAppStore((state) => state.activateContainers);
  const focusHostContainersTab = useAppStore((state) => state.focusHostContainersTab);
  const closeHostContainersTab = useAppStore((state) => state.closeHostContainersTab);
  const reorderContainerTab = useAppStore((state) => state.reorderContainerTab);
  const refreshHostContainers = useAppStore((state) => state.refreshHostContainers);
  const refreshEcsClusterUtilization = useAppStore(
    (state) => state.refreshEcsClusterUtilization,
  );
  const openEcsExecShell = useAppStore((state) => state.openEcsExecShell);
  const selectHostContainer = useAppStore((state) => state.selectHostContainer);
  const setHostContainersPanel = useAppStore((state) => state.setHostContainersPanel);
  const setHostContainerTunnelState = useAppStore(
    (state) => state.setHostContainerTunnelState,
  );
  const setEcsClusterSelectedService = useAppStore(
    (state) => state.setEcsClusterSelectedService,
  );
  const setEcsClusterActivePanel = useAppStore(
    (state) => state.setEcsClusterActivePanel,
  );
  const setEcsClusterTunnelState = useAppStore(
    (state) => state.setEcsClusterTunnelState,
  );
  const setEcsClusterLogsState = useAppStore(
    (state) => state.setEcsClusterLogsState,
  );
  const refreshHostContainerLogs = useAppStore(
    (state) => state.refreshHostContainerLogs,
  );
  const loadMoreHostContainerLogs = useAppStore(
    (state) => state.loadMoreHostContainerLogs,
  );
  const setHostContainerLogsFollow = useAppStore(
    (state) => state.setHostContainerLogsFollow,
  );
  const setHostContainerLogsSearchQuery = useAppStore(
    (state) => state.setHostContainerLogsSearchQuery,
  );
  const searchHostContainerLogs = useAppStore(
    (state) => state.searchHostContainerLogs,
  );
  const clearHostContainerLogsSearch = useAppStore(
    (state) => state.clearHostContainerLogsSearch,
  );
  const refreshHostContainerStats = useAppStore(
    (state) => state.refreshHostContainerStats,
  );
  const runHostContainerAction = useAppStore((state) => state.runHostContainerAction);
  const openHostContainerShell = useAppStore((state) => state.openHostContainerShell);
  const handleContainerConnectionProgressEvent = useAppStore(
    (state) => state.handleContainerConnectionProgressEvent,
  );

  return {
    containerTabs,
    activeContainerHostId,
    activateContainers,
    focusHostContainersTab,
    closeHostContainersTab,
    reorderContainerTab,
    refreshHostContainers,
    refreshEcsClusterUtilization,
    openEcsExecShell,
    selectHostContainer,
    setHostContainersPanel,
    setHostContainerTunnelState,
    setEcsClusterSelectedService,
    setEcsClusterActivePanel,
    setEcsClusterTunnelState,
    setEcsClusterLogsState,
    refreshHostContainerLogs,
    loadMoreHostContainerLogs,
    setHostContainerLogsFollow,
    setHostContainerLogsSearchQuery,
    searchHostContainerLogs,
    clearHostContainerLogsSearch,
    refreshHostContainerStats,
    runHostContainerAction,
    openHostContainerShell,
    handleContainerConnectionProgressEvent,
  };
}
