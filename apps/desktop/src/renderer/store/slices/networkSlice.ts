import type { SliceDeps } from "../services/context";
import type { NetworkSlice } from "../types";
import {
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
} from "../utils";
import { cancelReconnect } from "../services/reconnect-orchestrator";
import { createContainersServices } from "../services/containers";
import { createNetworkServices } from "../services/network";
import { createSessionServices } from "../services/session";
import { createSftpServices } from "../services/sftp";
import { t } from '../../i18n';

export function createNetworkSlice(deps: SliceDeps): NetworkSlice {
  const { api, set, get } = deps;
  const services = createNetworkServices(deps);
  const sessionServices = createSessionServices(deps);
  const containersServices = createContainersServices(deps);
  const sftpServices = createSftpServices(deps);

  const {
    startTrustedPortForward,
    ensureTrustedHost,
    markSessionError,
    syncOperationalData,
    promptForMissingUsername,
  } = services;
  const { startPendingSessionConnect } = sessionServices;
  const {
    clearContainerTabConnectionOverlay,
    startPendingContainerShellConnect,
    loadContainersList,
  } = containersServices;
  const { connectTrustedHostPane, uploadFilesToHostPath } = sftpServices;

  return {
    portForwards: [],
    dnsOverrides: [],
    snippets: [],
    portForwardRuntimes: [],
    knownHosts: [],
    pendingHostKeyPrompt: null,
    savePortForward: async (ruleId, draft) => {
            const next = ruleId
              ? await api.portForwards.update(ruleId, draft)
              : await api.portForwards.create(draft);
            set((state) => ({
              homeSection: "portForwarding",
              portForwards: sortPortForwards([
                ...state.portForwards.filter((rule) => rule.id !== next.id),
                next,
              ]),
            }));
          },
    saveDnsOverride: async (overrideId, draft) => {
            const next = overrideId
              ? await api.dnsOverrides.update(overrideId, draft)
              : await api.dnsOverrides.create(draft);
            set((state) => ({
              homeSection: "portForwarding",
              dnsOverrides: sortDnsOverrides([
                ...state.dnsOverrides.filter((override) => override.id !== next.id),
                next,
              ]),
            }));
            await syncOperationalData(set);
          },
    setStaticDnsOverrideActive: async (overrideId, active) => {
            try {
              const next = await api.dnsOverrides.setStaticActive(overrideId, active);
              set((state) => ({
                dnsOverrides: sortDnsOverrides([
                  ...state.dnsOverrides.filter((override) => override.id !== next.id),
                  next,
                ]),
              }));
              await syncOperationalData(set).catch(() => undefined);
            } catch (error) {
              await syncOperationalData(set).catch(() => undefined);
              throw error;
            }
          },
    removeDnsOverride: async (overrideId) => {
            await api.dnsOverrides.remove(overrideId);
            set((state) => ({
              dnsOverrides: state.dnsOverrides.filter(
                (override) => override.id !== overrideId,
              ),
            }));
            await syncOperationalData(set);
          },
    saveSnippet: async (snippetId, draft) => {
            const next = snippetId
              ? await api.snippets.update(snippetId, draft)
              : await api.snippets.create(draft);
            set((state) => ({
              snippets: [
                ...state.snippets.filter((entry) => entry.id !== next.id),
                next,
              ].sort((left, right) => left.label.localeCompare(right.label)),
            }));
            return next;
          },
    removeSnippet: async (snippetId) => {
            await api.snippets.remove(snippetId);
            set((state) => ({
              snippets: state.snippets.filter((entry) => entry.id !== snippetId),
              hosts: state.hosts.map((host) =>
                (host.kind === "ssh" ||
                  host.kind === "aws-ec2" ||
                  host.kind === "warpgate-ssh") &&
                host.startupCommand?.type === "snippet" &&
                host.startupCommand.snippetId === snippetId
                  ? { ...host, startupCommand: null }
                  : host,
              ),
            }));
          },
    removePortForward: async (ruleId) => {
            await api.portForwards.remove(ruleId);
            set((state) => ({
              portForwards: state.portForwards.filter((rule) => rule.id !== ruleId),
              dnsOverrides: state.dnsOverrides.filter(
                (override) => !isLinkedDnsOverrideRecord(override) || override.portForwardRuleId !== ruleId,
              ),
              portForwardRuntimes: state.portForwardRuntimes.filter(
                (runtime) => runtime.ruleId !== ruleId,
              ),
            }));
            await syncOperationalData(set);
          },
    startPortForward: async (ruleId) => {
            const rule = get().portForwards.find((item) => item.id === ruleId);
            if (!rule) {
              return;
            }
            const host = get().hosts.find((item) => item.id === rule.hostId);
            if (
              host &&
              promptForMissingUsername(set, get, {
                hostId: rule.hostId,
                source: "portForward",
                ruleId,
              })
            ) {
              return;
            }
            const requiresTrustedHost =
              host?.kind === "ssh" ||
              host?.kind === "warpgate-ssh" ||
              // 서버 프록시 EC2 포트포워딩은 네이티브 SSM이 아니라 SSH -L로 붙으므로
              // strict 호스트키 검사를 탄다 → 시작 전에 호스트 키 신뢰가 선행돼야 한다.
              (host?.kind === "aws-ec2" &&
                host.awsSsmServerProxyEnabled === true);
            if (requiresTrustedHost) {
              const trusted = await ensureTrustedHost(set, {
                hostId: rule.hostId,
                // 이미 신뢰된 호스트/베스천은 재-probe 생략(중복 순회 방지, 실연결이 strict 검사).
                skipProbeIfAlreadyTrusted: true,
                action: {
                  kind: "portForward",
                  ruleId,
                  hostId: rule.hostId,
                },
              });
              if (!trusted) {
                return;
              }
            }
            await startTrustedPortForward(set, get, ruleId);
          },
    stopPortForward: async (ruleId) => {
            // 사용자가 직접 멈추면 진행 중 자동 재연결을 취소(의도적 종료).
            cancelReconnect(ruleId, "user-stop");
            await api.portForwards.stop(ruleId);
            const rule = get().portForwards.find((item) => item.id === ruleId);
            set((state) => ({
              portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, {
                ...(state.portForwardRuntimes.find(
                  (runtime) => runtime.ruleId === ruleId,
                ) ?? {
                  ruleId,
                  hostId: "",
                  transport: rule?.transport ?? "ssh",
                  mode: "local",
                  bindAddress: "127.0.0.1",
                  bindPort: 0,
                }),
                status: "stopped",
                updatedAt: new Date().toISOString(),
                message: undefined,
              }),
            }));
          },
    removeKnownHost: async (id) => {
            await api.knownHosts.remove(id);
            set((state) => ({
              knownHosts: state.knownHosts.filter((record) => record.id !== id),
            }));
            await syncOperationalData(set);
          },
    acceptPendingHostKeyPrompt: async (mode) => {
            const pending = get().pendingHostKeyPrompt;
            if (!pending) {
              return;
            }
            if (mode === "replace") {
              await api.knownHosts.replace(toTrustInput(pending.probe));
            } else {
              await api.knownHosts.trust(toTrustInput(pending.probe));
            }
            set({ pendingHostKeyPrompt: null });
            await syncOperationalData(set);
            if (pending.action.kind === "ssh") {
              if (pending.sessionId) {
                await startPendingSessionConnect(
                  set,
                  get,
                  pending.sessionId,
                  pending.action.hostId,
                  pending.action.secrets,
                );
              }
              return;
            }
            if (pending.action.kind === "sftp") {
              await connectTrustedHostPane(set, get, {
                paneId: pending.action.paneId,
                hostId: pending.action.hostId,
                endpointId: pending.action.endpointId,
                secrets: pending.action.secrets,
              });
              return;
            }
            if (pending.action.kind === "terminalUpload") {
              await uploadFilesToHostPath(set, get, {
                hostId: pending.action.hostId,
                targetPath: pending.action.targetPath,
                localPaths: pending.action.localPaths,
                endpointId: pending.action.endpointId,
                skipHostTrustPrompt: true,
              });
              return;
            }
            if (pending.action.kind === "containers") {
              await loadContainersList(set, get, pending.action.hostId);
              return;
            }
            if (pending.action.kind === "containerShell") {
              if (pending.sessionId) {
                await startPendingContainerShellConnect(
                  set,
                  get,
                  pending.sessionId,
                  pending.action.hostId,
                  pending.action.containerId,
                );
              }
              return;
            }
            await startTrustedPortForward(set, get, pending.action.ruleId);
          },
    dismissPendingHostKeyPrompt: () => {
            const pending = get().pendingHostKeyPrompt;
            if (pending?.action.kind === "containerShell" && pending.sessionId) {
              const message = t('networkSlice.hostKeyCancelled', { label: pending.probe.hostLabel });
              markSessionError(set, pending.sessionId, message, {
                progress: resolveErrorProgress(message),
              });
              clearContainerTabConnectionOverlay(set, pending.action.hostId);
              set({ pendingHostKeyPrompt: null });
              return;
            }
            if (pending?.sessionId) {
              const message = t('networkSlice.hostKeyCancelled', { label: pending.probe.hostLabel });
              markSessionError(set, pending.sessionId, message, {
                progress: resolveErrorProgress(message),
              });
              set({ pendingHostKeyPrompt: null });
              return;
            }
            set({ pendingHostKeyPrompt: null });
          }
  };

}
