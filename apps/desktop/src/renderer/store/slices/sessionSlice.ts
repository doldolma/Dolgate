import { isSplittablePaneKind } from "@shared";
import type { TabCommandPayload, TerminalTab } from "@shared";
import type { SliceDeps } from "../services/context";
import type {
  DynamicTabStripItem,
  SessionSlice,
  WorkspaceTab,
} from "../types";
import {
  AWS_SFTP_DEFAULT_PORT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  getAwsEc2SftpDisabledMessage,
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
  findPendingInteractiveAuthByChallengeId,
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
  asTmuxSessionGroupTabId,
  findTmuxGroupForWorkspace,
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
  parseTmuxLayout,
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
import {
  cancelReconnect,
  isReconnecting,
} from "../services/reconnect-orchestrator";

// 재연결로 control 세션이 교체(old→new)되면 서버 tmux 가 재부팅돼 새 세션일 수 있어
// 일부 window 가 다시 안 나타난다. list-windows rebind burst 가 끝난 뒤(디바운스) 옛
// controlSessionId 에 남은(=재출현 안 한) workspace 만 1회 정리한다(고스트 윈도우 제거).
const tmuxRebindPruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
import { createContainersServices } from "../services/containers";
import { createSessionServices } from "../services/session";
import { createSftpServices } from "../services/sftp";
import { createTrustAuthServices } from "../services/trust-auth";
import { parseSnippetVariables, resolveSnippetCommand } from "../../lib/snippet";
import { popClosedHost, pushClosedHost } from "../../lib/recently-closed-tabs";
import { t } from '../../i18n';

// 사용자가 닫은 tmux control 세션. 닫는 순간 control 채널 stdout 에 이미 버퍼돼 있던
// 늦은 %layout-change 가 도착해 워크스페이스를 되살리는(부활) 것을 막기 위한 단기 가드.
const recentlyClosedTmuxControlSessions = new Map<string, number>();
const TMUX_CLOSED_GUARD_MS = 5000;
function markTmuxControlSessionClosed(controlSessionId: string): void {
  recentlyClosedTmuxControlSessions.set(controlSessionId, Date.now());
}
function isTmuxControlSessionRecentlyClosed(controlSessionId: string): boolean {
  const at = recentlyClosedTmuxControlSessions.get(controlSessionId);
  if (at == null) {
    return false;
  }
  if (Date.now() - at > TMUX_CLOSED_GUARD_MS) {
    recentlyClosedTmuxControlSessions.delete(controlSessionId);
    return false;
  }
  return true;
}

// 윈도우 하나만 닫을 때 쓰는 window 단위 가드. 세션 전체 가드를 켜면 같은 control
// 세션의 다른 window 들 layout-change 까지 막혀 "하나 닫으면 전부 닫힘" 처럼 보인다.
// (세션 전체 가드는 detach 처럼 세션 전부를 닫을 때만 쓴다.)
const recentlyClosedTmuxWindows = new Map<string, number>();
function tmuxWindowGuardKey(controlSessionId: string, windowId: string): string {
  return `${controlSessionId}\t${windowId}`;
}
function markTmuxWindowClosed(controlSessionId: string, windowId: string): void {
  recentlyClosedTmuxWindows.set(
    tmuxWindowGuardKey(controlSessionId, windowId),
    Date.now(),
  );
}
function isTmuxWindowRecentlyClosed(
  controlSessionId: string,
  windowId: string,
): boolean {
  const key = tmuxWindowGuardKey(controlSessionId, windowId);
  const at = recentlyClosedTmuxWindows.get(key);
  if (at == null) {
    return false;
  }
  if (Date.now() - at > TMUX_CLOSED_GUARD_MS) {
    recentlyClosedTmuxWindows.delete(key);
    return false;
  }
  return true;
}

/** 이 세션 탭을 분할 화면에 넣을 수 있는가. 판정은 shared-core 한 곳에 있다. */
function isSplittableSession(tabs: TerminalTab[], sessionId: string): boolean {
  const tab = tabs.find((item) => item.sessionId === sessionId);
  return isSplittablePaneKind(tab?.paneKind);
}

export function createSessionSlice(deps: SliceDeps): SessionSlice {
  const { api, set, get } = deps;
  const services = createSessionServices(deps);
  const bootstrapServices = createBootstrapSyncServices(deps);
  const containersServices = createContainersServices(deps);
  const sftpServices = createSftpServices(deps);
  const trustServices = createTrustAuthServices(deps);

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
    startRdpConnectionFlow,
    retryRdpConnection,
    retryVncConnection,
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
    tmuxGroups: [],
    tmuxCommandPrompt: null,
    tabStrip: [],
    pendingCredentialRetry: null,
    activeCredentialRetryAttempt: null,
    pendingMissingUsernamePrompt: null,
    pendingStartupCommandPrompt: null,
    pendingInteractiveAuths: [],
    pendingConnectionAttempts: [],
    resolvedStartupCommandsBySessionId: {},
    sessionReturnTargets: {},
    handleTmuxLayoutChange: (controlSessionId, windowId, layout, meta) => {
            // 방금 닫은 세션 전체(detach)의 늦은 layout-change 는 무시(부활 금지).
            if (isTmuxControlSessionRecentlyClosed(controlSessionId)) {
              return;
            }
            // 방금 닫은 이 window 의 늦은 layout-change 만 무시(다른 window 는 계속 갱신).
            if (isTmuxWindowRecentlyClosed(controlSessionId, windowId)) {
              return;
            }
            const tree = parseTmuxLayout(
              layout,
              (paneNum) => `tmux:${controlSessionId}:${paneNum}`,
            );
            if (!tree) {
              return;
            }
            const paneSessionIds = listWorkspaceSessionIds(tree);
            if (paneSessionIds.length === 0) {
              return;
            }
            // 재연결 rebind 판별은 set 밖에서 한다(cancelReconnect/prune 은 side-effect).
            const owningBefore = get().workspaces.find(
              (w) => w.tmux?.windowId === windowId,
            );
            const owningBeforeControl = owningBefore?.tmux?.controlSessionId;
            // 다른 control 세션의 같은 windowId(@0 등) workspace 를 old(rebind 대상)로
            // 삼는 건 그 그룹이 재연결 중일 때만. 그래야 살아있는 별개 tmux 세션(새 탭)을
            // 덮어쓰지 않는다. 같은 control 이면 migration 이 아니므로 old 는 비운다.
            const oldControlSessionId =
              owningBeforeControl &&
              owningBeforeControl !== controlSessionId &&
              get().tmuxGroups.some(
                (g) =>
                  g.controlSessionId === owningBeforeControl &&
                  g.reconnect != null,
              )
                ? owningBeforeControl
                : undefined;
            const isControlMigration = Boolean(oldControlSessionId);
            const reconnectingGroup =
              get().tmuxGroups.find(
                (g) => g.controlSessionId === controlSessionId,
              ) ??
              (oldControlSessionId
                ? get().tmuxGroups.find(
                    (g) => g.controlSessionId === oldControlSessionId,
                  )
                : undefined);
            const wasReconnecting = reconnectingGroup
              ? isReconnecting(reconnectingGroup.id)
              : false;
            set((state) => {
              const existing = new Set(state.tabs.map((t) => t.sessionId));
              const live = new Set(paneSessionIds);
              const now = new Date().toISOString();
              const newPaneTabs: TerminalTab[] = paneSessionIds
                .filter((sid) => !existing.has(sid))
                .map((sid) => {
                  const paneNum = sid.slice(sid.lastIndexOf(":") + 1);
                  return {
                    id: sid,
                    // stableId 는 재연결(=새 controlSessionId)에도 불변이어야 터미널이
                    // remount/dispose 되지 않는다(그래야 handleResize dispose race 와
                    // 빈 화면이 사라진다). 그래서 controlSessionId 대신 windowId+paneNum
                    // 으로 구성한다(단일 호스트 가정; 다중 호스트 동시 tmux 는 windowId
                    // 충돌 가능 — 후속 과제).
                    stableId: `tmux-pane:${windowId}:${paneNum}`,
                    sessionId: sid,
                    source: "host",
                    hostId: null,
                    title: `pane ${paneNum}`,
                    status: "connected",
                    hasReceivedOutput: true,
                    lastEventAt: now,
                    tmux: { controlSessionId, paneId: `%${paneNum}`, windowId },
                  } satisfies TerminalTab;
                });

              // --- 윈도우 = WorkspaceTab (windowId 로 매칭, 재연결에도 동일 workspace
              // 를 rebind 해 터미널 remount 를 막는다). control 세션이 바뀌어도 windowId
              // 는 유지된다(단일 호스트 가정). index/name 은 윈도우 바 라벨용. ---
              // 같은 controlSessionId 의 windowId 를 우선 매칭한다. 다른 controlSessionId
              // 의 같은 windowId(@0 등)는 그 그룹이 재연결 중일 때만 rebind 대상으로 —
              // 살아있는 별개 tmux 세션(새 탭)을 덮어쓰지 않도록 한다.
              const owning =
                state.workspaces.find(
                  (w) =>
                    w.tmux?.windowId === windowId &&
                    w.tmux?.controlSessionId === controlSessionId,
                ) ??
                state.workspaces.find(
                  (w) =>
                    w.tmux?.windowId === windowId &&
                    w.tmux?.controlSessionId !== controlSessionId &&
                    state.tmuxGroups.some(
                      (g) =>
                        g.controlSessionId === w.tmux?.controlSessionId &&
                        g.reconnect != null,
                    ),
                );
              const oldControlSessionId =
                owning && owning.tmux?.controlSessionId !== controlSessionId
                  ? owning.tmux?.controlSessionId
                  : undefined;
              const windowTmux = {
                controlSessionId,
                windowId,
                index: meta?.index ?? owning?.tmux?.index,
                name: meta?.name ?? owning?.tmux?.name,
              };
              const windowTitle =
                windowTmux.name !== undefined
                  ? windowTmux.name
                    ? `${windowTmux.index ?? 0}:${windowTmux.name}`
                    : `${windowTmux.index ?? 0}`
                  : undefined;

              let workspaceId: string;
              let nextWorkspaces: WorkspaceTab[];
              if (owning) {
                workspaceId = owning.id;
                nextWorkspaces = state.workspaces.map((w) =>
                  w.id === owning.id
                    ? {
                        ...w,
                        layout: tree,
                        title: windowTitle ?? w.title,
                        tmux: windowTmux,
                        activeSessionId: live.has(w.activeSessionId)
                          ? w.activeSessionId
                          : paneSessionIds[0],
                      }
                    : w,
                );
              } else {
                workspaceId = globalThis.crypto.randomUUID();
                const controlTab = state.tabs.find(
                  (t) => t.sessionId === controlSessionId,
                );
                nextWorkspaces = [
                  ...state.workspaces,
                  {
                    id: workspaceId,
                    title: windowTitle ?? controlTab?.title ?? `tmux ${windowId}`,
                    layout: tree,
                    activeSessionId: paneSessionIds[0],
                    broadcastEnabled: false,
                    tmux: windowTmux,
                  },
                ];
              }

              // --- 세션 그룹 = TmuxSessionGroup (controlSessionId 당 1개; 상단 탭 1개).
              // 새 controlSessionId 로 먼저 찾고(재연결 시 형제 윈도우가 이미 rebind 했을
              // 수 있음), 없으면 기존 윈도우의 옛 controlSessionId 로 찾아 rebind 한다. ---
              const existingGroup =
                state.tmuxGroups.find(
                  (g) => g.controlSessionId === controlSessionId,
                ) ??
                (oldControlSessionId
                  ? state.tmuxGroups.find(
                      (g) => g.controlSessionId === oldControlSessionId,
                    )
                  : undefined);
              const hadControlTab = state.tabs.some(
                (t) => t.sessionId === controlSessionId,
              );

              let groupId: string;
              let nextGroups: typeof state.tmuxGroups;
              if (existingGroup) {
                groupId = existingGroup.id;
                // 활성 윈도우: list-windows 의 active 플래그가 true 거나, 기존 활성
                // 윈도우가 더 이상 존재하지 않을 때만 이 윈도우로 옮긴다.
                const activeStillValid = nextWorkspaces.some(
                  (w) => w.id === existingGroup.activeWorkspaceId,
                );
                const makeActive = meta?.active === true || !activeStillValid;
                nextGroups = state.tmuxGroups.map((g) =>
                  g.id === existingGroup.id
                    ? {
                        ...g,
                        controlSessionId,
                        activeWorkspaceId: makeActive
                          ? workspaceId
                          : g.activeWorkspaceId,
                        // 세션명은 layout-change payload(handle.sessionName)로 따라온다.
                        // 비어 있으면 기존 값 유지(호스트명 fallback 클로버 방지).
                        sessionName: meta?.sessionName || g.sessionName,
                        // rebind = 새 control 세션이 붙었다 → 재연결 상태 해제.
                        reconnect: null,
                        // 재연결 종료 → 직전 control 정리 추적도 비운다.
                        reconnectSessionId: null,
                      }
                    : g,
                );
              } else {
                groupId = globalThis.crypto.randomUUID();
                const controlTab = state.tabs.find(
                  (t) => t.sessionId === controlSessionId,
                );
                // 이 control 세션을 띄운 attempt 에서 감지 버전을 캡처해 그룹에 저장한다
                // (자동 재연결 시 다시 넘겨 구버전 입력 인코딩이 유지되게).
                const controlAttempt = state.pendingConnectionAttempts.find(
                  (a) => a.sessionId === controlSessionId,
                );
                nextGroups = [
                  ...state.tmuxGroups,
                  {
                    id: groupId,
                    controlSessionId,
                    // 실제 tmux 세션명(payload) 우선, 없으면 호스트 탭 제목으로 fallback.
                    sessionName:
                      meta?.sessionName || controlTab?.title || "tmux",
                    activeWorkspaceId: workspaceId,
                    // 새 세션 생성/전환(connectHost)에 쓸 호스트. control 세션 탭에서 캡처.
                    hostId: controlTab?.hostId ?? null,
                    tmuxVersion: controlAttempt?.tmuxVersion ?? null,
                  },
                ];
              }

              const hasGroupTab = state.tabStrip.some(
                (item) => item.kind === "tmux" && item.tmuxGroupId === groupId,
              );
              // control 세션 standalone 탭이 있던 자리에 그룹 탭을 끼운다(끝에 append 가
              // 아님). 그래야 "현재 탭에서 열기"(원 세션 슬롯에 둔 control 탭) 위치가
              // 그대로 유지된다. standalone 탭이 없으면(직접 호출 등) 끝에 추가.
              const controlTabIndex = state.tabStrip.findIndex(
                (item) =>
                  item.kind === "session" &&
                  item.sessionId === controlSessionId,
              );
              const nextTabStrip: DynamicTabStripItem[] = state.tabStrip.filter(
                (item) =>
                  !(
                    item.kind === "session" &&
                    item.sessionId === controlSessionId
                  ),
              );
              if (!hasGroupTab) {
                const insertAt =
                  controlTabIndex >= 0 ? controlTabIndex : nextTabStrip.length;
                nextTabStrip.splice(Math.min(insertAt, nextTabStrip.length), 0, {
                  kind: "tmux",
                  tmuxGroupId: groupId,
                });
              }

              return {
                tabs: [
                  ...state.tabs.filter(
                    (t) =>
                      // 같은 window 의 pane 중 현재 레이아웃에 없는 것 제거. 단 같은
                      // control 세션이거나 재연결 대상(old)인 pane 만 — 살아있는 다른
                      // 그룹의 같은 windowId(@0 등) pane 을 지우지 않도록 스코프한다.
                      // (재연결로 controlSessionId 가 바뀐 옛 pane 은 oldControlSessionId
                      // 로 잡아 제거된다.)
                      !(
                        t.tmux?.windowId === windowId &&
                        (t.tmux?.controlSessionId === controlSessionId ||
                          t.tmux?.controlSessionId === oldControlSessionId) &&
                        !live.has(t.sessionId)
                      ) &&
                      // 재연결로 새로 생긴 control 세션 standalone 탭 제거(그룹으로 흡수).
                      t.sessionId !== controlSessionId,
                  ),
                  ...newPaneTabs,
                ],
                workspaces: nextWorkspaces,
                tmuxGroups: nextGroups,
                tabStrip: nextTabStrip,
                // 최초 그룹 생성 또는 standalone control 탭 흡수 시 그룹 탭으로 전환 —
                // 단 사용자가 그 연결을 보고 있을 때만(연결 중인 control 탭에 있거나 이미
                // 이 그룹에 있을 때). home 등 다른 데로 이동했으면 강제 포커스하지 않는다.
                ...((!existingGroup || hadControlTab) &&
                (state.activeWorkspaceTab === asSessionTabId(controlSessionId) ||
                  state.activeWorkspaceTab === asTmuxSessionGroupTabId(groupId))
                  ? { activeWorkspaceTab: asTmuxSessionGroupTabId(groupId) }
                  : {}),
              };
            });
            // 재연결 성공: 예약 취소(패인은 위 rebind 로 새 'connected' 탭이 됐다).
            if (wasReconnecting && reconnectingGroup) {
              cancelReconnect(reconnectingGroup.id, "reconnected");
            }
            // 서버 재부팅 등으로 control 세션이 교체됐으면, list-windows burst 가 끝난
            // 뒤(디바운스) 옛 controlSessionId 에 남은 고스트 workspace 를 1회 정리한다.
            if (isControlMigration && oldControlSessionId) {
              const oldId = oldControlSessionId;
              const prev = tmuxRebindPruneTimers.get(oldId);
              if (prev) {
                clearTimeout(prev);
              }
              tmuxRebindPruneTimers.set(
                oldId,
                setTimeout(() => {
                  tmuxRebindPruneTimers.delete(oldId);
                  get().removeTmuxWorkspacesLocal(oldId);
                }, 400),
              );
            }
          },
    openLocalTerminal: async (cols, rows) => {
            await startLocalTerminalFlow(set, get, cols, rows);
          },
    connectHost: async (
            hostId,
            cols,
            rows,
            secrets,
            tmux,
            tmuxCommand,
            replaceSessionId,
            reconnectGroupId,
            tmuxVersion,
            startupCommandOverride,
          ) => {
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
            let startupCommand: string | undefined;
            // passthrough(< 2.6 tmux) 등 일회성 startup 명령은 호스트 설정을 무시하고 그대로 쓴다.
            if (
              startupCommandOverride !== undefined &&
              startupCommandOverride !== ""
            ) {
              startupCommand = startupCommandOverride;
            } else if (
              host.kind === "ssh" ||
              host.kind === "aws-ec2" ||
              host.kind === "warpgate-ssh"
            ) {
              const configured = host.startupCommand;
              if (configured?.type === "command") {
                startupCommand = configured.command;
              } else if (configured?.type === "snippet") {
                const snippet = get().snippets.find(
                  (entry) => entry.id === configured.snippetId,
                );
                if (snippet) {
                  const variables = parseSnippetVariables(snippet.command);
                  if (variables.length > 0) {
                    set({
                      pendingStartupCommandPrompt: {
                        hostId,
                        cols,
                        rows,
                        secrets,
                        snippetId: snippet.id,
                        command: snippet.command,
                        variables,
                      },
                    });
                    return;
                  }
                  startupCommand = snippet.command;
                }
              }
            }
            await startSessionConnectionFlow(
              set,
              get,
              hostId,
              cols,
              rows,
              secrets,
              undefined,
              startupCommand,
              tmux,
              tmuxCommand,
              // tmux control mode 또는 passthrough(startupCommandOverride 지정)일 때 원 세션을
              // 대체해 '현재 화면에서 열기' UX 를 유지한다. 일반 연결엔 replaceSessionId 가
              // 안 와서(undefined) 영향 없음.
              tmux ||
                (startupCommandOverride !== undefined &&
                  startupCommandOverride !== "")
                ? replaceSessionId
                : undefined,
              // tmux 재연결 경로면 새 control 을 standalone 탭으로 만들지 않는다.
              tmux ? reconnectGroupId : undefined,
              // 버전은 tmux control mode 진입일 때만 의미가 있다.
              tmux ? tmuxVersion : undefined,
            );
          },
    retryRdpConnection: async (sessionId) => {
            await retryRdpConnection(set, get, sessionId);
          },
    retryVncConnection: async (sessionId) => {
            await retryVncConnection(set, get, sessionId);
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
                      stableId: tab.stableId,
                      source: "local",
                      hostId: null,
                      title: tab.title,
                      progress: createConnectionProgress(
                        "retrying-session",
                        t('sessionStore.ecsShellReopening', { label: host.label }),
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
                      stableId: tab.stableId,
                      source: "host",
                      hostId: currentAttempt.hostId,
                      title: tab.title,
                      progress: isAwsEc2HostRecord(host)
                        ? createConnectionProgress(
                            "checking-profile",
                            t('containersStore.checkingProfile', { profile: host.awsProfileName }),
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
                // 이미 신뢰된 호스트/베스천은 재-probe 생략(중복 순회 방지, 실연결이 strict 검사).
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
                      stableId: tab.stableId,
                      source: "local",
                      hostId: null,
                      title: tab.title,
                      progress: createConnectionProgress(
                        "retrying-session",
                        t('sessionStore.localRestarting'),
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
                    stableId: tab.stableId,
                    source: "host",
                    hostId: tab.hostId,
                    title: tab.title,
                    progress: isAwsEc2HostRecord(host)
                      ? createConnectionProgress(
                          "checking-profile",
                          t('containersStore.checkingProfile', { profile: host.awsProfileName }),
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
    // 전체 모니터로 다시 붙는다.
    //
    // 모니터 레이아웃은 GCC 블록으로 접속 시점에 선언하는 값이라 세션 중에 바꿀 수 없다.
    // 그래서 끊고 다시 붙인다 — mstsc 나 Microsoft Remote Desktop 도 이 설정에 재접속을
    setRdpMicrophoneProblem: (sessionId, problem) => {
            set((state) => {
              const tab = state.tabs.find((item) => item.sessionId === sessionId);
              // 값이 그대로면 손대지 않는다 — 렌더러가 매 렌더마다 같은 값을 알려도 리렌더가
              // 번지지 않게.
              if (!tab || (tab.rdpMicrophoneProblem ?? null) === (problem ?? null)) {
                return {};
              }
              return {
                tabs: state.tabs.map((item) =>
                  item.sessionId === sessionId
                    ? { ...item, rdpMicrophoneProblem: problem ?? null }
                    : item,
                ),
              };
            });
          },

    // 요구한다. 이 선택은 호스트에 저장하지 않는다: 이번 세션에만 적용된다.
    setRdpMonitors: async (sessionId, monitors) => {
            const tab = get().tabs.find((item) => item.sessionId === sessionId);
            if (!tab || tab.paneKind !== "rdp" || !tab.hostId) {
              return;
            }
            const host = get().hosts.find((item) => item.id === tab.hostId);
            if (!host || host.kind !== "rdp") {
              return;
            }

            // 기기 로컬 설정에 남긴다. 호스트 레코드에 두지 않는 이유: 레코드는 동기화되는데
            // 붙어 있는 모니터는 기기마다 달라서, 다른 기기에서 고른 배치가 넘어오면 없는 화면을
            // 가리킨다. 호스트에는 "전체 모니터를 쓸 것인가"만 남는다.
            //
            // 먼저 저장한다 — 재접속이 실패해도 고른 배치는 남아 다음 접속에 쓰인다.
            const current = get().settings.rdpMonitorsByHostId;
            const nextMap = { ...current };
            if (monitors && monitors.length > 0) {
              nextMap[host.id] = monitors;
            } else {
              delete nextMap[host.id];
            }
            const settings = await api.settings.update({
              rdpMonitorsByHostId: nextMap,
            });
            set({ settings });

            // 모니터 배치는 접속 시점에 서버와 협상해 고정된다 — 붙어 있는 세션에 적용할 방법이
            // 없어서 다시 붙어야 한다.
            await api.rdp.disconnect(sessionId).catch(() => undefined);
            set((state) => removeSessionFromState(state, sessionId));
            await startRdpConnectionFlow(set, get, host);
          },
    disconnectTab: async (sessionId) => {
            // tmux pane 은 SSH 세션이 아니라 control 채널 위의 가상 pane 이다. 닫기는
            // tmux kill-pane 으로 보내고, 레이아웃/탭 제거는 이어 오는 tmux 이벤트
            // (tmuxLayoutChange / tmuxWindowClose)가 처리하므로 로컬 상태는 건드리지 않는다.
            if (sessionId.startsWith("tmux:")) {
              void api.ssh.tmuxKillPane(sessionId);
              return;
            }
            // 닫은 탭 다시 열기(Cmd+Shift+T)용: 호스트 세션이면 hostId 를 최근닫음 스택에 기록.
            const closingHostId = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            )?.hostId;
            if (closingHostId) {
              pushClosedHost(closingHostId);
            }
            // 원격 화면 세션은 별도 코어를 쓴다. 아래 경로는 전부 ssh-core 를 향하고, 이 세션의
            // sessionId 는 pending 접두사를 유지하므로 그냥 두면 탭만 사라지고 사이드카 세션은
            // 계속 살아 프레임을 흘린다.
            const vncTab = get().tabs.find(
              (tab) => tab.sessionId === sessionId && tab.paneKind === "vnc",
            );
            if (vncTab) {
              // 사용자가 직접 끊었다. 예약된 자동 재연결이 남아 있으면 닫은 세션이 되살아난다.
              cancelReconnect(vncTab.stableId, "user-disconnect");
              await api.vnc.disconnect(sessionId).catch(() => undefined);
              set((state) => removeSessionFromState(state, sessionId));
              return;
            }
            const rdpTab = get().tabs.find(
              (tab) => tab.sessionId === sessionId && tab.paneKind === "rdp",
            );
            if (rdpTab) {
              // 사용자가 직접 끊었다. 예약된 자동 재연결이 남아 있으면 닫은 세션이 되살아난다.
              cancelReconnect(rdpTab.stableId, "user-disconnect");
              await api.rdp.disconnect(sessionId).catch(() => undefined);
              set((state) => removeSessionFromState(state, sessionId));
              return;
            }
            // 사용자가 직접 끊으면 진행 중인 자동 재연결을 즉시 취소(의도적 종료).
            const reconnectTab = get().tabs.find(
              (tab) => tab.sessionId === sessionId,
            );
            if (reconnectTab) {
              cancelReconnect(reconnectTab.stableId, "user-disconnect");
            }
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
    cancelSessionReconnect: (sessionId) => {
            // 사용자가 자동 재연결을 취소 → 백오프 중단 + 수동 재연결 가능한 error 상태로.
            const tab = get().tabs.find((item) => item.sessionId === sessionId);
            if (!tab) {
              return;
            }
            // tmux pane 은 그룹 단위(키=tmuxGroup.id)로 백오프가 걸려 있다. stableId 로
            // 취소하면 그룹 백오프가 안 멈춰 곧 다시 재연결 오버레이가 그룹 전체에 뜬다.
            // 그룹을 찾아 백오프를 멈추고 모든 pane 을 수동 재연결 가능한 error 로 만든다.
            const tmuxControlSessionId = tab.tmux?.controlSessionId;
            if (tmuxControlSessionId) {
              const group = get().tmuxGroups.find(
                (g) => g.controlSessionId === tmuxControlSessionId,
              );
              if (group) {
                cancelReconnect(group.id, "user-cancel");
                get().applyTmuxGroupReconnectGaveUp(
                  group.id,
                  t('sessionStore.autoReconnectCancelled'),
                );
                return;
              }
            }
            cancelReconnect(tab.stableId, "user-cancel");
            const message = t('sessionStore.autoReconnectCancelled');
            set((state) => ({
              tabs: state.tabs.map((item) =>
                item.sessionId === sessionId
                  ? {
                      ...item,
                      status: "error" as const,
                      errorMessage: message,
                      connectionProgress: createConnectionProgress(
                        "reconnecting",
                        message,
                        { retryable: true },
                      ),
                      reconnect: null,
                      lastEventAt: new Date().toISOString(),
                    }
                  : item,
              ),
            }));
          },
    closeActiveTab: () => {
            // Cmd+W(크롬식): 현재 활성 탭을 닫는다. 닫을 것이 있으면 true, 없으면
            // (home/sftp 처럼 닫는다는 개념이 없는 고정 탭) false 를 돌려준다 — 호출부가
            // false 면 창을 닫는다.
            const active = get().activeWorkspaceTab;
            if (active.startsWith("session:")) {
              void get().disconnectTab(active.slice("session:".length));
              return true;
            }
            if (active.startsWith("workspace:")) {
              void get().closeWorkspace(active.slice("workspace:".length));
              return true;
            }
            if (active.startsWith("tmuxgrp:")) {
              const groupId = active.slice("tmuxgrp:".length);
              const group = get().tmuxGroups.find((g) => g.id === groupId);
              if (group) {
                // 탭 × 와 동일하게 detach(서버 tmux 세션은 유지).
                void get().detachTmuxWorkspace(group.activeWorkspaceId);
              }
              return true;
            }
            // containers 는 고정 탭이지만 그 안에 호스트 탭이 따로 있다. 화면에 보이는
            // 닫을 것은 그 호스트 탭이므로 Cmd+W 도 그것을 닫는다 — 탭 × 와 같은 동작이다.
            // 여기서 창을 닫아 버리면 (창이 하나일 때) 앱이 통째로 종료됐다.
            if (active === "containers") {
              const hostId = get().activeContainerHostId;
              if (hostId) {
                void get().closeHostContainersTab(hostId);
                return true;
              }
              // 호스트 탭이 하나도 없으면 닫을 것이 없다 — home/sftp 와 같게 둔다.
              return false;
            }
            return false;
          },
    runTabCommand: (payload) => {
            // 닫은 탭 다시 열기: 최근닫음 스택에서 호스트를 꺼내 그대로 재연결(내용 복구 X).
            if (payload.kind === "reopen") {
              const hostId = popClosedHost();
              if (hostId && get().hosts.some((host) => host.id === hostId)) {
                void get().connectHost(hostId, 120, 32);
              }
              return;
            }
            // 가시 탭 순서: 고정(home/sftp) + 열린 컨테이너가 있을 때만 containers + 동적(tabStrip) 좌→우.
            // Containers 탭은 containerTabs가 있을 때만 표시되므로(AppTitleBar hasOpenContainers), 순환
            // 순서도 같게 맞춰 숨겨진(없는) 컨테이너 탭으로 이동하지 않게 한다.
            const order: string[] = ["home", "sftp"];
            if (get().containerTabs.length > 0) {
              order.push("containers");
            }
            for (const item of get().tabStrip) {
              if (item.kind === "session") {
                order.push(asSessionTabId(item.sessionId));
              } else if (item.kind === "workspace") {
                order.push(asWorkspaceTabId(item.workspaceId));
              } else if (item.kind === "tmux") {
                order.push(asTmuxSessionGroupTabId(item.tmuxGroupId));
              }
            }
            let targetKey: string | undefined;
            if (payload.kind === "index") {
              targetKey = order[payload.index - 1]; // 1-based
            } else if (payload.kind === "last") {
              targetKey = order[order.length - 1];
            } else {
              const delta = payload.kind === "next" ? 1 : -1;
              const current = order.indexOf(get().activeWorkspaceTab);
              const base = current < 0 ? 0 : current;
              targetKey = order[(base + delta + order.length) % order.length];
            }
            if (!targetKey) {
              return;
            }
            if (targetKey === "home") {
              get().activateHome();
            } else if (targetKey === "sftp") {
              get().activateSftp();
            } else if (targetKey === "containers") {
              get().activateContainers();
            } else if (targetKey.startsWith("session:")) {
              get().activateSession(targetKey.slice("session:".length));
            } else if (targetKey.startsWith("workspace:")) {
              get().activateWorkspace(targetKey.slice("workspace:".length));
            } else if (targetKey.startsWith("tmuxgrp:")) {
              get().activateTmuxGroup(targetKey.slice("tmuxgrp:".length));
            }
          },
    closeWorkspace: async (workspaceId) => {
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace) {
              return;
            }

            // tmux control mode 워크스페이스 = window 하나. 닫는 동안 도착하는 늦은
            // layout-change 가 이 window 만 되살리지 못하도록 **window 단위로** 가드한다
            // (세션 전체 가드를 쓰면 같은 세션의 다른 window 까지 막혀 전부 닫힌 듯 보였다).
            const closedTmux = workspace.tmux ?? null;
            if (closedTmux) {
              markTmuxWindowClosed(closedTmux.controlSessionId, closedTmux.windowId);
            }

            const sessionIds = listWorkspaceSessionIds(workspace.layout);
            for (const sessionId of sessionIds) {
              const tab = get().tabs.find((item) => item.sessionId === sessionId);
              if (tab) {
                cancelReconnect(tab.stableId, "workspace-closed");
              }
            }

            // tmux window: kill-window 로 그 window 만 종료(control 세션·다른 window 생존).
            // 로컬 정리는 그룹을 인지하는 removeTmuxWorkspacesLocal 에 위임한다(마지막
            // window 면 세션 그룹·상단 탭까지 정리). 이후 도착하는 %window-close 는
            // 대상이 이미 없어 idempotent.
            if (closedTmux) {
              const anyPane = sessionIds[0];
              if (anyPane) {
                await Promise.resolve(
                  api.ssh.tmuxKillWindow(anyPane, closedTmux.windowId),
                ).catch(() => undefined);
              }
              get().removeTmuxWorkspacesLocal(
                closedTmux.controlSessionId,
                closedTmux.windowId,
              );
              return;
            }

            // 비 tmux workspace: 각 세션 disconnect + 로컬 제거.
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
            // tmux pane 의 분할은 자유로운 drag-split 이 아니라 tmux 의 split-window 다.
            // 로컬 레이아웃을 직접 바꾸지 않고 control 채널로 분할만 요청한다. 결과
            // 레이아웃은 이어 도착하는 tmuxLayoutChange 이벤트가 재구성한다.
            // 방향: left/right → 좌우("h"), top/bottom → 상하("v").
            if (sessionId.startsWith("tmux:")) {
              void api.ssh.tmuxSplitPane(
                sessionId,
                directionAxis(direction) === "horizontal" ? "h" : "v",
              );
              return false;
            }
            const state = get();
            // 원격 화면(RDP·VNC)은 분할에 넣지 않는다. UI 도 안내선을 막지만(SessionShell) 그것만
            // 믿을 수는 없다 — 이 액션은 단축키·다른 드롭 경로에서도 불린다.
            if (!isSplittableSession(state.tabs, sessionId)) {
              return false;
            }
            const adjacent = resolveAdjacentTarget(
              state.tabStrip,
              state.workspaces,
              sessionId,
            );
            if (!adjacent) {
              return false;
            }
            if (
              adjacent.kind === "session" &&
              !isSplittableSession(state.tabs, adjacent.sessionId)
            ) {
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
            // 이미 있는 분할 화면으로 끌어 넣는 경로다. 여기도 막지 않으면 원격 화면이 분할 안에
            // 들어간다.
            if (!isSplittableSession(state.tabs, sessionId)) {
              return false;
            }
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
            // tmux pane 포커스는 control 채널의 select-pane 으로도 동기화한다. UI 의 active
            // pane 표시는 즉시 갱신하고, tmux 쪽 활성 pane 도 따라오게 한다.
            if (sessionId.startsWith("tmux:")) {
              void api.ssh.tmuxSelectPane(sessionId);
            }
            set((state) => {
              const workspace = state.workspaces.find(
                (w) => w.id === workspaceId,
              );
              const group = findTmuxGroupForWorkspace(
                state.tmuxGroups,
                workspace,
              );
              return {
                workspaces: state.workspaces.map((w) =>
                  w.id === workspaceId
                    ? { ...w, activeSessionId: sessionId }
                    : w,
                ),
                // tmux 윈도우면 상단 세션 탭(tmuxgrp:)을 활성 유지하고 그룹의 활성
                // 윈도우만 옮긴다. workspace: 로 바꾸면 세션 탭 강조가 꺼지고(닫을 때
                // 빈 화면) 윈도우 바 강조와 화면이 어긋난다.
                ...(group
                  ? {
                      activeWorkspaceTab: asTmuxSessionGroupTabId(group.id),
                      tmuxGroups: state.tmuxGroups.map((g) =>
                        g.id === group.id
                          ? { ...g, activeWorkspaceId: workspaceId }
                          : g,
                      ),
                    }
                  : { activeWorkspaceTab: asWorkspaceTabId(workspaceId) }),
              };
            });
          },
    applyTmuxActivePane: (controlSessionId, paneId) => {
            // 서버의 active pane 변경(%window-pane-changed)을 로컬 포커스에 반영한다.
            // select-pane 을 재전송하지 않아(루프 방지) activeSessionId 와 그룹의 활성
            // window 만 갱신한다. 상단 탭(activeWorkspaceTab)은 건드리지 않아 다른 화면을
            // 보고 있을 때 갑자기 끌려오지 않는다.
            const paneSessionId = `tmux:${controlSessionId}:${paneId.replace(/^%/, "")}`;
            set((state) => {
              const workspace = state.workspaces.find(
                (w) =>
                  w.tmux?.controlSessionId === controlSessionId &&
                  listWorkspaceSessionIds(w.layout).includes(paneSessionId),
              );
              if (!workspace || workspace.activeSessionId === paneSessionId) {
                return {};
              }
              const group = findTmuxGroupForWorkspace(state.tmuxGroups, workspace);
              return {
                workspaces: state.workspaces.map((w) =>
                  w.id === workspace.id
                    ? { ...w, activeSessionId: paneSessionId }
                    : w,
                ),
                ...(group
                  ? {
                      tmuxGroups: state.tmuxGroups.map((g) =>
                        g.id === group.id
                          ? { ...g, activeWorkspaceId: workspace.id }
                          : g,
                      ),
                    }
                  : {}),
              };
            });
          },
    openTmuxCommandPrompt: (spec) => {
            set({ tmuxCommandPrompt: spec });
          },
    closeTmuxCommandPrompt: () => {
            set({ tmuxCommandPrompt: null });
          },
    tmuxNewWindowInWorkspace: (workspaceId) => {
            // tmux workspace 에서 새 tmux window 생성. 비 tmux workspace 면 무시한다.
            // 대상 control 세션은 이 workspace 의 pane 가상 sessionId 로 식별한다.
            // 새 window 는 이어 오는 tmuxWindowAdd / tmuxLayoutChange 가 새 workspace 로
            // 반영하므로 여기서는 로컬 상태를 만들지 않는다.
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace?.tmux) {
              return;
            }
            const paneSessionId = listWorkspaceSessionIds(workspace.layout).find(
              (sessionId) => sessionId.startsWith("tmux:"),
            );
            if (!paneSessionId) {
              return;
            }
            void api.ssh.tmuxNewWindow(paneSessionId);
          },
    detachTmuxWorkspace: async (workspaceId) => {
            // closeWorkspace(=kill: 각 pane 을 kill-pane 으로 종료)와 달리, detach 는
            // 서버 tmux 세션·프로세스를 살린 채 control 채널만 분리한다(detach-client).
            // pane 을 kill 하지 않으므로 같은 호스트에 다시 attach 하면 그대로 복원된다.
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace?.tmux) {
              return;
            }
            const controlSessionId = workspace.tmux.controlSessionId;
            // 닫는 동안 도착하는 늦은 layout-change 가 워크스페이스를 되살리지 못하게 가드.
            markTmuxControlSessionClosed(controlSessionId);
            // 예약된 rebind prune 타이머도 취소(detach 가 자동 prune 보다 앞섰을 때).
            const pendingDetachPrune =
              tmuxRebindPruneTimers.get(controlSessionId);
            if (pendingDetachPrune) {
              clearTimeout(pendingDetachPrune);
              tmuxRebindPruneTimers.delete(controlSessionId);
            }

            // detach-client 는 control 채널 전체(이 control 세션의 모든 window)를 분리한다.
            // 그래서 같은 controlSessionId 를 공유하는 모든 workspace(=window)를 함께 정리한다.
            const siblingWorkspaces = get().workspaces.filter(
              (item) => item.tmux?.controlSessionId === controlSessionId,
            );
            const siblingWorkspaceIds = new Set(
              siblingWorkspaces.map((item) => item.id),
            );
            const allSessionIds = siblingWorkspaces.flatMap((item) =>
              listWorkspaceSessionIds(item.layout),
            );
            for (const sessionId of allSessionIds) {
              const tab = get().tabs.find((item) => item.sessionId === sessionId);
              if (tab) {
                cancelReconnect(tab.stableId, "workspace-closed");
              }
            }
            // 그룹 단위 재연결 예약도 취소(재연결 갭 중 detach 가 그룹을 되살리지 못하게).
            const detachGroup = get().tmuxGroups.find(
              (g) => g.controlSessionId === controlSessionId,
            );
            if (detachGroup) {
              cancelReconnect(detachGroup.id, "workspace-closed");
            }
            // detach 는 control 세션 단위 동작이다. 임의의 pane 가상 sessionId 한 개로
            // control 채널에 detach-client 를 보내면 Go 가 채널을 정리한다(kill-pane 미발생).
            const paneSessionId = allSessionIds.find((sessionId) =>
              sessionId.startsWith("tmux:"),
            );
            if (paneSessionId) {
              await Promise.resolve(api.ssh.tmuxDetach(paneSessionId)).catch(
                () => undefined,
              );
            }
            set((state) => {
              // detach 는 세션 전체 → 세션 그룹(+상단 탭)과 그 모든 window workspace 를 제거.
              const group = state.tmuxGroups.find(
                (g) => g.controlSessionId === controlSessionId,
              );
              const groupIndex = group
                ? state.tabStrip.findIndex(
                    (item) =>
                      item.kind === "tmux" && item.tmuxGroupId === group.id,
                  )
                : -1;
              const nextTabStrip = state.tabStrip.filter(
                (item) =>
                  !(
                    item.kind === "tmux" &&
                    group != null &&
                    item.tmuxGroupId === group.id
                  ),
              );
              // 활성 탭이 이 그룹(또는 그 윈도우 중 하나)이면 재계산(빈 화면 방지).
              const activeTabId = state.activeWorkspaceTab;
              const activeWasGroupOrWindow =
                (group != null &&
                  activeTabId === asTmuxSessionGroupTabId(group.id)) ||
                (activeTabId.startsWith("workspace:") &&
                  siblingWorkspaceIds.has(
                    activeTabId.slice("workspace:".length),
                  ));
              const nextActive = activeWasGroupOrWindow
                ? resolveNextVisibleTab(
                    nextTabStrip,
                    groupIndex >= 0 ? groupIndex : nextTabStrip.length,
                  )
                : state.activeWorkspaceTab;
              return {
                workspaces: state.workspaces.filter(
                  (item) => !siblingWorkspaceIds.has(item.id),
                ),
                tmuxGroups: state.tmuxGroups.filter(
                  (g) => g.controlSessionId !== controlSessionId,
                ),
                tabStrip: nextTabStrip,
                // tmux pane 탭은 SSH 세션이 아니므로 완전히 제거한다(늦은 layout-change 재흡수 방지).
                tabs: state.tabs.filter(
                  (tab) => !allSessionIds.includes(tab.sessionId),
                ),
                activeWorkspaceTab: nextActive,
              };
            });
          },
    removeTmuxWorkspacesLocal: (controlSessionId, windowId) => {
            // tmux window-close(%window-close) / exit(%exit) 후 로컬 정리. 서버에서 이미
            // 닫혔으므로 tmux 명령은 보내지 않고 window workspace/pane 탭만 제거한다.
            // windowId 가 있으면 그 window 만, 없으면(=exit) controlSessionId 의 모든 window.
            // 세션의 window 가 모두 사라지면 그룹·상단 탭까지 제거한다.
            // 이 control 세션에 예약된 rebind prune 타이머가 있으면 취소한다(수동 정리가
            // 자동 prune 보다 앞섰음 → 좀비 타이머가 비어버린 세션을 건드리지 않게).
            const pendingPrune = tmuxRebindPruneTimers.get(controlSessionId);
            if (pendingPrune) {
              clearTimeout(pendingPrune);
              tmuxRebindPruneTimers.delete(controlSessionId);
            }
            const groupBefore = get().tmuxGroups.find(
              (g) => g.controlSessionId === controlSessionId,
            );
            set((state) => {
              const targets = state.workspaces.filter(
                (item) =>
                  item.tmux?.controlSessionId === controlSessionId &&
                  (windowId == null || item.tmux?.windowId === windowId),
              );
              if (targets.length === 0) {
                return {};
              }
              const targetIds = new Set(targets.map((item) => item.id));
              const allSessionIds = targets.flatMap((item) =>
                listWorkspaceSessionIds(item.layout),
              );
              const remainingWindows = state.workspaces.filter(
                (item) =>
                  item.tmux?.controlSessionId === controlSessionId &&
                  !targetIds.has(item.id),
              );
              const group = state.tmuxGroups.find(
                (g) => g.controlSessionId === controlSessionId,
              );
              const groupGone = group != null && remainingWindows.length === 0;
              const groupIndex =
                group && groupGone
                  ? state.tabStrip.findIndex(
                      (item) =>
                        item.kind === "tmux" && item.tmuxGroupId === group.id,
                    )
                  : -1;
              const nextTabStrip =
                group && groupGone
                  ? state.tabStrip.filter(
                      (item) =>
                        !(item.kind === "tmux" && item.tmuxGroupId === group.id),
                    )
                  : state.tabStrip;
              const nextGroups = groupGone
                ? state.tmuxGroups.filter(
                    (g) => g.controlSessionId !== controlSessionId,
                  )
                : state.tmuxGroups.map((g) =>
                    g.controlSessionId === controlSessionId &&
                    targetIds.has(g.activeWorkspaceId) &&
                    remainingWindows.length > 0
                      ? { ...g, activeWorkspaceId: remainingWindows[0].id }
                      : g,
                  );
              // 활성 탭이 닫히는 그룹/윈도우를 가리키면 재계산해 빈 화면을 막는다.
              // activeWorkspaceTab 은 보통 tmuxgrp:(#3) 지만, 어쩌다 닫힌 윈도우
              // workspace:<id> 여도 대응한다.
              const activeTabId = state.activeWorkspaceTab;
              const activeWasGroupTab =
                group != null &&
                activeTabId === asTmuxSessionGroupTabId(group.id);
              const activeWasRemovedWindow =
                activeTabId.startsWith("workspace:") &&
                targetIds.has(activeTabId.slice("workspace:".length));
              let nextActive = activeTabId;
              if (groupGone) {
                if (activeWasGroupTab || activeWasRemovedWindow) {
                  nextActive = resolveNextVisibleTab(
                    nextTabStrip,
                    groupIndex >= 0 ? groupIndex : nextTabStrip.length,
                  );
                }
              } else if (activeWasRemovedWindow && group != null) {
                // 그룹 생존 + 활성 윈도우가 닫힘 → 그룹 탭으로(생존 윈도우 표시).
                nextActive = asTmuxSessionGroupTabId(group.id);
              }
              return {
                workspaces: state.workspaces.filter(
                  (item) => !targetIds.has(item.id),
                ),
                tmuxGroups: nextGroups,
                tabStrip: nextTabStrip,
                tabs: state.tabs.filter(
                  (tab) => !allSessionIds.includes(tab.sessionId),
                ),
                activeWorkspaceTab: nextActive,
              };
            });
            // 그룹이 통째로 제거됐으면 예약된 재연결도 취소(좀비 방지).
            if (
              groupBefore &&
              !get().tmuxGroups.some((g) => g.id === groupBefore.id)
            ) {
              cancelReconnect(groupBefore.id, "tmux-group-removed");
            }
          },
    applyTmuxGroupReconnecting: (groupId, summary, message) => {
            set((state) => {
              const group = state.tmuxGroups.find((g) => g.id === groupId);
              if (!group) {
                return {};
              }
              const controlSessionId = group.controlSessionId;
              const progress = createConnectionProgress("reconnecting", message);
              return {
                tmuxGroups: state.tmuxGroups.map((g) =>
                  g.id === groupId ? { ...g, reconnect: summary } : g,
                ),
                // 갭 동안 패인 탭을 'connecting'(재연결 중 오버레이)으로. 재연결 성공 시
                // handleTmuxLayoutChange 가 새 'connected' 패인 탭으로 교체한다.
                tabs: state.tabs.map((tab) =>
                  tab.tmux?.controlSessionId === controlSessionId
                    ? {
                        ...tab,
                        status: "connecting" as const,
                        connectionProgress: progress,
                        lastEventAt: new Date().toISOString(),
                      }
                    : tab,
                ),
              };
            });
          },
    applyTmuxGroupReconnectGaveUp: (groupId, message) => {
            set((state) => {
              const group = state.tmuxGroups.find((g) => g.id === groupId);
              if (!group) {
                return {};
              }
              const controlSessionId = group.controlSessionId;
              const progress = createConnectionProgress("reconnecting", message, {
                retryable: true,
              });
              return {
                tmuxGroups: state.tmuxGroups.map((g) =>
                  g.id === groupId ? { ...g, reconnect: null } : g,
                ),
                tabs: state.tabs.map((tab) =>
                  tab.tmux?.controlSessionId === controlSessionId
                    ? {
                        ...tab,
                        status: "error" as const,
                        connectionProgress: progress,
                        lastEventAt: new Date().toISOString(),
                      }
                    : tab,
                ),
              };
            });
          },
    applyTabCommandState: (sessionId, commandState) => {
            // 셸 통합 OSC133 마커마다 호출되므로, 값이 바뀔 때만 set 해 불필요한 리렌더를 막는다.
            const tab = get().tabs.find((t) => t.sessionId === sessionId);
            if (!tab || tab.commandState === commandState) {
              return;
            }
            set((state) => ({
              tabs: state.tabs.map((t) =>
                t.sessionId === sessionId ? { ...t, commandState } : t,
              ),
            }));
          },
    selectTmuxWindow: (workspaceId) => {
            // 그룹 내 활성 window 전환: tmux 에 select-window 를 보내고 그룹의
            // activeWorkspaceId 를 갱신한다. activeWorkspaceTab 은 그룹 탭 그대로 유지.
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace?.tmux) {
              return;
            }
            const { controlSessionId, windowId } = workspace.tmux;
            const paneSessionId = listWorkspaceSessionIds(workspace.layout).find(
              (sessionId) => sessionId.startsWith("tmux:"),
            );
            if (paneSessionId) {
              void api.ssh.tmuxSelectWindow(paneSessionId, windowId);
            }
            set((state) => {
              const group = state.tmuxGroups.find(
                (g) => g.controlSessionId === controlSessionId,
              );
              if (!group) {
                return {};
              }
              return {
                tmuxGroups: state.tmuxGroups.map((g) =>
                  g.id === group.id
                    ? { ...g, activeWorkspaceId: workspaceId }
                    : g,
                ),
                activeWorkspaceTab: asTmuxSessionGroupTabId(group.id),
              };
            });
          },
    renameTmuxWindow: (workspaceId, name) => {
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (!workspace?.tmux) {
              return;
            }
            const { windowId, index } = workspace.tmux;
            const paneSessionId = listWorkspaceSessionIds(workspace.layout).find(
              (sessionId) => sessionId.startsWith("tmux:"),
            );
            if (paneSessionId) {
              void api.ssh.tmuxRenameWindow(paneSessionId, windowId, name);
            }
            // 결과는 %window-renamed 로 되돌아오지만, 즉시성 위해 낙관적으로도 반영.
            set((state) => ({
              workspaces: state.workspaces.map((w) =>
                w.id === workspaceId && w.tmux
                  ? {
                      ...w,
                      tmux: { ...w.tmux, name },
                      title: `${index ?? 0}:${name}`,
                    }
                  : w,
              ),
            }));
          },
    applyTmuxWindowRenamed: (controlSessionId, windowId, name) => {
            set((state) => ({
              workspaces: state.workspaces.map((w) =>
                w.tmux?.controlSessionId === controlSessionId &&
                w.tmux?.windowId === windowId
                  ? {
                      ...w,
                      tmux: { ...w.tmux, name },
                      title: `${w.tmux.index ?? 0}:${name}`,
                    }
                  : w,
              ),
            }));
          },
    applyTmuxSessionName: (controlSessionId, sessionName) => {
            // %session-changed → 세션 그룹 푸터의 세션명을 실제 tmux 세션명으로 갱신.
            // controlSessionId 가 직접 매칭되거나, 재연결로 rebind 됐을 수 있어 그룹의
            // 현재 controlSessionId 로만 찾는다(handleTmuxLayoutChange 가 rebind 유지).
            if (!sessionName) {
              return;
            }
            set((state) => ({
              tmuxGroups: state.tmuxGroups.map((g) =>
                g.controlSessionId === controlSessionId
                  ? { ...g, sessionName }
                  : g,
              ),
            }));
          },
    applyTmuxSessionsList: (controlSessionId, sessions) => {
            // %sessions-changed → 그 control 세션 그룹의 원격 세션 목록을 갱신(메뉴 표시용).
            set((state) => ({
              tmuxGroups: state.tmuxGroups.map((g) =>
                g.controlSessionId === controlSessionId ? { ...g, sessions } : g,
              ),
            }));
          },
    killTmuxSession: (sessionId, sessionName) => {
            // 원격 tmux 세션 전체 종료(kill-session). sessionId 가 control 세션의 pane id 면
            // Go 가 control 채널로, 감지 하단바의 SSH 세션 id 면 보조 exec 채널로 라우팅한다.
            // 결과는 control: %sessions-changed / SSH: 재감지(EventTmuxAvailable)로 목록 갱신.
            if (!sessionName) {
              return;
            }
            void api.ssh.tmuxKillSession(sessionId, sessionName);
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
              const message = t('sessionStore.authInputCancelled', {
                label: host?.label ?? t('runtime.session'),
              });
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
              throw new Error(t('sessionStore.usernameRequired'));
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
                throw new Error(t('sessionStore.usernameUpdateFailed'));
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
              throw new Error(t('sessionStore.usernameRequired'));
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
    confirmStartupCommandPrompt: async (values) => {
            const pending = get().pendingStartupCommandPrompt;
            if (!pending) {
              return;
            }
            set({ pendingStartupCommandPrompt: null });
            await startSessionConnectionFlow(
              set,
              get,
              pending.hostId,
              pending.cols,
              pending.rows,
              pending.secrets,
              undefined,
              resolveSnippetCommand(pending.command, values),
            );
          },
    cancelStartupCommandPrompt: () => {
            set({ pendingStartupCommandPrompt: null });
          },
    respondInteractiveAuth: async (
            challengeId,
            responses,
            storedPasswordIndexes,
          ) => {
            // 어느 대상의 요청인지는 챌린지 ID 로 찾는다 — 화면이 여러 개 떠 있어도 답이 자기
            // 연결로 간다.
            const pending = findPendingInteractiveAuthByChallengeId(
              get().pendingInteractiveAuths,
              challengeId,
            );
            if (!pending) {
              return;
            }
            try {
              await api.ssh.respondKeyboardInteractive(
                // endpointId 가 있으면 답은 그쪽으로 간다(코어의 대기표가 거기 걸려 있다).
                // 세션과 공개 키 설치는 sessionId 가 상관 ID 다.
                !("endpointId" in pending)
                  ? {
                      sessionId: pending.sessionId,
                      challengeId,
                      responses,
                      // 세션 경로만 코어에서 대입을 처리한다. SFTP·컨테이너·포워딩은 각자 다른
                      // 서비스를 타므로 인덱스를 보내도 채워지지 않는다 — 그래서 보내지 않는다.
                      ...(storedPasswordIndexes?.length
                        ? { storedPasswordIndexes }
                        : {}),
                    }
                  : {
                      endpointId: pending.endpointId,
                      challengeId,
                      responses,
                    },
              );
            } catch (error) {
              // 받을 곳이 없어졌을 때(연결이 이미 끝났거나 코어가 그 챌린지를 버렸을 때) 조용히
              // 넘기면 버튼이 먹통으로 보인다. 이유를 카드에 남긴다.
              set((state) => ({
                pendingInteractiveAuths: state.pendingInteractiveAuths.map((auth) =>
                  auth.challengeId === challengeId
                    ? {
                        ...auth,
                        deliveryError: normalizeErrorMessage(
                          error,
                          t('authOverlay.deliveryFailed'),
                        ),
                      }
                    : auth,
                ),
              }));
            }
          },
    reopenInteractiveAuthUrl: async (challengeId) => {
            const auths = get().pendingInteractiveAuths;
            const pending = challengeId
              ? findPendingInteractiveAuthByChallengeId(auths, challengeId)
              : (auths.find((auth) => auth.approvalUrl) ?? null);
            if (!pending?.approvalUrl) {
              return;
            }
            await api.shell.openExternal(pending.approvalUrl);
          },
    clearPendingInteractiveAuth: (challengeId) => {
            // 카드를 지우기 전에, 그 물음을 기다리던 코어에 닫혔다고 알린다.
            //
            // **이걸 빠뜨리면 연결이 멈춘 채로 남는다.** 화면에서 지우는 것은 렌더러 상태일 뿐이라
            // 코어는 계속 답을 기다리고, 사람을 기다리는 구간은 코어의 정지 감시가 일부러 꺼져
            // 있어서 그쪽이 대신 끊어 주지도 않는다. 결국 예산 5분이 지나야 풀렸다 — 그동안 진행
            // 카드는 "연결 중…"에 앉아 있고, tailnet 을 경유하면 그 노드의 리스까지 잡은 채라
            // 설정의 "연결 종료"도 거절된다.
            const closing = challengeId
              ? get().pendingInteractiveAuths.filter(
                  (auth) => auth.challengeId === challengeId,
                )
              : get().pendingInteractiveAuths;
            for (const auth of closing) {
              void api.ssh
                .respondKeyboardInteractive(
                  !("endpointId" in auth)
                    ? {
                        sessionId: auth.sessionId,
                        challengeId: auth.challengeId,
                        responses: [],
                        cancelled: true,
                      }
                    : {
                        endpointId: auth.endpointId,
                        challengeId: auth.challengeId,
                        responses: [],
                        cancelled: true,
                      },
                )
                // 이미 끝난 물음이면 코어가 "not found" 를 준다. 닫는 동작에는 알릴 것이 없다.
                .catch(() => {});
            }
            set((state) => ({
              pendingInteractiveAuths: challengeId
                ? state.pendingInteractiveAuths.filter(
                    (auth) => auth.challengeId !== challengeId,
                  )
                : [],
            }));
          },
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
