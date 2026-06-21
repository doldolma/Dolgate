import type { SliceDeps } from "../services/context";
import type {
  AppState,
  ContainerTunnelTabState,
  EcsTunnelTabState,
  RuntimeEventSlice,
} from "../types";
import type {
  KeyboardInteractiveChallenge,
  KeyboardInteractivePrompt,
  TerminalTab,
} from "@shared";
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
import { createBootstrapSyncServices } from "../services/bootstrap-sync";
import { updateStoredSshUsername } from "../services/credential-retry";
import { createRuntimeEventServices } from "../services/runtime-events";
import {
  cancelReconnect,
  isReconnecting,
  scheduleReconnect,
} from "../services/reconnect-orchestrator";
import { classifyReconnect } from "../utils/reconnect-classify";
import type { CoreEvent, HostRecord } from "@shared";

// AWS SSM 세션 종료 메시지에서 종료 코드를 뽑는다(예: "AWS SSM session exited with code 1").
const AWS_SSM_SESSION_EXIT_PATTERN = /AWS SSM session exited with code\s+(-?\d+)/i;

// 예기치 않은 끊김(closed/error)에 대해 터미널 세션을 자동 재연결할지 판별한다.
// - 활성 연결(connected) + 실제 출력이 있던 세션만 대상(최초 연결 실패는 기존 경로).
// - 의도적 종료(상태가 connected가 아님)·인증/영구 오류는 제외.
// - 원격 정상 종료(exit)는 빈 close 메시지(또는 reason=remote-exit, SSM code 0)로 오므로 제외.
// - 대상: ssh/warpgate-ssh(전송 reason·메시지 기준) + aws-ec2(SSM 종료코드 기준).
//   serial·로컬·컨테이너·ecs-exec는 제외.
function shouldAutoReconnectSession(
  tab: TerminalTab | undefined,
  host: HostRecord | undefined,
  event: CoreEvent,
  autoReconnectEnabled: boolean,
): boolean {
  if (!autoReconnectEnabled) {
    return false;
  }
  if (!tab || tab.source !== "host" || !host) {
    return false;
  }
  if (
    host.kind !== "ssh" &&
    host.kind !== "warpgate-ssh" &&
    host.kind !== "aws-ec2"
  ) {
    return false;
  }
  // ecs-exec 셸은 SSM이지만 태스크 종속이라 재연결 대상이 아니다.
  if (tab.shellKind === "aws-ecs-exec") {
    return false;
  }
  if (tab.status !== "connected" || tab.hasReceivedOutput !== true) {
    return false;
  }
  const payload = event.payload as
    | { message?: unknown; reason?: unknown }
    | undefined;
  const message = String(payload?.message ?? "");

  // aws-ec2(SSM): reason discriminator가 없으므로 SSM 종료 코드로 판별한다.
  if (host.kind === "aws-ec2") {
    if (event.type === "error") {
      return classifyReconnect(message) !== "permanent";
    }
    if (event.type === "closed") {
      const exitMatch = AWS_SSM_SESSION_EXIT_PATTERN.exec(message);
      if (exitMatch) {
        // code 0 = 사용자 정상 종료 → 재연결 안 함. 비정상 종료 = 드롭 → 재연결.
        return Number(exitMatch[1]) !== 0;
      }
      if (!message.trim()) {
        return false; // 빈 메시지 = 정상 종료로 간주
      }
      return classifyReconnect(message) !== "permanent";
    }
    return false;
  }

  // ssh / warpgate-ssh
  if (event.type === "closed") {
    // Go 코어가 제공하는 reason discriminator를 우선 사용한다(Part E).
    const reason = String(payload?.reason ?? "");
    if (reason === "remote-exit" || reason === "client") {
      return false; // 정상 종료/클라이언트 요청 → 되살리지 않음
    }
    if (reason === "transport" || reason === "keepalive") {
      return true; // 전송 단절/keepalive 실패 → 재연결
    }
    // 구버전 코어(reason 없음): 빈 close 메시지는 정상 종료로 간주(오탐 방지),
    // 비어있지 않으면 transient 여부로 판단.
    if (!message.trim()) {
      return false;
    }
    return classifyReconnect(message) === "transient";
  }
  if (event.type === "error") {
    return classifyReconnect(message) === "transient";
  }
  return false;
}

// 자동 재연결 트리거 시 탭을 제거/에러로 두지 않고 connecting+reconnecting 상태로
// 유지한다. 정확한 시도횟수/메시지는 이후 오케스트레이터의 renderScheduled가 채운다.
function applySessionReconnecting(
  state: AppState,
  sessionId: string,
): Partial<AppState> {
  return {
    tabs: state.tabs.map((tab) =>
      tab.sessionId === sessionId
        ? {
            ...tab,
            status: "connecting" as const,
            errorMessage: undefined,
            connectionProgress: createConnectionProgress(
              "reconnecting",
              "연결이 끊겨 재연결 중입니다…",
            ),
            lastEventAt: new Date().toISOString(),
          }
        : tab,
    ),
  };
}

export function createRuntimeEventSlice(deps: SliceDeps): RuntimeEventSlice {
  const { api, set, get } = deps;
  const services = createRuntimeEventServices(deps);
  const bootstrapServices = createBootstrapSyncServices(deps);

  const {
    openedInteractiveBrowserChallenges,
    scheduleActivityLogsRefresh,
  } = services;
  const { refreshHostAndKeychainState } = bootstrapServices;
  const missingContainerShellMessage =
    "컨테이너 셸을 시작하지 못했습니다. /bin/sh 또는 /bin/bash가 없거나 셸이 바로 종료되었습니다.";
  const missingEcsShellMessage =
    "ECS 컨테이너 셸을 시작하지 못했습니다. /bin/sh가 없거나 셸 프로세스가 바로 종료되었을 수 있습니다.";
  const IMMEDIATE_ECS_CLOSE_WINDOW_MS = 5_000;
  const isLikelyMissingShellErrorMessage = (message: string): boolean =>
    /status 127|command not found|not found|no such file|cannot execute|exec format|executable file not found/i.test(
      message,
    );
  const awsSsmSessionExitPattern =
    /^AWS SSM session exited with code\s+(-?\d+)/i;

  return {
    handleActivityLogsChanged: () => {
      scheduleActivityLogsRefresh();
    },
    handleCoreEvent: (event) => {
            const sessionId = event.sessionId;
            const endpointId = event.endpointId;
            const activeRetryAttemptBeforeUpdate =
              get().activeCredentialRetryAttempt;
            scheduleActivityLogsRefresh();

            // mosh 연결 상태 이벤트 — 해당 탭의 moshState/lastMoshResponseAt만 갱신한다.
            if (event.type === "moshState" && sessionId) {
              const payload = event.payload as {
                state?: string;
                lastResponseAt?: string;
              };
              const moshState =
                payload.state === "reconnecting" ||
                payload.state === "disconnected"
                  ? payload.state
                  : "connected";
              set((state) => ({
                tabs: state.tabs.map((tab) =>
                  tab.sessionId === sessionId
                    ? {
                        ...tab,
                        moshState,
                        lastMoshResponseAt:
                          payload.lastResponseAt ??
                          tab.lastMoshResponseAt ??
                          null,
                      }
                    : tab,
                ),
              }));
              return;
            }
    
            if (endpointId) {
              const containerHostId = resolveContainersHostIdByEndpoint(endpointId);
              if (containerHostId) {
                if (event.type === "keyboardInteractiveChallenge") {
                  const payload = event.payload as Record<string, unknown>;
                  const challenge: KeyboardInteractiveChallenge = {
                    endpointId,
                    challengeId: String(payload.challengeId ?? ""),
                    attempt: Number(payload.attempt ?? 1),
                    name: typeof payload.name === "string" ? payload.name : null,
                    instruction: String(payload.instruction ?? ""),
                    prompts: Array.isArray(payload.prompts)
                      ? payload.prompts.map((prompt) => {
                          const candidate = prompt as Record<string, unknown>;
                          return {
                            label: String(candidate.label ?? ""),
                            echo: Boolean(candidate.echo),
                          } satisfies KeyboardInteractivePrompt;
                        })
                      : [],
                  };
                  const currentState = get();
                  const currentHost = currentState.hosts.find(
                    (host) => host.id === containerHostId,
                  );
                  const interactiveState = resolveInteractiveAuthUiState(
                    currentHost,
                    challenge,
                  );
                  const browserChallengeKey = buildInteractiveBrowserChallengeKey({
                    endpointId,
                    challengeId: challenge.challengeId,
                    approvalUrl: interactiveState.approvalUrl,
                  });
    
                  if (
                    interactiveState.approvalUrl &&
                    !openedInteractiveBrowserChallenges.has(browserChallengeKey)
                  ) {
                    openedInteractiveBrowserChallenges.add(browserChallengeKey);
                    void api.shell
                      .openExternal(interactiveState.approvalUrl)
                      .catch(() => undefined);
                  }
    
                  set((state) => {
                    const currentTab = findContainersTab(state, containerHostId);
                    return {
                      activeWorkspaceTab: currentTab
                        ? "containers"
                        : state.activeWorkspaceTab,
                      activeContainerHostId: currentTab
                        ? containerHostId
                        : state.activeContainerHostId,
                      pendingInteractiveAuth:
                        currentHost === undefined
                          ? state.pendingInteractiveAuth
                          : {
                              source: "containers",
                              endpointId,
                              hostId: containerHostId,
                              challengeId: challenge.challengeId,
                              name: challenge.name ?? null,
                              instruction: challenge.instruction,
                              prompts: challenge.prompts,
                              provider: interactiveState.provider,
                              approvalUrl: interactiveState.approvalUrl,
                              authCode: interactiveState.authCode,
                              autoSubmitted: interactiveState.autoSubmitted,
                            },
                      containerTabs: currentTab
                        ? upsertContainersTab(state.containerTabs, {
                            ...currentTab,
                            isLoading: true,
                          })
                        : state.containerTabs,
                    };
                  });
    
                  if (interactiveState.autoSubmitted) {
                    void api.ssh
                      .respondKeyboardInteractive({
                        endpointId,
                        challengeId: challenge.challengeId,
                        responses: interactiveState.autoResponses,
                      })
                      .catch(() => undefined);
                  }
                  return;
                }
    
                if (event.type === "keyboardInteractiveResolved") {
                  set((state) => {
                    if (
                      !isPendingContainersInteractiveAuth(
                        state.pendingInteractiveAuth,
                      ) ||
                      state.pendingInteractiveAuth.endpointId !== endpointId
                    ) {
                      return state;
                    }
                    const currentTab = findContainersTab(state, containerHostId);
                    const currentHost = state.hosts.find(
                      (host) => host.id === containerHostId,
                    );
                    if (state.pendingInteractiveAuth.provider === "warpgate") {
                      return state;
                    }
                    return {
                      pendingInteractiveAuth: null,
                      containerTabs: currentTab
                        ? upsertContainersTab(state.containerTabs, {
                            ...currentTab,
                            connectionProgress:
                              currentHost === undefined
                                ? currentTab.connectionProgress
                                : createContainerConnectionProgress(
                                    containerHostId,
                                    endpointId,
                                    "connecting-containers",
                                    `${currentHost.label} 컨테이너 연결을 진행하는 중입니다.`,
                                  ),
                          })
                        : state.containerTabs,
                    };
                  });
                  return;
                }
    
                if (
                  event.type === "containersConnected" ||
                  event.type === "containersDisconnected" ||
                  event.type === "containersError"
                ) {
                  set((state) => {
                    const currentTab = findContainersTab(state, containerHostId);
                    return {
                      pendingInteractiveAuth:
                        isPendingContainersInteractiveAuth(
                          state.pendingInteractiveAuth,
                        ) &&
                        state.pendingInteractiveAuth.endpointId === endpointId
                          ? null
                          : state.pendingInteractiveAuth,
                      containerTabs: currentTab
                        ? upsertContainersTab(state.containerTabs, {
                            ...currentTab,
                            isLoading:
                              event.type === "containersConnected"
                                ? currentTab.isLoading
                                : false,
                            connectionProgress:
                              event.type === "containersConnected"
                                ? currentTab.connectionProgress
                                : null,
                          })
                        : state.containerTabs,
                    };
                  });
                  return;
                }
              }
    
              const portForwardRule = get().portForwards.find(
                (rule) => rule.id === endpointId,
              );
              if (portForwardRule) {
                if (event.type === "keyboardInteractiveChallenge") {
                  const payload = event.payload as Record<string, unknown>;
                  const challenge: KeyboardInteractiveChallenge = {
                    endpointId,
                    challengeId: String(payload.challengeId ?? ""),
                    attempt: Number(payload.attempt ?? 1),
                    name: typeof payload.name === "string" ? payload.name : null,
                    instruction: String(payload.instruction ?? ""),
                    prompts: Array.isArray(payload.prompts)
                      ? payload.prompts.map((prompt) => {
                          const candidate = prompt as Record<string, unknown>;
                          return {
                            label: String(candidate.label ?? ""),
                            echo: Boolean(candidate.echo),
                          } satisfies KeyboardInteractivePrompt;
                        })
                      : [],
                  };
                  const currentHost = get().hosts.find(
                    (host) => host.id === portForwardRule.hostId,
                  );
                  const interactiveState = resolveInteractiveAuthUiState(
                    currentHost,
                    challenge,
                  );
                  const browserChallengeKey = buildInteractiveBrowserChallengeKey({
                    endpointId,
                    challengeId: challenge.challengeId,
                    approvalUrl: interactiveState.approvalUrl,
                  });
    
                  if (
                    interactiveState.approvalUrl &&
                    !openedInteractiveBrowserChallenges.has(browserChallengeKey)
                  ) {
                    openedInteractiveBrowserChallenges.add(browserChallengeKey);
                    void api.shell
                      .openExternal(interactiveState.approvalUrl)
                      .catch(() => undefined);
                  }
    
                  set((state) => ({
                    homeSection: "portForwarding",
                    pendingInteractiveAuth:
                      currentHost === undefined
                        ? state.pendingInteractiveAuth
                        : {
                            source: "portForward",
                            endpointId,
                            ruleId: portForwardRule.id,
                            hostId: portForwardRule.hostId,
                            challengeId: challenge.challengeId,
                            name: challenge.name ?? null,
                            instruction: challenge.instruction,
                            prompts: challenge.prompts,
                            provider: interactiveState.provider,
                            approvalUrl: interactiveState.approvalUrl,
                            authCode: interactiveState.authCode,
                            autoSubmitted: interactiveState.autoSubmitted,
                          },
                  }));
    
                  if (interactiveState.autoSubmitted) {
                    void api.ssh
                      .respondKeyboardInteractive({
                        endpointId,
                        challengeId: challenge.challengeId,
                        responses: interactiveState.autoResponses,
                      })
                      .catch(() => undefined);
                  }
                  return;
                }
    
                if (event.type === "keyboardInteractiveResolved") {
                  set((state) => {
                    if (
                      !isPendingPortForwardInteractiveAuth(
                        state.pendingInteractiveAuth,
                      ) ||
                      state.pendingInteractiveAuth.endpointId !== endpointId
                    ) {
                      return state;
                    }
                    if (state.pendingInteractiveAuth.provider === "warpgate") {
                      return state;
                    }
                    return {
                      pendingInteractiveAuth: null,
                    };
                  });
                  return;
                }
    
                if (
                  event.type === "portForwardStarted" ||
                  event.type === "portForwardStopped" ||
                  event.type === "portForwardError"
                ) {
                  set((state) => ({
                    pendingInteractiveAuth:
                      isPendingPortForwardInteractiveAuth(
                        state.pendingInteractiveAuth,
                      ) &&
                      state.pendingInteractiveAuth.endpointId === endpointId
                        ? null
                        : state.pendingInteractiveAuth,
                  }));
                  return;
                }
              }
    
              if (event.type === "keyboardInteractiveChallenge") {
                const payload = event.payload as Record<string, unknown>;
                const challenge: KeyboardInteractiveChallenge = {
                  endpointId,
                  challengeId: String(payload.challengeId ?? ""),
                  attempt: Number(payload.attempt ?? 1),
                  name: typeof payload.name === "string" ? payload.name : null,
                  instruction: String(payload.instruction ?? ""),
                  prompts: Array.isArray(payload.prompts)
                    ? payload.prompts.map((prompt) => {
                        const candidate = prompt as Record<string, unknown>;
                        return {
                          label: String(candidate.label ?? ""),
                          echo: Boolean(candidate.echo),
                        } satisfies KeyboardInteractivePrompt;
                      })
                    : [],
                };
                const currentState = get();
                const paneId = resolveSftpPaneIdByEndpoint(currentState, endpointId);
                if (!paneId) {
                  return;
                }
                const pane = getPane(currentState, paneId);
                const hostId =
                  pane.connectingHostId ?? pane.selectedHostId ?? pane.endpoint?.hostId ?? null;
                const currentHost = hostId
                  ? currentState.hosts.find((host) => host.id === hostId)
                  : undefined;
                const interactiveState = resolveInteractiveAuthUiState(
                  currentHost,
                  challenge,
                );
                const browserChallengeKey = buildInteractiveBrowserChallengeKey({
                  endpointId,
                  challengeId: challenge.challengeId,
                  approvalUrl: interactiveState.approvalUrl,
                });
    
                if (
                  interactiveState.approvalUrl &&
                  !openedInteractiveBrowserChallenges.has(browserChallengeKey)
                ) {
                  openedInteractiveBrowserChallenges.add(browserChallengeKey);
                  void api.shell
                    .openExternal(interactiveState.approvalUrl)
                    .catch(() => undefined);
                }
    
                set((state) => ({
                  activeWorkspaceTab: "sftp",
                  pendingInteractiveAuth:
                    hostId === null
                      ? state.pendingInteractiveAuth
                      : {
                          source: "sftp",
                          paneId,
                          endpointId,
                          hostId,
                          challengeId: challenge.challengeId,
                          name: challenge.name ?? null,
                          instruction: challenge.instruction,
                          prompts: challenge.prompts,
                          provider: interactiveState.provider,
                          approvalUrl: interactiveState.approvalUrl,
                          authCode: interactiveState.authCode,
                          autoSubmitted: interactiveState.autoSubmitted,
                        },
                }));
    
                if (interactiveState.autoSubmitted) {
                  void api.ssh
                    .respondKeyboardInteractive({
                      endpointId,
                      challengeId: challenge.challengeId,
                      responses: interactiveState.autoResponses,
                    })
                    .catch(() => undefined);
                }
                return;
              }
    
              if (event.type === "keyboardInteractiveResolved") {
                set((state) => {
                  if (
                    !isPendingSftpInteractiveAuth(state.pendingInteractiveAuth) ||
                    state.pendingInteractiveAuth.endpointId !== endpointId
                  ) {
                    return state;
                  }
                  if (state.pendingInteractiveAuth.provider === "warpgate") {
                    return state;
                  }
                  return {
                    pendingInteractiveAuth: null,
                  };
                });
                return;
              }
    
              if (
                event.type === "sftpConnected" ||
                event.type === "sftpDisconnected" ||
                event.type === "sftpError" ||
                event.type === "sftpSudoStatus"
              ) {
                // 자동 재연결 판별(set 이전). 드롭은 sftpError로 surface된다(Go SFTP엔
                // keepalive 없음). 연결돼 있던 pane(endpoint 존재) 또는 진행 중 재연결의
                // transient 에러면 백오프 재연결. 영구 오류는 제외.
                const sftpPaneId = resolveSftpPaneIdByEndpoint(get(), endpointId);
                const sftpPaneBefore = sftpPaneId
                  ? getPane(get(), sftpPaneId)
                  : null;
                const sftpActiveReconnect = sftpPaneId
                  ? isReconnecting(sftpPaneId)
                  : false;
                const sftpReconnectHostId =
                  sftpPaneBefore?.endpoint?.hostId ??
                  sftpPaneBefore?.connectingHostId ??
                  sftpPaneBefore?.selectedHostId ??
                  null;
                const sftpPermanent =
                  classifyReconnect(
                    String(
                      (event.payload as { message?: unknown } | undefined)
                        ?.message ?? "",
                    ),
                  ) === "permanent";
                const sftpWillReconnect =
                  get().settings.autoReconnectEnabled &&
                  sftpPaneId != null &&
                  sftpReconnectHostId != null &&
                  event.type === "sftpError" &&
                  !sftpPermanent &&
                  (sftpPaneBefore?.endpoint != null || sftpActiveReconnect);

                set((state) => {
                  const paneId = resolveSftpPaneIdByEndpoint(state, endpointId);
                  if (!paneId) {
                    return {
                      pendingInteractiveAuth:
                        isPendingSftpInteractiveAuth(state.pendingInteractiveAuth) &&
                        state.pendingInteractiveAuth.endpointId === endpointId
                          ? null
                          : state.pendingInteractiveAuth,
                    };
                  }
                  const pane = getPane(state, paneId);
                  const sudoStatus =
                    typeof event.payload.status === "string" &&
                    (event.payload.status === "probing" ||
                      event.payload.status === "root" ||
                      event.payload.status === "passwordless" ||
                      event.payload.status === "passwordRequired" ||
                      event.payload.status === "unavailable")
                      ? event.payload.status
                      : "unknown";
                  return {
                    pendingInteractiveAuth:
                      isPendingSftpInteractiveAuth(state.pendingInteractiveAuth) &&
                      state.pendingInteractiveAuth.endpointId === endpointId
                        ? null
                        : state.pendingInteractiveAuth,
                    sftp: updatePaneState(state, paneId, {
                      ...pane,
                      endpoint:
                        event.type === "sftpSudoStatus" && pane.endpoint
                          ? {
                              ...pane.endpoint,
                              sudoStatus,
                            }
                          : pane.endpoint,
                      connectionProgress:
                        event.type === "sftpError" || event.type === "sftpDisconnected"
                          ? null
                          : pane.connectionProgress,
                    }),
                  };
                });

                if (sftpWillReconnect && sftpPaneId) {
                  scheduleReconnect({
                    kind: "sftp",
                    key: sftpPaneId,
                    meta: { hostId: sftpReconnectHostId },
                  });
                } else if (
                  sftpPaneId &&
                  sftpActiveReconnect &&
                  (event.type === "sftpConnected" ||
                    (event.type === "sftpError" && sftpPermanent))
                ) {
                  cancelReconnect(sftpPaneId, "resolved");
                }
                return;
              }

              return;
            }

            if (!sessionId) {
              return;
            }
    
            if (event.type === "keyboardInteractiveChallenge") {
              const payload = event.payload as Record<string, unknown>;
              const challenge: KeyboardInteractiveChallenge = {
                sessionId,
                challengeId: String(payload.challengeId ?? ""),
                attempt: Number(payload.attempt ?? 1),
                name: typeof payload.name === "string" ? payload.name : null,
                instruction: String(payload.instruction ?? ""),
                prompts: Array.isArray(payload.prompts)
                  ? payload.prompts.map((prompt) => {
                      const candidate = prompt as Record<string, unknown>;
                      return {
                        label: String(candidate.label ?? ""),
                        echo: Boolean(candidate.echo),
                      } satisfies KeyboardInteractivePrompt;
                    })
                  : [],
              };
              const currentTab = get().tabs.find(
                (tab) => tab.sessionId === sessionId,
              );
              const currentHost =
                currentTab?.source === "host" && currentTab.hostId
                  ? get().hosts.find((host) => host.id === currentTab.hostId)
                  : undefined;
              const interactiveState = resolveInteractiveAuthUiState(
                currentHost,
                challenge,
              );
              const browserChallengeKey = buildInteractiveBrowserChallengeKey({
                sessionId,
                challengeId: challenge.challengeId,
                approvalUrl: interactiveState.approvalUrl,
              });
    
              if (
                interactiveState.approvalUrl &&
                !openedInteractiveBrowserChallenges.has(browserChallengeKey)
              ) {
                openedInteractiveBrowserChallenges.add(browserChallengeKey);
                void api.shell
                  .openExternal(interactiveState.approvalUrl)
                  .catch(() => undefined);
              }
    
              set((state) => {
                const currentTab = state.tabs.find(
                  (tab) => tab.sessionId === sessionId,
                );
                const progress = createConnectionProgress(
                  "waiting-interactive-auth",
                  interactiveState.provider === "warpgate"
                    ? `${currentHost?.label ?? "세션"} Warpgate 승인을 기다리는 중입니다.`
                    : `${currentHost?.label ?? "세션"} 추가 인증 응답이 필요합니다.`,
                  {
                    blockingKind: "panel",
                  },
                );
    
                return {
                  tabs: currentTab
                    ? state.tabs.map((tab) =>
                        tab.sessionId === sessionId
                          ? {
                              ...tab,
                              status: "connecting",
                              connectionProgress: progress,
                              lastEventAt: new Date().toISOString(),
                            }
                          : tab,
                      )
                    : state.tabs,
                  pendingInteractiveAuth: {
                    source: "ssh",
                    sessionId,
                    challengeId: challenge.challengeId,
                    name: challenge.name ?? null,
                    instruction: challenge.instruction,
                    prompts: challenge.prompts,
                    provider: interactiveState.provider,
                    approvalUrl: interactiveState.approvalUrl,
                    authCode: interactiveState.authCode,
                    autoSubmitted: interactiveState.autoSubmitted,
                  },
                  ...activateSessionContextInState(state, sessionId),
                };
              });
    
              if (interactiveState.autoSubmitted) {
                void api.ssh
                  .respondKeyboardInteractive({
                    sessionId,
                    challengeId: challenge.challengeId,
                    responses: interactiveState.autoResponses,
                  })
                  .catch(() => undefined);
              }
              return;
            }
    
            if (event.type === "keyboardInteractiveResolved") {
              set((state) => {
                const currentTab = state.tabs.find(
                  (tab) => tab.sessionId === sessionId,
                );
                const currentHost =
                  currentTab?.source === "host" && currentTab.hostId
                    ? state.hosts.find((host) => host.id === currentTab.hostId)
                    : undefined;
    
                if (
                  !isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) ||
                  state.pendingInteractiveAuth.sessionId !== sessionId
                ) {
                  return state;
                }
                if (state.pendingInteractiveAuth.provider === "warpgate") {
                  return state;
                }
                return {
                  pendingInteractiveAuth: null,
                  tabs: currentTab
                    ? state.tabs.map((tab) =>
                        tab.sessionId === sessionId
                          ? {
                              ...tab,
                              connectionProgress: currentHost
                                ? resolveConnectingProgress(currentHost)
                                : tab.connectionProgress,
                              lastEventAt: new Date().toISOString(),
                            }
                          : tab,
                      )
                    : state.tabs,
                };
              });
              return;
            }
    
            const resolvedShellKind =
              typeof event.payload.shellKind === "string"
                ? event.payload.shellKind.trim() || undefined
                : undefined;

            // 자동 재연결 판별은 set 이전(끊김 반영 전) 상태로 한다. set 안에서는
            // 탭을 유지(reconnecting)하고, set 이후에 백오프 스케줄을 건다.
            const sessionTabBeforeEvent = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            );
            const sessionHostBeforeEvent =
              sessionTabBeforeEvent?.source === "host" &&
              sessionTabBeforeEvent.hostId
                ? get().hosts.find(
                    (host) => host.id === sessionTabBeforeEvent.hostId,
                  )
                : undefined;
            const reconnectStableId = sessionTabBeforeEvent?.stableId ?? null;
            const autoReconnectEnabled = get().settings.autoReconnectEnabled;
            // 진행 중 재연결의 시도 결과인지(이미 reconnecting 상태라 status가 connecting).
            const activeSessionReconnect = reconnectStableId
              ? isReconnecting(reconnectStableId)
              : false;
            const isDropEvent =
              event.type === "closed" || event.type === "error";
            const reconnectEventPermanent =
              event.type === "error" &&
              classifyReconnect(
                String(
                  (event.payload as { message?: unknown } | undefined)
                    ?.message ?? "",
                ),
              ) === "permanent";
            // 탭을 reconnecting으로 유지하고 다음 백오프를 걸 조건:
            //  - 활성 연결의 첫 드롭(shouldAutoReconnectSession), 또는
            //  - 진행 중 재연결 시도의 실패(영구 오류 제외 → 그 경우 일반 플로우로).
            const willKeepSessionReconnecting =
              isDropEvent &&
              reconnectStableId != null &&
              autoReconnectEnabled &&
              (shouldAutoReconnectSession(
                sessionTabBeforeEvent,
                sessionHostBeforeEvent,
                event,
                true,
              ) ||
                (activeSessionReconnect && !reconnectEventPermanent));
            const willCancelSessionReconnect =
              isDropEvent && activeSessionReconnect && reconnectEventPermanent;

            set((state) => {
              const currentTab = state.tabs.find(
                (tab) => tab.sessionId === sessionId,
              );
              const currentAttempt = findPendingConnectionAttempt(
                state,
                sessionId,
              );
              const currentHost =
                currentTab?.source === "host" && currentTab.hostId
                  ? state.hosts.find((host) => host.id === currentTab.hostId)
                  : undefined;
              const currentAwsHost =
                currentHost && isAwsEc2HostRecord(currentHost)
                  ? currentHost
                  : null;
              const rawEventMessage =
                event.type === "error"
                  ? String(event.payload.message ?? "SSH error")
                  : "";
              const closedEventMessage =
                event.type === "closed"
                  ? String(event.payload.message ?? "")
                  : "";
              const awsSsmExitCodeMatch =
                awsSsmSessionExitPattern.exec(closedEventMessage);
              const isFailedAwsSsmExit =
                awsSsmExitCodeMatch !== null &&
                Number(awsSsmExitCodeMatch[1]) !== 0;
              const shouldKeepAwsSsmClosedAsError =
                event.type === "closed" &&
                currentTab != null &&
                currentAwsHost != null &&
                // 자동 재연결이 처리할 드롭(연결됨+출력)이면 error로 잡지 않고 재연결로 넘긴다.
                !willKeepSessionReconnecting &&
                (
                  isFailedAwsSsmExit ||
                  (
                    currentTab.hasReceivedOutput !== true &&
                    (
                      currentTab.status === "connecting" ||
                      currentTab.status === "error"
                    )
                  )
                );
              const shellLaunchFailureMessage =
                currentAttempt?.source === "container-shell"
                  ? missingContainerShellMessage
                  : currentAttempt?.source === "ecs-shell"
                    ? missingEcsShellMessage
                    : currentTab?.shellKind === "aws-ecs-exec"
                    ? missingEcsShellMessage
                    : null;
              const isEcsExecTab = currentTab?.shellKind === "aws-ecs-exec";
              const wasClosedImmediatelyAfterLastEvent =
                currentTab != null &&
                Date.now() - new Date(currentTab.lastEventAt).getTime() <=
                  IMMEDIATE_ECS_CLOSE_WINDOW_MS;
              const hasKnownShellLaunchFailureState =
                currentTab?.status === "error" &&
                shellLaunchFailureMessage != null &&
                currentTab.errorMessage === shellLaunchFailureMessage;
              const isContainerShellLaunchFailure =
                shellLaunchFailureMessage != null &&
                currentTab != null &&
                (
                  hasKnownShellLaunchFailureState ||
                  (event.type === "error" &&
                    isLikelyMissingShellErrorMessage(rawEventMessage) &&
                    (currentAttempt?.source === "container-shell" ||
                      currentAttempt?.source === "ecs-shell" ||
                      currentTab?.shellKind === "aws-ecs-exec")) ||
                  (event.type === "closed" &&
                    isEcsExecTab &&
                    currentTab.hasReceivedOutput !== true &&
                    wasClosedImmediatelyAfterLastEvent &&
                    (currentTab.status === "connecting" ||
                      currentTab.status === "connected" ||
                      hasKnownShellLaunchFailureState)) ||
                  (currentTab.hasReceivedOutput !== true &&
                    (
                      currentAttempt?.source === "ecs-shell" ||
                      currentTab?.shellKind === "aws-ecs-exec"
                        ? currentTab.status === "connecting" ||
                          currentTab.status === "connected" ||
                          hasKnownShellLaunchFailureState ||
                          currentTab.connectionProgress?.stage ===
                            "waiting-shell"
                        : currentTab.status === "connected" ||
                          currentTab.connectionProgress?.stage ===
                            "waiting-shell"
                    ))
                );
              const nextContainerShellFailureState = (
                clearAttempt: boolean,
              ): Partial<AppState> => {
                if (!shellLaunchFailureMessage) {
                  return state;
                }
                return {
                  tabs: state.tabs.map((tab): TerminalTab =>
                    tab.sessionId === sessionId
                      ? {
                          ...tab,
                          status: "error" as const,
                          errorMessage: shellLaunchFailureMessage,
                          connectionProgress: createConnectionProgress(
                            "waiting-shell",
                            shellLaunchFailureMessage,
                            {
                              blockingKind: "dialog",
                              retryable: false,
                            },
                          ),
                          lastEventAt: new Date().toISOString(),
                        }
                      : tab,
                  ),
                  pendingConnectionAttempts: clearAttempt
                    ? state.pendingConnectionAttempts.filter(
                        (attempt) => attempt.sessionId !== sessionId,
                      )
                    : state.pendingConnectionAttempts,
                };
              };
              if (event.type === "error" && isContainerShellLaunchFailure) {
                return nextContainerShellFailureState(false);
              }
              if (event.type === "closed") {
                const shouldKeepEcsExecClosedAsError =
                  isEcsExecTab &&
                  currentTab?.status === "error" &&
                  !hasKnownShellLaunchFailureState;
                if (
                  activeRetryAttemptBeforeUpdate?.source === "ssh" &&
                  activeRetryAttemptBeforeUpdate.sessionId === sessionId &&
                  activeRetryAttemptBeforeUpdate.originalUsername !==
                    activeRetryAttemptBeforeUpdate.attemptedUsername
                ) {
                  void updateStoredSshUsername(
                    { api, get, set },
                    activeRetryAttemptBeforeUpdate.hostId,
                    activeRetryAttemptBeforeUpdate.originalUsername,
                  ).catch(() => undefined);
                }
                if (isContainerShellLaunchFailure) {
                  return nextContainerShellFailureState(true);
                }
                if (shouldKeepEcsExecClosedAsError) {
                  const message =
                    currentTab.errorMessage?.trim() ||
                    closedEventMessage.trim() ||
                    "ECS Exec 세션이 종료되었습니다.";
                  return {
                    tabs: state.tabs.map((tab): TerminalTab =>
                      tab.sessionId === sessionId
                        ? {
                            ...tab,
                            status: "error" as const,
                            errorMessage: message,
                            connectionProgress: resolveErrorProgress(message),
                            lastEventAt: new Date().toISOString(),
                          }
                        : tab,
                    ),
                    pendingConnectionAttempts:
                      state.pendingConnectionAttempts.filter(
                        (attempt) => attempt.sessionId !== sessionId,
                      ),
                  };
                }
                if (shouldKeepAwsSsmClosedAsError) {
                  const message =
                    currentTab.errorMessage?.trim() ||
                    closedEventMessage.trim() ||
                    "AWS SSM session closed";
                  return {
                    tabs: state.tabs.map((tab): TerminalTab =>
                      tab.sessionId === sessionId
                        ? {
                            ...tab,
                            status: "error" as const,
                            errorMessage: message,
                            connectionProgress: resolveErrorProgress(message),
                            lastEventAt: new Date().toISOString(),
                          }
                        : tab,
                    ),
                    pendingConnectionAttempts:
                      state.pendingConnectionAttempts.filter(
                        (attempt) => attempt.sessionId !== sessionId,
                      ),
                  };
                }
                // 예기치 않은 끊김이면 탭을 제거하지 않고 reconnecting 상태로 유지.
                if (willKeepSessionReconnecting) {
                  return applySessionReconnecting(state, sessionId);
                }
                return removeSessionFromState(state, sessionId);
              }
              if (!currentTab) {
                return state;
              }
              // transient 에러로 인한 자동 재연결: 에러/자격증명 프롬프트 대신 유지.
              if (event.type === "error" && willKeepSessionReconnecting) {
                return applySessionReconnecting(state, sessionId);
              }
              const currentSshHost =
                currentHost && isSshHostRecord(currentHost) ? currentHost : null;
              const errorMessage = String(event.payload.message ?? "SSH error");
              const shouldPromptCredentialRetry =
                event.type === "error"
                  ? resolveCredentialRetryKind(
                      currentSshHost ?? undefined,
                      errorMessage,
                    )
                  : null;
              const matchingRetryAttempt =
                currentSshHost &&
                state.activeCredentialRetryAttempt?.source === "ssh" &&
                state.activeCredentialRetryAttempt.hostId === currentSshHost.id
                  ? state.activeCredentialRetryAttempt
                  : null;
              const nextProgress =
                event.type === "connected"
                  ? currentAttempt?.source === "container-shell"
                    ? null
                    : (resolvedShellKind ?? currentTab.shellKind) === "aws-ecs-exec"
                    ? null
                    : currentTab.source === "local"
                    ? resolveLocalWaitingShellProgress()
                    : currentHost
                      ? resolveWaitingShellProgress(currentHost)
                      : createConnectionProgress(
                          "waiting-shell",
                          "원격 셸이 첫 출력을 보내는 중입니다.",
                        )
                  : event.type === "error"
                    ? shouldPromptCredentialRetry && currentHost
                      ? resolveCredentialRetryProgress(currentHost, "auth")
                      : resolveErrorProgress(errorMessage)
                    : currentTab.connectionProgress;
    
              const tabs = state.tabs.map((tab) => {
                if (tab.sessionId !== sessionId) {
                  return tab;
                }
    
                let nextStatus: TerminalTab["status"] = tab.status;
                if (event.type === "connected") {
                  nextStatus = "connected";
                }
                if (event.type === "error") {
                  nextStatus = "error";
                }
                return {
                  ...tab,
                  status: nextStatus,
                  shellKind:
                    tab.sessionId === sessionId
                      ? resolvedShellKind ?? tab.shellKind
                      : tab.shellKind,
                  errorMessage: event.type === "error" ? errorMessage : undefined,
                  connectionProgress: nextProgress,
                  hasReceivedOutput:
                    event.type === "connected" ? false : tab.hasReceivedOutput,
                  lastEventAt: new Date().toISOString(),
                };
              });
    
              return {
                tabs,
                resolvedStartupCommandsBySessionId:
                  event.type === "connected"
                    ? Object.fromEntries(
                        Object.entries(state.resolvedStartupCommandsBySessionId).filter(
                          ([id]) => id !== sessionId,
                        ),
                      )
                    : state.resolvedStartupCommandsBySessionId,
                pendingInteractiveAuth:
                  event.type === "connected" || event.type === "error"
                    ? isPendingSessionInteractiveAuth(state.pendingInteractiveAuth) &&
                      state.pendingInteractiveAuth.sessionId === sessionId
                      ? null
                      : state.pendingInteractiveAuth
                    : state.pendingInteractiveAuth,
                pendingCredentialRetry:
                  shouldPromptCredentialRetry && currentSshHost
                    ? {
                        sessionId,
                        hostId: currentSshHost.id,
                        source: "ssh",
                        authType:
                          currentSshHost.authType === "certificate"
                            ? "certificate"
                            : currentSshHost.authType === "privateKey"
                              ? "privateKey"
                              : "password",
                        message: errorMessage,
                        initialUsername:
                          matchingRetryAttempt?.attemptedUsername ??
                          currentSshHost.username,
                      }
                    : event.type === "connected" &&
                        state.pendingCredentialRetry?.source === "ssh" &&
                        (state.pendingCredentialRetry.sessionId
                          ? state.pendingCredentialRetry.sessionId === sessionId
                          : state.pendingCredentialRetry.hostId === currentHost?.id)
                      ? null
                      : state.pendingCredentialRetry,
                activeCredentialRetryAttempt:
                  event.type === "connected" || event.type === "error"
                    ? matchingRetryAttempt
                      ? null
                      : state.activeCredentialRetryAttempt
                    : state.activeCredentialRetryAttempt,
              };
            });

            // 자동 재연결 스케줄/취소 (set 이후 — 타이머 등 부수효과).
            // 인터미널 안내선은 출력하지 않는다(Termius처럼 조용히 이어지게). 진행 표시는
            // 오버레이(connectionProgress)로만 한다.
            if (willKeepSessionReconnecting && reconnectStableId) {
              scheduleReconnect({ kind: "session", key: reconnectStableId });
            } else if (willCancelSessionReconnect && reconnectStableId) {
              cancelReconnect(reconnectStableId, "permanent-error");
            } else if (
              event.type === "connected" &&
              reconnectStableId &&
              isReconnecting(reconnectStableId)
            ) {
              cancelReconnect(reconnectStableId, "reconnected");
            }

            if (
              event.type === "connected" &&
              activeRetryAttemptBeforeUpdate?.source === "ssh"
            ) {
              const currentTab = get().tabs.find(
                (tab) => tab.sessionId === sessionId,
              );
              const currentHost =
                currentTab?.source === "host" && currentTab.hostId
                  ? (get().hosts.find((host) => host.id === currentTab.hostId) ??
                    null)
                  : null;
              if (
                currentHost &&
                currentHost.id === activeRetryAttemptBeforeUpdate.hostId
              ) {
                void refreshHostAndKeychainState(set);
              }
            }
            if (
              event.type === "error" &&
              activeRetryAttemptBeforeUpdate?.source === "ssh" &&
              activeRetryAttemptBeforeUpdate.sessionId === sessionId &&
              activeRetryAttemptBeforeUpdate.originalUsername !==
                activeRetryAttemptBeforeUpdate.attemptedUsername
            ) {
              void updateStoredSshUsername(
                { api, get, set },
                activeRetryAttemptBeforeUpdate.hostId,
                activeRetryAttemptBeforeUpdate.originalUsername,
              ).catch(() => undefined);
            }
          },
    handleSessionShareEvent: (event) => {
            set((state) => ({
              tabs: setSessionShareState(state.tabs, event.sessionId, event.state),
              sessionShareChatNotifications:
                event.state.status === "active"
                  ? state.sessionShareChatNotifications
                  : clearSessionShareChatNotifications(
                      state.sessionShareChatNotifications,
                      event.sessionId,
                    ),
            }));
          },
    handleSessionShareChatEvent: (event) => {
            set((state) => {
              const currentTab = state.tabs.find(
                (tab) => tab.sessionId === event.sessionId,
              );
              if (
                !currentTab ||
                currentTab.sessionShare?.status !== "active" ||
                event.message.senderRole === "owner"
              ) {
                return state;
              }
    
              return {
                sessionShareChatNotifications: appendSessionShareChatNotification(
                  state.sessionShareChatNotifications,
                  event.sessionId,
                  event.message,
                ),
              };
            });
          },
    dismissSessionShareChatNotification: (sessionId, messageId) => {
            set((state) => ({
              sessionShareChatNotifications: dismissSessionShareChatNotification(
                state.sessionShareChatNotifications,
                sessionId,
                messageId,
              ),
            }));
          },
    handleTransferEvent: (event) => {
            set((state) => ({
              sftp: {
                ...state.sftp,
                transfers: upsertTransferJob(state.sftp.transfers, event.job),
              },
            }));
    
            scheduleActivityLogsRefresh();
    
            if (event.job.status === "completed" && event.job.request) {
              const request = event.job.request;
              const state = get();
              for (const paneId of ["left", "right"] as const) {
                const pane = getPane(state, paneId);
                const paneRef =
                  pane.sourceKind === "local"
                    ? { kind: "local" as const, path: pane.currentPath }
                    : pane.endpoint
                      ? {
                          kind: "remote" as const,
                          endpointId: pane.endpoint.id,
                          path: pane.currentPath,
                        }
                      : null;
                if (!paneRef) {
                  continue;
                }
                if (
                  paneRef.kind === request.target.kind &&
                  paneRef.path === request.target.path &&
                  (paneRef.kind === "local" ||
                    (request.target.kind === "remote" &&
                      paneRef.endpointId === request.target.endpointId))
                ) {
                  void get().refreshSftpPane(paneId);
                }
              }
            }
          },
    handlePortForwardEvent: (event) => {
            // 자동 재연결 판별(set 이전 상태로). 확립된 포워딩(running)이 error로
            // 떨어지면 드롭으로 보고 재시작한다. ecs/container 터널 ruleId는 제외.
            const pfRuleId = event.runtime.ruleId;
            const pfIsRealRule = get().portForwards.some(
              (rule) => rule.id === pfRuleId,
            );
            const pfPrev = get().portForwardRuntimes.find(
              (runtime) => runtime.ruleId === pfRuleId,
            );
            const pfActiveReconnect = isReconnecting(pfRuleId);
            const pfPermanent =
              classifyReconnect(event.runtime.message ?? "") === "permanent";
            const pfWillReconnect =
              get().settings.autoReconnectEnabled &&
              pfIsRealRule &&
              event.runtime.status === "error" &&
              !pfPermanent &&
              (pfPrev?.status === "running" || pfActiveReconnect);

            set((state) => {
              const nextState: Partial<AppState> = {
                portForwardRuntimes: upsertForwardRuntime(
                  state.portForwardRuntimes,
                  event.runtime,
                ),
              };
    
              if (event.runtime.ruleId.startsWith("ecs-service-tunnel:")) {
                nextState.containerTabs = state.containerTabs.map((tab) => {
                  if (tab.kind !== "ecs-cluster") {
                    return tab;
                  }
                  let changed = false;
                  const nextTunnelStates = Object.fromEntries(
                    Object.entries(tab.ecsTunnelStatesByServiceName).map(
                      ([serviceName, tunnelState]) => {
                        if (tunnelState.runtime?.ruleId !== event.runtime.ruleId) {
                          return [serviceName, tunnelState];
                        }
                        changed = true;
                        return [
                          serviceName,
                          {
                            ...tunnelState,
                            loading: false,
                            error:
                              event.runtime.status === "error"
                                ? event.runtime.message ?? tunnelState.error
                                : tunnelState.error,
                            runtime:
                              event.runtime.status === "stopped"
                                ? null
                                : event.runtime,
                          },
                        ];
                      },
                    ),
                  ) as Record<string, EcsTunnelTabState>;
                  return changed
                    ? { ...tab, ecsTunnelStatesByServiceName: nextTunnelStates }
                    : tab;
                });
              } else if (event.runtime.ruleId.startsWith("container-service-tunnel:")) {
                nextState.containerTabs = (nextState.containerTabs ??
                  state.containerTabs
                ).map((tab) => {
                  if (tab.kind !== "host-containers") {
                    return tab;
                  }
                  let changed = false;
                  const nextTunnelStates = Object.fromEntries(
                    Object.entries(tab.containerTunnelStatesByContainerId).map(
                      ([containerId, tunnelState]) => {
                        if (tunnelState.runtime?.ruleId !== event.runtime.ruleId) {
                          return [containerId, tunnelState];
                        }
                        changed = true;
                        return [
                          containerId,
                          {
                            ...tunnelState,
                            loading: false,
                            error: null,
                            runtime:
                              event.runtime.status === "stopped"
                                ? null
                                : event.runtime.status === "error"
                                ? null
                                : event.runtime,
                          },
                        ];
                      },
                    ),
                  ) as Record<string, ContainerTunnelTabState>;
                  return changed
                    ? { ...tab, containerTunnelStatesByContainerId: nextTunnelStates }
                    : tab;
                });
              }
    
              return nextState;
            });

            if (pfWillReconnect) {
              scheduleReconnect({ kind: "portForward", key: pfRuleId });
            } else if (
              pfActiveReconnect &&
              (event.runtime.status === "running" ||
                event.runtime.status === "stopped" ||
                (event.runtime.status === "error" && pfPermanent))
            ) {
              cancelReconnect(pfRuleId, "resolved");
            }

            scheduleActivityLogsRefresh();
          },
    handleSftpConnectionProgressEvent: (event) => {
            set((state) => {
              const paneId = resolveSftpPaneIdByEndpoint(state, event.endpointId);
              if (!paneId) {
                return state;
              }
              const pane = getPane(state, paneId);
              if (
                pane.connectingEndpointId !== event.endpointId &&
                pane.endpoint?.id !== event.endpointId
              ) {
                return state;
              }
              return {
                sftp: updatePaneState(state, paneId, {
                  ...pane,
                  connectionProgress: event,
                  connectionDiagnostic: event.reasonCode
                    ? event
                    : pane.connectionDiagnostic,
                }),
              };
            });
          },
    handleContainerConnectionProgressEvent: (event) => {
            set((state) => {
              const currentTab = findContainersTab(state, event.hostId);
              if (!currentTab) {
                return state;
              }
              const expectedEndpointId = buildContainersEndpointId(event.hostId);
              if (event.endpointId !== expectedEndpointId) {
                return state;
              }
              const pendingContainerShellSessionIds = new Set(
                state.pendingConnectionAttempts
                  .filter(
                    (attempt) =>
                      attempt.source === "container-shell" &&
                      attempt.hostId === event.hostId,
                  )
                  .map((attempt) => attempt.sessionId),
              );
              const isAwaitingContainerShellTrust =
                state.pendingHostKeyPrompt?.action.kind === "containerShell" &&
                state.pendingHostKeyPrompt.action.hostId === event.hostId;

              if (pendingContainerShellSessionIds.size > 0) {
                if (isAwaitingContainerShellTrust) {
                  return state;
                }

                let didUpdatePendingSession = false;
                const nextTabs = state.tabs.map((tab) => {
                  if (!pendingContainerShellSessionIds.has(tab.sessionId)) {
                    return tab;
                  }
                  if (tab.connectionProgress?.stage === "awaiting-host-trust") {
                    return tab;
                  }

                  didUpdatePendingSession = true;
                  return {
                    ...tab,
                    connectionProgress: createConnectionProgress(
                      event.stage,
                      event.message,
                      {
                        blockingKind:
                          event.stage === "browser-login" ? "browser" : "none",
                      },
                    ),
                    lastEventAt: new Date().toISOString(),
                  };
                });

                return didUpdatePendingSession ? { tabs: nextTabs } : state;
              }

              if (isAwaitingContainerShellTrust) {
                return state;
              }
              return {
                containerTabs: upsertContainersTab(state.containerTabs, {
                  ...currentTab,
                  connectionProgress: event,
                  isLoading: true,
                }),
              };
            });
          }
  };

}
