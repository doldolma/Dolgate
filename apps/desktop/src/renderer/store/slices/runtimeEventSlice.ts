import type { SliceDeps } from "../services/context";
import { clearSessionCwd } from "../../lib/terminal-cwd-registry";
import { recordRtt } from "../../lib/rtt-history";
import { writeTerminalNotice } from "../../lib/terminal-write-registry";
import type {
  AppState,
  ContainerTunnelTabState,
  EcsTunnelTabState,
  RuntimeEventSlice,
} from "../types";
import type {
  KeyboardInteractiveChallenge,
  KeyboardInteractivePrompt,
  TerminalConnectionHop,
  TerminalTab,
} from "@shared";
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
  isVncHostRecord,
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
  resolveVncTunnelSessionId,
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
  isChangedHostKeyErrorMessage,
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
  toKeyboardInteractiveHop,
  upsertPendingInteractiveAuth,
  clearSessionPendingInteractiveAuth,
  clearEndpointPendingInteractiveAuth,
  findSessionPendingInteractiveAuth,
  findEndpointPendingInteractiveAuth,
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
  enqueueHostKeyPrompt,
  findHostByAddress,
  updateConnectionView,
  upsertConnectionHop,
  clearConnectionView,
} from "../utils";
import { createBootstrapSyncServices } from "../services/bootstrap-sync";
import { createTrustAuthServices } from "../services/trust-auth";
import { updateStoredSshUsername } from "../services/credential-retry";
import { createRuntimeEventServices } from "../services/runtime-events";
import {
  cancelReconnect,
  isReconnecting,
  scheduleReconnect,
} from "../services/reconnect-orchestrator";
import {
  classifyReconnect,
  isRemoteScreenErrorFinal,
} from "../utils/reconnect-classify";
import {
  isAutoRecoveredTransferJob,
  isTerminalUploadJob,
  markAutoRecoveredTransferJob,
} from "../../lib/terminal-upload-registry";
import { resolveHopHostNames } from "../../lib/connection-hops";
import type { CoreEvent, HostRecord } from "@shared";
import { hostIdFromKeyInstallCorrelation } from "@shared";
import { t } from "../../i18n";

/**
 * 원격 화면(RDP·VNC)의 예기치 않은 오류를 자동 재연결할지.
 *
 * **붙었던 적이 없는 연결은 되살리지 않는다.** SSH 가 쓰는 규칙과 같다(shouldAutoReconnectSession
 * 의 `status !== "connected"` 게이트). 첫 시도가 실패하는 흔한 이유는 설정이 틀린 것이고 — 포트를
 * 잘못 넣은 경우가 실제로 그랬다 — 그것을 열 번 반복하면 사용자는 자기 오타를 볼 기회를 잃는다.
 * 실패한 채로 앉혀 두면 재시도 버튼이 그 자리에 있다.
 *
 * 다만 재연결 주기 안의 실패는 이어 가야 한다(서버 재부팅은 여러 번 거절한다). 주기 여부는 탭이
 * 아니라 오케스트레이터에 묻는다 — 재시도는 세션 id 를 새로 만들고 그때 탭의 reconnect 요약이
 * 비므로, 탭만 보면 시도 1회에서 멈춘다. 오케스트레이터는 stableId 로 키잉해 그 교체를 넘어간다.
 *
 * 오류 종류로도 한 번 더 막는다: 인증 실패를 반복하면 계정이 잠기고(VeNCrypt Plain 은 PAM 을
 * 타므로 실제로 잠긴다) 인증서 변경은 신뢰 프롬프트를 무한히 다시 띄운다.
 */
function shouldAutoReconnectRemoteScreen(
  tab: TerminalTab,
  message: string,
): boolean {
  if (tab.status !== "connected" && !isReconnecting(tab.stableId)) {
    return false;
  }
  return !isRemoteScreenErrorFinal(message);
}

// AWS SSM 세션 종료 메시지에서 종료 코드를 뽑는다(예: "AWS SSM session exited with code 1").
const AWS_SSM_SESSION_EXIT_PATTERN =
  /AWS SSM session exited with code\s+(-?\d+)/i;

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

  // aws-ec2(SSM): 서버 프록시 세션은 core-manager가 reason 구분자를 직접
  // 실어준다(사용자 X 닫기 = "client" → 재연결 금지, 웹소켓 단절 = "transport").
  // 직결 SSM 세션은 reason이 없으므로 기존대로 SSM 종료 코드로 판별한다.
  if (host.kind === "aws-ec2") {
    if (event.type === "error") {
      return classifyReconnect(message) !== "permanent";
    }
    if (event.type === "closed") {
      const reason = String(payload?.reason ?? "");
      if (reason === "client" || reason === "remote-exit") {
        return false; // 사용자 요청 종료/원격 정상 종료 → 되살리지 않음
      }
      if (reason === "transport" || reason === "keepalive") {
        return true; // 프록시 연결 단절 → 재연결
      }
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
              t("runtime.reconnecting"),
            ),
            lastEventAt: new Date().toISOString(),
          }
        : tab,
    ),
  };
}

/**
 * 코어 이벤트에서 공통 진행 상태를 뽑아 둔다.
 *
 * 여기서 하는 일은 기록뿐이다 — 화면 전환도, 탭 조작도 하지 않는다. 그래야 이 함수가 모든 경로의
 * 모든 이벤트에서 돌아도 기존 동작을 건드리지 않는다.
 */
function recordConnectionView(
  set: (updater: (state: AppState) => Partial<AppState>) => void,
  event: CoreEvent,
): void {
  // 상관 ID 가 곧 열쇠다. 둘 다 없으면 어느 연결인지 알 수 없으므로 기록하지 않는다.
  const key = event.sessionId || event.endpointId;
  if (!key) {
    return;
  }

  switch (event.type) {
    case "connectionHopProgress": {
      const payload = event.payload as {
        hopLabel?: unknown;
        hopIndex?: unknown;
        hopCount?: unknown;
        stage?: unknown;
      };
      const index = typeof payload.hopIndex === "number" ? payload.hopIndex : 0;
      if (index <= 0) {
        return;
      }
      const hop: TerminalConnectionHop = {
        index,
        count: typeof payload.hopCount === "number" ? payload.hopCount : index,
        label: typeof payload.hopLabel === "string" ? payload.hopLabel : "",
        stage:
          payload.stage === "connected" || payload.stage === "failed"
            ? payload.stage
            : "connecting",
      };
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          status: "connecting",
          hops: upsertConnectionHop(state.connectionViews[key]?.hops, hop),
        }),
      }));
      return;
    }
    case "sshBanner": {
      const payload = event.payload as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text) {
        return;
      }
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          banner: text,
        }),
      }));
      return;
    }
    case "keyboardInteractiveChallenge": {
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          status: "connecting",
          stage: "waiting-interactive-auth",
        }),
      }));
      return;
    }
    case "hostKeyTrustChallenge": {
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          status: "connecting",
          stage: "probing-host-key",
        }),
      }));
      return;
    }
    case "keyboardInteractiveResolved": {
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          stage: "connecting",
        }),
      }));
      return;
    }
    // 끝났으면 지운다. 남겨 두면 다음 연결이 앞 시도의 홉을 물려받는다.
    case "connected":
    case "closed":
    case "portForwardStarted":
    case "portForwardStopped":
    case "containersConnected":
    case "authorizedKeyInstalled": {
      set((state) => ({
        connectionViews: clearConnectionView(state.connectionViews, key),
      }));
      return;
    }
    case "error":
    case "portForwardError":
    case "containersError": {
      const payload = event.payload as { message?: unknown };
      set((state) => ({
        connectionViews: updateConnectionView(state.connectionViews, key, {
          status: "error",
          message:
            typeof payload?.message === "string" ? payload.message : undefined,
        }),
      }));
      return;
    }
    default:
      return;
  }
}

export function createRuntimeEventSlice(deps: SliceDeps): RuntimeEventSlice {
  const { api, set, get } = deps;
  const services = createRuntimeEventServices(deps);
  const bootstrapServices = createBootstrapSyncServices(deps);
  const { recoverFromChangedHostKey } = createTrustAuthServices(deps);

  const { openedInteractiveBrowserChallenges, scheduleActivityLogsRefresh } =
    services;
  const { refreshHostAndKeychainState } = bootstrapServices;
  const missingContainerShellMessage = t("runtime.containerShellFailed");
  const missingEcsShellMessage = t("runtime.ecsShellFailed");
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
    // RDP 는 별도 코어를 쓰고 재연결·tmux·자격증명 재시도 같은 SSH 기계를 타지 않는다.
    // handleCoreEvent 에 분기를 더하면 그 1500 줄이 RDP 도 감당한다고 착각하게 되므로 분리한다.
    handleRdpEvent: (event) => {
      // 재연결 예약은 set 밖에서 한다 — 예약이 다시 스토어를 갱신하므로(핸들러의
      // renderScheduled) set 안에서 부르면 갱신이 겹친다.
      let scheduleFor: { stableId: string; hostId: string } | null = null as {
        stableId: string;
        hostId: string;
      } | null;

      // 세션이 끝나면 hover 의 "연결 경과" 시각을 지운다. 자동 재연결이 같은
      // sessionId 를 재사용하므로, 안 지우면 재연결 후에도 옛 시각부터 센다.
      if (event.type === "error" || event.type === "closed") {
        clearSessionCwd(event.sessionId);
      }

      set((state) => {
        const tab = state.tabs.find(
          (item) => item.sessionId === event.sessionId,
        );
        if (!tab) {
          return state;
        }

        if (event.type === "resized") {
          // 탭 hover 의 해상도 표기를 실제 크기에 따라 갱신한다.
          return {
            tabs: state.tabs.map((item) =>
              item.sessionId === event.sessionId
                ? {
                    ...item,
                    rdpDesktopSize: {
                      width: event.desktopWidth,
                      height: event.desktopHeight,
                    },
                    rdpMonitorCount: event.monitors.length,
                    lastEventAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
        }

        if (event.type === "error") {
          // 인증 실패는 재시도하지 않는다 — 반복하면 계정이 잠긴다. 인증서 변경도
          // 자동 재시도하면 프롬프트가 무한히 다시 뜬다.
          if (
            get().settings.autoReconnectEnabled &&
            tab.hostId &&
            shouldAutoReconnectRemoteScreen(tab, event.message)
          ) {
            scheduleFor = { stableId: tab.stableId, hostId: tab.hostId };
          }
          return {
            tabs: state.tabs.map((item) =>
              item.sessionId === event.sessionId
                ? {
                    ...item,
                    status: "error" as const,
                    errorMessage: event.message,
                    connectionProgress: resolveErrorProgress(
                      event.message,
                      true,
                    ),
                    lastEventAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
        }

        if (event.type === "closed") {
          // rdp-core 는 실패 시 error 다음에 항상 closed 를 보낸다. 무조건 지우면 방금
          // 띄운 에러가 스쳐 지나가 사용자가 이유를 못 본다. 에러 상태면 남겨 둔다
          // (재연결 예약도 그 error 에서 이미 판단했다).
          if (tab.status === "error") {
            return state;
          }
          // 붙어 있던 세션이 갑자기 닫혔다 = 서버 재부팅·네트워크 끊김·tailnet 만료.
          // 탭을 지우면 사용자는 이유도 모른 채 창이 사라진 것만 본다.
          //
          // 사용자가 끊은 경우는 여기 오지 않는다 — disconnectTab 이 먼저 탭을 지우므로
          // 위에서 `!tab` 으로 빠져나간다.
          if (
            tab.status === "connected" &&
            // 정상 종료(원격 로그오프·서버가 끊음)는 되살리지 않는다. 네트워크가 끊긴
            // 경우는 IO 오류라 error 로 오고 여기 오지 않는다.
            event.graceful !== true &&
            get().settings.autoReconnectEnabled &&
            tab.hostId
          ) {
            scheduleFor = { stableId: tab.stableId, hostId: tab.hostId };
            return state;
          }
          return removeSessionFromState(state, event.sessionId);
        }

        return state;
      });

      if (scheduleFor) {
        scheduleReconnect({
          kind: "rdp",
          key: scheduleFor.stableId,
          meta: { hostId: scheduleFor.hostId },
        });
      }
    },
    /**
     * VNC 세션 이벤트. RDP 와 같은 이유로 SSH 기계를 타지 않는다.
     *
     * 여기서 하는 일은 하나다 — **끊긴 세션을 되살리거나, 왜 끊겼는지 남기는 것.** 예전에는 VNC
     * 이벤트가 스토어에 아예 오지 않아서, 붙어 있던 세션이 끊기면 화면만 멈추고 탭은 초록색으로
     * 남았다(재연결도 없었다).
     */
    handleVncEvent: (event) => {
      // 재연결 예약은 set 밖에서 한다 — 예약이 다시 스토어를 갱신하므로(핸들러의 renderScheduled)
      // set 안에서 부르면 갱신이 겹친다. 타입을 명시하는 이유는 RDP 쪽과 같다(추론이 never 로
      // 좁혀져 아래 할당이 막힌다).
      let scheduleFor: { stableId: string; hostId: string } | null = null as {
        stableId: string;
        hostId: string;
      } | null;

      if (event.type === "error" || event.type === "closed") {
        clearSessionCwd(event.sessionId);
      }

      set((state) => {
        const tab = state.tabs.find(
          (item) => item.sessionId === event.sessionId,
        );
        if (!tab) {
          return state;
        }

        if (event.type === "progress") {
          // 결과가 난 탭에는 얹지 않는다. 통로를 여는 보고는 접속 요청 안에서 나오므로, 실패한
          // 뒤에 도착하는 순서가 실제로 생긴다 — 그러면 방금 띄운 이유가 진행 문구로 덮인다.
          if (tab.status === "connected" || tab.status === "error") {
            return state;
          }
          return {
            tabs: state.tabs.map((item) =>
              item.sessionId === event.sessionId
                ? {
                    ...item,
                    connectionProgress: createConnectionProgress(
                      event.stage,
                      event.message,
                    ),
                    lastEventAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
        }

        if (event.type === "resized") {
          // 탭 hover 의 해상도 표기. VNC 는 프레임버퍼가 하나라 모니터 수는 없다.
          return {
            tabs: state.tabs.map((item) =>
              item.sessionId === event.sessionId
                ? {
                    ...item,
                    rdpDesktopSize: {
                      width: event.desktopWidth,
                      height: event.desktopHeight,
                    },
                    lastEventAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
        }

        if (event.type === "error") {
          if (
            get().settings.autoReconnectEnabled &&
            tab.hostId &&
            shouldAutoReconnectRemoteScreen(tab, event.message)
          ) {
            scheduleFor = { stableId: tab.stableId, hostId: tab.hostId };
          }
          return {
            tabs: state.tabs.map((item) =>
              item.sessionId === event.sessionId
                ? {
                    ...item,
                    status: "error" as const,
                    errorMessage: event.message,
                    connectionProgress: resolveErrorProgress(
                      event.message,
                      true,
                    ),
                    lastEventAt: new Date().toISOString(),
                  }
                : item,
            ),
          };
        }

        if (event.type === "closed") {
          // 실패 뒤에는 error 다음에 closed 가 온다. 무조건 지우면 방금 띄운 이유가 스쳐 지나간다.
          if (tab.status === "error") {
            return state;
          }
          // 붙어 있던 세션이 갑자기 닫혔다 = 서버 재부팅·네트워크 끊김·다른 클라이언트가 독점
          // 접속(shared 를 끈 클라이언트가 붙으면 서버가 우리를 끊는다).
          if (
            tab.status === "connected" &&
            get().settings.autoReconnectEnabled &&
            tab.hostId
          ) {
            scheduleFor = { stableId: tab.stableId, hostId: tab.hostId };
            return state;
          }
          return removeSessionFromState(state, event.sessionId);
        }

        return state;
      });

      if (scheduleFor) {
        scheduleReconnect({
          kind: "vnc",
          key: scheduleFor.stableId,
          meta: { hostId: scheduleFor.hostId },
        });
      }
    },
    handleCoreEvent: (event) => {
      const sessionId = event.sessionId;
      const endpointId = event.endpointId;
      const activeRetryAttemptBeforeUpdate = get().activeCredentialRetryAttempt;
      scheduleActivityLogsRefresh();

      // 공통 진행 상태를 먼저 모은다. **아래 라우팅과 무관하게** 돈다 — 그래야 자기 화면이 없는
      // 경로(포워딩·공개키 설치)도 tailnet·점프·신뢰·인증을 그대로 보여줄 수 있다.
      //
      // 실패해도 아래로 넘어간다. 이건 진행 표시용 곁가지인데, 여기서 던지면 그 이벤트의 **본
      // 처리가 통째로 건너뛰어진다** — 터미널이 붙지 않거나 탭이 안 닫히는 식으로 번진다.
      // 곁가지가 본류를 끊게 두지 않는다.
      try {
        recordConnectionView(set, event);
      } catch (error) {
        console.warn("[connection-view] 진행 상태를 기록하지 못했습니다", error);
      }

      // 서버가 인증 단계에 보낸 배너(RFC 4252 §5.4). 해석하지 않고 터미널에 그대로 찍는다 —
      // OpenSSH 가 하는 것과 같고, 승인 주소인지 회사 경고문인지는 사용자가 읽고 판단한다.
      // 우리가 문구를 뒤져 의도를 추측하면 정책 안내 링크를 "승인하라"고 잘못 말하게 된다.
      //
      // 터미널에 찍는 이유가 하나 더 있다: web-links 애드온이 URL 을 눌러 열 수 있게 만들어
      // 준다(terminal-runtime). 카드에 글자로 박으면 복사도 클릭도 안 된다.
      if (event.type === "sshBanner" && sessionId) {
        const payload = event.payload as { text?: unknown };
        const text = typeof payload?.text === "string" ? payload.text : "";
        const bannerTab = get().tabs.find(
          (item) => item.sessionId === sessionId,
        );
        if (!text || !bannerTab) {
          return;
        }
        // xterm 은 \n 만으로는 열을 되돌리지 않아 줄이 계단처럼 밀린다 — CRLF 로 맞춘다.
        writeTerminalNotice(
          bannerTab.stableId,
          `${text.replace(/\r?\n/g, "\r\n")}\r\n`,
        );
        set((state) => ({
          tabs: state.tabs.map((item) =>
            item.sessionId === sessionId
              ? { ...item, serverBannerShown: true }
              : item,
          ),
        }));
        return;
      }

      // 공개 키 설치가 묻는 인증.
      //
      // 세션 처리부보다 **먼저** 가른다. 설치는 탭을 만들지 않으므로 그쪽으로 흘려보내면 탭을
      // 찾다가 아무 일도 못 하고, 사용자는 붉은 오류만 본다. 여기서 자기 카드로 만들어 설치
      // 대화상자가 그린다(@shared 의 KEY_INSTALL_CORRELATION_PREFIX).
      const keyInstallHostId = hostIdFromKeyInstallCorrelation(sessionId);
      if (keyInstallHostId) {
        if (event.type === "keyboardInteractiveChallenge") {
          const payload = event.payload as Record<string, unknown>;
          set((state) => ({
            pendingInteractiveAuths: upsertPendingInteractiveAuth(
              state.pendingInteractiveAuths,
              {
                source: "keyInstall",
                sessionId: sessionId as string,
                hostId: keyInstallHostId,
                challengeId: String(payload.challengeId ?? ""),
                name: typeof payload.name === "string" ? payload.name : null,
                instruction: String(payload.instruction ?? ""),
                prompts: Array.isArray(payload.prompts)
                  ? payload.prompts.map((prompt) => {
                      const candidate = prompt as Record<string, unknown>;
                      return {
                        label: String(candidate.label ?? ""),
                        echo: Boolean(candidate.echo),
                        allowStoredPassword: Boolean(candidate.allowStoredPassword),
                        masked: Boolean(candidate.masked),
                      };
                    })
                  : [],
                hasStoredPassword: Boolean(payload.hasStoredPassword),
                hop: toKeyboardInteractiveHop(payload.hop),
                provider: "generic",
                autoSubmitted: false,
              },
            ),
          }));
          return;
        }
        if (event.type === "keyboardInteractiveResolved") {
          set((state) => ({
            pendingInteractiveAuths: state.pendingInteractiveAuths.filter(
              (auth) =>
                !(auth.source === "keyInstall" && auth.sessionId === sessionId),
            ),
          }));
          return;
        }
      }

      // 연결이 "이 서버 키를 신뢰하겠습니까" 를 묻고, 그 자리에서 답을 기다린다.
      //
      // 범위를 가리지 않는다(세션·포워딩·SFTP·컨테이너). 대화상자는 하나뿐이고 답은 챌린지 ID 로
      // 코어의 대기표에 돌아가므로, 어느 연결이 물었는지는 화면이 구분할 필요가 없다. 세션 처리부
      // 안에 두면 sessionId 가 없는 연결(포워딩·SFTP)의 질문이 그냥 사라져서, 사용자는 아무 창도
      // 보지 못한 채 기다리다 끝난다.
      if (event.type === "hostKeyTrustChallenge") {
        const payload = event.payload as Record<string, unknown>;
        const hop = toKeyboardInteractiveHop(payload.hop);
        const host = hop?.host ?? "";
        const port = hop?.port ?? 22;
        const state = get();
        // 이 키를 **어느 호스트의 것으로 저장할지** 가 여기서 갈린다. 점프 체인이면 질문은 그 홉의
        // 것이므로 홉 주소로 레코드를 찾는다 — 탭의 호스트(최종 대상)로 저장하면 신뢰 범위
        // (tailnet)가 어긋나서, 저장은 되는데 다음 연결이 또 묻는 상태가 된다.
        const currentTab = sessionId
          ? state.tabs.find((tab) => tab.sessionId === sessionId)
          : undefined;
        const hostRecord =
          // 주소로 찾는 규칙은 인증 카드가 이름을 얹을 때 쓰는 것과 같아야 한다 — 따로 두면
          // 신뢰 대화상자와 인증 카드가 같은 홉을 다른 이름으로 부른다.
          findHostByAddress(state.hosts, host, port) ??
          (currentTab?.source === "host" && currentTab.hostId
            ? state.hosts.find((record) => record.id === currentTab.hostId)
            : undefined);
        const existing =
          state.knownHosts.find(
            (record) =>
              record.host === host &&
              record.port === port &&
              record.algorithm === String(payload.algorithm ?? ""),
          ) ?? null;
        // 보여 주는 것이 있으면 뒤에 세운다. 덮어쓰면 그 물음은 아무도 답할 수 없게 되고, 그
        // 연결은 예산이 다 될 때까지 "연결 중…"에 앉아 있는다.
        set((current) =>
          enqueueHostKeyPrompt(current, {
            // 공개 키 설치의 상관 ID 는 여기 담지 않는다.
            //
            // 이 값은 "답을 기다리는 **탭**" 을 뜻한다 — AppShell 이 그 탭으로 화면을 옮기고,
            // 거절하면 그 탭을 오류로 표시한다. 설치는 탭이 없으므로 담으면 있지도 않은
            // `session:keyinstall:…` 로 화면이 튄다. 신뢰 대화상자는 전역이라 이것 없이도 뜬다.
            sessionId: hostIdFromKeyInstallCorrelation(sessionId)
              ? null
              : (sessionId ?? null),
            liveChallengeId: String(payload.challengeId ?? ""),
            probe: {
              hostId: hostRecord?.id ?? "",
              hostLabel: hostRecord?.label ?? host,
              host,
              port,
              targetDescription: null,
              algorithm: String(payload.algorithm ?? ""),
              publicKeyBase64: String(payload.publicKeyBase64 ?? ""),
              fingerprintSha256: String(payload.fingerprintSha256 ?? ""),
              status: payload.mismatch === true ? "mismatch" : "untrusted",
              existing,
            },
            // 살아 있는 질의는 수락 후 다시 연결하지 않는다. action 은 형태를 맞추기 위한 값이다.
            action: { kind: "containers", hostId: hostRecord?.id ?? "" },
          }),
        );
        return;
      }

      // tmux control mode: window layout을 workspace(pane 분할)로 반영한다.
      if (event.type === "tmuxLayoutChange") {
        const payload = event.payload as {
          controlSessionId?: string;
          windowId?: string;
          layout?: string;
          index?: number;
          name?: string;
          active?: boolean;
          sessionName?: string;
        };
        if (
          payload.controlSessionId &&
          payload.windowId &&
          typeof payload.layout === "string"
        ) {
          get().handleTmuxLayoutChange(
            payload.controlSessionId,
            payload.windowId,
            payload.layout,
            // index/name/active/sessionName 는 list-windows 응답에서만 온다(실시간
            // layout-change 엔 sessionName 만). 없으면 store 가 기존 값을 유지한다.
            {
              index: payload.index,
              name: payload.name,
              active: payload.active,
              sessionName: payload.sessionName,
            },
          );
        }
        return;
      }

      // tmux 활성 pane 변경(%window-pane-changed): 키보드 pane 이동 등 서버에서
      // active pane 이 바뀌면 화면 포커스를 따라가게 한다(select-pane 재전송 없이 로컬만).
      if (event.type === "tmuxActivePaneChanged") {
        const payload = event.payload as {
          controlSessionId?: string;
          paneId?: string;
        };
        if (payload.controlSessionId && payload.paneId) {
          get().applyTmuxActivePane(payload.controlSessionId, payload.paneId);
        }
        return;
      }

      // tmux 감지(하단바): SSH 접속 후 보조채널이 보낸 원격 tmux 정보를 해당
      // 탭의 tmuxAvailable 에 set 한다(moshState 와 동일하게 표시 전용).
      if (event.type === "tmuxAvailable" && sessionId) {
        const payload = event.payload as {
          version?: string;
          sessions?: {
            name?: string;
            windows?: number;
            attached?: boolean;
          }[];
        };
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId
              ? {
                  ...tab,
                  tmuxAvailable: payload.version
                    ? {
                        version: payload.version,
                        sessions: (payload.sessions ?? []).map((s) => ({
                          name: s.name ?? "",
                          windows: s.windows ?? 0,
                          attached: s.attached ?? false,
                        })),
                      }
                    : null,
                }
              : tab,
          ),
        }));
        return;
      }

      // 그 밖의 tmux 구조 이벤트(window-add/close/renamed, sessions-changed,
      // paused/continue, exit)는 아직 전용 핸들러가 없다. payload 없이 오는
      // 경우가 있어(예: tmuxSessionsChanged) 일반 세션 경로로 새면 아래 shellKind
      // 접근에서 throw 하거나 pane 탭 상태를 잘못 갱신하므로 여기서 무시한다.
      // tmux window 닫힘 / control 세션 종료: 로컬 workspace·pane 탭 정리(좀비 방지).
      // 서버에서 이미 닫혔으므로 명령은 보내지 않는다.
      if (event.type === "tmuxWindowClose") {
        const payload = event.payload as {
          controlSessionId?: string;
          windowId?: string;
        };
        if (payload?.controlSessionId && payload?.windowId) {
          get().removeTmuxWorkspacesLocal(
            payload.controlSessionId,
            payload.windowId,
          );
        }
        return;
      }
      if (event.type === "tmuxExit") {
        const payload = event.payload as { controlSessionId?: string };
        if (payload?.controlSessionId) {
          get().removeTmuxWorkspacesLocal(payload.controlSessionId, undefined);
        }
        return;
      }

      // tmux window 이름 변경(%window-renamed) → 해당 window WorkspaceTab 라벨 반영.
      if (event.type === "tmuxWindowRenamed") {
        const payload = event.payload as {
          controlSessionId?: string;
          windowId?: string;
          name?: string;
        };
        if (payload?.controlSessionId && payload?.windowId) {
          get().applyTmuxWindowRenamed(
            payload.controlSessionId,
            payload.windowId,
            payload.name ?? "",
          );
        }
        return;
      }

      // tmux 세션 변경(%session-changed) → 세션 그룹 푸터의 세션명을 실제 tmux
      // 세션명으로 갱신(호스트명 대체). attach 직후·세션 전환 시 발생.
      if (event.type === "tmuxSessionChanged") {
        const payload = event.payload as {
          controlSessionId?: string;
          sessionName?: string;
        };
        if (payload?.controlSessionId && payload.sessionName) {
          get().applyTmuxSessionName(
            payload.controlSessionId,
            payload.sessionName,
          );
        }
        return;
      }

      // tmux 세션 목록 변경(%sessions-changed) → 그 control 세션 그룹의 세션
      // 목록 갱신(푸터 메뉴). 페이로드는 SSH 감지와 동일 형태(version+sessions),
      // controlSessionId 는 event.sessionId(=control 세션 id).
      if (event.type === "tmuxSessionsChanged" && sessionId) {
        const payload = event.payload as {
          sessions?: { name?: string; windows?: number; attached?: boolean }[];
        };
        get().applyTmuxSessionsList(
          sessionId,
          (payload?.sessions ?? []).map((s) => ({
            name: s.name ?? "",
            windows: s.windows ?? 0,
            attached: s.attached ?? false,
          })),
        );
        return;
      }

      if (event.type.startsWith("tmux")) {
        return;
      }

      // mosh 연결 상태 이벤트 — 해당 탭의 moshState/lastMoshResponseAt만 갱신한다.
      if (event.type === "moshState" && sessionId) {
        const payload = event.payload as {
          state?: string;
          lastResponseAt?: string;
        };
        const moshState =
          payload.state === "reconnecting" || payload.state === "disconnected"
            ? payload.state
            : "connected";
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId
              ? {
                  ...tab,
                  moshState,
                  lastMoshResponseAt:
                    payload.lastResponseAt ?? tab.lastMoshResponseAt ?? null,
                }
              : tab,
          ),
        }));
        return;
      }

      // keepalive RTT 이벤트 — 하단바 표시용. SSH 세션은 탭의 sessionId 가,
      // tmux 는 그룹의 controlSessionId 가 매칭된다(둘 중 하나만 갱신됨).
      if (event.type === "latency" && sessionId) {
        const payload = event.payload as { roundTripMs?: number };
        const rtt =
          typeof payload?.roundTripMs === "number" ? payload.roundTripMs : null;
        if (rtt == null) {
          return;
        }
        // 이력은 스토어가 아니라 레지스트리에 쌓는다 — 10초마다 오는 값을 여기 배열에 넣으면
        // 그때마다 tabs 가 새로 만들어져 리렌더가 앱 전체로 번진다. 키는 재연결에도 불변인
        // stableId(그룹은 group.id)다.
        const historyKey =
          get().tabs.find((tab) => tab.sessionId === sessionId)?.stableId ??
          get().tmuxGroups.find((group) => group.controlSessionId === sessionId)?.id ??
          null;
        if (historyKey) {
          recordRtt(historyKey, rtt);
        }
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId ? { ...tab, lastRttMs: rtt } : tab,
          ),
          tmuxGroups: state.tmuxGroups.map((group) =>
            group.controlSessionId === sessionId
              ? { ...group, lastRttMs: rtt }
              : group,
          ),
        }));
        return;
      }

      // 다단 ProxyJump 연결 진행 — 각 홉(점프/최종 대상)의 상태를 해당 연결에 upsert해
      // 공통 오버레이에 표시. sessionId=터미널/mosh/tmux, endpointId=SFTP pane·컨테이너.
      // 프로브·실연결 어느 쪽이든 같은 이벤트로 도착하며, hopIndex 1 & connecting = 새 시도
      // 시작 → 리셋. 가장 깊은 점프부터 순서대로 도착한다.
      if (event.type === "connectionHopProgress") {
        const payload = event.payload as {
          hopLabel?: string;
          hopIndex?: number;
          hopCount?: number;
          stage?: string;
        };
        const index =
          typeof payload.hopIndex === "number" ? payload.hopIndex : 0;
        if (index <= 0) {
          return;
        }
        const hop: TerminalConnectionHop = {
          index,
          count:
            typeof payload.hopCount === "number" ? payload.hopCount : index,
          label: typeof payload.hopLabel === "string" ? payload.hopLabel : "",
          stage:
            payload.stage === "connected" || payload.stage === "failed"
              ? payload.stage
              : "connecting",
        };
        const upsertHop = (
          existing: readonly TerminalConnectionHop[] | null | undefined,
          entry: TerminalConnectionHop,
        ): TerminalConnectionHop[] => {
          const base =
            entry.index === 1 && entry.stage === "connecting"
              ? []
              : (existing ?? []);
          const at = base.findIndex((item) => item.index === entry.index);
          return at >= 0
            ? base.map((item, i) => (i === at ? entry : item))
            : [...base, entry];
        };
        // 홉 라벨(Go: user@host:port) 위에 사용자 지정 호스트 이름을 얹는다. 연결 대상의
        // jumpHostIds 체인 → 홉 인덱스별 라벨을 해석(첫 홉 … 최종 대상). 공통 헬퍼 재사용해
        // 터미널·SFTP·컨테이너가 동일하게 이름을 얻는다.
        const named = (
          hostId: string | null | undefined,
          allHosts: readonly HostRecord[],
        ): TerminalConnectionHop => {
          const host = hostId
            ? allHosts.find((item) => item.id === hostId)
            : undefined;
          return {
            ...hop,
            name: host
              ? (resolveHopHostNames(host, allHosts)[hop.index - 1] ?? null)
              : null,
          };
        };
        if (sessionId) {
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.sessionId === sessionId
                ? {
                    ...tab,
                    connectionHops: upsertHop(
                      tab.connectionHops,
                      named(tab.hostId, state.hosts),
                    ),
                  }
                : tab,
            ),
          }));
          return;
        }
        if (endpointId) {
          set((state) => {
            const sftpPaneId = resolveSftpPaneIdByEndpoint(state, endpointId);
            if (sftpPaneId) {
              const pane = getPane(state, sftpPaneId);
              return {
                sftp: updatePaneState(state, sftpPaneId, {
                  ...pane,
                  connectionHops: upsertHop(
                    pane.connectionHops,
                    named(
                      pane.connectingHostId ?? pane.selectedHostId,
                      state.hosts,
                    ),
                  ),
                }),
              };
            }
            const containerHostId =
              resolveContainersHostIdByEndpoint(endpointId);
            if (containerHostId) {
              const tab = findContainersTab(state, containerHostId);
              if (tab) {
                return {
                  containerTabs: upsertContainersTab(state.containerTabs, {
                    ...tab,
                    connectionHops: upsertHop(
                      tab.connectionHops,
                      named(containerHostId, state.hosts),
                    ),
                  }),
                };
              }
            }
            return state;
          });
          return;
        }
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
                      allowStoredPassword: Boolean(
                        candidate.allowStoredPassword,
                      ),
                      masked: Boolean(candidate.masked),
                    } satisfies KeyboardInteractivePrompt;
                  })
                : [],
              hop: toKeyboardInteractiveHop(payload.hop),
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
              // 인증 프롬프트(pendingInteractiveAuth)는 Home/SFTP/Containers 셸 어디서나
              // 뜨므로, 그 탭들에 있으면 강제로 containers 로 끌어오지 않는다(연결 중
              // 다른 데로 이동했을 때 포커스 가로채기 방지). 프롬프트가 안 보이는
              // 세션/그룹 탭에 있을 때만 containers 로 전환해 인증을 놓치지 않게 한다.
              const promptVisibleHere =
                state.activeWorkspaceTab === "home" ||
                state.activeWorkspaceTab === "sftp" ||
                state.activeWorkspaceTab === "containers";
              return {
                activeWorkspaceTab:
                  currentTab && !promptVisibleHere
                    ? "containers"
                    : state.activeWorkspaceTab,
                activeContainerHostId: currentTab
                  ? containerHostId
                  : state.activeContainerHostId,
                pendingInteractiveAuths:
                  currentHost === undefined
                    ? state.pendingInteractiveAuths
                    : upsertPendingInteractiveAuth(state.pendingInteractiveAuths, {
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
                        hop: challenge.hop ?? null,
                      }),
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
              const resolvedAuth = findEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              );
              if (!isPendingContainersInteractiveAuth(resolvedAuth)) {
                return state;
              }
              const currentTab = findContainersTab(state, containerHostId);
              const currentHost = state.hosts.find(
                (host) => host.id === containerHostId,
              );
              if (resolvedAuth.provider === "warpgate") {
                return state;
              }
              return {
                pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                  state.pendingInteractiveAuths,
                  endpointId,
                ),
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
                              t("runtime.containerConnecting", {
                                label: currentHost.label,
                              }),
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
                pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                  state.pendingInteractiveAuths,
                  endpointId,
                ),
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
                      allowStoredPassword: Boolean(
                        candidate.allowStoredPassword,
                      ),
                      masked: Boolean(candidate.masked),
                    } satisfies KeyboardInteractivePrompt;
                  })
                : [],
              hop: toKeyboardInteractiveHop(payload.hop),
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
              pendingInteractiveAuths:
                currentHost === undefined
                  ? state.pendingInteractiveAuths
                  : upsertPendingInteractiveAuth(state.pendingInteractiveAuths, {
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
                      hop: challenge.hop ?? null,
                    }),
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
              const resolvedAuth = findEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              );
              if (!isPendingPortForwardInteractiveAuth(resolvedAuth)) {
                return state;
              }
              if (resolvedAuth.provider === "warpgate") {
                return state;
              }
              return {
                pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                  state.pendingInteractiveAuths,
                  endpointId,
                ),
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
              pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              ),
            }));
            return;
          }
        }

        // VNC 세션의 경유 터널. 사용자가 만든 포워딩 규칙이 아니라 세션에 딸린 터널이라 위의
        // portForwards 목록에 없다 — 그래서 예전에는 이 질문이 아래 SFTP 판정까지 흘러가 판을 못
        // 찾고 버려졌다. 실기기에서 VNC 를 OTP 경유 호스트로 열면 코드를 물어보는 창이 아예 뜨지
        // 않고 진행만 멈춰 있었다.
        //
        // 답은 endpointId 로 보내고(코어의 대기표가 그 ID 에 걸려 있다) 카드는 세션 위에 그린다.
        const vncTunnelSessionId = resolveVncTunnelSessionId(endpointId);
        if (vncTunnelSessionId) {
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
                      allowStoredPassword: Boolean(
                        candidate.allowStoredPassword,
                      ),
                      masked: Boolean(candidate.masked),
                    } satisfies KeyboardInteractivePrompt;
                  })
                : [],
              hop: toKeyboardInteractiveHop(payload.hop),
            };
            const currentState = get();
            const vncTab = currentState.tabs.find(
              (tab) => tab.sessionId === vncTunnelSessionId,
            );
            // 묻는 쪽은 경유 SSH 호스트다. VNC 호스트가 아니라 그 터널 호스트의 설정으로
            // 판정해야 warpgate 같은 특수 흐름이 어긋나지 않는다.
            const vncHost =
              vncTab?.hostId
                ? currentState.hosts.find(
                    (record) => record.id === vncTab.hostId,
                  )
                : undefined;
            const tunnelHostId =
              vncHost && isVncHostRecord(vncHost)
                ? vncHost.sshTunnelHostId?.trim()
                : undefined;
            const tunnelHost = tunnelHostId
              ? currentState.hosts.find((record) => record.id === tunnelHostId)
              : undefined;
            const interactiveState = resolveInteractiveAuthUiState(
              tunnelHost,
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
              pendingInteractiveAuths: upsertPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                {
                  source: "vncTunnel",
                  endpointId,
                  sessionId: vncTunnelSessionId,
                  hostId: tunnelHostId ?? vncTab?.hostId ?? "",
                  challengeId: challenge.challengeId,
                  name: challenge.name ?? null,
                  instruction: challenge.instruction,
                  prompts: challenge.prompts,
                  provider: interactiveState.provider,
                  approvalUrl: interactiveState.approvalUrl,
                  authCode: interactiveState.authCode,
                  autoSubmitted: interactiveState.autoSubmitted,
                  hop: challenge.hop ?? null,
                },
              ),
              // 카드가 이 탭 위에 뜨므로 그 탭으로 데려간다 — 다른 탭을 보고 있으면 코드를 넣을
              // 창이 있다는 것을 모른다.
              ...activateSessionContextInState(state, vncTunnelSessionId),
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
            set((state) => ({
              pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              ),
            }));
            return;
          }

          // 터널이 끝나면(성공이든 실패든) 남은 카드를 내린다. 남겨 두면 답을 받아 줄 연결이 없는
          // 입력창이 화면에 계속 떠 있다.
          if (
            event.type === "portForwardStarted" ||
            event.type === "portForwardStopped" ||
            event.type === "portForwardError"
          ) {
            set((state) => ({
              pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              ),
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
                    allowStoredPassword: Boolean(candidate.allowStoredPassword),
                    masked: Boolean(candidate.masked),
                  } satisfies KeyboardInteractivePrompt;
                })
              : [],
            hop: toKeyboardInteractiveHop(payload.hop),
          };
          const currentState = get();
          const paneId = resolveSftpPaneIdByEndpoint(currentState, endpointId);
          if (!paneId) {
            return;
          }
          const pane = getPane(currentState, paneId);
          const hostId =
            pane.connectingHostId ??
            pane.selectedHostId ??
            pane.endpoint?.hostId ??
            null;
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
            pendingInteractiveAuths:
              hostId === null
                ? state.pendingInteractiveAuths
                : upsertPendingInteractiveAuth(state.pendingInteractiveAuths, {
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
                    hop: challenge.hop ?? null,
                  }),
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
            const resolvedAuth = findEndpointPendingInteractiveAuth(
              state.pendingInteractiveAuths,
              endpointId,
            );
            if (!isPendingSftpInteractiveAuth(resolvedAuth)) {
              return state;
            }
            if (resolvedAuth.provider === "warpgate") {
              return state;
            }
            return {
              pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              ),
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
          const sftpPaneBefore = sftpPaneId ? getPane(get(), sftpPaneId) : null;
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
                (event.payload as { message?: unknown } | undefined)?.message ??
                  "",
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
                pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                  state.pendingInteractiveAuths,
                  endpointId,
                ),
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
              pendingInteractiveAuths: clearEndpointPendingInteractiveAuth(
                state.pendingInteractiveAuths,
                endpointId,
              ),
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
                  event.type === "sftpError" ||
                  event.type === "sftpDisconnected"
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
                  allowStoredPassword: Boolean(candidate.allowStoredPassword),
                  masked: Boolean(candidate.masked),
                } satisfies KeyboardInteractivePrompt;
              })
            : [],
          // 코어가 "쓸 수 있는 저장된 비밀번호가 있다" 만 알려 준다. 값은 오지 않는다.
          hasStoredPassword: Boolean(payload.hasStoredPassword),
          // 누구의 프롬프트인지. 코어가 준 값을 그대로 옮긴다.
          hop: toKeyboardInteractiveHop(payload.hop),
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
              ? t("runtime.warpgateApproval", {
                  label: currentHost?.label ?? t("runtime.session"),
                })
              : t("runtime.extraAuth", {
                  label: currentHost?.label ?? t("runtime.session"),
                }),
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
            pendingInteractiveAuths: upsertPendingInteractiveAuth(
              state.pendingInteractiveAuths,
              {
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
              hasStoredPassword: challenge.hasStoredPassword,
              hop: challenge.hop ?? null,
              },
            ),
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

          const resolvedAuth = findSessionPendingInteractiveAuth(
            state.pendingInteractiveAuths,
            sessionId,
          );
          if (!resolvedAuth) {
            return state;
          }
          if (resolvedAuth.provider === "warpgate") {
            return state;
          }
          return {
            pendingInteractiveAuths: clearSessionPendingInteractiveAuth(
              state.pendingInteractiveAuths,
              sessionId,
            ),
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

      // tmux control 세션의 비정상 단절: control 세션은 그룹 형성 시 탭이 제거돼
      // shouldAutoReconnectSession(탭 필요)을 못 탄다. 그룹을 controlSessionId 로
      // 찾아 그룹 단위 전용 재연결을 건다. 정상 종료(client/remote-exit)는 detach/
      // tmuxExit 가 이미 그룹을 정리하므로 여기선 보통 매칭되지 않는다.
      if (event.type === "closed") {
        const tmuxGroup = get().tmuxGroups.find(
          (group) => group.controlSessionId === sessionId,
        );
        if (tmuxGroup) {
          const tmuxReason = String(
            (event.payload as { reason?: unknown } | undefined)?.reason ?? "",
          );
          const tmuxAbnormal =
            tmuxReason === "transport" || tmuxReason === "keepalive";
          if (
            tmuxAbnormal &&
            get().settings.autoReconnectEnabled &&
            tmuxGroup.hostId
          ) {
            // scheduleReconnect → handler.renderScheduled 가 그룹/패인을
            // 재연결 중으로 표시한다(applyTmuxGroupReconnecting).
            scheduleReconnect({
              kind: "tmux",
              key: tmuxGroup.id,
              meta: { hostId: tmuxGroup.hostId },
            });
          } else if (tmuxAbnormal) {
            // 자동 재연결 off / 호스트 불명 → 패인을 끊김(수동 재시도) 상태로.
            get().applyTmuxGroupReconnectGaveUp(
              tmuxGroup.id,
              t("runtime.disconnected"),
            );
          } else {
            // 정상 종료(client/remote-exit): %exit 는 Go 가 stream 을 즉시 닫아
            // 늦은 layout-change 가 없으므로 recently-closed 가드 없이 안전하다.
            // 보통 detach/tmuxExit 가 이미 그룹을 정리했고 여기선 방어적 정리다.
            get().removeTmuxWorkspacesLocal(sessionId);
          }
          return;
        }
      }

      const resolvedShellKind =
        typeof event.payload?.shellKind === "string"
          ? event.payload.shellKind.trim() || undefined
          : undefined;

      // 자동 재연결 판별은 set 이전(끊김 반영 전) 상태로 한다. set 안에서는
      // 탭을 유지(reconnecting)하고, set 이후에 백오프 스케줄을 건다.
      const sessionTabBeforeEvent = get().tabs.find(
        (tab) => tab.sessionId === sessionId,
      );
      const sessionHostBeforeEvent =
        sessionTabBeforeEvent?.source === "host" && sessionTabBeforeEvent.hostId
          ? get().hosts.find((host) => host.id === sessionTabBeforeEvent.hostId)
          : undefined;
      const reconnectStableId = sessionTabBeforeEvent?.stableId ?? null;
      const autoReconnectEnabled = get().settings.autoReconnectEnabled;
      // 진행 중 재연결의 시도 결과인지(이미 reconnecting 상태라 status가 connecting).
      const activeSessionReconnect = reconnectStableId
        ? isReconnecting(reconnectStableId)
        : false;
      const isDropEvent = event.type === "closed" || event.type === "error";
      const reconnectEventPermanent =
        event.type === "error" &&
        classifyReconnect(
          String(
            (event.payload as { message?: unknown } | undefined)?.message ?? "",
          ),
        ) === "permanent";
      // 자동 재연결 자격을 갖춘 비정상 드롭인지(설정 OFF여도 판정). 정상 exit/client는
      // false. 자동 재연결을 안 거는 경우에도 탭을 없애지 않고 끊김 상태로 유지하는 데 쓴다.
      const eligibleAbnormalDrop =
        isDropEvent &&
        shouldAutoReconnectSession(
          sessionTabBeforeEvent,
          sessionHostBeforeEvent,
          event,
          true,
        );
      // 탭을 reconnecting으로 유지하고 다음 백오프를 걸 조건:
      //  - 활성 연결의 첫 드롭(shouldAutoReconnectSession), 또는
      //  - 진행 중 재연결 시도의 실패(영구 오류 제외 → 그 경우 일반 플로우로).
      const willKeepSessionReconnecting =
        isDropEvent &&
        reconnectStableId != null &&
        autoReconnectEnabled &&
        (eligibleAbnormalDrop ||
          (activeSessionReconnect && !reconnectEventPermanent));
      const willCancelSessionReconnect =
        isDropEvent && activeSessionReconnect && reconnectEventPermanent;

      set((state) => {
        const currentTab = state.tabs.find(
          (tab) => tab.sessionId === sessionId,
        );
        const currentAttempt = findPendingConnectionAttempt(state, sessionId);
        const currentHost =
          currentTab?.source === "host" && currentTab.hostId
            ? state.hosts.find((host) => host.id === currentTab.hostId)
            : undefined;
        const currentAwsHost =
          currentHost && isAwsEc2HostRecord(currentHost) ? currentHost : null;
        const rawEventMessage =
          event.type === "error"
            ? String(event.payload.message ?? "SSH error")
            : "";
        const closedEventMessage =
          event.type === "closed" ? String(event.payload.message ?? "") : "";
        const awsSsmExitCodeMatch =
          awsSsmSessionExitPattern.exec(closedEventMessage);
        const isFailedAwsSsmExit =
          awsSsmExitCodeMatch !== null && Number(awsSsmExitCodeMatch[1]) !== 0;
        const shouldKeepAwsSsmClosedAsError =
          event.type === "closed" &&
          currentTab != null &&
          currentAwsHost != null &&
          // 자동 재연결이 처리할 드롭(연결됨+출력)이면 error로 잡지 않고 재연결로 넘긴다.
          !willKeepSessionReconnecting &&
          (isFailedAwsSsmExit ||
            (currentTab.hasReceivedOutput !== true &&
              (currentTab.status === "connecting" ||
                currentTab.status === "error" ||
                // connected 도 포함한다. SSM 세션의 connected 는 **데이터채널이 열린
                // 시점**에 나가고, 그 뒤의 핸드셰이크나 셸 기동이 실패하면 이 상태에서
                // 죽는다(계정의 KMS 세션 암호화가 그 경로다). 여기서 빠뜨리면 그런 실패가
                // 전부 "탭이 그냥 사라짐" 으로 보인다 — 이유를 볼 방법이 없다.
                //
                // 출력을 한 번도 못 받았다는 조건이 정상 종료를 걸러 준다. 붙은 뒤 쓰다가
                // 끝낸 세션은 최소한 프롬프트를 받았다.
                currentTab.status === "connected")));
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
          (hasKnownShellLaunchFailureState ||
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
              (currentAttempt?.source === "ecs-shell" ||
              currentTab?.shellKind === "aws-ecs-exec"
                ? currentTab.status === "connecting" ||
                  currentTab.status === "connected" ||
                  hasKnownShellLaunchFailureState ||
                  currentTab.connectionProgress?.stage === "waiting-shell"
                : currentTab.status === "connected" ||
                  currentTab.connectionProgress?.stage === "waiting-shell")));
        const nextContainerShellFailureState = (
          clearAttempt: boolean,
        ): Partial<AppState> => {
          if (!shellLaunchFailureMessage) {
            return state;
          }
          return {
            tabs: state.tabs.map(
              (tab): TerminalTab =>
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
              t("runtime.ecsExecClosed");
            return {
              tabs: state.tabs.map(
                (tab): TerminalTab =>
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
              pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
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
              tabs: state.tabs.map(
                (tab): TerminalTab =>
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
              pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
                (attempt) => attempt.sessionId !== sessionId,
              ),
            };
          }
          // 예기치 않은 끊김이면 탭을 제거하지 않고 reconnecting 상태로 유지.
          if (willKeepSessionReconnecting) {
            return applySessionReconnecting(state, sessionId);
          }
          // 자동 재연결을 안 거는(설정 OFF 등) 비정상 드롭이어도 탭을 없애지 말고
          // 끊김(error+Retry) 상태로 유지한다 — 정상 exit/client만 닫는다.
          // resolveErrorProgress는 기본 retryable=true라 수동 재연결 버튼이 노출된다.
          if (eligibleAbnormalDrop) {
            const message =
              closedEventMessage.trim() || t("runtime.disconnectedRetry");
            return {
              tabs: state.tabs.map(
                (tab): TerminalTab =>
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
              pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
                (attempt) => attempt.sessionId !== sessionId,
              ),
            };
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
            ? currentTab.hasReceivedOutput === true
              ? null
              : currentAttempt?.source === "container-shell"
                ? null
                : (resolvedShellKind ?? currentTab.shellKind) === "aws-ecs-exec"
                  ? null
                  : currentTab.source === "local"
                    ? resolveLocalWaitingShellProgress()
                    : currentHost
                      ? resolveWaitingShellProgress(currentHost)
                      : createConnectionProgress(
                          "waiting-shell",
                          t("runtime.waitingFirstOutput"),
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
                ? (resolvedShellKind ?? tab.shellKind)
                : tab.shellKind,
            errorMessage: event.type === "error" ? errorMessage : undefined,
            connectionProgress: nextProgress,
            hasReceivedOutput: tab.hasReceivedOutput,
            lastEventAt: new Date().toISOString(),
          };
        });

        return {
          tabs,
          resolvedStartupCommandsBySessionId:
            event.type === "connected"
              ? Object.fromEntries(
                  Object.entries(
                    state.resolvedStartupCommandsBySessionId,
                  ).filter(([id]) => id !== sessionId),
                )
              : state.resolvedStartupCommandsBySessionId,
          pendingInteractiveAuths:
            event.type === "connected" || event.type === "error"
              ? clearSessionPendingInteractiveAuth(
                  state.pendingInteractiveAuths,
                  sessionId,
                )
              : state.pendingInteractiveAuths,
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

      // 전송이 connection_lost로 죽으면(SSM idle 타임아웃 등) 죽은 SFTP 엔드포인트를
      // 자동 재수립하고 실패 항목을 재업로드한다. 터미널 업로드 잡만, 자동 재시도로
      // 만든 잡은 제외(한 번만), autoReconnect 켜졌을 때만.
      if (
        event.job.status === "failed" &&
        event.job.errorCode === "connection_lost" &&
        get().settings.autoReconnectEnabled &&
        isTerminalUploadJob(event.job.id) &&
        !isAutoRecoveredTransferJob(event.job.id)
      ) {
        // 이 실패 잡을 표식해 같은 잡의 중복 이벤트로 복구가 두 번 트리거되지 않게 한다.
        // recover 쪽은 재수립된 새 잡을 표식해, 그 재시도가 또 죽어도 재복구 안 하게 한다.
        markAutoRecoveredTransferJob(event.job.id);
        // 복구 실패는 이미 실패한 전송을 그대로 두는 것뿐이라 삼킨다 — catch 가 없으면
        // 재수립 도중의 예외가 unhandled rejection 으로 새어 나간다.
        void get()
          .recoverTransferConnectionLoss(event.job)
          .catch(() => undefined);
      }

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

        // 포워딩이 끝났으면 그 포워딩의 인증 카드도 내린다.
        //
        // 코어의 portForwardStopped·portForwardError 는 메인에서 **런타임 레코드로 바뀌어** 이
        // 핸들러로 들어온다(core-manager 가 그 지점에서 return 한다). 그래서 handleCoreEvent 쪽
        // 정리 코드는 실기기에서 도달하지 않고, 정지 후에도 "코드를 입력하세요" 카드가 남아 있었다.
        if (
          event.runtime.status === "stopped" ||
          event.runtime.status === "error"
        ) {
          nextState.pendingInteractiveAuths = clearEndpointPendingInteractiveAuth(
            state.pendingInteractiveAuths,
            event.runtime.ruleId,
          );
        }

        // 진행 팝업도 여기서 내린다. **바로 위 주석과 같은 이유다** — 코어의
        // portForwardStarted·Stopped·Error 는 메인에서 런타임 레코드로 바뀌므로 handleCoreEvent 는
        // 그것을 보지 못한다. 그래서 뷰가 지워지지 않고, 포워딩이 붙은 뒤에도 팝업이 "SSH 연결"
        // 에 앉은 채 남아 있었다.
        //
        // 실패도 여기서 지운다: 이유는 규칙 줄과 활동 로그가 이미 말해 주고, 모달로 한 번 더
        // 막아 세우면 사용자가 목록을 만질 수 없다.
        nextState.connectionViews = clearConnectionView(
          state.connectionViews,
          event.runtime.ruleId,
        );

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
                          ? (event.runtime.message ?? tunnelState.error)
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
        } else if (
          event.runtime.ruleId.startsWith("container-service-tunnel:")
        ) {
          nextState.containerTabs = (
            nextState.containerTabs ?? state.containerTabs
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

      // 포워딩은 start 실패를 삼키고 이 런타임 이벤트로만 알린다(services/network.ts).
      // 그래서 키가 바뀐 경우도 여기가 유일한 접점이다 — 다시 probe해 교체 프롬프트를
      // 띄우고, 수락하면 acceptPendingHostKeyPrompt 가 이 룰을 다시 시작한다.
      //
      // 이미 프롬프트가 떠 있으면 건드리지 않는다. 여러 룰이 같이 실패하면(같은 호스트를
      // 쓰는 포워딩들) 각 이벤트가 probe를 돌려 서로의 프롬프트를 덮어쓴다.
      const pfRule = get().portForwards.find((rule) => rule.id === pfRuleId);
      if (
        pfRule &&
        event.runtime.status === "error" &&
        isChangedHostKeyErrorMessage(event.runtime.message ?? "") &&
        !get().pendingHostKeyPrompt
      ) {
        // 이벤트 핸들러는 동기다. probe 왕복을 기다리게 하지 않고 띄우기만 한다 —
        // 런타임 상태는 위 set 에서 이미 error 로 반영됐고, 수락하면 running 으로 바뀐다.
        void recoverFromChangedHostKey(set, {
          hostId: pfRule.hostId,
          message: event.runtime.message ?? "",
          action: {
            kind: "portForward",
            ruleId: pfRuleId,
            hostId: pfRule.hostId,
          },
        });
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
        if (event.endpointId === `aws-ec2-ssh:${event.hostId}`) {
          const pendingHostSessionIds = new Set(
            state.pendingConnectionAttempts
              .filter(
                (attempt) =>
                  attempt.source === "host" && attempt.hostId === event.hostId,
              )
              .map((attempt) => attempt.sessionId),
          );
          if (pendingHostSessionIds.size === 0) {
            return state;
          }

          let didUpdatePendingSession = false;
          const nextTabs = state.tabs.map((tab) => {
            if (!pendingHostSessionIds.has(tab.sessionId)) {
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
    },
  };
}
