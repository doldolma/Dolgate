import { openHostInNewWindow } from '../services/desktop/auth-window-updater';
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
  const snippets = useAppStore((state) => state.snippets);
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
  const activateSftp = useAppStore((state) => state.activateSftp);
  const activateContainers = useAppStore((state) => state.activateContainers);
  const openHomeSection = useAppStore((state) => state.openHomeSection);
  const openSettingsSection = useAppStore((state) => state.openSettingsSection);
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
  const setHostFavorite = useAppStore((state) => state.setHostFavorite);
  const removeHost = useAppStore((state) => state.removeHost);
  const openLocalTerminal = useAppStore((state) => state.openLocalTerminal);
  const connectHost = useAppStore((state) => state.connectHost);
  const connectSftpHost = useAppStore((state) => state.connectSftpHost);
  const openHostContainersTab = useAppStore((state) => state.openHostContainersTab);
  const savePortForward = useAppStore((state) => state.savePortForward);
  const saveDnsOverride = useAppStore((state) => state.saveDnsOverride);
  const setStaticDnsOverrideActive = useAppStore(
    (state) => state.setStaticDnsOverrideActive,
  );
  const removeDnsOverride = useAppStore((state) => state.removeDnsOverride);
  const removePortForward = useAppStore((state) => state.removePortForward);
  const saveSnippet = useAppStore((state) => state.saveSnippet);
  const removeSnippet = useAppStore((state) => state.removeSnippet);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);
  const handleCoreEvent = useAppStore((state) => state.handleCoreEvent);
  const handlePortForwardEvent = useAppStore((state) => state.handlePortForwardEvent);
  const handleActivityLogsChanged = useAppStore(
    (state) => state.handleActivityLogsChanged,
  );
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
    snippets,
    portForwardRuntimes,
    bootstrap,
    refreshHostCatalog,
    refreshSyncedWorkspaceData,
    clearSyncedWorkspaceData,
    setSearchQuery,
    activateHome,
    activateSftp,
    activateContainers,
    openHomeSection,
    openSettingsSection,
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
    setHostFavorite,
    removeHost,
    openLocalTerminal,
    connectHost,
    connectSftpHost,
    openHostContainersTab,
    savePortForward,
    saveDnsOverride,
    setStaticDnsOverrideActive,
    removeDnsOverride,
    removePortForward,
    saveSnippet,
    removeSnippet,
    startPortForward,
    stopPortForward,
    handleCoreEvent,
    handlePortForwardEvent,
    handleActivityLogsChanged,
    openHostInNewWindow,
  };
}
