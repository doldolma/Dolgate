import type { SliceDeps } from "../services/context";
import type { ContainersSlice, SessionContainerTunnel } from "../types";
import { createDefaultLogsRelativeRange } from "../../lib/log-range";
import {
  AWS_SFTP_DEFAULT_PORT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  getAwsEc2SftpDisabledMessage,
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
  createEmptyEcsServiceLogsViewState,
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
} from "../utils";
import { createContainersServices } from "../services/containers";
import { t } from '../../i18n';

/** 이만큼 지나도 응답이 없으면 다시 누를 수 있게 놓아 준다(그 줄이 굳지 않게). */
const TUNNEL_START_STALE_MS = 30_000;

export function createContainersSlice(deps: SliceDeps): ContainersSlice {
  const { api, set, get } = deps;
  const services = createContainersServices(deps);

  const {
    updateSessionProgress,
    markSessionError,
    promptForMissingUsername,
    clearContainerTabConnectionOverlay,
    beginContainerLifecycle,
    reportContainerLifecycleError,
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

  const connectHostContainersTab = async (hostId: string) => {
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
    let lifecycleId: string | null = null;
    try {
      lifecycleId = await beginContainerLifecycle(set, hostId);
    } catch (error) {
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
            errorMessage: normalizeErrorMessage(
              error,
              t('containersSlice.lifecycleLogFailed'),
            ),
          }),
        };
      });
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
          t('connectProgress.hostKeyChecking', { label: host.label }),
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

    let trusted = false;
    try {
      trusted = await ensureTrustedHost(set, {
        hostId,
        endpointId: buildContainersEndpointId(hostId),
        // 이미 신뢰된 호스트/베스천은 재-probe 생략(중복 순회 방지, 실연결이 strict 검사).
        action: {
          kind: "containers",
          hostId,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? normalizeRemoteInvokeErrorMessage(error.message)
          : t('containersSlice.pageOpenFailed');
      await reportContainerLifecycleError(
        lifecycleId,
        error,
        t('containersSlice.pageOpenFailed'),
      );
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
            errorMessage: message,
          }),
        };
      });
      return;
    }
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
  };

  return {
    containerTabs: [],
    activeContainerHostId: null,
    sessionContainerTunnels: {},
    openSessionContainerTunnel: async ({
      sessionId,
      hostId,
      containerId,
      containerName,
      networkName,
      targetPort,
      resolveNetworks,
    }) => {
      // 빠르게 두 번 눌러도 한 번만 나간다. 화면은 곧바로 "여는 중" 으로 바뀌지만 그 사이의
      // 두 번째 클릭이 IPC 를 또 태우면 같은 포트로 터널이 둘 열린다(로컬 포트만 다르게).
      const existing = (get().sessionContainerTunnels[sessionId] ?? []).find(
        (entry) => entry.containerId === containerId && entry.targetPort === targetPort,
      );
      // 열려 있거나 여는 중이면 무시한다. 다만 **오래 걸린 대기는 놓아 준다** — 응답이 영영
      // 오지 않으면 그 줄이 "여는 중" 으로 굳어 다시 누를 방법이 없다.
      const stalled =
        existing?.status === 'starting' &&
        Date.now() - (existing.startedAtMs ?? 0) > TUNNEL_START_STALE_MS;
      if (existing && existing.status !== 'error' && !stalled) {
        return;
      }
      // 누른 즉시 "여는 중" 을 남긴다. 터널 하나 여는 데 1~2초가 걸리는데 그동안 화면이 그대로면
      // 눌린 것인지 알 수 없어 다시 누르게 된다(실제로 그랬다).
      const pendingId = `pending:${containerId}:${targetPort}`;
      const startedAtMs = Date.now();
      const put = (tunnel: SessionContainerTunnel, replaceId: string) => {
        set((state) => ({
          sessionContainerTunnels: {
            ...state.sessionContainerTunnels,
            [sessionId]: [
              ...(state.sessionContainerTunnels[sessionId] ?? []).filter(
                (entry) => entry.ruleId !== replaceId && entry.ruleId !== tunnel.ruleId,
              ),
              tunnel,
            ],
          },
        }));
      };
      put(
        {
          ruleId: pendingId,
          containerId,
          containerName,
          targetPort,
          bindPort: 0,
          status: 'starting',
          startedAtMs,
        },
        pendingId,
      );
      // 대상의 근거는 **"여는 중" 을 찍은 뒤에** 구한다. 값이 이미 있으면 그 자리에서 오고,
      // 물어봐야 하는 경우에도 화면은 이미 눌린 것으로 보인다.
      const networks = await resolveNetworks?.();
      try {
        // 로컬 포트는 0 으로 보낸다 — 코어가 빈 포트를 잡고 실제 값을 런타임으로 알려 준다.
        // 사용자에게 포트를 고르게 하지 않는 이유이자, 충돌을 우리가 떠안는 방법이다.
        const runtime = await api.containers.startTunnel({
          hostId,
          containerId,
          networkName,
          targetPort,
          bindAddress: '127.0.0.1',
          bindPort: 0,
          // 패널이 이미 읽어 둔 네트워크. sudo 가 필요한 호스트에서는 이 값이 있어야 열린다 —
          // 코어의 컨테이너 연결은 그 세션의 sudo 비밀번호를 갖고 있지 않다.
          networks,
          // 주인 세션. 이 세션이 끝나면 메인이 이 터널을 회수한다(렌더러가 아니라 메인이 한다 —
          // 창을 닫거나 렌더러가 죽어도 새지 않게).
          ownerSessionId: sessionId,
        });
        put(
          {
            ruleId: runtime.ruleId,
            containerId,
            containerName,
            targetPort,
            bindPort: runtime.bindPort,
            status: runtime.status === 'running' ? 'running' : 'starting',
            startedAtMs,
          },
          pendingId,
        );
      } catch (error) {
        // 실패는 그 줄에 남긴다 — 로그에만 찍히면 사용자는 아무 일도 안 일어난 것으로 본다.
        put(
          {
            ruleId: pendingId,
            containerId,
            containerName,
            targetPort,
            bindPort: 0,
            status: 'error',
            startedAtMs,
            message: error instanceof Error ? error.message : String(error),
          },
          pendingId,
        );
      }
    },
    closeSessionContainerTunnel: async (sessionId, ruleId) => {
      // 먼저 화면에서 지운다 — 눌렀는데 남아 있으면 다시 누르게 된다. 실제 정지는 뒤따른다.
      set((state) => ({
        sessionContainerTunnels: {
          ...state.sessionContainerTunnels,
          [sessionId]: (state.sessionContainerTunnels[sessionId] ?? []).filter(
            (tunnel) => tunnel.ruleId !== ruleId,
          ),
        },
      }));
      await api.containers.stopTunnel(ruleId).catch(() => undefined);
    },
    openHostContainersTab: connectHostContainersTab,
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
            }
            const lifecycleId = currentTab?.lifecycleId ?? null;
            if (lifecycleId) {
              await api.containers
                .release(hostId, lifecycleId)
                .catch(() => undefined);
            } else {
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
                pendingInteractiveAuths: state.pendingInteractiveAuths.filter(
                  (auth) =>
                    !(isPendingContainersInteractiveAuth(auth) && auth.hostId === hostId),
                ),
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
            await connectHostContainersTab(hostId);
          },
    refreshEcsClusterUtilization: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host || !isAwsEcsHostRecord(host)) {
              return;
            }
            await loadEcsClusterUtilization(set, get, hostId);
          },
    loginAwsProfileForEcsHost: async (hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host || !isAwsEcsHostRecord(host)) {
              return;
            }
            if (!host.awsProfileId) {
              throw new Error(
                t('aws.profile.linkedNotFoundNamed', { label: host.awsProfileName }),
              );
            }
            await api.aws.loginById(host.awsProfileId);
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
                  logsRangeMode: "recent",
                  logsRelativeRange: createDefaultLogsRelativeRange(),
                  logsAbsoluteRange: null,
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
                const currentLogsState =
                  currentTab.ecsLogsByServiceName[serviceName]
                    ? {
                        ...createEmptyEcsServiceLogsViewState(),
                        ...currentTab.ecsLogsByServiceName[serviceName],
                      }
                    : createEmptyEcsServiceLogsViewState();
                nextLogsByServiceName[serviceName] =
                  typeof logsState === "function"
                    ? logsState(currentLogsState)
                    : logsState;
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
                  logsRangeMode: enabled ? "recent" : currentTab.logsRangeMode,
                  logsRelativeRange: enabled
                    ? createDefaultLogsRelativeRange()
                    : currentTab.logsRelativeRange,
                  logsAbsoluteRange: enabled ? null : currentTab.logsAbsoluteRange,
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
                  t('containersStore.checkingProfile', { profile: host.awsProfileName }),
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
            let trusted = false;
            try {
              trusted = await ensureTrustedHost(set, {
                hostId,
                sessionId,
                endpointId: buildContainersEndpointId(hostId),
                // 이미 신뢰된 호스트/베스천은 재-probe 생략(중복 순회 방지, 실연결이 strict 검사).
                action: {
                  kind: "containerShell",
                  hostId,
                  containerId,
                },
              });
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : t('containersStore.shellFailed');
              clearContainerTabConnectionOverlay(set, hostId);
              markSessionError(set, sessionId, message);
              return;
            }
            if (!trusted) {
              clearContainerTabConnectionOverlay(set, hostId);
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
                t('containersSlice.ecsShellPreparing', { label: host.label }),
              ),
            });
            await startPendingEcsExecShellConnect(set, get, sessionId);
          }
  };

}
