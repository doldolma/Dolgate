import type { ConnectionProgressStage, TerminalConnectionProgress } from "@shared";
import {
  createDefaultLogsRelativeRange,
  normalizeLogsAbsoluteRange,
  normalizeLogsRelativeRange,
} from "../../lib/log-range";
import type { SliceDeps } from "./context";
import type {
  HostContainerLogsRefreshOptions,
  HostContainersTabState,
} from "../types";
import {
  DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
  createEmptyContainersTabState,
} from "../defaults";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import {
  buildContainersEndpointId,
  buildContainersTabTitle,
  classifyContainerLogsErrorMessage,
  clearEcsServiceUtilization,
  createContainerConnectionProgress,
  createEcsUtilizationHistoryState,
  createConnectionProgress,
  isAwsEcsHostRecord,
  isAwsSsoAuthenticationErrorMessage,
  isPendingContainersInteractiveAuth,
  mergeContainerLogLines,
  mergeEcsClusterUtilizationSnapshot,
  mergeEcsUtilizationHistoryState,
  normalizeErrorMessage,
  trimContainerMetricsSamples,
  upsertContainersTab,
  findContainersTab,
  normalizeEcsExecShellPermissionMessage,
  replaceSessionReferencesInState,
  findPendingConnectionAttempt,
  isPendingEcsShellAttempt,
} from "../utils";
import { t } from '../../i18n';

type StoreSetter = SliceDeps["set"];
type StoreGetter = SliceDeps["get"];

function resolveEcsAuthProgressStage(
  stage?: TerminalConnectionProgress["stage"],
): ConnectionProgressStage {
  if (stage === "browser-login" || stage === "checking-profile") {
    return stage;
  }
  return "checking-profile";
}

function resolveContainerLogsRange(
  tab: Pick<
    HostContainersTabState,
    "logsRangeMode" | "logsRelativeRange" | "logsAbsoluteRange"
  >,
): { startTime: string | null; endTime: string | null } {
  const normalizedRange =
    tab.logsRangeMode === "absolute"
      ? normalizeLogsAbsoluteRange(tab.logsAbsoluteRange)
      : normalizeLogsRelativeRange(tab.logsRelativeRange);
  return {
    startTime: normalizedRange?.startTime ?? null,
    endTime: normalizedRange?.endTime ?? null,
  };
}

function resolveContainerLogsRequestRange(
  tab: HostContainersTabState,
  options?: HostContainerLogsRefreshOptions,
): { startTime: string | null; endTime: string | null } {
  if (options?.followCursor) {
    return { startTime: null, endTime: null };
  }
  if (options?.startTime !== undefined || options?.endTime !== undefined) {
    return {
      startTime: options.startTime ?? null,
      endTime: options.endTime ?? null,
    };
  }
  if (options?.rangeMode === "absolute") {
    const normalizedRange = normalizeLogsAbsoluteRange(options.absoluteRange ?? null);
    return {
      startTime: normalizedRange?.startTime ?? null,
      endTime: normalizedRange?.endTime ?? null,
    };
  }
  if (options?.rangeMode === "recent") {
    const normalizedRange = normalizeLogsRelativeRange(
      options.relativeRange ?? createDefaultLogsRelativeRange(),
    );
    return {
      startTime: normalizedRange?.startTime ?? null,
      endTime: normalizedRange?.endTime ?? null,
    };
  }
  if (tab.logsFollowEnabled) {
    return { startTime: null, endTime: null };
  }
  return resolveContainerLogsRange(tab);
}

function applyContainerLogsRangeOptions(
  tab: HostContainersTabState,
  options?: HostContainerLogsRefreshOptions,
): HostContainersTabState {
  if (!options?.rangeMode) {
    return tab;
  }
  return {
    ...tab,
    logsFollowEnabled: false,
    logsRangeMode: options.rangeMode,
    logsRelativeRange:
      options.rangeMode === "recent"
        ? options.relativeRange ?? createDefaultLogsRelativeRange()
        : createDefaultLogsRelativeRange(),
    logsAbsoluteRange: options.rangeMode === "absolute" ? options.absoluteRange ?? null : null,
  };
}

export function createContainersServices(deps: SliceDeps) {
  const { api } = deps;
  const sessionServices = createSessionServices(deps);
  const trustServices = createTrustAuthServices(deps);
  const clearContainerTabConnectionOverlay = (
    set: StoreSetter,
    hostId: string,
  ) => {
    set((state) => {
      const currentTab = findContainersTab(state, hostId);
      if (!currentTab) {
        return state;
      }
      if (!currentTab.isLoading && currentTab.connectionProgress == null) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          isLoading: false,
          connectionProgress: null,
        }),
      };
    });
  };
  const beginContainerLifecycle = async (
    set: StoreSetter,
    hostId: string,
  ): Promise<string> => {
    const { lifecycleId } = await api.containers.beginLifecycle(hostId);
    set((state) => {
      const host = state.hosts.find((item) => item.id === hostId);
      const currentTab =
        findContainersTab(state, hostId) ??
        (host ? createEmptyContainersTabState(host) : null);
      if (!currentTab) {
        return state;
      }
      if (currentTab.lifecycleId === lifecycleId) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          lifecycleId,
        }),
      };
    });
    return lifecycleId;
  };
  const reportContainerLifecycleError = async (
    lifecycleId: string | null | undefined,
    error: unknown,
    fallbackMessage: string,
  ): Promise<void> => {
    if (!lifecycleId) {
      return;
    }
    await api.containers
      .reportLifecycleError({
        lifecycleId,
        message: normalizeErrorMessage(error, fallbackMessage),
      })
      .catch(() => undefined);
  };
  const {
    updateSessionProgress,
    promptForMissingUsername,
    startPendingContainerShellConnect,
    startPendingEcsExecShellConnect,
    createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell,
  } = {
    updateSessionProgress: sessionServices.updateSessionProgress,
    promptForMissingUsername: sessionServices.promptForMissingUsername,
    startPendingContainerShellConnect: async (
      set: StoreSetter,
      get: StoreGetter,
      sessionId: string,
      hostId: string,
      containerId: string,
    ) => {
      const host = get().hosts.find((item) => item.id === hostId);
      if (!host) {
        return;
      }

      clearContainerTabConnectionOverlay(set, hostId);
      sessionServices.updateSessionProgress(
        set,
        sessionId,
        createConnectionProgress(
          "retrying-session",
          t("containersStore.openingShell", { label: host.label }),
        ),
      );

      try {
        const connection = await api.containers.openShell(hostId, containerId);
        const latestAttempt = get().pendingConnectionAttempts.find(
          (attempt) => attempt.sessionId === sessionId,
        );
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
              connectionProgress: createConnectionProgress(
                "connecting",
                t("containersStore.connectingShell", { label: host.label }),
              ),
              hasReceivedOutput: false,
              lastEventAt: new Date().toISOString(),
            }),
          ),
          pendingConnectionAttempts: currentState.pendingConnectionAttempts.map(
            (attempt) =>
              attempt.sessionId === sessionId
                ? {
                    ...attempt,
                    sessionId: connection.sessionId,
                  }
                : attempt,
          ),
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t("containersStore.shellFailed");
        sessionServices.markSessionError(set, sessionId, message);
      } finally {
        clearContainerTabConnectionOverlay(set, hostId);
      }
    },
    startPendingEcsExecShellConnect: async (
      set: StoreSetter,
      get: StoreGetter,
      sessionId: string,
    ) => {
      const attempt = findPendingConnectionAttempt(get(), sessionId);
      if (!isPendingEcsShellAttempt(attempt)) {
        return;
      }
      const host = get().hosts.find((item) => item.id === attempt.hostId);
      if (!host || !isAwsEcsHostRecord(host)) {
        return;
      }

      sessionServices.updateSessionProgress(
        set,
        sessionId,
        createConnectionProgress(
          "retrying-session",
          t("containersStore.openingEcsShell", { label: host.label }),
        ),
      );

      try {
        const connection = await api.aws.openEcsExecShell({
          hostId: attempt.hostId,
          serviceName: attempt.serviceName,
          taskArn: attempt.taskArn,
          containerName: attempt.containerName,
          cols: findPendingConnectionAttempt(get(), sessionId)?.latestCols ?? 120,
          rows: findPendingConnectionAttempt(get(), sessionId)?.latestRows ?? 32,
          command: "/bin/sh",
        });
        const latestAttempt = findPendingConnectionAttempt(get(), sessionId);
        if (!isPendingEcsShellAttempt(latestAttempt)) {
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
              title: `${host.label} · ${latestAttempt.serviceName} · ${latestAttempt.containerName}`,
              shellKind: "aws-ecs-exec",
              status: "connecting",
              errorMessage: undefined,
              connectionProgress: createConnectionProgress(
                "connecting",
                t("containersStore.connectingEcsShell", { label: host.label }),
              ),
              hasReceivedOutput: false,
              lastEventAt: new Date().toISOString(),
            }),
          ),
          pendingConnectionAttempts: currentState.pendingConnectionAttempts.map(
            (attemptItem) =>
              attemptItem.sessionId === sessionId
                ? {
                    ...attemptItem,
                    sessionId: connection.sessionId,
                  }
                : attemptItem,
          ),
        }));
      } catch (error) {
        const message =
          normalizeEcsExecShellPermissionMessage(
            error instanceof Error ? error.message : t("containersStore.ecsShellFailed"),
          ) ?? t("containersStore.ecsShellFailed");
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.sessionId === sessionId
              ? {
                  ...tab,
                  shellKind: "aws-ecs-exec",
                  status: "error",
                  errorMessage: message,
                  connectionProgress: null,
                  lastEventAt: new Date().toISOString(),
                }
              : tab,
          ),
        }));
      }
    },
    createPendingSessionTabForContainerShell:
      sessionServices.createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell:
      sessionServices.createPendingSessionTabForEcsShell,
  };

  const pruneEcsLogsByServiceName = <T,>(
    logsByServiceName: Record<string, T>,
    serviceNames: string[],
  ): Record<string, T> => {
    const validServiceNames = new Set(serviceNames);
    return Object.fromEntries(
      Object.entries(logsByServiceName).filter(([serviceName]) =>
        validServiceNames.has(serviceName),
      ),
    );
  };

  const loadContainerDetails = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
    containerId: string,
  ) => {
    set((state) => {
      const currentTab = findContainersTab(state, hostId);
      if (!currentTab) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          detailsLoading: true,
          detailsError: undefined,
        }),
      };
    });

    try {
      const details = await api.containers.inspect(hostId, containerId);
      set((state) => {
        const currentTab = findContainersTab(state, hostId);
        if (!currentTab || currentTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            details,
            detailsLoading: false,
            detailsError: undefined,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const currentTab = findContainersTab(state, hostId);
        if (!currentTab || currentTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            details: null,
            detailsLoading: false,
            detailsError:
              error instanceof Error
                ? error.message
                : t("containersStore.detailsFailed"),
          }),
        };
      });
    }
  };

  const loadEcsClusterUtilization = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host || !isAwsEcsHostRecord(host)) {
      return;
    }

    set((state) => {
      const currentTab =
        findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          kind: "ecs-cluster",
          title: buildContainersTabTitle(host),
          ecsMetricsLoading: true,
        }),
      };
    });

    try {
      const utilization = await api.aws.loadEcsClusterUtilization(hostId);
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        const nextSnapshot = currentTab.ecsSnapshot
          ? mergeEcsClusterUtilizationSnapshot(currentTab.ecsSnapshot, utilization)
          : currentTab.ecsSnapshot;
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            ecsSnapshot: nextSnapshot,
            ecsMetricsWarning: utilization.warning ?? null,
            ecsMetricsLoadedAt: utilization.loadedAt,
            ecsMetricsLoading: false,
            ecsUtilizationHistoryByServiceName: mergeEcsUtilizationHistoryState(
              currentTab.ecsUtilizationHistoryByServiceName,
              utilization,
            ),
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        const nextSnapshot = currentTab.ecsSnapshot
          ? clearEcsServiceUtilization(currentTab.ecsSnapshot)
          : currentTab.ecsSnapshot;
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            ecsSnapshot: nextSnapshot,
            ecsMetricsWarning: normalizeErrorMessage(
              error,
              t("aws.ecs.metricsPartial"),
            ),
            ecsMetricsLoading: false,
            ecsUtilizationHistoryByServiceName: {},
          }),
        };
      });
    }
  };

  const loadEcsClusterSnapshot = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host || !isAwsEcsHostRecord(host)) {
      return;
    }

    const setEcsProgress = (
      stage: ConnectionProgressStage,
      message: string,
    ) => {
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            isLoading: true,
            connectionProgress: createContainerConnectionProgress(
              hostId,
              buildContainersEndpointId(hostId),
              stage,
              message,
            ),
            errorMessage: undefined,
          }),
        };
      });
    };

    set((state) => {
      const currentTab =
        findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
      return {
        activeWorkspaceTab: "containers",
        activeContainerHostId: hostId,
        homeSection: "hosts",
        hostDrawer: { mode: "closed" },
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          kind: "ecs-cluster",
          title: buildContainersTabTitle(host),
          isLoading: true,
          connectionProgress: createContainerConnectionProgress(
            hostId,
            buildContainersEndpointId(hostId),
            "checking-profile",
            t("containersStore.checkingProfile", { profile: host.awsProfileName }),
          ),
          errorMessage: undefined,
        }),
      };
    });

    const reportAuthProgress = (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => {
      setEcsProgress(resolveEcsAuthProgressStage(options?.stage), message);
    };

    try {
      await beginContainerLifecycle(set, hostId);
      const profileStatus =
        await trustServices.ensureAwsSsoProfileAuthenticationIfNeeded(
          host.awsProfileId,
          host.awsProfileName,
          reportAuthProgress,
        );
      let snapshot;
      try {
        setEcsProgress(
          "loading-ecs-cluster",
          t("containersStore.loadingEcs"),
        );
        snapshot = await api.aws.loadEcsClusterSnapshot(hostId);
      } catch (error) {
        const message = normalizeErrorMessage(
          error,
          t("containersStore.ecsLoadFailed"),
        );
        if (
          profileStatus.isSsoProfile &&
          isAwsSsoAuthenticationErrorMessage(message)
        ) {
          await trustServices.loginAwsSsoProfile(
            host.awsProfileId,
            host.awsProfileName,
            reportAuthProgress,
          );
          setEcsProgress(
            "loading-ecs-cluster",
            t("containersStore.reloadingEcs"),
          );
          snapshot = await api.aws.loadEcsClusterSnapshot(hostId);
        } else {
          throw new Error(message);
        }
      }
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        const nextEcsLogsByServiceName = pruneEcsLogsByServiceName(
          currentTab.ecsLogsByServiceName,
          snapshot.services.map((service) => service.serviceName),
        );
        return {
          activeWorkspaceTab: "containers",
          activeContainerHostId: hostId,
          homeSection: "hosts",
          hostDrawer: { mode: "closed" },
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            isLoading: true,
            errorMessage: undefined,
            connectionProgress: createContainerConnectionProgress(
              hostId,
              buildContainersEndpointId(hostId),
              "loading-ecs-metrics",
              t("containersStore.loadingEcsMetrics"),
            ),
            ecsSnapshot: snapshot,
            ecsMetricsWarning: null,
            ecsMetricsLoadedAt: null,
            ecsUtilizationHistoryByServiceName: {},
            ecsLogsByServiceName: nextEcsLogsByServiceName,
          }),
        };
      });
      await loadEcsClusterUtilization(set, get, hostId);
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            isLoading: false,
            connectionProgress: null,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            kind: "ecs-cluster",
            title: buildContainersTabTitle(host),
            isLoading: false,
            connectionProgress: null,
            errorMessage: normalizeErrorMessage(
              error,
              t("containersStore.ecsLoadFailed"),
            ),
            ecsMetricsLoading: false,
          }),
        };
      });
    }
  };

  const loadContainersList = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
  ) => {
    const host = get().hosts.find((item) => item.id === hostId);
    if (!host) {
      return;
    }

    set((state) => {
      const currentTab =
        findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...currentTab,
          title: buildContainersTabTitle(host),
          isLoading: true,
          connectionProgress:
            currentTab.connectionProgress ??
            createContainerConnectionProgress(
              hostId,
              buildContainersEndpointId(hostId),
              "connecting-containers",
              t("containersStore.checkingConnection", { label: host.label }),
            ),
          errorMessage: undefined,
        }),
      };
    });

    try {
      await beginContainerLifecycle(set, hostId);
      const result = await api.containers.list(hostId);
      const nextSelectedContainerId = (() => {
        const currentSelectedId =
          findContainersTab(get(), hostId)?.selectedContainerId ?? null;
        if (
          currentSelectedId &&
          result.containers.some((item) => item.id === currentSelectedId)
        ) {
          return currentSelectedId;
        }
        return result.containers[0]?.id ?? null;
      })();

      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        return {
          activeWorkspaceTab: "containers",
          activeContainerHostId: hostId,
          homeSection: "hosts",
          hostDrawer: { mode: "closed" },
          pendingInteractiveAuth:
            isPendingContainersInteractiveAuth(state.pendingInteractiveAuth) &&
            state.pendingInteractiveAuth.hostId === hostId
              ? null
              : state.pendingInteractiveAuth,
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            title: buildContainersTabTitle(host),
            runtime: result.runtime,
            unsupportedReason: result.unsupportedReason ?? null,
            connectionProgress: null,
            items: result.containers,
            selectedContainerId: nextSelectedContainerId,
            isLoading: false,
            errorMessage: undefined,
            details:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.details
                : null,
            detailsError:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.detailsError
                : undefined,
            logs:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logs
                : null,
            logsState:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsState
                : "idle",
            logsError:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsError
                : undefined,
            logsTailWindow:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsTailWindow
                : DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
            logsSearchQuery:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsSearchQuery
                : "",
            logsSearchMode:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsSearchMode
                : null,
            logsSearchLoading:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsSearchLoading
                : false,
            logsSearchError:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsSearchError
                : undefined,
            logsSearchResult:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.logsSearchResult
                : null,
            metricsSamples:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.metricsSamples
                : [],
            metricsState:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.metricsState
                : "idle",
            metricsLoading:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.metricsLoading
                : false,
            metricsError:
              currentTab.selectedContainerId === nextSelectedContainerId
                ? currentTab.metricsError
                : undefined,
            pendingAction: null,
            actionError: undefined,
          }),
        };
      });

      if (nextSelectedContainerId && !result.unsupportedReason) {
        await loadContainerDetails(set, get, hostId, nextSelectedContainerId);
      }
    } catch (error) {
      set((state) => {
        const currentTab =
          findContainersTab(state, hostId) ?? createEmptyContainersTabState(host);
        return {
          pendingInteractiveAuth:
            isPendingContainersInteractiveAuth(state.pendingInteractiveAuth) &&
            state.pendingInteractiveAuth.hostId === hostId
              ? null
              : state.pendingInteractiveAuth,
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...currentTab,
            title: buildContainersTabTitle(host),
            connectionProgress: null,
            isLoading: false,
            errorMessage:
              error instanceof Error
                ? error.message
                : t("containersStore.listFailed"),
          }),
        };
      });
    }
  };

  const loadContainerLogs = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
    options?: HostContainerLogsRefreshOptions,
  ) => {
    const currentTab = findContainersTab(get(), hostId);
    const containerId = currentTab?.selectedContainerId ?? null;
    if (!currentTab || !containerId) {
      return;
    }
    const requestRange = resolveContainerLogsRequestRange(currentTab, options);

    set((state) => {
      const nextTab = findContainersTab(state, hostId);
      if (!nextTab || nextTab.selectedContainerId !== containerId) {
        return state;
      }
      const shouldPreserveVisibleLogs = Boolean(
        options?.followCursor &&
          nextTab.logs &&
          nextTab.logs.lines.length > 0 &&
          nextTab.logsState === "ready",
      );
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...applyContainerLogsRangeOptions(nextTab, options),
          logsState: shouldPreserveVisibleLogs ? nextTab.logsState : "loading",
          logsLoading: true,
          logsError: undefined,
          logsTailWindow: options?.tail ?? nextTab.logsTailWindow,
          logsSearchLoading: false,
          logsSearchError: undefined,
          logsSearchMode: nextTab.logsSearchMode === "local" ? "local" : null,
          logsSearchResult: null,
        }),
      };
    });

    try {
      const logs = await api.containers.logs({
        hostId,
        containerId,
        tail: options?.tail ?? currentTab.logsTailWindow,
        followCursor: options?.followCursor ?? null,
        startTime: requestRange.startTime,
        endTime: requestRange.endTime,
      });
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        const mergedLines =
          options?.followCursor && nextTab.logs
            ? mergeContainerLogLines(nextTab.logs.lines, logs.lines)
            : logs.lines;
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...applyContainerLogsRangeOptions(nextTab, options),
            runtime: logs.runtime,
            logs: {
              ...logs,
              lines: mergedLines,
            },
            logsState: mergedLines.length > 0 ? "ready" : "empty",
            logsLoading: false,
            logsError: undefined,
            logsTailWindow: options?.tail ?? nextTab.logsTailWindow,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            logsLoading: false,
            logsState:
              error instanceof Error
                ? classifyContainerLogsErrorMessage(error.message)
                : "error",
            logsError:
              error instanceof Error
                ? classifyContainerLogsErrorMessage(error.message) === "malformed"
                  ? t("containersStore.logsParseFailed")
                  : error.message
                : t("containersStore.logsFailed"),
          }),
        };
      });
    }
  };

  const loadContainerStats = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
  ) => {
    const currentTab = findContainersTab(get(), hostId);
    const containerId = currentTab?.selectedContainerId ?? null;
    if (!currentTab || !containerId) {
      return;
    }

    set((state) => {
      const nextTab = findContainersTab(state, hostId);
      if (!nextTab || nextTab.selectedContainerId !== containerId) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...nextTab,
          metricsLoading: true,
          metricsState:
            nextTab.metricsSamples.length > 0 ? nextTab.metricsState : "loading",
          metricsError: undefined,
        }),
      };
    });

    try {
      const sample = await api.containers.stats({ hostId, containerId });
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            runtime: sample.runtime,
            metricsSamples: trimContainerMetricsSamples([
              ...nextTab.metricsSamples,
              sample,
            ]),
            metricsState: "ready",
            metricsLoading: false,
            metricsError: undefined,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            metricsState: nextTab.metricsSamples.length > 0 ? "ready" : "error",
            metricsLoading: false,
            metricsError:
              error instanceof Error
                ? error.message
                : t("containersStore.metricsFailed"),
          }),
        };
      });
    }
  };

  const searchContainerLogs = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
  ) => {
    const currentTab = findContainersTab(get(), hostId);
    const containerId = currentTab?.selectedContainerId ?? null;
    const query = currentTab?.logsSearchQuery.trim() ?? "";
    if (!currentTab || !containerId || !query) {
      return;
    }
    const requestRange = resolveContainerLogsRange(currentTab);

    set((state) => {
      const nextTab = findContainersTab(state, hostId);
      if (!nextTab || nextTab.selectedContainerId !== containerId) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...nextTab,
          logsFollowEnabled: false,
          logsSearchMode: "remote",
          logsSearchLoading: true,
          logsSearchError: undefined,
        }),
      };
    });

    try {
      const result = await api.containers.searchLogs({
        hostId,
        containerId,
        tail: currentTab.logsTailWindow,
        query,
        startTime: requestRange.startTime,
        endTime: requestRange.endTime,
      });
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            logsSearchMode: "remote",
            logsSearchLoading: false,
            logsSearchError: undefined,
            logsSearchResult: result,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            logsSearchMode: "remote",
            logsSearchLoading: false,
            logsSearchError:
              error instanceof Error
                ? error.message
                : t("containersStore.remoteSearchFailed"),
          }),
        };
      });
    }
  };

  const runContainerAction = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
    action: "start" | "stop" | "restart" | "remove",
  ) => {
    const currentTab = findContainersTab(get(), hostId);
    const containerId = currentTab?.selectedContainerId ?? null;
    if (!currentTab || !containerId) {
      return;
    }

    set((state) => {
      const nextTab = findContainersTab(state, hostId);
      if (!nextTab || nextTab.selectedContainerId !== containerId) {
        return state;
      }
      return {
        containerTabs: upsertContainersTab(state.containerTabs, {
          ...nextTab,
          pendingAction: action,
          actionError: undefined,
        }),
      };
    });

    try {
      if (action === "start") {
        await api.containers.start(hostId, containerId);
      } else if (action === "stop") {
        await api.containers.stop(hostId, containerId);
      } else if (action === "restart") {
        await api.containers.restart(hostId, containerId);
      } else {
        await api.containers.remove(hostId, containerId);
      }
      await loadContainersList(set, get, hostId);
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            pendingAction: null,
            actionError: undefined,
          }),
        };
      });
    } catch (error) {
      set((state) => {
        const nextTab = findContainersTab(state, hostId);
        if (!nextTab || nextTab.selectedContainerId !== containerId) {
          return state;
        }
        return {
          containerTabs: upsertContainersTab(state.containerTabs, {
            ...nextTab,
            pendingAction: null,
            actionError:
              error instanceof Error
                ? error.message
                : t("containersStore.actionFailed"),
          }),
        };
      });
    }
  };

  return {
    updateSessionProgress,
    markSessionError: sessionServices.markSessionError,
    promptForMissingUsername,
    ensureTrustedHost: trustServices.ensureTrustedHost,
    clearContainerTabConnectionOverlay,
    beginContainerLifecycle,
    reportContainerLifecycleError,
    createPendingSessionTabForContainerShell,
    createPendingSessionTabForEcsShell,
    startPendingContainerShellConnect,
    startPendingEcsExecShellConnect,
    loadContainerDetails,
    loadEcsClusterUtilization,
    loadEcsClusterSnapshot,
    loadContainersList,
    loadContainerLogs,
    loadContainerStats,
    searchContainerLogs,
    runContainerAction,
  };
}
