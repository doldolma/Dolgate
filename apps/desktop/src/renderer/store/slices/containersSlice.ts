import type { SliceDeps } from "../services/context";
import type { ContainersSlice } from "../types";
import * as defaults from "../defaults";
import * as utils from "../utils";
import { createContainersServices } from "../services/containers";

export function createContainersSlice(deps: SliceDeps): ContainersSlice {
  const { api, set, get } = deps;
  const services = createContainersServices(deps);
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
    updateSessionProgress,
    promptForMissingUsername,
    loadContainerDetails,
    loadEcsClusterUtilization,
    loadEcsClusterSnapshot,
    loadContainersList,
    loadContainerLogs,
    loadContainerStats,
    searchContainerLogs,
    runContainerAction,
    startPendingContainerShellConnect,
    startPendingEcsExecShellConnect,
    createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell,
    ensureTrustedHost,
  } = services;

  return {
    containerTabs: [],
    activeContainerHostId: null,
    openHostContainersTab: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host) {
              return;
            }
            if (isAwsEcsHostRecord(host)) {
              set((state) => {
                const existingTab = findContainersTab(state, hostId);
                const nextTab = {
                  ...(existingTab ?? createEmptyContainersTabState(host)),
                  kind: "ecs-cluster" as const,
                  title: buildContainersTabTitle(host),
                  isLoading: true,
                  errorMessage: undefined,
                };
                return {
                  activeWorkspaceTab: "containers",
                  activeContainerHostId: hostId,
                  homeSection: "hosts",
                  hostDrawer: { mode: "closed" },
                  containerTabs: upsertContainersTab(state.containerTabs, nextTab),
                };
              });
              await loadEcsClusterSnapshot(set, get, hostId);
              return;
            }
            if (
              promptForMissingUsername(set, get, {
                hostId,
                source: "containers",
              })
            ) {
              return;
            }
            set((state) => {
              const existingTab = findContainersTab(state, hostId);
              const nextTab = {
                ...(existingTab ?? createEmptyContainersTabState(host)),
                title: buildContainersTabTitle(host),
                isLoading: true,
                connectionProgress: createContainerConnectionProgress(
                  hostId,
                  buildContainersEndpointId(hostId),
                  "probing-host-key",
                  `${host.label} 호스트 키를 확인하는 중입니다.`,
                ),
                errorMessage: undefined,
              };
              return {
                activeWorkspaceTab: "containers",
                activeContainerHostId: hostId,
                homeSection: "hosts",
                hostDrawer: { mode: "closed" },
                containerTabs: upsertContainersTab(state.containerTabs, nextTab),
              };
            });
    
            const trusted = await ensureTrustedHost(set, {
              hostId,
              endpointId: buildContainersEndpointId(hostId),
              action: {
                kind: "containers",
                hostId,
              },
            });
            if (!trusted) {
              set((state) => {
                const currentTab = findContainersTab(state, hostId);
                if (!currentTab) {
                  return state;
                }
                return {
                  containerTabs: upsertContainersTab(state.containerTabs, {
                    ...currentTab,
                    isLoading: false,
                    connectionProgress: null,
                  }),
                };
              });
              return;
            }
    
            await loadContainersList(set, get, hostId);
          },
    closeHostContainersTab: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            const currentTab = findContainersTab(get(), hostId);
            if (host && isAwsEcsHostRecord(host)) {
              const runtimeIds = new Set(
                Object.values(currentTab?.ecsTunnelStatesByServiceName ?? {})
                  .map((state) => state.runtime?.ruleId)
                  .filter((runtimeId): runtimeId is string => Boolean(runtimeId)),
              );
              for (const runtimeId of runtimeIds) {
                await api.aws.stopEcsServiceTunnel(runtimeId).catch(() => undefined);
              }
            } else {
              const runtimeIds = new Set(
                Object.values(currentTab?.containerTunnelStatesByContainerId ?? {})
                  .map((state) => state.runtime?.ruleId)
                  .filter((runtimeId): runtimeId is string => Boolean(runtimeId)),
              );
              for (const runtimeId of runtimeIds) {
                await api.containers.stopTunnel(runtimeId).catch(() => undefined);
              }
              await api.containers.release(hostId).catch(() => undefined);
            }
            set((state) => {
              const nextActiveContainerHostId =
                state.activeContainerHostId === hostId
                  ? resolveNextContainerHostId(state.containerTabs, hostId)
                  : state.activeContainerHostId;
              return {
                containerTabs: state.containerTabs.filter(
                  (tab) => tab.hostId !== hostId,
                ),
                activeContainerHostId: nextActiveContainerHostId,
                pendingInteractiveAuth:
                  isPendingContainersInteractiveAuth(state.pendingInteractiveAuth) &&
                  state.pendingInteractiveAuth.hostId === hostId
                    ? null
                    : state.pendingInteractiveAuth,
              };
            });
          },
    reorderContainerTab: (sourceHostId, targetHostId, placement) => {
            if (sourceHostId === targetHostId) {
              return;
            }
            set((state) => {
              const sourceIndex = state.containerTabs.findIndex(
                (tab) => tab.hostId === sourceHostId,
              );
              const targetIndex = state.containerTabs.findIndex(
                (tab) => tab.hostId === targetHostId,
              );
              if (
                sourceIndex < 0 ||
                targetIndex < 0 ||
                sourceIndex === targetIndex
              ) {
                return state;
              }
    
              const nextTabs = [...state.containerTabs];
              const [moved] = nextTabs.splice(sourceIndex, 1);
              const nextTargetIndex = nextTabs.findIndex(
                (tab) => tab.hostId === targetHostId,
              );
              if (!moved || nextTargetIndex < 0) {
                return state;
              }
    
              nextTabs.splice(
                placement === "after" ? nextTargetIndex + 1 : nextTargetIndex,
                0,
                moved,
              );
              return { containerTabs: nextTabs };
            });
          },
    refreshHostContainers: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (host && isAwsEcsHostRecord(host)) {
              await loadEcsClusterSnapshot(set, get, hostId);
              return;
            }
            await loadContainersList(set, get, hostId);
          },
    refreshEcsClusterUtilization: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host || !isAwsEcsHostRecord(host)) {
              return;
            }
            await loadEcsClusterUtilization(set, get, hostId);
          },
    selectHostContainer: async (hostId, containerId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host) {
              return;
            }
            set((state) => {
              const currentTab = findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
              if (currentTab.selectedContainerId === containerId) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  selectedContainerId: containerId,
                  details: null,
                  detailsError: undefined,
                  logs: null,
                  logsState: "idle",
                  logsError: undefined,
                  logsTailWindow: DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
                  logsSearchQuery: "",
                  logsSearchMode: null,
                  logsSearchLoading: false,
                  logsSearchError: undefined,
                  logsSearchResult: null,
                  metricsSamples: [],
                  metricsState: "idle",
                  metricsLoading: false,
                  metricsError: undefined,
                  pendingAction: null,
                  actionError: undefined,
                }),
              };
            });
            if (!containerId) {
              return;
            }
            await loadContainerDetails(set, get, hostId, containerId);
            const nextTab = findContainersTab(get(), hostId);
            if (nextTab?.activePanel === "logs") {
              await loadContainerLogs(set, get, hostId);
            }
          },
    setHostContainersPanel: (hostId, panel) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  activePanel: panel,
                }),
              };
            }),
    setHostContainerTunnelState: (hostId, containerId, tunnelState) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab || currentTab.kind !== "host-containers") {
                return state;
              }
              const nextTunnelState =
                normalizeContainerTunnelTabStateForPersistence(tunnelState);
              const currentTunnelState =
                currentTab.containerTunnelStatesByContainerId[containerId] ?? null;
              if (
                areContainerTunnelTabStatesEqual(currentTunnelState, nextTunnelState)
              ) {
                return state;
              }
              const nextTunnelStates = {
                ...currentTab.containerTunnelStatesByContainerId,
              };
              if (nextTunnelState) {
                nextTunnelStates[containerId] = nextTunnelState;
              } else {
                delete nextTunnelStates[containerId];
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  containerTunnelStatesByContainerId: nextTunnelStates,
                }),
              };
            }),
    setEcsClusterSelectedService: (hostId, serviceName) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab || currentTab.kind !== "ecs-cluster") {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  ecsSelectedServiceName: serviceName,
                }),
              };
            }),
    setEcsClusterActivePanel: (hostId, panel) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab || currentTab.kind !== "ecs-cluster") {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  ecsActivePanel: panel,
                }),
              };
            }),
    setEcsClusterTunnelState: (hostId, serviceName, tunnelState) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab || currentTab.kind !== "ecs-cluster") {
                return state;
              }
              const currentTunnelState =
                currentTab.ecsTunnelStatesByServiceName[serviceName] ?? null;
              if (areEcsTunnelTabStatesEqual(currentTunnelState, tunnelState)) {
                return state;
              }
              const nextTunnelStates = { ...currentTab.ecsTunnelStatesByServiceName };
              if (tunnelState) {
                nextTunnelStates[serviceName] = tunnelState;
              } else {
                delete nextTunnelStates[serviceName];
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  ecsTunnelStatesByServiceName: nextTunnelStates,
                }),
              };
            }),
    setEcsClusterLogsState: (hostId, serviceName, logsState) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab || currentTab.kind !== "ecs-cluster") {
                return state;
              }
              const nextLogsByServiceName = { ...currentTab.ecsLogsByServiceName };
              if (logsState) {
                nextLogsByServiceName[serviceName] = logsState;
              } else {
                delete nextLogsByServiceName[serviceName];
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  ecsLogsByServiceName: nextLogsByServiceName,
                }),
              };
            }),
    refreshHostContainerLogs: async (hostId, options) => {
            await loadContainerLogs(set, get, hostId, options);
          },
    loadMoreHostContainerLogs: async (hostId) => {
            const currentTab = findContainersTab(get(), hostId);
            if (!currentTab) {
              return;
            }
            const nextTail = Math.min(
              MAX_CONTAINER_LOGS_TAIL_WINDOW,
              currentTab.logsTailWindow + CONTAINER_LOGS_TAIL_INCREMENT,
            );
            if (nextTail === currentTab.logsTailWindow) {
              return;
            }
            set((state) => {
              const nextTab = findContainersTab(state, hostId);
              if (!nextTab) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...nextTab,
                  logsFollowEnabled: false,
                }),
              };
            });
            await loadContainerLogs(set, get, hostId, { tail: nextTail });
          },
    setHostContainerLogsFollow: (hostId, enabled) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  logsFollowEnabled: enabled,
                }),
              };
            }),
    setHostContainerLogsSearchQuery: (hostId, query) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab) {
                return state;
              }
              const trimmed = query.trim();
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  logsSearchQuery: query,
                  logsSearchMode: trimmed ? "local" : null,
                  logsFollowEnabled: trimmed ? false : currentTab.logsFollowEnabled,
                  logsSearchError: trimmed ? undefined : currentTab.logsSearchError,
                  logsSearchResult: null,
                }),
              };
            }),
    searchHostContainerLogs: async (hostId) => {
            await searchContainerLogs(set, get, hostId);
          },
    clearHostContainerLogsSearch: (hostId) =>
            set((state) => {
              const currentTab = findContainersTab(state, hostId);
              if (!currentTab) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  logsSearchQuery: "",
                  logsSearchMode: null,
                  logsSearchLoading: false,
                  logsSearchError: undefined,
                  logsSearchResult: null,
                }),
              };
            }),
    refreshHostContainerStats: async (hostId) => {
            await loadContainerStats(set, get, hostId);
          },
    runHostContainerAction: async (hostId, action) => {
            await runContainerAction(set, get, hostId, action);
          },
    openHostContainerShell: async (hostId, containerId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host) {
              return;
            }
            if (
              promptForMissingUsername(set, get, {
                hostId,
                source: "containerShell",
                containerId,
              })
            ) {
              return;
            }
            const initialProgress = isAwsEc2HostRecord(host)
              ? createConnectionProgress(
                  "checking-profile",
                  `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
                )
              : resolveHostKeyCheckProgress(host);
            const sessionId = createPendingSessionTabForContainerShell(
              set,
              get,
              host,
              containerId,
              120,
              32,
              initialProgress,
            );
            const trusted = await ensureTrustedHost(set, {
              hostId,
              sessionId,
              endpointId: buildContainersEndpointId(hostId),
              action: {
                kind: "containerShell",
                hostId,
                containerId,
              },
            });
            if (!trusted) {
              updateSessionProgress(
                set,
                sessionId,
                resolveAwaitingHostTrustProgress(host),
              );
              return;
            }
            await startPendingContainerShellConnect(
              set,
              get,
              sessionId,
              hostId,
              containerId,
            );
          },
    openEcsExecShell: async (
            hostId,
            serviceName,
            taskArn,
            containerName,
          ) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host || !isAwsEcsHostRecord(host)) {
              return;
            }
            const sessionId = createPendingSessionTabForEcsShell(set, get, {
              hostId,
              serviceName,
              taskArn,
              containerName,
              cols: 120,
              rows: 32,
              progress: createConnectionProgress(
                "retrying-session",
                `${host.label} ECS 셸을 준비하는 중입니다.`,
              ),
            });
            await startPendingEcsExecShellConnect(set, get, sessionId);
          }
  };

}
