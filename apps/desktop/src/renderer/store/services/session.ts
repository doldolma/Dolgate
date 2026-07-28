import type {
  HostRecord,
  HostSecretInput,
  TerminalConnectionProgress,
  TerminalTab,
} from "@shared";
import type { AppState, PendingMissingUsernamePrompt } from "../types";
import type { SliceDeps } from "./context";
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

export function createSessionServices(deps: SliceDeps) {
  const { api } = deps;
  const {
    ensureAwsHostAuthentication,
    ensureTrustedHost,
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
      if (!state.tabs.some((tab) => tab.sessionId === sessionId)) {
        return {
          pendingConnectionAttempts: state.pendingConnectionAttempts.filter(
            (attempt) => attempt.sessionId !== sessionId,
          ),
        };
      }
      return {
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
        skipProbeIfAlreadyTrusted: true,
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
        const trusted = await ensureTrustedHost(set, {
          hostId,
          sessionId,
          endpointId: `aws-ec2-ssh:${hostId}`,
          skipProbeIfAlreadyTrusted: true,
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
        skipProbeIfAlreadyTrusted: true,
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
