import { isAwsEc2WindowsPlatform, isRdpHostRecord, isVncHostRecord } from "@shared";
import { markSessionConnected } from "../../lib/terminal-cwd-registry";
import type {
  HostRecord,
  HostSecretInput,
  TerminalConnectionProgress,
  TerminalTab,
} from "@shared";
import type { AppState, PendingMissingUsernamePrompt } from "../types";
import type { SliceDeps } from "./context";
import { rdpViewportSize } from "./rdp-viewport";
import { createTrustAuthServices } from "./trust-auth";
import {
  activateSessionContextInState,
  asSessionTabId,
  buildSessionTitle,
  captureSessionReturnTarget,
  createConnectionProgress,
  createPendingSessionId,
  createPendingSessionTab,
  findContainersTab,
  findPendingConnectionAttempt,
  findPendingConnectionAttemptByHost,
  findSshHostMissingUsername,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isSerialHostRecord,
  isSshHostRecord,
  isPendingEcsShellAttempt,
  normalizeEcsExecShellPermissionMessage,
  isPendingSessionId,
  isPendingSessionInteractiveAuth,
  clearSessionPendingInteractiveAuth,
  replaceSessionReferencesInState,
  resolveAwaitingHostTrustProgress,
  resolveConnectingProgress,
  resolveCredentialRetryKind,
  resolveErrorProgress,
  resolveHostKeyCheckProgress,
  resolveLocalStartingProgress,
} from "../utils";
import { t } from '../../i18n';

type StoreSetter = SliceDeps["set"];
type StoreGetter = SliceDeps["get"];

/**
 * pane 의 크기 보고를 기다리는 프레임 한도.
 *
 * pane 은 마운트 다음 프레임에 fit 하고 보고하므로 한두 프레임이면 충분하다. 넉넉히 잡지 않는
 * 이유는 이 대기가 로컬 셸 시작을 늦추기 때문이다 — 못 받으면 씨앗 크기로 시작하고, 붙은 뒤
 * 컨트롤러가 정정한다.
 */
const PENDING_SIZE_MEASURE_FRAMES = 4;



function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 16);
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}

export function createSessionServices(deps: SliceDeps) {
  const { api } = deps;
  const {
    ensureAwsHostAuthentication,
    ensureAwsSsoAuthenticationByProfileName,
    ensureAwsSsoProfileAuthenticationIfNeeded,
    ensureTrustedHost,
    recoverFromChangedHostKey,
    ensureTailnetReady,
  } = createTrustAuthServices(deps);

  const updateSessionProgress = (
    set: StoreSetter,
    sessionId: string,
    progress: TerminalConnectionProgress,
    status: TerminalTab["status"] = "pending",
  ) => {
    set((state) => {
      if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
        return state;
      }
      return {
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status,
                errorMessage: undefined,
                connectionProgress: progress,
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      };
    });
  };

  const markSessionError = (
    set: StoreSetter,
    sessionId: string,
    message: string,
    options: {
      progress?: TerminalConnectionProgress | null;
      retryable?: boolean;
    } = {},
  ) => {
    set((state) => {
      // 이 연결에 걸려 있던 인증 카드는 함께 내린다.
      //
      // 남겨 두면 답을 받을 곳이 없는 카드가 화면에 계속 떠 있다 — 사용자는 코드를 넣고 보내지만
      // 아무 일도 일어나지 않는다. 실기기에서 OTP 를 늦게 넣었을 때 겪은 그 상태다.
      const interactiveAuths = clearSessionPendingInteractiveAuth(
        state.pendingInteractiveAuths,
        sessionId,
      );
      if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
        return {
          pendingInteractiveAuths: interactiveAuths,
          pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
            (attempt) => attempt.sessionId !== sessionId,
          ),
        };
      }
      return {
        pendingInteractiveAuths: interactiveAuths,
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status: "error",
                errorMessage: message,
                connectionProgress:
                  options.progress ??
                  resolveErrorProgress(message, options.retryable ?? true),
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
        pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
          (attempt) => attempt.sessionId !== sessionId,
        ),
      };
    });
  };

  const createPendingSessionTabForHost = (
    set: StoreSetter,
    get: StoreGetter,
    host: HostRecord,
    cols: number,
    rows: number,
    progress: TerminalConnectionProgress,
    existingSessionId?: string,
    startupCommand?: string,
    tmux?: boolean,
    tmuxCommand?: string,
    replaceSessionId?: string,
    reconnectGroupId?: string,
    tmuxVersion?: string,
  ): string => {
    const sessionId = existingSessionId ?? createPendingSessionId();
    const existingTab = existingSessionId
      ? (get().tabs.find((tab) => tab.sessionId === existingSessionId) ?? null)
      : null;
    const title =
      existingTab?.title ??
      buildSessionTitle(
        host.label,
        { source: "host", hostId: host.id },
        get().tabs,
      );
    const tab = createPendingSessionTab({
      sessionId,
      stableId: existingTab?.stableId,
      source: "host",
      hostId: host.id,
      title,
      progress,
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter(
          (attempt) => attempt.sessionId !== sessionId,
        ),
        {
          sessionId,
          source: "host" as const,
          hostId: host.id,
          title,
          latestCols: cols,
          latestRows: rows,
          tmux,
          tmuxCommand,
          tmuxVersion,
        },
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) =>
            item.sessionId === sessionId ? tab : item,
          ),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId),
        };
      }

      // tmux 자동 재연결: 새 control 세션을 standalone 탭(tabStrip)으로 만들지 않는다.
      // 진행/이벤트 처리를 위해 tabs+pendingConnectionAttempts 에만 추가하고, 화면
      // (activeWorkspaceTab)·홈/드로어 전환은 건드리지 않아 그룹 탭의 reconnecting 표시를
      // 유지한다. 성공 시 handleTmuxLayoutChange 가 이 control 을 그룹으로 흡수(tabs 에서
      // 제거)하고, 직전 시도의 실패 control 탭 정리는 reconnect-handlers(perform)가 한다.
      // → 재연결 시 별도 SSH 탭이 보이거나 시도마다 쌓이지 않는다.
      if (reconnectGroupId != null) {
        return {
          tabs: [
            ...state.tabs.filter((item) => item.sessionId !== sessionId),
            tab,
          ],
          pendingConnectionAttempts: nextAttempts,
        };
      }

      // tmux 를 원 세션 자리에서 열 때: 새 control 세션 탭을 원 세션의 tabStrip
      // 슬롯에 끼우고 원 세션 탭은 제거한다("현재 화면에서 진행"; 원격 셸 종료는
      // 호출부가 disconnect 로 처리). replaceSessionId 가 없으면 기존처럼 끝에 추가.
      const replaceIndex =
        replaceSessionId != null
          ? state.tabStrip.findIndex(
              (item) =>
                item.kind === "session" &&
                item.sessionId === replaceSessionId,
            )
          : -1;
      const nextTabs = [
        ...state.tabs.filter(
          (item) =>
            item.sessionId !== sessionId &&
            !(replaceSessionId != null && item.sessionId === replaceSessionId),
        ),
        tab,
      ];
      const strippedTabStrip = state.tabStrip.filter(
        (item) =>
          !(item.kind === "session" && item.sessionId === sessionId) &&
          !(
            replaceSessionId != null &&
            item.kind === "session" &&
            item.sessionId === replaceSessionId
          ),
      );
      const nextTabStrip: typeof state.tabStrip = [...strippedTabStrip];
      if (replaceIndex >= 0) {
        nextTabStrip.splice(Math.min(replaceIndex, nextTabStrip.length), 0, {
          kind: "session",
          sessionId,
        });
      } else {
        nextTabStrip.push({ kind: "session", sessionId });
      }

      return {
        tabs: nextTabs,
        tabStrip: nextTabStrip,
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: "hosts",
        hostDrawer: { mode: "closed" },
        pendingConnectionAttempts: nextAttempts,
        sessionReturnTargets: {
          ...state.sessionReturnTargets,
          [sessionId]: captureSessionReturnTarget(state),
        },
        resolvedStartupCommandsBySessionId: startupCommand
          ? {
              ...state.resolvedStartupCommandsBySessionId,
              [sessionId]: startupCommand,
            }
          : state.resolvedStartupCommandsBySessionId,
      };
    });

    return sessionId;
  };

  const createPendingSessionTabForLocal = (
    set: StoreSetter,
    get: StoreGetter,
    cols: number,
    rows: number,
    progress: TerminalConnectionProgress,
    existingSessionId?: string,
  ): string => {
    const sessionId = existingSessionId ?? createPendingSessionId();
    const existingTab = existingSessionId
      ? (get().tabs.find((tab) => tab.sessionId === existingSessionId) ?? null)
      : null;
    const title =
      existingTab?.title ??
      buildSessionTitle("Terminal", { source: "local" }, get().tabs);
    const tab = createPendingSessionTab({
      sessionId,
      stableId: existingTab?.stableId,
      source: "local",
      hostId: null,
      title,
      progress,
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter(
          (attempt) => attempt.sessionId !== sessionId,
        ),
        {
          sessionId,
          source: "local" as const,
          hostId: null,
          title,
          latestCols: cols,
          latestRows: rows,
        },
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) =>
            item.sessionId === sessionId ? tab : item,
          ),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId),
        };
      }

      return {
        tabs: [
          ...state.tabs.filter((item) => item.sessionId !== sessionId),
          tab,
        ],
        tabStrip: [
          ...state.tabStrip.filter(
            (item) =>
              !(item.kind === "session" && item.sessionId === sessionId),
          ),
          { kind: "session", sessionId },
        ],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: "hosts",
        hostDrawer: { mode: "closed" },
        pendingConnectionAttempts: nextAttempts,
        sessionReturnTargets: {
          ...state.sessionReturnTargets,
          [sessionId]: captureSessionReturnTarget(state),
        },
      };
    });

    return sessionId;
  };

  const createPendingSessionTabForContainerShell = (
    set: StoreSetter,
    get: StoreGetter,
    host: HostRecord,
    containerId: string,
    cols: number,
    rows: number,
    progress: TerminalConnectionProgress,
    existingSessionId?: string,
  ): string => {
    const sessionId = existingSessionId ?? createPendingSessionId();
    const existingTab = existingSessionId
      ? (get().tabs.find((tab) => tab.sessionId === existingSessionId) ?? null)
      : null;
    const existingContainer = findContainersTab(get(), host.id)?.items.find(
      (item) => item.id === containerId,
    );
    const title =
      existingTab?.title ??
      buildSessionTitle(
        `${host.label} · ${existingContainer?.name || containerId}`,
        { source: "host", hostId: host.id },
        get().tabs,
      );
    const tab = createPendingSessionTab({
      sessionId,
      stableId: existingTab?.stableId,
      source: "host",
      hostId: host.id,
      title,
      progress,
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter(
          (attempt) => attempt.sessionId !== sessionId,
        ),
        {
          sessionId,
          source: "container-shell" as const,
          hostId: host.id,
          title,
          latestCols: cols,
          latestRows: rows,
          containerId,
        },
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) =>
            item.sessionId === sessionId ? tab : item,
          ),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId),
        };
      }

      return {
        tabs: [
          ...state.tabs.filter((item) => item.sessionId !== sessionId),
          tab,
        ],
        tabStrip: [
          ...state.tabStrip.filter(
            (item) =>
              !(item.kind === "session" && item.sessionId === sessionId),
          ),
          { kind: "session", sessionId },
        ],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: "hosts",
        hostDrawer: { mode: "closed" },
        pendingConnectionAttempts: nextAttempts,
        sessionReturnTargets: {
          ...state.sessionReturnTargets,
          [sessionId]: captureSessionReturnTarget(state),
        },
      };
    });

    return sessionId;
  };

  const createPendingSessionTabForEcsShell = (
    set: StoreSetter,
    get: StoreGetter,
    input: {
      hostId: string;
      serviceName: string;
      taskArn: string;
      containerName: string;
      cols: number;
      rows: number;
      progress: TerminalConnectionProgress;
      existingSessionId?: string;
    },
  ): string => {
    const sessionId = input.existingSessionId ?? createPendingSessionId();
    const existingTab = input.existingSessionId
      ? (get().tabs.find((tab) => tab.sessionId === input.existingSessionId) ??
        null)
      : null;
    const host = get().hosts.find((item) => item.id === input.hostId);
    const title =
      existingTab?.title ??
      `${host?.label ?? "ECS"} · ${input.serviceName} · ${input.containerName}`;
    const tab = createPendingSessionTab({
      sessionId,
      stableId: existingTab?.stableId,
      source: "local",
      hostId: null,
      title,
      shellKind: "aws-ecs-exec",
      progress: input.progress,
    });

    set((state) => {
      const nextAttempts = [
        ...state.pendingConnectionAttempts.filter(
          (attempt) => attempt.sessionId !== sessionId,
        ),
        {
          sessionId,
          source: "ecs-shell" as const,
          hostId: input.hostId,
          title,
          latestCols: input.cols,
          latestRows: input.rows,
          serviceName: input.serviceName,
          taskArn: input.taskArn,
          containerName: input.containerName,
        },
      ];

      if (existingTab) {
        return {
          tabs: state.tabs.map((item) =>
            item.sessionId === sessionId ? tab : item,
          ),
          pendingConnectionAttempts: nextAttempts,
          ...activateSessionContextInState(state, sessionId),
        };
      }

      return {
        tabs: [
          ...state.tabs.filter((item) => item.sessionId !== sessionId),
          tab,
        ],
        tabStrip: [
          ...state.tabStrip.filter(
            (item) =>
              !(item.kind === "session" && item.sessionId === sessionId),
          ),
          { kind: "session", sessionId },
        ],
        activeWorkspaceTab: asSessionTabId(sessionId),
        homeSection: "hosts",
        hostDrawer: { mode: "closed" },
        pendingConnectionAttempts: nextAttempts,
        sessionReturnTargets: {
          ...state.sessionReturnTargets,
          [sessionId]: captureSessionReturnTarget(state),
        },
      };
    });

    return sessionId;
  };

  const startPendingSessionConnect = async (
    set: StoreSetter,
    get: StoreGetter,
    sessionId: string,
    hostId: string,
    secrets?: HostSecretInput,
  ) => {
    const state = get();
    const attempt = findPendingConnectionAttempt(state, sessionId);
    const host = state.hosts.find((item) => item.id === hostId);
    if (!attempt || !host) {
      return;
    }

    // 점프(베스천) 경유 타깃이면, 신뢰된 베스천을 통해 타깃 호스트 키를 probe/신뢰한
    // 뒤에 연결한다. 베스천 자체의 신뢰는 진입 플로우(또는 직전 프롬프트 수락)에서
    // 이미 보장돼, 이 시점엔 베스천 경유 probe가 동작한다.
    if (isSshHostRecord(host) && host.jumpHostId) {
      const targetTrusted = await ensureTrustedHost(set, {
        hostId,
        sessionId,
        // 이미 신뢰된 타깃은 재-probe하지 않는다. 안 그러면 프로브가 점프 체인을 한 번 더
        // 순회해(홉 UI가 같은 단계를 반복 표시) 실연결과 합쳐 여러 바퀴처럼 보인다. 키 변경은
        // 실연결의 strict host-key 검사가 잡으므로 신뢰된 경우 프로브는 불필요하다.
        action: {
          kind: "ssh",
          hostId,
          cols: attempt.latestCols,
          rows: attempt.latestRows,
          secrets,
        },
      });
      if (!targetTrusted) {
        updateSessionProgress(
          set,
          sessionId,
          resolveAwaitingHostTrustProgress(host),
        );
        return;
      }
    }

    const currentProgressStage = state.tabs.find(
      (tab) => tab.sessionId === sessionId,
    )?.connectionProgress?.stage;
    if (currentProgressStage !== "retrying-session") {
      updateSessionProgress(set, sessionId, resolveConnectingProgress(host));
    }

    try {
      const connection = isSerialHostRecord(host)
        ? await api.serial.connect({
            hostId,
            title: attempt.title,
            cols: attempt.latestCols,
            rows: attempt.latestRows,
          })
        : await api.ssh.connect({
            hostId,
            title: attempt.title,
            cols: attempt.latestCols,
            rows: attempt.latestRows,
            startupCommand: state.resolvedStartupCommandsBySessionId[sessionId],
            secrets,
            tmux: attempt.tmux,
            tmuxCommand: attempt.tmuxCommand,
            tmuxVersion: attempt.tmuxVersion,
          });
      const latestAttempt = findPendingConnectionAttempt(get(), sessionId);
      if (!latestAttempt) {
        await api.ssh.disconnect(connection.sessionId).catch(() => undefined);
        return;
      }

      set((currentState) => ({
        ...replaceSessionReferencesInState(
          currentState,
          sessionId,
          connection.sessionId,
          (tab) => ({
            ...tab,
            status: "connecting",
            errorMessage: undefined,
            // 연결은 됐지만 원래 가려던 길이 아니었다는 알림(EC2 가 SSM 셸로 물러난 경우).
            // 매 연결마다 새로 정한다 — 지난 시도의 알림이 남으면 거짓말이 된다.
            transportNotice:
              'notice' in connection && typeof connection.notice === 'string'
                ? connection.notice
                : undefined,
            connectionProgress: resolveConnectingProgress(host),
            hasReceivedOutput: false,
            lastEventAt: new Date().toISOString(),
          }),
        ),
        pendingConnectionAttempts:
          currentState.pendingConnectionAttempts.filter(
            (attemptItem) => attemptItem.sessionId !== sessionId,
          ),
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('sessionSvc.connectFailed');

      // 키가 바뀐 호스트는 위에서 probe를 건너뛰었으므로 여기서 처음 드러난다. 다시 probe해
      // 교체 프롬프트를 띄우고, 수락 시 이 연결이 이어진다(pendingConnectionAttempt가 남아 있다).
      if (
        await recoverFromChangedHostKey(set, {
          hostId,
          sessionId,
          message,
          action: {
            kind: "ssh",
            hostId,
            cols: attempt.latestCols,
            rows: attempt.latestRows,
            secrets,
          },
        })
      ) {
        updateSessionProgress(
          set,
          sessionId,
          resolveAwaitingHostTrustProgress(host),
        );
        return;
      }

      const shouldPromptCredentialRetry =
        !isSerialHostRecord(host) && resolveCredentialRetryKind(host, message);
      if (shouldPromptCredentialRetry && isSshHostRecord(host)) {
        set({
          pendingCredentialRetry: {
            sessionId,
            hostId: host.id,
            source: "ssh",
            authType:
              host.authType === "certificate"
                ? "certificate"
                : host.authType === "privateKey"
                  ? "privateKey"
                  : "password",
            message,
            initialUsername: host.username,
          },
        });
      }
      markSessionError(set, sessionId, message);
    }
  };

  /**
   * pane 이 씨앗 크기를 실제 측정값으로 바꿀 때까지 몇 프레임만 기다린다.
   *
   * best-effort 다. 창이 숨어 있으면 프레임이 오지 않으므로 한도를 두고 그냥 진행한다 — 그때는
   * 예전과 같이 씨앗 크기로 시작하고, 붙은 뒤 컨트롤러가 크기를 정정한다.
   */
  const awaitMeasuredPendingSize = async (
    get: StoreGetter,
    sessionId: string,
    seed: { cols: number; rows: number },
  ) => {
    for (let frame = 0; frame < PENDING_SIZE_MEASURE_FRAMES; frame += 1) {
      const attempt = findPendingConnectionAttempt(get(), sessionId);
      // 탭이 사라졌으면(사용자가 닫았다) 기다릴 이유가 없다.
      if (!attempt) {
        return;
      }
      if (attempt.latestCols !== seed.cols || attempt.latestRows !== seed.rows) {
        return;
      }
      await nextAnimationFrame();
    }
  };

  const startPendingLocalSessionConnect = async (
    set: StoreSetter,
    get: StoreGetter,
    sessionId: string,
  ) => {
    const state = get();
    const attempt = findPendingConnectionAttempt(state, sessionId);
    if (!attempt || attempt.source !== "local") {
      return;
    }

    const currentProgressStage = state.tabs.find(
      (tab) => tab.sessionId === sessionId,
    )?.connectionProgress?.stage;
    if (currentProgressStage !== "retrying-session") {
      updateSessionProgress(set, sessionId, resolveLocalStartingProgress());
    }

    try {
      const connection = await api.ssh.connectLocal({
        title: attempt.title,
        cols: attempt.latestCols,
        rows: attempt.latestRows,
      });
      const latestAttempt = findPendingConnectionAttempt(get(), sessionId);
      if (!latestAttempt) {
        await api.ssh.disconnect(connection.sessionId).catch(() => undefined);
        return;
      }

      set((currentState) => ({
        ...replaceSessionReferencesInState(
          currentState,
          sessionId,
          connection.sessionId,
          (tab) => ({
            ...tab,
            source: "local",
            hostId: null,
            status: "connecting",
            errorMessage: undefined,
            connectionProgress: resolveLocalStartingProgress(),
            hasReceivedOutput: false,
            lastEventAt: new Date().toISOString(),
          }),
        ),
        pendingConnectionAttempts:
          currentState.pendingConnectionAttempts.filter(
            (attemptItem) => attemptItem.sessionId !== sessionId,
          ),
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('sessionSvc.localFailed');
      markSessionError(set, sessionId, message);
    }
  };

  // RDP 는 터미널 세션 기계(재연결·tmux·홉·셸 통합)를 타지 않는다. 탭 하나를 만들고 코어에
  // 붙이는 게 전부라, startSessionConnectionFlow 에 분기를 흩뿌리는 대신 별도 경로로 둔다.
  /**
   * RDP 세션을 연다.
   *
   * `reuseSessionId` 가 있으면 탭을 새로 만들지 않는다 — 재연결이 이미 그 자리에 탭을 두고
   * (stableId 를 유지한 채) 이 함수를 부르기 때문이다. 새 탭을 만들면 재연결마다 탭이 늘어나고
   * 재연결 상태(백오프 카운터)가 붙어 있던 stableId 를 잃는다.
   */
  const startRdpConnectionFlow = async (
    set: StoreSetter,
    get: StoreGetter,
    host: HostRecord,
    reuseSessionId?: string,
  ) => {
    const sessionId = reuseSessionId ?? createPendingSessionId();
    if (!reuseSessionId) {
      const title = buildSessionTitle(
        host.label,
        { source: "host", hostId: host.id },
        get().tabs,
      );

      const tab = createPendingSessionTab({
        sessionId,
        source: "host",
        hostId: host.id,
        title,
        paneKind: "rdp",
        progress: resolveConnectingProgress(host),
      });

      set((state) => ({
        tabs: [...state.tabs, tab],
        tabStrip: [...state.tabStrip, { kind: "session" as const, sessionId }],
        ...activateSessionContextInState(state, sessionId),
      }));
    }

    updateSessionProgress(
      set,
      sessionId,
      resolveConnectingProgress(host),
      "connecting",
    );

    // SSM 을 경유하는 호스트는 AWS 인증이 먼저 살아 있어야 한다.
    //
    // 이 단계가 없으면 SSO 세션이 만료된 채로 접속이 시작되고, 메인이 터널을 열다 SDK 원문 오류
    // ("The SSO session token associated with profile=... was not found or is invalid")로 끝난다 —
    // 다른 호스트 종류는 여기서 브라우저 로그인을 띄우는데 RDP 만 그 단계를 건너뛰고 있었다.
    if (isRdpHostRecord(host) && host.awsSsm) {
      const { profileId, profileName } = host.awsSsm;
      const report = (
        message: string,
        options?: {
          blockingKind?: TerminalConnectionProgress["blockingKind"];
          stage?: TerminalConnectionProgress["stage"];
        },
      ) => {
        updateSessionProgress(
          set,
          sessionId,
          createConnectionProgress(
            options?.stage ?? "checking-profile",
            message,
            options?.blockingKind ? { blockingKind: options.blockingKind } : undefined,
          ),
          "connecting",
        );
      };
      try {
        // id 가 신원이다. 이름은 id 가 없는 레코드(이 필드가 생기기 전에 만든 것)와 앱이 관리하지
        // 않는 프로파일을 위한 폴백이다 — 이름은 사용자가 바꿀 수 있어서 그것만 믿을 수 없다.
        if (profileId) {
          const status = await ensureAwsSsoProfileAuthenticationIfNeeded(
            profileId,
            profileName,
            report,
          );
          if (!status.isAuthenticated && !status.isSsoProfile) {
            throw new Error(
              status.errorMessage ||
                t('trustAuth.cliCredentialsNeeded', { profile: profileName }),
            );
          }
        } else {
          await ensureAwsSsoAuthenticationByProfileName(profileName, report);
        }
      } catch (error) {
        markSessionError(
          set,
          sessionId,
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        );
        return;
      }
    }

    // tailnet 을 경유하는 호스트는 노드가 먼저 올라와 있어야 한다. 메인이 접속 직전에 로컬
    // 포워드를 여는데, 노드가 내려가 있으면 그 포워드가 곧바로 실패하고 사용자는 이유를
    // "연결할 수 없음" 으로만 본다. 진행 상황은 이 세션의 오버레이에 그대로 나온다.
    //
    // SSH 의 신뢰 체인(호스트 키 probe)은 타지 않는다 — RDP 는 인증서 TOFU 를 메인이 따로 한다.
    const tailnetReady = await ensureTailnetReady(set, {
      hostId: host.id,
      sessionId,
    });
    if (!tailnetReady) {
      return;
    }

    try {
      const connected = await api.rdp.connect(sessionId, host.id, rdpViewportSize());
      // 탭 hover 의 "연결 경과"가 SSH 와 같은 레지스트리를 읽는다. 재연결이 sessionId 를
      // 재사용하므로, 끊길 때(runtimeEventSlice) 지워 두면 여기서 새 시각이 찍힌다.
      markSessionConnected(sessionId);
      // 붙고 나면 진행 표시는 지운다 — 연결 화면이 캔버스를 가리면 안 된다.
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status: "connected" as const,
                errorMessage: undefined,
                connectionProgress: null,
                // 전체화면에서 화면마다 창을 펼칠지 여기서 판단한다.
                rdpMonitorCount: connected.monitors.length,
                // 탭 hover 표기용 — 대상(user@host)과 해상도.
                rdpUsername: connected.username,
                rdpDesktopSize: {
                  width: connected.desktopWidth,
                  height: connected.desktopHeight,
                },
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    } catch (error) {
      // 원문을 그대로 담는다 — 문장으로 바꾸는 일은 화면이
      // resolveConnectionFailurePresentation 으로 한다(분류가 한 곳에만 있어야 한다).
      markSessionError(
        set,
        sessionId,
        error instanceof Error ? error.message : String(error),
        { retryable: false },
      );
    }
  };

  /**
   * VNC 세션을 연다.
   *
   * RDP 흐름과 같은 모양이다. 다른 점은 RFB 에 없는 것들이 빠진 것뿐이다 — 모니터 배치·사용자
   * 이름이 없고, 접속 시 화면 크기를 요청하지 않는다(서버가 자기 해상도를 통보한다).
   */
  const startVncConnectionFlow = async (
    set: StoreSetter,
    get: StoreGetter,
    host: HostRecord,
    reuseSessionId?: string,
  ) => {
    const sessionId = reuseSessionId ?? createPendingSessionId();
    if (!reuseSessionId) {
      const title = buildSessionTitle(
        host.label,
        { source: "host", hostId: host.id },
        get().tabs,
      );

      const tab = createPendingSessionTab({
        sessionId,
        source: "host",
        hostId: host.id,
        title,
        paneKind: "vnc",
        progress: resolveConnectingProgress(host),
      });

      set((state) => ({
        tabs: [...state.tabs, tab],
        tabStrip: [...state.tabStrip, { kind: "session" as const, sessionId }],
        ...activateSessionContextInState(state, sessionId),
      }));
    }

    updateSessionProgress(
      set,
      sessionId,
      resolveConnectingProgress(host),
      "connecting",
    );

    // tailnet 을 경유하는 호스트는 노드가 먼저 올라와 있어야 한다(RDP 와 같은 이유).
    const tailnetReady = await ensureTailnetReady(set, {
      hostId: host.id,
      sessionId,
    });
    if (!tailnetReady) {
      return;
    }

    // SSH 터널로 경유하면 **그 SSH 호스트의 키를 먼저 신뢰해야** 한다.
    //
    // VNC 자체에는 신뢰 체인이 없지만 통로는 SSH 다. 이 관문이 없으면 메인이 포워드를 열다
    // "Host key is not trusted yet" 로 끝나고, 사용자는 신뢰할지 물어보는 화면을 못 본다 —
    // 처음 쓰는 경유 호스트에서는 접속이 아예 불가능했다.
    //
    // 신뢰 대상은 경유 SSH 호스트이고, 수락한 뒤 이어갈 것은 이 VNC 접속이다(action.kind:
    // 'vnc'). false 면 프롬프트가 떴다는 뜻이라 여기서 멈춘다 — 수락하면 그쪽에서 다시 부른다.
    const tunnelHostId = isVncHostRecord(host) ? host.sshTunnelHostId?.trim() : null;
    if (tunnelHostId) {
      const trusted = await ensureTrustedHost(set, {
        hostId: tunnelHostId,
        sessionId,
        action: { kind: "vnc", hostId: host.id },
      });
      if (!trusted) {
        return;
      }
    }

    try {
      const connected = await api.vnc.connect(sessionId, host.id);
      markSessionConnected(sessionId);
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                status: "connected" as const,
                errorMessage: undefined,
                // 붙고 나면 진행 표시는 지운다 — 연결 화면이 캔버스를 가리면 안 된다.
                connectionProgress: null,
                // 탭 hover 표기용. VNC 는 계정이 없어 해상도만 싣는다.
                rdpDesktopSize: {
                  width: connected.desktopWidth,
                  height: connected.desktopHeight,
                },
                lastEventAt: new Date().toISOString(),
              }
            : tab,
        ),
      }));
    } catch (error) {
      // 원문을 그대로 담는다 — 문장으로 바꾸는 일은 화면이
      // resolveConnectionFailurePresentation 으로 한다(분류가 한 곳에만 있어야 한다).
      markSessionError(
        set,
        sessionId,
        error instanceof Error ? error.message : String(error),
        { retryable: false },
      );
    }
  };

  /**
   * RDP 세션을 같은 탭에 다시 붙인다.
   *
   * 재연결은 탭을 유지해야 한다 — 재연결 상태(시도 횟수·백오프)가 `stableId` 에 붙어 있고,
   * 새 탭을 만들면 그 카운터를 잃는다. 그래서 세션 id 만 새로 발급하고 참조를 갈아끼운다
   * (SSH 의 retrySessionConnection 과 같은 방식).
   */
  const retryRdpConnection = async (
    set: StoreSetter,
    get: StoreGetter,
    sessionId: string,
  ) => {
    const tab = get().tabs.find((item) => item.sessionId === sessionId);
    if (!tab || tab.paneKind !== "rdp" || !tab.hostId) {
      return;
    }
    const host = get().hosts.find((item) => item.id === tab.hostId);
    if (!host || !isRdpHostRecord(host)) {
      return;
    }

    const pendingSessionId = createPendingSessionId();
    set((state) => ({
      ...replaceSessionReferencesInState(
        state,
        sessionId,
        pendingSessionId,
        (current) =>
          createPendingSessionTab({
            sessionId: pendingSessionId,
            // 이것이 재연결 상태의 키다. 잃으면 시도 횟수가 처음부터 다시 센다.
            stableId: current.stableId,
            source: "host",
            hostId: host.id,
            title: current.title,
            paneKind: "rdp",
            progress: resolveConnectingProgress(host),
          }),
      ),
    }));

    // 아직 코어에 붙지 않은 세션(pending)은 끊을 것이 없다.
    if (!isPendingSessionId(sessionId)) {
      await api.rdp.disconnect(sessionId).catch(() => undefined);
    }

    await startRdpConnectionFlow(set, get, host, pendingSessionId);
  };

  /**
   * VNC 세션을 같은 탭에 다시 붙인다.
   *
   * RDP 와 같은 모양이고 같은 이유다 — 재연결 상태(시도 횟수·백오프)가 `stableId` 에 붙어 있어서
   * 새 탭을 만들면 그 카운터를 잃는다.
   */
  const retryVncConnection = async (
    set: StoreSetter,
    get: StoreGetter,
    sessionId: string,
  ) => {
    const tab = get().tabs.find((item) => item.sessionId === sessionId);
    if (!tab || tab.paneKind !== "vnc" || !tab.hostId) {
      return;
    }
    const host = get().hosts.find((item) => item.id === tab.hostId);
    if (!host || !isVncHostRecord(host)) {
      return;
    }

    const pendingSessionId = createPendingSessionId();
    set((state) => ({
      ...replaceSessionReferencesInState(
        state,
        sessionId,
        pendingSessionId,
        (current) =>
          createPendingSessionTab({
            sessionId: pendingSessionId,
            // 이것이 재연결 상태의 키다. 잃으면 시도 횟수가 처음부터 다시 센다.
            stableId: current.stableId,
            source: "host",
            hostId: host.id,
            title: current.title,
            paneKind: "vnc",
            progress: resolveConnectingProgress(host),
          }),
      ),
    }));

    // 아직 코어에 붙지 않은 세션(pending)은 끊을 것이 없다.
    if (!isPendingSessionId(sessionId)) {
      await api.vnc.disconnect(sessionId).catch(() => undefined);
    }

    await startVncConnectionFlow(set, get, host, pendingSessionId);
  };

  const startSessionConnectionFlow = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
    cols: number,
    rows: number,
    secrets?: HostSecretInput,
    reuseSessionId?: string,
    startupCommand?: string,
    tmux?: boolean,
    tmuxCommand?: string,
    replaceSessionId?: string,
    reconnectGroupId?: string,
    tmuxVersion?: string,
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host) {
      return;
    }

    if (isRdpHostRecord(host)) {
      await startRdpConnectionFlow(set, get, host);
      return;
    }

    if (isVncHostRecord(host)) {
      await startVncConnectionFlow(set, get, host);
      return;
    }

    const initialProgress = isAwsEc2HostRecord(host)
      ? createConnectionProgress(
          "checking-profile",
          t('containersStore.checkingProfile', { profile: host.awsProfileName }),
        )
      : isSerialHostRecord(host)
        ? resolveConnectingProgress(host)
      : resolveHostKeyCheckProgress(host);
    // 원 세션이 "standalone 세션 탭"일 때만 그 자리를 재사용한다. 워크스페이스(분할)
    // 안의 pane 이면 슬롯 교체/disconnect 가 분할을 깨므로 무시하고 새 탭으로 연다.
    const replaceStandaloneSessionId =
      replaceSessionId != null &&
      get().tabStrip.some(
        (item) => item.kind === "session" && item.sessionId === replaceSessionId,
      )
        ? replaceSessionId
        : undefined;
    const sessionId = createPendingSessionTabForHost(
      set,
      get,
      host,
      cols,
      rows,
      initialProgress,
      reuseSessionId,
      startupCommand,
      tmux,
      tmuxCommand,
      replaceStandaloneSessionId,
      reconnectGroupId,
      tmuxVersion,
    );

    // tmux 를 원 세션 자리에서 여는 경우: 원 세션의 로컬 탭은 위에서 이미 control 세션
    // 탭으로 교체됐다(같은 슬롯). 원 세션의 원격 셸은 여기서 끊는다. 그 'closed'
    // 이벤트의 탭 제거는 이미 사라진 탭이라 idempotent 하고, 활성 탭은 control(곧 tmux
    // 그룹)이라 홈으로 튀지 않는다.
    if (replaceStandaloneSessionId && replaceStandaloneSessionId !== sessionId) {
      void api.ssh.disconnect(replaceStandaloneSessionId).catch(() => undefined);
    }

    try {
      if (isAwsEc2HostRecord(host)) {
        await ensureAwsHostAuthentication(host, (message, options) => {
          updateSessionProgress(
            set,
            sessionId,
            createConnectionProgress(
              options?.stage ?? "checking-profile",
              message,
              {
                blockingKind: options?.blockingKind ?? "none",
              },
            ),
          );
        });
        // 일반 SSH 호스트와 동일하게, SSM 위 SSH 호스트 키를 먼저 probe하고 미신뢰면
        // 신뢰 프롬프트(KnownHostPromptDialog)를 띄운다 — 수락 전에는 연결하지 않는다.
        // probe 진행 이벤트는 aws-ec2-ssh 엔드포인트로 흘려 이 터미널 탭 오버레이에 매핑한다.
        //
        // Windows 는 이 probe 자체가 성립하지 않는다. SSM 셸(PowerShell)로 붙으므로 대조할
        // SSH 호스트 키가 없고, probe 는 SSM 터널을 열어 22번 포트에서 키를 읽으려 한다.
        // 게다가 probe 경로의 AWS preflight 가 Windows 를 거부하므로, 연결이 여기서 끝나
        // 메인의 SSM 셸 경로까지 가지도 못한다.
        const trusted = isAwsEc2WindowsPlatform(host.awsPlatform)
          ? true
          : await ensureTrustedHost(set, {
              hostId,
              sessionId,
              endpointId: `aws-ec2-ssh:${hostId}`,
              action: {
                kind: "ssh",
                hostId,
                cols,
                rows,
                secrets,
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
        updateSessionProgress(
          set,
          sessionId,
          createConnectionProgress(
            "retrying-session",
            t('sessionSvc.ssmRetrying', { label: host.label }),
          ),
        );
        await startPendingSessionConnect(set, get, sessionId, host.id, secrets);
        return;
      }

      if (isSerialHostRecord(host)) {
        await startPendingSessionConnect(set, get, sessionId, host.id);
        return;
      }

      // ensureTrustedHost는 jumpHostId가 있으면 베스천을 먼저 신뢰한 뒤 타깃을
      // (베스천 경유로) probe한다. 타깃 자신의 키 신뢰는 startPendingSessionConnect에서
      // 베스천이 신뢰된 상태로 한 번 더 보장한다(수락 후 재시도 경로 포함).
      const trusted = await ensureTrustedHost(set, {
        hostId,
        sessionId,
        // 이미 신뢰된 호스트는 프로브를 생략한다(startPendingSessionConnect의 재확인과 겹쳐
        // 점프 체인을 중복 순회하던 문제 제거 — 홉 UI가 여러 바퀴 도는 원인이었다).
        action: {
          kind: "ssh",
          hostId,
          cols,
          rows,
          secrets,
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

      await startPendingSessionConnect(set, get, sessionId, host.id, secrets);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('sessionSvc.connectFailed');
      markSessionError(set, sessionId, message);
    }
  };

  const promptForMissingUsername = (
    set: StoreSetter,
    get: StoreGetter,
    prompt: PendingMissingUsernamePrompt,
  ): boolean => {
    const host = findSshHostMissingUsername(get().hosts, prompt.hostId);
    if (!host) {
      return false;
    }
    set({ pendingMissingUsernamePrompt: prompt });
    return true;
  };

  const startLocalTerminalFlow = async (
    set: StoreSetter,
    get: StoreGetter,
    cols: number,
    rows: number,
    reuseSessionId?: string,
  ) => {
    const sessionId = createPendingSessionTabForLocal(
      set,
      get,
      cols,
      rows,
      resolveLocalStartingProgress(),
      reuseSessionId,
    );

    // 셸을 띄우기 전에 pane 이 실제 크기를 보고할 틈을 준다.
    //
    // 셸은 처음 받은 크기로 프롬프트를 그린다. 씨앗값으로 시작하면 곧 도착하는 실제 크기에 맞춰
    // conhost 가 리플로우하면서 그 프롬프트가 화면에 남는다 — 실기기에서 첫 줄에 프롬프트가 두 번
    // 찍히고 첫 입력이 엉뚱한 열에서 시작했다(cls 를 하면 사라졌다).
    //
    // 여기서 한두 프레임 기다리면 pane 이 이미 측정을 마쳐서 셸이 처음부터 올바른 폭으로 시작한다.
    await awaitMeasuredPendingSize(get, sessionId, { cols, rows });

    try {
      await startPendingLocalSessionConnect(set, get, sessionId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t('sessionSvc.localFailed');
      markSessionError(set, sessionId, message);
    }
  };

  return {
    updateSessionProgress,
    markSessionError,
    createPendingSessionTabForHost,
    startRdpConnectionFlow,
    // 경유 SSH 호스트를 신뢰한 뒤 멈춰 둔 접속을 이어가려면 밖에서 부를 수 있어야 한다
    // (networkSlice 의 acceptPendingHostKeyPrompt).
    startVncConnectionFlow,
    retryRdpConnection,
    retryVncConnection,
    createPendingSessionTabForLocal,
    createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell,
    startPendingSessionConnect,
    startPendingLocalSessionConnect,
    startSessionConnectionFlow,
    promptForMissingUsername,
    startLocalTerminalFlow,
  };
}
