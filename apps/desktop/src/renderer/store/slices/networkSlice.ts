import type { SliceDeps } from "../services/context";
import type { NetworkSlice } from "../types";
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
  const { startPendingSessionConnect, startVncConnectionFlow } = sessionServices;
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
    // RDP 서버 인증서 확인. 프롬프트를 그리는 곳과 그동안 자기를 내려야 하는 곳이 형제라
    // 여기에 둔다(types.ts 주석 참고).
    pendingRdpCertificatePrompt: null,
    setPendingRdpCertificatePrompt: (prompt) => {
      set({ pendingRdpCertificatePrompt: prompt });
    },
    tailnetStatuses: {},
    localTailnetNodeName: null,
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
            // 누른 즉시 상태를 바꾼다.
            //
            // 이 아래에는 호스트 키 확인(프로브)과 코어의 SSH 연결이 있고, OTP 를 묻는 호스트면
            // 사람이 답할 때까지 몇십 초가 걸린다. 그동안 화면이 그대로면 사용자는 버튼이 눌렸는지
            // 알 수 없다 — 실기기에서 "start 가 눌린 건가?" 로 겪은 그 상태다.
            //
            // 중간에 멈추면(사용자명·호스트 키 프롬프트) 또는 실패하면 원래 상태로 되돌린다.
            // 되돌리지 않으면 아무 일도 진행되지 않는데 화면만 "starting" 으로 남는다.
            const previousRuntime = get().portForwardRuntimes.find(
              (runtime) => runtime.ruleId === ruleId,
            );
            const restoreRuntime = () => {
              set((state) => ({
                portForwardRuntimes: previousRuntime
                  ? upsertForwardRuntime(state.portForwardRuntimes, previousRuntime)
                  : state.portForwardRuntimes.filter(
                      (runtime) => runtime.ruleId !== ruleId,
                    ),
              }));
            };
            set((state) => ({
              portForwardRuntimes: upsertForwardRuntime(state.portForwardRuntimes, {
                ...(previousRuntime ?? {
                  ruleId,
                  hostId: rule.hostId,
                  transport: rule.transport,
                  bindAddress: "bindAddress" in rule ? rule.bindAddress : "127.0.0.1",
                  bindPort: "bindPort" in rule ? rule.bindPort : 0,
                }),
                status: "starting",
                message: undefined,
                updatedAt: new Date().toISOString(),
              }),
            }));

            const host = get().hosts.find((item) => item.id === rule.hostId);
            if (
              host &&
              promptForMissingUsername(set, get, {
                hostId: rule.hostId,
                source: "portForward",
                ruleId,
              })
            ) {
              restoreRuntime();
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
              let trusted = false;
              try {
                trusted = await ensureTrustedHost(set, {
                  hostId: rule.hostId,
                  // 이미 신뢰된 호스트/베스천은 재-probe 생략(중복 순회 방지, 실연결이 strict 검사).
                  action: {
                    kind: "portForward",
                    ruleId,
                    hostId: rule.hostId,
                  },
                });
              } catch (error) {
                // 프로브 실패(도달 불가·점프 인증 실패 등). 이유는 활동 로그에 남고, 여기서는
                // 화면을 원래대로 돌려 놓는다.
                restoreRuntime();
                throw error;
              }
              if (!trusted) {
                // 호스트 키 신뢰 프롬프트가 떴다 — 사용자가 수락하면 그 경로가 다시 시작한다.
                restoreRuntime();
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
    revokeRdpCertificateTrust: async (hostId) => {
            const next = await api.rdp.revokeCertificateTrust(hostId);
            if (!next) {
              return;
            }
            // 돌려받은 레코드로 갈아 끼운다 — 목록을 다시 받아오지 않는다(호스트 전체를 다시
            // 읽으면 이 화면 말고도 흔들린다). 메인이 동기화·감사 로그를 이미 처리했다.
            set((state) => ({
              hosts: state.hosts.map((host) => (host.id === next.id ? next : host)),
            }));
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
            // 연결이 이 답을 기다리는 중이면 여기서 끝난다 — 다시 연결하지 않는다. 그것이 이 흐름의
            // 요점이다(다시 연결하면 OTP 를 한 번 더 물어야 한다).
            if (pending.liveChallengeId) {
              await api.ssh.respondHostKeyTrust({
                challengeId: pending.liveChallengeId,
                trust: true,
              });
              return;
            }
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
            if (pending.action.kind === "vnc") {
              // 경유 SSH 호스트를 방금 신뢰했다. 멈춰 둔 VNC 접속을 같은 탭에서 이어간다.
              const host = get().hosts.find(
                (item) => item.id === pending.action.hostId,
              );
              if (host && pending.sessionId) {
                await startVncConnectionFlow(set, get, host, pending.sessionId);
              }
              return;
            }
            await startTrustedPortForward(set, get, pending.action.ruleId);
          },
    dismissPendingHostKeyPrompt: () => {
            // 살아 있는 질의는 거절을 코어에 알려야 그 연결이 끝난다(안 알리면 계속 기다린다).
            const pendingLive = get().pendingHostKeyPrompt?.liveChallengeId;
            if (pendingLive) {
              void api.ssh
                .respondHostKeyTrust({ challengeId: pendingLive, trust: false })
                .catch(() => undefined);
            }
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
