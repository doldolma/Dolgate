import type { SliceDeps } from "../services/context";
import type { CatalogSlice } from "../types";
import * as defaults from "../defaults";
import * as utils from "../utils";
import { createBootstrapSyncServices } from "../services/bootstrap-sync";

export function createCatalogSlice(deps: SliceDeps): CatalogSlice {
  const { api, set, get } = deps;
  const services = createBootstrapSyncServices(deps);
  const {
    AWS_SFTP_DEFAULT_PORT,
    DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
    getAwsEc2HostSftpDisabledReason,
    getAwsEc2HostSshPort,
    getParentGroupPath,
    isAwsEc2HostRecord,
    isAwsEcsHostRecord,
    isLinkedDnsOverrideRecord,
    isSshHostDraft,
    isGroupWithinPath,
    isSshHostRecord,
    isWarpgateSshHostRecord,
    normalizeGroupPath,
    stripRemovedGroupSegment,
    mergeContainerLogLines,
    normalizeRemoteInvokeErrorMessage,
    normalizeErrorMessage,
    isAwsSsoAuthenticationErrorMessage,
    arePortForwardRuntimeRecordsEqual,
    areEcsTunnelTabStatesEqual,
    areContainerTunnelTabStatesEqual,
    normalizeContainerTunnelTabStateForPersistence,
    normalizeHomeSectionInput,
    detectRendererPlatform,
    resolveRendererDefaultTerminalFontFamily,
    defaultSettings,
    createEmptyPane,
    isPendingSessionInteractiveAuth,
    isPendingSftpInteractiveAuth,
    isPendingContainersInteractiveAuth,
    isPendingPortForwardInteractiveAuth,
    resolveSftpPaneIdByEndpoint,
    resolveContainersHostIdByEndpoint,
    createContainerConnectionProgress,
    buildSftpHostPickerPane,
    defaultSftpState,
    sortHosts,
    toHostDraft,
    findSshHostMissingUsername,
    getDuplicateHostBaseLabel,
    buildDuplicateHostLabel,
    normalizeTagValue,
    matchesSelectedTags,
    hasProvidedSecrets,
    sortGroups,
    sortPortForwards,
    sortDnsOverrides,
    sortKnownHosts,
    sortLogs,
    sortKeychainEntries,
    asSessionTabId,
    asWorkspaceTabId,
    buildContainersEndpointId,
    buildContainersTabTitle,
    DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
    CONTAINER_LOGS_TAIL_INCREMENT,
    MAX_CONTAINER_LOGS_TAIL_WINDOW,
    MAX_CONTAINER_METRICS_SAMPLES,
    ECS_UTILIZATION_HISTORY_WINDOW_MS,
    classifyContainerLogsErrorMessage,
    trimContainerMetricsSamples,
    createEmptyContainersTabState,
    clearEcsServiceUtilization,
    mergeEcsClusterUtilizationSnapshot,
    createEcsUtilizationHistoryState,
    mergeMetricHistory,
    mergeEcsUtilizationHistoryState,
    upsertContainersTab,
    resolveNextContainerHostId,
    createWorkspaceLeaf,
    directionAxis,
    createWorkspaceSplit,
    listWorkspaceSessionIds,
    countWorkspaceSessions,
    findFirstWorkspaceSessionId,
    insertSessionIntoWorkspaceLayout,
    removeSessionFromWorkspaceLayout,
    moveSessionWithinWorkspaceLayout,
    updateWorkspaceSplitRatio,
    buildSessionTitle,
    PENDING_SESSION_PREFIX,
    createPendingSessionId,
    isPendingSessionId,
    createConnectionProgress,
    createInactiveSessionShareState,
    normalizeSessionShareState,
    setSessionShareState,
    clearSessionShareChatNotifications,
    appendSessionShareChatNotification,
    dismissSessionShareChatNotification,
    createPendingSessionTab,
    findPendingConnectionAttempt,
    findPendingConnectionAttemptByHost,
    isPendingEcsShellAttempt,
    normalizeEcsExecShellPermissionMessage,
    replaceSessionIdInLayout,
    replaceSessionReferencesInState,
    removeSessionFromState,
    activateSessionContextInState,
    buildWorkspaceTitle,
    resolveNextVisibleTab,
    resolveAdjacentTarget,
    dynamicTabMatches,
    findContainersTab,
    parentPath,
    resolveCurrentGroupPathAfterGroupRemoval,
    resolveCredentialRetryKind,
    shouldPromptAwsSftpConfigRetry,
    resolveHostKeyCheckProgress,
    resolveAwaitingHostTrustProgress,
    resolveConnectingProgress,
    resolveLocalStartingProgress,
    resolveWaitingShellProgress,
    resolveLocalWaitingShellProgress,
    resolveCredentialRetryProgress,
    resolveErrorProgress,
    normalizeInteractiveText,
    parseWarpgateApprovalUrl,
    parseWarpgateAuthCode,
    isWarpgateCompletionPrompt,
    isWarpgateCodePrompt,
    shouldTreatAsWarpgate,
    resolveInteractiveAuthUiState,
    buildInteractiveBrowserChallengeKey,
    upsertTransferJob,
    upsertForwardRuntime,
    basenameFromPath,
    resolveSftpVisibleEntryPaths,
    resolveNextSftpSelection,
    resolveTransferItemsFromPane,
    isBrowsableSftpPane,
    pushHistory,
    getPane,
    updatePaneState,
    toTrustInput,
  } = { ...defaults, ...utils };

  const {
    syncOperationalData,
    syncSyncedWorkspaceData,
    refreshHostAndKeychainState,
  } = services;

  return {
    hosts: [],
    groups: [],
    activeWorkspaceTab: "home",
    homeSection: "hosts",
    settingsSection: "general",
    hostDrawer: { mode: "closed" },
    currentGroupPath: null,
    searchQuery: "",
    selectedHostTags: [],
    isReady: false,
    setSearchQuery: (value) => set({ searchQuery: value }),
    toggleHostTag: (tag) =>
            set((state) => {
              const key = normalizeTagValue(tag);
              const alreadySelected = state.selectedHostTags.some(
                (value) => normalizeTagValue(value) === key,
              );
              return {
                selectedHostTags: alreadySelected
                  ? state.selectedHostTags.filter(
                      (value) => normalizeTagValue(value) !== key,
                    )
                  : [...state.selectedHostTags, tag],
              };
            }),
    clearHostTagFilter: () => set({ selectedHostTags: [] }),
    activateHome: () => set({ activeWorkspaceTab: "home" }),
    activateSftp: () => set({ activeWorkspaceTab: "sftp" }),
    activateSession: (sessionId) =>
            set({ activeWorkspaceTab: asSessionTabId(sessionId) }),
    activateWorkspace: (workspaceId) =>
            set({ activeWorkspaceTab: asWorkspaceTabId(workspaceId) }),
    activateContainers: () =>
            set((state) => ({
              activeWorkspaceTab: "containers",
              activeContainerHostId:
                state.activeContainerHostId ?? state.containerTabs[0]?.hostId ?? null,
            })),
    focusHostContainersTab: (hostId) =>
            set((state) => {
              if (!state.containerTabs.some((tab) => tab.hostId === hostId)) {
                return state;
              }
              return {
                activeWorkspaceTab: "containers",
                activeContainerHostId: hostId,
              };
            }),
    openHomeSection: (section) =>
            set((state) => {
              const nextSection = normalizeHomeSectionInput(section);
              return {
                activeWorkspaceTab: "home",
                homeSection: nextSection.homeSection,
                settingsSection:
                  nextSection.homeSection === "settings"
                    ? (nextSection.settingsSection ?? state.settingsSection)
                    : state.settingsSection,
                hostDrawer:
                  nextSection.homeSection === "hosts"
                    ? get().hostDrawer
                    : { mode: "closed" },
              };
            }),
    openSettingsSection: (section) =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "settings",
              settingsSection: section,
              hostDrawer: { mode: "closed" },
            }),
    openCreateHostDrawer: () =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              hostDrawer: {
                mode: "create",
                defaultGroupPath: get().currentGroupPath,
              },
            }),
    openEditHostDrawer: (hostId) =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              hostDrawer: { mode: "edit", hostId },
            }),
    closeHostDrawer: () => set({ hostDrawer: { mode: "closed" } }),
    navigateGroup: (path) =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              currentGroupPath: normalizeGroupPath(path),
              hostDrawer: { mode: "closed" },
            }),
    bootstrap: async () => {
            const snapshot = await api.bootstrap.getInitialSnapshot();
            set({
              hosts: sortHosts(snapshot.hosts),
              groups: sortGroups(snapshot.groups),
              tabs: snapshot.tabs.map((tab) => ({
                ...tab,
                sessionShare: normalizeSessionShareState(tab.sessionShare),
                hasReceivedOutput:
                  tab.status === "connected"
                    ? true
                    : (tab.hasReceivedOutput ?? false),
              })),
              workspaces: [],
              tabStrip: snapshot.tabs.map((tab) => ({
                kind: "session" as const,
                sessionId: tab.sessionId,
              })),
              portForwards: sortPortForwards(snapshot.portForwardSnapshot.rules),
              dnsOverrides: sortDnsOverrides(snapshot.dnsOverrides),
              portForwardRuntimes: snapshot.portForwardSnapshot.runtimes,
              knownHosts: sortKnownHosts(snapshot.knownHosts),
              activityLogs: sortLogs(snapshot.activityLogs),
              keychainEntries: sortKeychainEntries(snapshot.keychainEntries),
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              settingsSection: "general",
              hostDrawer: { mode: "closed" },
              currentGroupPath: null,
              selectedHostTags: [],
              settings: snapshot.settings,
              isReady: true,
              pendingHostKeyPrompt: null,
              pendingCredentialRetry: null,
              pendingAwsSftpConfigRetry: null,
              pendingMissingUsernamePrompt: null,
              pendingInteractiveAuth: null,
              pendingConnectionAttempts: [],
              sftp: {
                localHomePath: snapshot.localHomePath,
                leftPane: {
                  ...createEmptyPane("left"),
                  sourceKind: "local",
                  currentPath: snapshot.localHomeListing.path,
                  lastLocalPath: snapshot.localHomeListing.path,
                  history: [snapshot.localHomeListing.path],
                  historyIndex: 0,
                  entries: snapshot.localHomeListing.entries,
                  warningMessages: snapshot.localHomeListing.warnings ?? [],
                },
                rightPane: createEmptyPane("right"),
                transfers: [],
                pendingConflictDialog: null,
              },
            });
          },
    refreshHostCatalog: async () => {
            const [nextHosts, nextGroups, nextKeychainEntries] = await Promise.all([
              api.hosts.list(),
              api.groups.list(),
              api.keychain.list(),
            ]);
            set({
              hosts: sortHosts(nextHosts),
              groups: sortGroups(nextGroups),
              keychainEntries: sortKeychainEntries(nextKeychainEntries),
            });
          },
    refreshOperationalData: async () => {
            await syncOperationalData(set);
          },
    refreshSyncedWorkspaceData: async () => {
            await syncSyncedWorkspaceData(set);
          },
    clearSyncedWorkspaceData: () =>
            set({
              hosts: [],
              groups: [],
              portForwards: [],
              dnsOverrides: [],
              portForwardRuntimes: [],
              knownHosts: [],
              keychainEntries: [],
            }),
    createGroup: async (name) => {
            const next = await api.groups.create(name, get().currentGroupPath);
            set((state) => ({
              groups: sortGroups([
                ...state.groups.filter((group) => group.id !== next.id),
                next,
              ]),
            }));
          },
    removeGroup: async (path, mode) => {
            const result = await api.groups.remove(path, mode);
            set((state) => ({
              groups: sortGroups(result.groups),
              hosts: sortHosts(result.hosts),
              currentGroupPath: resolveCurrentGroupPathAfterGroupRemoval(
                state.currentGroupPath,
                path,
                mode,
              ),
            }));
          },
    saveHost: async (hostId, draft, secrets) => {
            const next = hostId
              ? await api.hosts.update(hostId, draft, secrets)
              : await api.hosts.create(draft, secrets);
            set({
              hosts: sortHosts([
                ...get().hosts.filter((host) => host.id !== next.id),
                next,
              ]),
              hostDrawer: { mode: "edit", hostId: next.id },
            });
            await refreshHostAndKeychainState(set);
            await syncOperationalData(set);
          },
    duplicateHosts: async (hostIds) => {
            if (hostIds.length === 0) {
              return;
            }
    
            let workingHosts = get().hosts;
            let didCreate = false;
            for (const hostId of hostIds) {
              const current = workingHosts.find((host) => host.id === hostId);
              if (!current) {
                continue;
              }
    
              const next = await api.hosts.create(
                toHostDraft(current, buildDuplicateHostLabel(current, workingHosts)),
              );
              workingHosts = sortHosts([
                ...workingHosts.filter((host) => host.id !== next.id),
                next,
              ]);
              didCreate = true;
            }
    
            if (!didCreate) {
              return;
            }
    
            set({
              hosts: workingHosts,
            });
            await syncOperationalData(set);
          },
    moveHostToGroup: async (hostId, groupPath) => {
            const current = get().hosts.find((host) => host.id === hostId);
            if (!current) {
              return;
            }
    
            const next = await api.hosts.update(hostId, {
              ...toHostDraft(current, current.label),
              groupName: groupPath,
            });
    
            set((state) => ({
              hosts: sortHosts([
                ...state.hosts.filter((host) => host.id !== next.id),
                next,
              ]),
            }));
            await syncOperationalData(set);
          },
    removeHost: async (hostId) => {
            await api.hosts.remove(hostId);
            const currentDrawer = get().hostDrawer;
            set({
              hosts: get().hosts.filter((host) => host.id !== hostId),
              pendingMissingUsernamePrompt:
                get().pendingMissingUsernamePrompt?.hostId === hostId
                  ? null
                  : get().pendingMissingUsernamePrompt,
              hostDrawer:
                currentDrawer.mode === "edit" && currentDrawer.hostId === hostId
                  ? { mode: "closed" }
                  : currentDrawer,
            });
            await syncOperationalData(set);
          }
  };

}
