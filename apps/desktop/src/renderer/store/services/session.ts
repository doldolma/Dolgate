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
          : "호스트 연결을 시작하지 못했습니다.";
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
          : "로컬 터미널을 시작하지 못했습니다.";
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
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host) {
      return;
    }

    const initialProgress = isAwsEc2HostRecord(host)
      ? createConnectionProgress(
          "checking-profile",
          `${host.awsProfileName} 프로필 인증 상태를 확인하는 중입니다.`,
        )
      : isSerialHostRecord(host)
        ? resolveConnectingProgress(host)
      : resolveHostKeyCheckProgress(host);
    const sessionId = createPendingSessionTabForHost(
      set,
      get,
      host,
      cols,
      rows,
      initialProgress,
      reuseSessionId,
      startupCommand,
    );

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
        updateSessionProgress(
          set,
          sessionId,
          createConnectionProgress(
            "retrying-session",
            `${host.label} SSM 연결을 다시 시도하는 중입니다.`,
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
          : "호스트 연결을 시작하지 못했습니다. AWS SSM 연결에는 session-manager-plugin이 필요할 수 있습니다.";
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
          : "로컬 터미널을 시작하지 못했습니다.";
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
