import { useAppStore } from '../store/appStore';

export function useHomeViewModel() {
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const homeSection = useAppStore((state) => state.homeSection);
  const hostDrawer = useAppStore((state) => state.hostDrawer);
  const currentGroupPath = useAppStore((state) => state.currentGroupPath);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const portForwards = useAppStore((state) => state.portForwards);
  const dnsOverrides = useAppStore((state) => state.dnsOverrides);
  const portForwardRuntimes = useAppStore((state) => state.portForwardRuntimes);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refreshHostCatalog = useAppStore((state) => state.refreshHostCatalog);
  const refreshSyncedWorkspaceData = useAppStore(
    (state) => state.refreshSyncedWorkspaceData,
  );
  const clearSyncedWorkspaceData = useAppStore(
    (state) => state.clearSyncedWorkspaceData,
  );
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const activateHome = useAppStore((state) => state.activateHome);
  const openHomeSection = useAppStore((state) => state.openHomeSection);
  const openCreateHostDrawer = useAppStore((state) => state.openCreateHostDrawer);
  const openCreateSerialDrawer = useAppStore((state) => state.openCreateSerialDrawer);
  const openEditHostDrawer = useAppStore((state) => state.openEditHostDrawer);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const navigateGroup = useAppStore((state) => state.navigateGroup);
  const createGroup = useAppStore((state) => state.createGroup);
  const removeGroup = useAppStore((state) => state.removeGroup);
  const moveGroup = useAppStore((state) => state.moveGroup);
  const renameGroup = useAppStore((state) => state.renameGroup);
  const saveHost = useAppStore((state) => state.saveHost);
  const duplicateHosts = useAppStore((state) => state.duplicateHosts);
  const moveHostToGroup = useAppStore((state) => state.moveHostToGroup);
  const removeHost = useAppStore((state) => state.removeHost);
  const openLocalTerminal = useAppStore((state) => state.openLocalTerminal);
  const connectHost = useAppStore((state) => state.connectHost);
  const openHostContainersTab = useAppStore((state) => state.openHostContainersTab);
  const savePortForward = useAppStore((state) => state.savePortForward);
  const saveDnsOverride = useAppStore((state) => state.saveDnsOverride);
  const setStaticDnsOverrideActive = useAppStore(
    (state) => state.setStaticDnsOverrideActive,
  );
  const removeDnsOverride = useAppStore((state) => state.removeDnsOverride);
  const removePortForward = useAppStore((state) => state.removePortForward);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);
  const handleCoreEvent = useAppStore((state) => state.handleCoreEvent);
  const handlePortForwardEvent = useAppStore((state) => state.handlePortForwardEvent);

  return {
    hosts,
    groups,
    activeWorkspaceTab,
    homeSection,
    hostDrawer,
    currentGroupPath,
    searchQuery,
    portForwards,
    dnsOverrides,
    portForwardRuntimes,
    bootstrap,
    refreshHostCatalog,
    refreshSyncedWorkspaceData,
    clearSyncedWorkspaceData,
    setSearchQuery,
    activateHome,
    openHomeSection,
    openCreateHostDrawer,
    openCreateSerialDrawer,
    openEditHostDrawer,
    closeHostDrawer,
    navigateGroup,
    createGroup,
    removeGroup,
    moveGroup,
    renameGroup,
    saveHost,
    duplicateHosts,
    moveHostToGroup,
    removeHost,
    openLocalTerminal,
    connectHost,
    openHostContainersTab,
    savePortForward,
    saveDnsOverride,
    setStaticDnsOverrideActive,
    removeDnsOverride,
    removePortForward,
    startPortForward,
    stopPortForward,
    handleCoreEvent,
    handlePortForwardEvent,
  };
}
