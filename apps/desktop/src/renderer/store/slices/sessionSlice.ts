import type { SliceDeps } from "../services/context";
import type { SessionSlice, WorkspaceTab } from "../types";
import * as defaults from "../defaults";
import * as utils from "../utils";
import { createBootstrapSyncServices } from "../services/bootstrap-sync";
import { updateStoredSshUsername } from "../services/credential-retry";
import { createContainersServices } from "../services/containers";
import { createSessionServices } from "../services/session";
import { createSftpServices } from "../services/sftp";
import { createTrustAuthServices } from "../services/trust-auth";

export function createSessionSlice(deps: SliceDeps): SessionSlice {
  const { api, set, get } = deps;
  const services = createSessionServices(deps);
  const bootstrapServices = createBootstrapSyncServices(deps);
  const containersServices = createContainersServices(deps);
  const sftpServices = createSftpServices(deps);
  const trustServices = createTrustAuthServices(deps);
  const {
    AWS_SFTP_DEFAULT_PORT,
    DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
    getAwsEc2HostSftpDisabledReason,
    getAwsEc2HostSshPort,
    getParentGroupPath,
    isAwsEc2HostRecord,
    isAwsEcsHostRecord,
    isSerialHostRecord,
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
    markSessionError,
    createPendingSessionTabForHost,
    createPendingSessionTabForLocal,
    createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell,
    startPendingSessionConnect,
    startPendingLocalSessionConnect,
    startSessionConnectionFlow,
    promptForMissingUsername,
    startLocalTerminalFlow,
  } = services;
  const { refreshHostAndKeychainState } = bootstrapServices;
  const { ensureTrustedHost } = trustServices;
  const {
    startPendingContainerShellConnect,
    startPendingEcsExecShellConnect,
  } = containersServices;
  const { connectTrustedHostPane } = sftpServices;

  return {
    tabs: [],
    sessionShareChatNotifications: {},
    workspaces: [],
    tabStrip: [],
    pendingCredentialRetry: null,
    activeCredentialRetryAttempt: null,
    pendingMissingUsernamePrompt: null,
    pendingInteractiveAuth: null,
    pendingConnectionAttempts: [],
    sessionReturnTargets: {},
    openLocalTerminal: async (cols, rows) => {
            await startLocalTerminalFlow(set, get, cols, rows);
          },
    connectHost: async (hostId, cols, rows, secrets) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host) {
              return;
            }
            if (isAwsEcsHostRecord(host)) {
              await get().openHostContainersTab(hostId);
              return;
            }
            if (isSerialHostRecord(host)) {
              const existingPendingAttempt = findPendingConnectionAttemptByHost(
                get(),
                hostId,
              );
              if (existingPendingAttempt) {
                set((state) =>
                  activateSessionContextInState(
                    state,
                    existingPendingAttempt.sessionId,
                  ),
                );
                return;
              }
              await startSessionConnectionFlow(set, get, hostId, cols, rows);
              return;
            }
            if (
              promptForMissingUsername(set, get, {
                hostId,
                source: "ssh",
                cols,
                rows,
                secrets,
              })
            ) {
              return;
            }
            const existingPendingAttempt = findPendingConnectionAttemptByHost(
              get(),
              hostId,
            );
            if (existingPendingAttempt) {
              set((state) =>
                activateSessionContextInState(
                  state,
                  existingPendingAttempt.sessionId,
                ),
              );
              return;
            }
            await startSessionConnectionFlow(set, get, hostId, cols, rows, secrets);
          },
    retrySessionConnection: async (sessionId, secrets) => {
            const currentTab = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            );
            if (!currentTab) {
              return;
            }
    
            const currentAttempt = findPendingConnectionAttempt(get(), sessionId);
            if (isPendingEcsShellAttempt(currentAttempt)) {
              const pendingSessionId = createPendingSessionId();
              const latestCols = currentAttempt.latestCols ?? 120;
              const latestRows = currentAttempt.latestRows ?? 32;
              const host = get().hosts.find(
                (item) => item.id === currentAttempt.hostId,
              );
              if (!host || !isAwsEcsHostRecord(host)) {
                return;
              }
    
              set((state) => ({
                ...replaceSessionReferencesInState(
                  state,
                  sessionId,
                  pendingSessionId,
                  (tab) =>
                    createPendingSessionTab({
                      sessionId: pendingSessionId,
                      source: "local",
                      hostId: null,
                      title: tab.title,
                      progress: createConnectionProgress(
                        "retrying-session",
                        `${host.label} ECS 셸을 다시 여는 중입니다.`,
                      ),
                    }),
                ),
                pendingConnectionAttempts: [
                  ...state.pendingConnectionAttempts.filter(
                    (attempt) => attempt.sessionId !== sessionId,
                  ),
                  {
                    ...currentAttempt,
                    sessionId: pendingSessionId,
                    latestCols,
                    latestRows,
                  },
                ],
              }));
    
              if (!isPendingSessionId(sessionId)) {
                await api.ssh.disconnect(sessionId).catch(() => undefined);
              }
    
              await startPendingEcsExecShellConnect(set, get, pendingSessionId);
              return;
            }
    
            if (
              currentAttempt?.source === "container-shell" &&
              currentAttempt.hostId &&
              currentAttempt.containerId
            ) {
              const pendingSessionId = createPendingSessionId();
              const latestCols = currentAttempt.latestCols ?? 120;
              const latestRows = currentAttempt.latestRows ?? 32;
              const host = get().hosts.find(
                (item) => item.id === currentAttempt.hostId,
              );
              if (!host) {
                return;
              }
    
              set((state) => ({
                ...replaceSessionReferencesInState(
                  state,
                  sessionId,
                  pendingSessionId,
                  (tab) =>
                    createPendingSessionTab({
                      sessionId: pendingSessionId,
                      source: "host",
                      hostId: currentAttempt.hostId,
                      title: tab.title,
                      progress: isAwsEc2HostRecord(host)
                        ? createConnectionProgress(
                            "checking-profile",
                            `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
                          )
                        : resolveHostKeyCheckProgress(host),
                    }),
                ),
                pendingConnectionAttempts: [
                  ...state.pendingConnectionAttempts.filter(
                    (attempt) => attempt.sessionId !== sessionId,
                  ),
                  {
                    sessionId: pendingSessionId,
                    source: "container-shell" as const,
                    hostId: currentAttempt.hostId,
                    title: currentTab.title,
                    latestCols,
                    latestRows,
                    containerId: currentAttempt.containerId,
                  },
                ],
              }));
    
              if (!isPendingSessionId(sessionId)) {
                await api.ssh.disconnect(sessionId).catch(() => undefined);
              }
    
              const trusted = await ensureTrustedHost(set, {
                hostId: currentAttempt.hostId,
                sessionId: pendingSessionId,
                endpointId: buildContainersEndpointId(currentAttempt.hostId),
                action: {
                  kind: "containerShell",
                  hostId: currentAttempt.hostId,
                  containerId: currentAttempt.containerId,
                },
              });
              if (!trusted) {
                updateSessionProgress(
                  set,
                  pendingSessionId,
                  resolveAwaitingHostTrustProgress(host),
                );
                return;
              }
              await startPendingContainerShellConnect(
                set,
                get,
                pendingSessionId,
                currentAttempt.hostId,
                currentAttempt.containerId,
              );
              return;
            }
    
            if (currentTab.source === "local") {
              const pendingSessionId = createPendingSessionId();
              const latestCols = currentAttempt?.latestCols ?? 120;
              const latestRows = currentAttempt?.latestRows ?? 32;
    
              set((state) => ({
                ...replaceSessionReferencesInState(
                  state,
                  sessionId,
                  pendingSessionId,
                  (tab) =>
                    createPendingSessionTab({
                      sessionId: pendingSessionId,
                      source: "local",
                      hostId: null,
                      title: tab.title,
                      progress: createConnectionProgress(
                        "retrying-session",
                        "로컬 터미널을 다시 시작하는 중입니다.",
                      ),
                    }),
                ),
                pendingConnectionAttempts: [
                  ...state.pendingConnectionAttempts.filter(
                    (attempt) => attempt.sessionId !== sessionId,
                  ),
                  {
                    sessionId: pendingSessionId,
                    source: "local" as const,
                    hostId: null,
                    title: currentTab.title,
                    latestCols,
                    latestRows,
                  },
                ],
              }));
    
              if (!isPendingSessionId(sessionId)) {
                await api.ssh.disconnect(sessionId).catch(() => undefined);
              }
    
              await startLocalTerminalFlow(
                set,
                get,
                latestCols,
                latestRows,
                pendingSessionId,
              );
              return;
            }
    
            const host = currentTab.hostId
              ? get().hosts.find((item) => item.id === currentTab.hostId)
              : null;
            if (!host) {
              return;
            }
            if (
              isSshHostRecord(host) &&
              promptForMissingUsername(set, get, {
                hostId: host.id,
                source: "ssh",
                cols: currentAttempt?.latestCols ?? 120,
                rows: currentAttempt?.latestRows ?? 32,
                secrets,
              })
            ) {
              return;
            }
    
            const pendingSessionId = createPendingSessionId();
            const latestCols = currentAttempt?.latestCols ?? 120;
            const latestRows = currentAttempt?.latestRows ?? 32;
    
            set((state) => ({
              ...replaceSessionReferencesInState(
                state,
                sessionId,
                pendingSessionId,
                (tab) =>
                  createPendingSessionTab({
                    sessionId: pendingSessionId,
                    source: "host",
                    hostId: tab.hostId,
                    title: tab.title,
                    progress: isAwsEc2HostRecord(host)
                      ? createConnectionProgress(
                          "checking-profile",
                          `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
                        )
                      : resolveHostKeyCheckProgress(host),
                  }),
              ),
              pendingConnectionAttempts: [
                ...state.pendingConnectionAttempts.filter(
                  (attempt) => attempt.sessionId !== sessionId,
                ),
                {
                  sessionId: pendingSessionId,
                  source: "host" as const,
                  hostId: host.id,
                  title: currentTab.title,
                  latestCols,
                  latestRows,
                },
              ],
            }));
    
            if (!isPendingSessionId(sessionId)) {
              await api.ssh.disconnect(sessionId).catch(() => undefined);
            }
    
            await startSessionConnectionFlow(
              set,
              get,
              host.id,
              latestCols,
              latestRows,
              secrets,
              pendingSessionId,
            );
          },
    startSessionShare: async (input) => {
            const { sessionId } = input;
            const tab = get().tabs.find((item) => item.sessionId === sessionId);
            if (!tab || tab.source !== "host" || tab.status !== "connected") {
              return;
            }
    
            set((state) => ({
              tabs: setSessionShareState(state.tabs, sessionId, {
                status: "starting",
                shareUrl: tab.sessionShare?.shareUrl ?? null,
                inputEnabled: tab.sessionShare?.inputEnabled ?? false,
                viewerCount: tab.sessionShare?.viewerCount ?? 0,
                errorMessage: null,
              }),
              sessionShareChatNotifications: clearSessionShareChatNotifications(
                state.sessionShareChatNotifications,
                sessionId,
              ),
            }));
    
            const nextState = await api.sessionShares.start(input);
            set((state) => ({
              tabs: setSessionShareState(state.tabs, sessionId, nextState),
            }));
          },
    updateSessionShareSnapshot: async (input) => {
            const { sessionId } = input;
            const tab = get().tabs.find((item) => item.sessionId === sessionId);
            if (!tab || tab.sessionShare?.status !== "active") {
              return;
            }
            await api.sessionShares.updateSnapshot(input);
          },
    setSessionShareInputEnabled: async (sessionId, inputEnabled) => {
            const tab = get().tabs.find((item) => item.sessionId === sessionId);
            if (!tab || tab.sessionShare?.status === "inactive") {
              return;
            }
            const nextState = await api.sessionShares.setInputEnabled({
              sessionId,
              inputEnabled,
            });
            set((state) => ({
              tabs: setSessionShareState(state.tabs, sessionId, nextState),
            }));
          },
    stopSessionShare: async (sessionId) => {
            await api.sessionShares.stop(sessionId);
            set((state) => ({
              tabs: setSessionShareState(
                state.tabs,
                sessionId,
                createInactiveSessionShareState(),
              ),
              sessionShareChatNotifications: clearSessionShareChatNotifications(
                state.sessionShareChatNotifications,
                sessionId,
              ),
            }));
          },
    disconnectTab: async (sessionId) => {
            const currentShare = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            )?.sessionShare;
            if (currentShare && currentShare.status !== "inactive") {
              await api.sessionShares.stop(sessionId).catch(() => undefined);
            }
            if (isPendingSessionId(sessionId)) {
              set((state) => removeSessionFromState(state, sessionId));
              return;
            }
    
            const currentTab = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            );
            if (currentTab?.status === "error") {
              await api.ssh.disconnect(sessionId).catch(() => undefined);
              set((state) => removeSessionFromState(state, sessionId));
              return;
            }
    
            await api.ssh.disconnect(sessionId);
            set((state) => ({
              tabs: state.tabs.map((tab) =>
                tab.sessionId === sessionId
                  ? {
                      ...tab,
                      status: "disconnecting",
                      lastEventAt: new Date().toISOString(),
                    }
                  : tab,
              ),
            }));
          },
    closeWorkspace: async (workspaceId) => {
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace) {
              return;
            }
    
            const sessionIds = listWorkspaceSessionIds(workspace.layout);
            await Promise.all(
              sessionIds.map((sessionId) => api.ssh.disconnect(sessionId)),
            );
            set((state) => {
              const workspaceIndex = state.tabStrip.findIndex(
                (item) =>
                  item.kind === "workspace" && item.workspaceId === workspaceId,
              );
              const nextTabStrip = state.tabStrip.filter(
                (item) =>
                  !(item.kind === "workspace" && item.workspaceId === workspaceId),
              );
              const nextActive =
                state.activeWorkspaceTab === asWorkspaceTabId(workspaceId)
                  ? resolveNextVisibleTab(
                      nextTabStrip,
                      workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
                    )
                  : state.activeWorkspaceTab;
    
              return {
                workspaces: state.workspaces.filter(
                  (item) => item.id !== workspaceId,
                ),
                tabStrip: nextTabStrip,
                tabs: state.tabs.map((tab) =>
                  sessionIds.includes(tab.sessionId)
                    ? {
                        ...tab,
                        status: "disconnecting",
                        lastEventAt: new Date().toISOString(),
                      }
                    : tab,
                ),
                activeWorkspaceTab: nextActive,
              };
            });
          },
    splitSessionIntoWorkspace: (sessionId, direction, targetSessionId) => {
            const state = get();
            const adjacent = resolveAdjacentTarget(
              state.tabStrip,
              state.workspaces,
              sessionId,
            );
            if (!adjacent) {
              return false;
            }
    
            if (adjacent.kind === "session") {
              const currentIndex = state.tabStrip.findIndex(
                (item) => item.kind === "session" && item.sessionId === sessionId,
              );
              const adjacentIndex = state.tabStrip.findIndex(
                (item) =>
                  item.kind === "session" && item.sessionId === adjacent.sessionId,
              );
              if (currentIndex < 0 || adjacentIndex < 0) {
                return false;
              }
    
              const workspaceId = globalThis.crypto.randomUUID();
              const workspace: WorkspaceTab = {
                id: workspaceId,
                title: buildWorkspaceTitle(state.workspaces),
                layout: createWorkspaceSplit(
                  adjacent.sessionId,
                  sessionId,
                  direction,
                ),
                activeSessionId: sessionId,
                broadcastEnabled: false,
              };
              const nextTabStrip = state.tabStrip.filter(
                (item) =>
                  !(
                    item.kind === "session" &&
                    (item.sessionId === sessionId ||
                      item.sessionId === adjacent.sessionId)
                  ),
              );
              const insertIndex = Math.min(currentIndex, adjacentIndex);
              nextTabStrip.splice(insertIndex, 0, {
                kind: "workspace",
                workspaceId,
              });
    
              set({
                workspaces: [...state.workspaces, workspace],
                tabStrip: nextTabStrip,
                activeWorkspaceTab: asWorkspaceTabId(workspaceId),
              });
              return true;
            }
    
            if (adjacent.kind !== "workspace") {
              return false;
            }
    
            const workspace = state.workspaces.find(
              (item) => item.id === adjacent.workspaceId,
            );
            if (!workspace || countWorkspaceSessions(workspace.layout) >= 4) {
              return false;
            }
    
            const resolvedTargetSessionId =
              targetSessionId &&
              listWorkspaceSessionIds(workspace.layout).includes(targetSessionId)
                ? targetSessionId
                : listWorkspaceSessionIds(workspace.layout).includes(
                      workspace.activeSessionId,
                    )
                  ? workspace.activeSessionId
                  : findFirstWorkspaceSessionId(workspace.layout);
            const nextLayout = insertSessionIntoWorkspaceLayout(
              workspace.layout,
              resolvedTargetSessionId,
              sessionId,
              direction,
            );
            if (!nextLayout.inserted) {
              return false;
            }
    
            set({
              workspaces: state.workspaces.map((item) =>
                item.id === workspace.id
                  ? {
                      ...item,
                      layout: nextLayout.layout,
                      activeSessionId: sessionId,
                    }
                  : item,
              ),
              tabStrip: state.tabStrip.filter(
                (item) =>
                  !(item.kind === "session" && item.sessionId === sessionId),
              ),
              activeWorkspaceTab: asWorkspaceTabId(workspace.id),
            });
            return true;
          },
    moveWorkspaceSession: (
            workspaceId,
            sessionId,
            direction,
            targetSessionId,
          ) => {
            const state = get();
            const workspace = state.workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace) {
              return false;
            }
    
            const nextLayout = moveSessionWithinWorkspaceLayout(
              workspace.layout,
              sessionId,
              targetSessionId,
              direction,
            );
            if (!nextLayout.moved) {
              return false;
            }
    
            set({
              workspaces: state.workspaces.map((item) =>
                item.id === workspaceId
                  ? {
                      ...item,
                      layout: nextLayout.layout,
                      activeSessionId: sessionId,
                    }
                  : item,
              ),
              activeWorkspaceTab: asWorkspaceTabId(workspaceId),
            });
            return true;
          },
    detachSessionFromWorkspace: (workspaceId, sessionId) => {
            const state = get();
            const workspace = state.workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace) {
              return;
            }
    
            const workspaceIndex = state.tabStrip.findIndex(
              (item) =>
                item.kind === "workspace" && item.workspaceId === workspaceId,
            );
            const reducedLayout = removeSessionFromWorkspaceLayout(
              workspace.layout,
              sessionId,
            );
            if (!reducedLayout) {
              return;
            }
    
            const insertIndex =
              workspaceIndex < 0 ? state.tabStrip.length : workspaceIndex + 1;
    
            if (reducedLayout.kind === "leaf") {
              const nextTabStrip = state.tabStrip.filter(
                (item) =>
                  !(item.kind === "workspace" && item.workspaceId === workspaceId),
              );
              nextTabStrip.splice(
                workspaceIndex >= 0 ? workspaceIndex : nextTabStrip.length,
                0,
                { kind: "session", sessionId: reducedLayout.sessionId },
              );
              nextTabStrip.splice(
                workspaceIndex >= 0 ? workspaceIndex + 1 : nextTabStrip.length,
                0,
                { kind: "session", sessionId },
              );
    
              set({
                workspaces: state.workspaces.filter(
                  (item) => item.id !== workspaceId,
                ),
                tabStrip: nextTabStrip,
                activeWorkspaceTab: asSessionTabId(sessionId),
              });
              return;
            }
    
            const nextTabStrip = [...state.tabStrip];
            nextTabStrip.splice(insertIndex, 0, { kind: "session", sessionId });
            set({
              workspaces: state.workspaces.map((item) =>
                item.id === workspaceId
                  ? {
                      ...item,
                      layout: reducedLayout,
                      activeSessionId:
                        item.activeSessionId === sessionId
                          ? findFirstWorkspaceSessionId(reducedLayout)
                          : item.activeSessionId,
                    }
                  : item,
              ),
              tabStrip: nextTabStrip,
              activeWorkspaceTab: asSessionTabId(sessionId),
            });
          },
    reorderDynamicTab: (source, target, placement) => {
            if (dynamicTabMatches(source, target)) {
              return;
            }
    
            set((state) => {
              const sourceIndex = state.tabStrip.findIndex((item) =>
                dynamicTabMatches(item, source),
              );
              const targetIndex = state.tabStrip.findIndex((item) =>
                dynamicTabMatches(item, target),
              );
              if (
                sourceIndex < 0 ||
                targetIndex < 0 ||
                sourceIndex === targetIndex
              ) {
                return state;
              }
    
              const nextTabStrip = [...state.tabStrip];
              const [moved] = nextTabStrip.splice(sourceIndex, 1);
              const nextTargetIndex = nextTabStrip.findIndex((item) =>
                dynamicTabMatches(item, target),
              );
    
              if (nextTargetIndex < 0) {
                return state;
              }
    
              nextTabStrip.splice(
                placement === "after" ? nextTargetIndex + 1 : nextTargetIndex,
                0,
                moved,
              );
              return { tabStrip: nextTabStrip };
            });
          },
    focusWorkspaceSession: (workspaceId, sessionId) => {
            set((state) => ({
              workspaces: state.workspaces.map((workspace) =>
                workspace.id === workspaceId
                  ? {
                      ...workspace,
                      activeSessionId: sessionId,
                    }
                  : workspace,
              ),
              activeWorkspaceTab: asWorkspaceTabId(workspaceId),
            }));
          },
    toggleWorkspaceBroadcast: (workspaceId) => {
            set((state) => ({
              workspaces: state.workspaces.map((workspace) =>
                workspace.id === workspaceId
                  ? {
                      ...workspace,
                      broadcastEnabled: !workspace.broadcastEnabled,
                    }
                  : workspace,
              ),
            }));
          },
    resizeWorkspaceSplit: (workspaceId, splitId, ratio) => {
            set((state) => ({
              workspaces: state.workspaces.map((workspace) =>
                workspace.id === workspaceId
                  ? {
                      ...workspace,
                      layout: updateWorkspaceSplitRatio(
                        workspace.layout,
                        splitId,
                        ratio,
                      ),
                    }
                  : workspace,
              ),
            }));
          },
    dismissPendingCredentialRetry: () => {
            const pending = get().pendingCredentialRetry;
            if (pending?.sessionId) {
              const host = get().hosts.find((item) => item.id === pending.hostId);
              const message = `${host?.label ?? "세션"} 인증 입력이 취소되었습니다.`;
              markSessionError(set, pending.sessionId, message, {
                progress: resolveErrorProgress(message),
              });
              set({ pendingCredentialRetry: null });
              return;
            }
            set({ pendingCredentialRetry: null });
          },
    submitCredentialRetry: async (input) => {
            const pending = get().pendingCredentialRetry;
            if (!pending) {
              return;
            }

            const host = get().hosts.find((item) => item.id === pending.hostId);
            if (!host || !isSshHostRecord(host)) {
              return;
            }

            const username = input.username.trim();
            if (!username) {
              throw new Error("사용자명을 입력해 주세요.");
            }

            const secrets = {
              password:
                input.password !== undefined && input.password.length > 0
                  ? input.password
                  : undefined,
              passphrase:
                input.passphrase !== undefined && input.passphrase.length > 0
                  ? input.passphrase
                  : undefined,
              privateKeyPem:
                input.privateKeyPem !== undefined &&
                input.privateKeyPem.length > 0
                  ? input.privateKeyPem
                  : undefined,
              certificateText:
                input.certificateText !== undefined &&
                input.certificateText.length > 0
                  ? input.certificateText
                  : undefined,
            };

            const usernameChanged = username !== host.username.trim();
            if (usernameChanged) {
              const nextHost = await updateStoredSshUsername(
                { api, get, set },
                host.id,
                username,
              );
              if (!nextHost || !isSshHostRecord(nextHost)) {
                throw new Error("사용자명을 업데이트하지 못했습니다.");
              }
            }

            set({
              activeCredentialRetryAttempt: {
                hostId: pending.hostId,
                source: pending.source,
                sessionId: pending.sessionId ?? null,
                paneId: pending.paneId,
                originalUsername: host.username,
                attemptedUsername: username,
              },
            });

            try {
              if (pending.source === "ssh") {
                if (pending.sessionId) {
                  await get().retrySessionConnection(pending.sessionId, secrets);
                } else {
                  await get().connectHost(pending.hostId, 120, 32, secrets);
                }
                set({ pendingCredentialRetry: null });
                return;
              }

              if (!pending.paneId) {
                return;
              }

              const endpointId = globalThis.crypto.randomUUID();

              const trusted = await ensureTrustedHost(set, {
                hostId: pending.hostId,
                action: {
                  kind: "sftp",
                  paneId: pending.paneId,
                  hostId: pending.hostId,
                  endpointId,
                  secrets,
                },
              });
              if (!trusted) {
                set({ activeCredentialRetryAttempt: null });
                return;
              }
              const connected = await connectTrustedHostPane(set, get, {
                paneId: pending.paneId,
                hostId: pending.hostId,
                endpointId,
                secrets,
              });
              if (!connected) {
                if (usernameChanged) {
                  await updateStoredSshUsername(
                    { api, get, set },
                    host.id,
                    host.username,
                  );
                }
                set({ activeCredentialRetryAttempt: null });
                return;
              }
              set({
                pendingCredentialRetry: null,
                activeCredentialRetryAttempt: null,
              });
            } catch (error) {
              if (usernameChanged) {
                await updateStoredSshUsername(
                  { api, get, set },
                  host.id,
                  host.username,
                ).catch(() => undefined);
              }
              set({ activeCredentialRetryAttempt: null });
              throw error;
            }
          },
    dismissPendingMissingUsernamePrompt: () =>
            set({ pendingMissingUsernamePrompt: null }),
    submitMissingUsernamePrompt: async ({ username }) => {
            const pending = get().pendingMissingUsernamePrompt;
            if (!pending) {
              return;
            }
    
            const trimmedUsername = username.trim();
            if (!trimmedUsername) {
              throw new Error("사용자명을 입력해 주세요.");
            }
    
            const currentHost = get().hosts.find((item) => item.id === pending.hostId);
            if (!currentHost || !isSshHostRecord(currentHost)) {
              set({ pendingMissingUsernamePrompt: null });
              return;
            }
    
            const currentDraft = toHostDraft(currentHost, currentHost.label);
            if (!isSshHostDraft(currentDraft)) {
              set({ pendingMissingUsernamePrompt: null });
              return;
            }
    
            const nextHost = await api.hosts.update(currentHost.id, {
              ...currentDraft,
              username: trimmedUsername,
            });
    
            set((state) => ({
              pendingMissingUsernamePrompt: null,
              hosts: sortHosts([
                ...state.hosts.filter((host) => host.id !== nextHost.id),
                nextHost,
              ]),
            }));
    
            if (pending.source === "ssh") {
              await get().connectHost(
                pending.hostId,
                pending.cols ?? 120,
                pending.rows ?? 32,
                pending.secrets,
              );
              return;
            }
    
            if (pending.source === "sftp" && pending.paneId) {
              await get().connectSftpHost(pending.paneId, pending.hostId);
              return;
            }
    
            if (pending.source === "containers") {
              await get().openHostContainersTab(pending.hostId);
              return;
            }
    
            if (pending.source === "containerShell" && pending.containerId) {
              await get().openHostContainerShell(pending.hostId, pending.containerId);
              return;
            }
    
            if (pending.source === "portForward" && pending.ruleId) {
              await get().startPortForward(pending.ruleId);
            }
          },
    respondInteractiveAuth: async (challengeId, responses) => {
            const pending = get().pendingInteractiveAuth;
            if (!pending || pending.challengeId !== challengeId) {
              return;
            }
            await api.ssh.respondKeyboardInteractive(
              pending.source === "ssh"
                ? {
                    sessionId: pending.sessionId,
                    challengeId,
                    responses,
                  }
                : {
                    endpointId: pending.endpointId,
                    challengeId,
                    responses,
                  },
            );
          },
    reopenInteractiveAuthUrl: async () => {
            const pending = get().pendingInteractiveAuth;
            if (!pending?.approvalUrl) {
              return;
            }
            await api.shell.openExternal(pending.approvalUrl);
          },
    clearPendingInteractiveAuth: () => set({ pendingInteractiveAuth: null }),
    updatePendingConnectionSize: (sessionId, cols, rows) => {
            set((state) => ({
              pendingConnectionAttempts: state.pendingConnectionAttempts.map(
                (attempt) =>
                  attempt.sessionId === sessionId
                    ? {
                        ...attempt,
                        latestCols: cols,
                        latestRows: rows,
                      }
                    : attempt,
              ),
            }));
          },
    markSessionOutput: (sessionId, _chunk) => {
            set((state) => {
              const tabIndex = state.tabs.findIndex(
                (tab) => tab.sessionId === sessionId,
              );
              if (tabIndex < 0) {
                return state;
              }
    
              const currentTab = state.tabs[tabIndex];
              if (!currentTab) {
                return state;
              }
    
              const nextConnectionProgress =
                currentTab.status === "connected"
                  ? null
                  : currentTab.connectionProgress;
              const nextPendingConnectionAttempts =
                state.pendingConnectionAttempts.filter(
                  (attempt) =>
                    !(
                      attempt.sessionId === sessionId &&
                      attempt.source === "container-shell"
                    ),
                );
              if (
                currentTab.hasReceivedOutput === true &&
                nextConnectionProgress === currentTab.connectionProgress &&
                nextPendingConnectionAttempts.length ===
                  state.pendingConnectionAttempts.length
              ) {
                return state;
              }
    
              const nextTabs = state.tabs.slice();
              nextTabs[tabIndex] = {
                ...currentTab,
                hasReceivedOutput: true,
                connectionProgress: nextConnectionProgress,
              };
    
              return {
                tabs: nextTabs,
                pendingConnectionAttempts: nextPendingConnectionAttempts,
              };
            });
          }
  };

}
