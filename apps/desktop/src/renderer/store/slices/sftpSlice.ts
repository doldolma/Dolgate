import type { SliceDeps } from "../services/context";
import type { SftpPaneState, SftpSlice } from "../types";
import type { HostDraft } from "@shared";
import * as defaults from "../defaults";
import * as utils from "../utils";
import { createSftpServices } from "../services/sftp";

export function createSftpSlice(deps: SliceDeps): SftpSlice {
  const { api, set, get } = deps;
  const services = createSftpServices(deps);
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
    loadPaneListing,
    setSftpPaneWarnings,
    startSftpTransferForItems,
    resolveLocalTransferItemsFromPaths,
    connectTrustedHostPane,
    ensureTrustedHost,
    refreshHostAndKeychainState,
    promptForMissingUsername,
  } = services;

  return {
    sftp: defaultSftpState,
    pendingAwsSftpConfigRetry: null,
    dismissPendingAwsSftpConfigRetry: () =>
            set({ pendingAwsSftpConfigRetry: null }),
    submitAwsSftpConfigRetry: async ({ username, port }) => {
            const pending = get().pendingAwsSftpConfigRetry;
            if (!pending) {
              return;
            }
    
            const currentHost = get().hosts.find((item) => item.id === pending.hostId);
            if (!currentHost || !isAwsEc2HostRecord(currentHost)) {
              set({ pendingAwsSftpConfigRetry: null });
              return;
            }
    
            const baseDraft = toHostDraft(
              currentHost,
              currentHost.label,
            ) as Extract<HostDraft, { kind: "aws-ec2" }>;
            const nextDraft: Extract<HostDraft, { kind: "aws-ec2" }> = {
              ...baseDraft,
              awsSshUsername: username.trim(),
              awsSshPort: port,
              awsSshMetadataStatus: "ready",
              awsSshMetadataError: null,
            };
            const nextHost = await api.hosts.update(currentHost.id, {
              ...nextDraft,
            });
            set((state) => ({
              pendingAwsSftpConfigRetry: null,
              hosts: sortHosts([
                ...state.hosts.filter((host) => host.id !== nextHost.id),
                nextHost,
              ]),
            }));
            await get().connectSftpHost(pending.paneId, pending.hostId);
          },
    setSftpPaneSource: async (paneId, sourceKind) => {
            const pane = getPane(get(), paneId);
            if (pane.sourceKind === sourceKind) {
              return;
            }
            if (pane.endpoint) {
              await api.sftp.disconnect(pane.endpoint.id);
            }
    
            const nextBasePane: SftpPaneState = {
              ...pane,
              sourceKind,
              endpoint: null,
              connectingHostId: null,
              connectingEndpointId: null,
              connectionProgress: null,
              hostGroupPath: null,
              currentPath:
                sourceKind === "local"
                  ? pane.lastLocalPath || get().sftp.localHomePath
                  : "",
              history:
                sourceKind === "local"
                  ? [pane.lastLocalPath || get().sftp.localHomePath]
                  : [],
              historyIndex: sourceKind === "local" ? 0 : -1,
              entries: [],
              selectedPaths: [],
              selectionAnchorPath: null,
              errorMessage: undefined,
              warningMessages: [],
              selectedHostId: null,
              hostSearchQuery: "",
              isLoading: false,
            };
    
            set((state) => ({
              pendingInteractiveAuth:
                isPendingSftpInteractiveAuth(state.pendingInteractiveAuth) &&
                state.pendingInteractiveAuth.paneId === paneId
                  ? null
                  : state.pendingInteractiveAuth,
              sftp: updatePaneState(state, paneId, nextBasePane),
            }));
    
            if (sourceKind === "local") {
              await loadPaneListing(set, get, paneId, nextBasePane.currentPath, {
                pushToHistory: false,
              });
            }
          },
    disconnectSftpPane: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (!pane.endpoint && !pane.connectingEndpointId) {
              return;
            }
            if (pane.endpoint) {
              await api.sftp.disconnect(pane.endpoint.id);
            }
            set((state) => ({
              pendingInteractiveAuth:
                isPendingSftpInteractiveAuth(state.pendingInteractiveAuth) &&
                state.pendingInteractiveAuth.paneId === paneId
                  ? null
                  : state.pendingInteractiveAuth,
              sftp: updatePaneState(state, paneId, buildSftpHostPickerPane(getPane(state, paneId))),
            }));
          },
    setSftpPaneFilter: (paneId, query) =>
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                filterQuery: query,
              }),
            })),
    setSftpHostSearchQuery: (paneId, query) =>
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                hostSearchQuery: query,
              }),
            })),
    navigateSftpHostGroup: (paneId, path) =>
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                hostGroupPath: normalizeGroupPath(path),
                selectedHostId: null,
                connectingHostId: null,
                connectingEndpointId: null,
                connectionProgress: null,
              }),
            })),
    selectSftpHost: (paneId, hostId) =>
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                selectedHostId: hostId,
              }),
            })),
    connectSftpHost: async (paneId, hostId) => {
            const host = get().hosts.find((item) => item.id === hostId);
            if (!host) {
              return;
            }
            if (
              promptForMissingUsername(set, get, {
                hostId,
                source: "sftp",
                paneId,
              })
            ) {
              return;
            }
            const awsHost = isAwsEc2HostRecord(host) ? host : null;
            if (awsHost) {
              const disabledReason = getAwsEc2HostSftpDisabledReason(awsHost);
              if (disabledReason) {
                set((state) => ({
                  activeWorkspaceTab: "sftp",
                  sftp: updatePaneState(state, paneId, {
                    ...getPane(state, paneId),
                    sourceKind: "host",
                    endpoint: null,
                    connectingHostId: null,
                    connectingEndpointId: null,
                    connectionProgress: null,
                    selectedHostId: hostId,
                    isLoading: false,
                    errorMessage: disabledReason,
                    warningMessages: [],
                  }),
                }));
                return;
              }
            }
            const endpointId = globalThis.crypto.randomUUID();
            const initialConnectionProgress = awsHost
              ? {
                  endpointId,
                  hostId: awsHost.id,
                  stage: "checking-profile" as const,
                  message: `${awsHost.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
                }
              : null;
            set((state) => ({
              activeWorkspaceTab: "sftp",
              pendingAwsSftpConfigRetry: null,
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                sourceKind: "host",
                endpoint: null,
                connectingHostId: hostId,
                connectingEndpointId: endpointId,
                connectionProgress: initialConnectionProgress,
                selectedHostId: hostId,
                isLoading: true,
                errorMessage: undefined,
                warningMessages: [],
              }),
            }));
            try {
              const trusted = await ensureTrustedHost(set, {
                hostId,
                endpointId,
                action: {
                  kind: "sftp",
                  paneId,
                  hostId,
                  endpointId,
                },
              });
              if (!trusted) {
                set((state) => ({
                  sftp: updatePaneState(state, paneId, {
                    ...getPane(state, paneId),
                    connectingHostId: null,
                    connectingEndpointId: null,
                    connectionProgress: null,
                    selectedHostId: hostId,
                    isLoading: false,
                    errorMessage: undefined,
                  }),
                }));
                return;
              }
              await connectTrustedHostPane(set, get, {
                paneId,
                hostId,
                endpointId,
              });
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "호스트 키를 확인하지 못했습니다.";
              if (shouldPromptAwsSftpConfigRetry(host, message)) {
                set({
                  pendingAwsSftpConfigRetry: {
                    hostId,
                    paneId,
                    message,
                    suggestedUsername: awsHost?.awsSshUsername?.trim() ?? "",
                    suggestedPort: awsHost
                      ? getAwsEc2HostSshPort(awsHost)
                      : AWS_SFTP_DEFAULT_PORT,
                  },
                });
              }
              set((state) => ({
                sftp: updatePaneState(state, paneId, {
                  ...getPane(state, paneId),
                  sourceKind: "host",
                  endpoint: null,
                  connectingHostId: null,
                  connectingEndpointId: null,
                  connectionProgress: null,
                  selectedHostId: hostId,
                  isLoading: false,
                  errorMessage:
                    shouldPromptAwsSftpConfigRetry(host, message) ? undefined : message,
                  warningMessages: [],
                }),
              }));
            }
          },
    openSftpEntry: async (paneId, entryPath) => {
            const pane = getPane(get(), paneId);
            const entry = pane.entries.find((item) => item.path === entryPath);
            if (!entry || !entry.isDirectory) {
              return;
            }
            await loadPaneListing(set, get, paneId, entry.path, {
              pushToHistory: true,
            });
          },
    refreshSftpPane: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (pane.sourceKind === "host" && !pane.endpoint) {
              return;
            }
            await loadPaneListing(set, get, paneId, pane.currentPath, {
              pushToHistory: false,
            });
          },
    navigateSftpBack: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (pane.historyIndex <= 0) {
              return;
            }
            const nextPath = pane.history[pane.historyIndex - 1];
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                historyIndex: getPane(state, paneId).historyIndex - 1,
              }),
            }));
            await loadPaneListing(set, get, paneId, nextPath, {
              pushToHistory: false,
            });
          },
    navigateSftpForward: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (pane.historyIndex >= pane.history.length - 1) {
              return;
            }
            const nextPath = pane.history[pane.historyIndex + 1];
            set((state) => ({
              sftp: updatePaneState(state, paneId, {
                ...getPane(state, paneId),
                historyIndex: getPane(state, paneId).historyIndex + 1,
              }),
            }));
            await loadPaneListing(set, get, paneId, nextPath, {
              pushToHistory: false,
            });
          },
    navigateSftpParent: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (!pane.currentPath) {
              return;
            }
            const nextPath =
              pane.sourceKind === "local"
                ? await api.files.getParentPath(pane.currentPath)
                : parentPath(pane.currentPath);
            await loadPaneListing(set, get, paneId, nextPath, {
              pushToHistory: true,
            });
          },
    navigateSftpBreadcrumb: async (paneId, nextPath) => {
            await loadPaneListing(set, get, paneId, nextPath, {
              pushToHistory: true,
            });
          },
    selectSftpEntry: (paneId, input) =>
            set((state) => {
              const pane = getPane(state, paneId);
              return {
                sftp: updatePaneState(state, paneId, {
                  ...pane,
                  ...resolveNextSftpSelection(pane, input),
                }),
              };
            }),
    createSftpDirectory: async (paneId, name) => {
            const pane = getPane(get(), paneId);
            if (!name.trim()) {
              return;
            }
            if (pane.sourceKind === "local") {
              await api.files.mkdir(pane.currentPath, name.trim());
            } else if (pane.endpoint) {
              await api.sftp.mkdir({
                endpointId: pane.endpoint.id,
                path: pane.currentPath,
                name: name.trim(),
              });
            }
            await get().refreshSftpPane(paneId);
          },
    renameSftpSelection: async (paneId, nextName) => {
            const pane = getPane(get(), paneId);
            const targetPath = pane.selectedPaths[0];
            if (
              !targetPath ||
              pane.selectedPaths.length !== 1 ||
              !nextName.trim()
            ) {
              return;
            }
            if (pane.sourceKind === "local") {
              await api.files.rename(targetPath, nextName.trim());
            } else if (pane.endpoint) {
              await api.sftp.rename({
                endpointId: pane.endpoint.id,
                path: targetPath,
                nextName: nextName.trim(),
              });
            }
            await get().refreshSftpPane(paneId);
          },
    changeSftpSelectionPermissions: async (paneId, mode) => {
            const pane = getPane(get(), paneId);
            const targetPath = pane.selectedPaths[0];
            if (!targetPath || pane.selectedPaths.length !== 1) {
              return;
            }
            if (pane.sourceKind === "local") {
              await api.files.chmod(targetPath, mode);
            } else if (pane.endpoint) {
              await api.sftp.chmod({
                endpointId: pane.endpoint.id,
                path: targetPath,
                mode,
              });
            }
            await get().refreshSftpPane(paneId);
          },
    changeSftpSelectionOwner: async (paneId, input) => {
            const pane = getPane(get(), paneId);
            const targetPath = pane.selectedPaths[0];
            if (
              !targetPath ||
              pane.selectedPaths.length !== 1 ||
              pane.sourceKind !== "host" ||
              !pane.endpoint
            ) {
              return;
            }
            await api.sftp.chown({
              endpointId: pane.endpoint.id,
              path: targetPath,
              ...input,
            });
            await get().refreshSftpPane(paneId);
          },
    listSftpPrincipals: async (paneId, kind, query) => {
            const pane = getPane(get(), paneId);
            if (pane.sourceKind !== "host" || !pane.endpoint) {
              return [];
            }
            return api.sftp.listPrincipals({
              endpointId: pane.endpoint.id,
              kind,
              query,
              limit: 100,
            });
          },
    deleteSftpSelection: async (paneId) => {
            const pane = getPane(get(), paneId);
            if (pane.selectedPaths.length === 0) {
              return;
            }
            if (pane.sourceKind === "local") {
              await api.files.delete(pane.selectedPaths);
            } else if (pane.endpoint) {
              await api.sftp.delete({
                endpointId: pane.endpoint.id,
                paths: pane.selectedPaths,
              });
            }
            await get().refreshSftpPane(paneId);
          },
    downloadSftpSelection: async (paneId) => {
            const state = get();
            const sourcePane = getPane(state, paneId);
            if (
              sourcePane.sourceKind !== "host" ||
              !sourcePane.endpoint ||
              sourcePane.selectedPaths.length === 0
            ) {
              return;
            }
            const selectedItems = sourcePane.entries.filter((entry) =>
              sourcePane.selectedPaths.includes(entry.path),
            );
            if (selectedItems.length === 0) {
              return;
            }
            const downloadsPath = await api.files.getDownloadsDirectory();
            const targetPane: SftpPaneState = {
              ...createEmptyPane("left"),
              sourceKind: "local",
              currentPath: downloadsPath,
              lastLocalPath: downloadsPath,
            };
            await startSftpTransferForItems(set, {
              sourcePane,
              targetPane,
              targetPath: downloadsPath,
              items: selectedItems,
            });
          },
    prepareSftpTransfer: async (
            sourcePaneId,
            targetPaneId,
            targetPath,
            draggedPath = null,
          ) => {
            const state = get();
            const sourcePane = getPane(state, sourcePaneId);
            const targetPane = getPane(state, targetPaneId);
            const items = resolveTransferItemsFromPane(sourcePane, draggedPath);
            await startSftpTransferForItems(set, {
              sourcePane,
              targetPane,
              targetPath,
              items,
            });
          },
    prepareSftpExternalTransfer: async (
            targetPaneId,
            targetPath,
            droppedPaths,
          ) => {
            const targetPane = getPane(get(), targetPaneId);
            if (targetPane.sourceKind !== "host" || !targetPane.endpoint) {
              return;
            }
            const { items, warnings } =
              await resolveLocalTransferItemsFromPaths(droppedPaths);
            if (warnings.length > 0) {
              setSftpPaneWarnings(set, targetPaneId, warnings);
            }
            if (items.length === 0) {
              if (warnings.length === 0) {
                setSftpPaneWarnings(set, targetPaneId, [
                  "드롭한 항목 경로를 읽지 못했습니다.",
                ]);
              }
              return;
            }
            const sourcePane: SftpPaneState = {
              ...createEmptyPane("left"),
              sourceKind: "local",
              currentPath: "",
              lastLocalPath: "",
              entries: items,
              selectedPaths: items.map((item) => item.path),
              selectionAnchorPath: items[0]?.path ?? null,
            };
            await startSftpTransferForItems(set, {
              sourcePane,
              targetPane,
              targetPath,
              items,
            });
          },
    transferSftpSelectionToPane: async (sourcePaneId, targetPaneId) => {
            const state = get();
            const sourcePane = getPane(state, sourcePaneId);
            const targetPane = getPane(state, targetPaneId);
            if (
              !isBrowsableSftpPane(sourcePane) ||
              !isBrowsableSftpPane(targetPane)
            ) {
              return;
            }
            const items = resolveTransferItemsFromPane(sourcePane);
            await startSftpTransferForItems(set, {
              sourcePane,
              targetPane,
              targetPath: targetPane.currentPath,
              items,
            });
          },
    resolveSftpConflict: async (resolution, remember = false) => {
            const pending = get().sftp.pendingConflictDialog;
            if (!pending) {
              return;
            }
            let nextSettings = get().settings;
            if (remember) {
              nextSettings = await api.settings.update({
                sftpConflictPolicy: resolution,
              });
            }
            const job = await api.sftp.startTransfer({
              ...pending.input,
              conflictResolution: resolution,
              preserveMetadata: {
                mtime: nextSettings.sftpPreserveMtime ?? true,
                permissions: nextSettings.sftpPreservePermissions ?? false,
              },
            });
            set((state) => ({
              activeWorkspaceTab: "sftp",
              settings: remember ? nextSettings : state.settings,
              sftp: {
                ...state.sftp,
                pendingConflictDialog: null,
                transfers: upsertTransferJob(state.sftp.transfers, job),
              },
            }));
          },
    dismissSftpConflict: () =>
            set((state) => ({
              sftp: {
                ...state.sftp,
                pendingConflictDialog: null,
              },
            })),
    pauseTransfer: async (jobId) => {
            const existing = get().sftp.transfers.find((job) => job.id === jobId);
            if (!existing || existing.status !== "running") {
              return;
            }
            const nextJob = {
              ...existing,
              status: "paused" as const,
              etaSeconds: null,
              updatedAt: new Date().toISOString(),
            };
            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: upsertTransferJob(state.sftp.transfers, nextJob),
              },
            }));
            try {
              await api.sftp.pauseTransfer(jobId);
            } catch (error) {
              set((state) => ({
                sftp: {
                  ...state.sftp,
                  transfers: upsertTransferJob(state.sftp.transfers, existing),
                },
              }));
              throw error;
            }
          },
    resumeTransfer: async (jobId) => {
            const existing = get().sftp.transfers.find((job) => job.id === jobId);
            if (!existing || existing.status !== "paused") {
              return;
            }
            const nextJob = {
              ...existing,
              status: "running" as const,
              updatedAt: new Date().toISOString(),
            };
            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: upsertTransferJob(state.sftp.transfers, nextJob),
              },
            }));
            try {
              await api.sftp.resumeTransfer(jobId);
            } catch (error) {
              set((state) => ({
                sftp: {
                  ...state.sftp,
                  transfers: upsertTransferJob(state.sftp.transfers, existing),
                },
              }));
              throw error;
            }
          },
    cancelTransfer: async (jobId) => {
            const existing = get().sftp.transfers.find((job) => job.id === jobId);
            if (!existing) {
              return;
            }
            if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
              return;
            }

            const nextJob = {
              ...existing,
              status: "cancelling" as const,
              etaSeconds: null,
              updatedAt: new Date().toISOString(),
            };

            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: upsertTransferJob(state.sftp.transfers, nextJob),
              },
            }));

            try {
              await api.sftp.cancelTransfer(jobId);
            } catch (error) {
              set((state) => ({
                sftp: {
                  ...state.sftp,
                  transfers: upsertTransferJob(state.sftp.transfers, existing),
                },
              }));
              throw error;
            }
          },
    retryTransfer: async (jobId) => {
            const job = get().sftp.transfers.find((item) => item.id === jobId);
            if (!job?.request) {
              return;
            }
            const retryItems =
              job.failedItems && job.failedItems.length > 0
                ? job.failedItems.map((failed) => failed.item)
                : job.request.items;
            const nextJob = await api.sftp.startTransfer({
              ...job.request,
              items: retryItems,
              retryOfJobId: job.id,
            });
            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: upsertTransferJob(state.sftp.transfers, nextJob),
              },
            }));
          },
    dismissTransfer: (jobId) => {
            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: state.sftp.transfers.filter((job) => job.id !== jobId),
              },
            }));
          }
  };

}
