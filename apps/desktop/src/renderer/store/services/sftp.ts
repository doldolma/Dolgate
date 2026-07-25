import type {
  DirectoryListing,
  FileEntry,
  HostSecretInput,
  SftpEndpointSummary,
  SftpPaneId,
  TransferJob,
  TransferStartInput,
} from "@shared";
import type {
  PendingHostKeyPrompt,
  SftpPaneState,
  TerminalUploadResult,
} from "../types";
import type { SliceDeps } from "./context";
import {
  markAutoRecoveredTransferJob,
  markTerminalUploadJob,
} from "../../lib/terminal-upload-registry";
import { createBootstrapSyncServices } from "./bootstrap-sync";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import {
  basenameFromPath,
  getAwsEc2HostSshPort,
  getPane,
  hasProvidedSecrets,
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  pushHistory,
  resolveAwsSftpFailureDiagnostic,
  resolveCredentialRetryKind,
  shouldPromptAwsSftpConfigRetry,
  updatePaneState,
  upsertTransferJob,
} from "../utils";

type StoreSetter = SliceDeps["set"];
type StoreGetter = SliceDeps["get"];

class TerminalUploadAwaitingHostTrustError extends Error {
  constructor() {
    super("터미널 업로드를 계속하려면 호스트 키 신뢰가 필요합니다.");
  }
}

function isTerminalUploadAwaitingHostTrustError(
  error: unknown,
): error is TerminalUploadAwaitingHostTrustError {
  return error instanceof TerminalUploadAwaitingHostTrustError;
}

type TerminalUploadInput = {
  hostId: string;
  targetPath: string | null;
  localPaths: string[];
  endpointId?: string;
  skipHostTrustPrompt?: boolean;
  // connection_lost 자동 복구 시 true — 캐시/열린 pane 엔드포인트를 재사용하지 않고
  // 반드시 새 엔드포인트(새 SSM 세션)를 맺는다.
  forceReconnect?: boolean;
};

export { upsertTransferJob } from "../utils";

// 터미널 업로드 전용 SFTP 연결은 재사용을 위해 호스트별로 캐시되지만, 어떤 UI에도
// 보이지 않아 사용자가 닫을 수 없다. 마지막 사용 후 이 시간이 지나면 자동으로 닫는다.
export const TERMINAL_UPLOAD_IDLE_TIMEOUT_MS = 5 * 60_000;

const terminalUploadIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const terminalUploadJobIdsByHost = new Map<string, Set<string>>();

const ACTIVE_TRANSFER_STATUSES = new Set<TransferJob["status"]>([
  "queued",
  "running",
  "paused",
  "cancelling",
]);

export function registerTerminalUploadJob(hostId: string, jobId: string): void {
  let jobIds = terminalUploadJobIdsByHost.get(hostId);
  if (!jobIds) {
    jobIds = new Set();
    terminalUploadJobIdsByHost.set(hostId, jobIds);
  }
  jobIds.add(jobId);
}

function clearTerminalUploadIdleTracking(hostId: string): void {
  const timer = terminalUploadIdleTimers.get(hostId);
  if (timer) {
    clearTimeout(timer);
  }
  terminalUploadIdleTimers.delete(hostId);
  terminalUploadJobIdsByHost.delete(hostId);
}

// 스냅샷 리셋처럼 캐시 참조를 통째로 버리는 경로에서 호출한다. 참조만 버리면
// 연결이 고아(재사용 불가 + 서버 타임아웃까지 잔존)가 되므로 실제로 닫는다.
export function releaseTerminalUploadEndpoints(
  api: SliceDeps["api"],
  endpoints: Record<string, SftpEndpointSummary>,
): void {
  for (const [hostId, endpoint] of Object.entries(endpoints)) {
    clearTerminalUploadIdleTracking(hostId);
    void api.sftp.disconnect(endpoint.id).catch(() => undefined);
  }
}

function normalizeDroppedPathForComparison(targetPath: string): string {
  return targetPath.replace(/[\\/]+$/, "").normalize("NFC");
}

function pathsReferToSameDroppedItem(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return (
    normalizeDroppedPathForComparison(left) ===
    normalizeDroppedPathForComparison(right)
  );
}

export function createSftpServices(deps: SliceDeps) {
  const { api, get } = deps;
  const { refreshHostAndKeychainState } = createBootstrapSyncServices(deps);
  const { promptForMissingUsername } = createSessionServices(deps);
  const { ensureTrustedHost } = createTrustAuthServices(deps);

  const loadPaneListing = async (
    set: StoreSetter,
    get: StoreGetter,
    paneId: SftpPaneId,
    targetPath: string,
    options: { pushToHistory: boolean },
  ) => {
    const pane = getPane(get(), paneId);

    set((state) => ({
      sftp: updatePaneState(state, paneId, {
        ...pane,
        isLoading: true,
        errorMessage: undefined,
        warningMessages: [],
      }),
    }));

    try {
      const listing =
        pane.sourceKind === "local"
          ? await api.files.list(targetPath)
          : await api.sftp.list({
              endpointId: pane.endpoint?.id ?? "",
              path: targetPath,
            });

      set((state) => {
        const latestPane = getPane(state, paneId);
        const historyPatch = options.pushToHistory
          ? pushHistory(latestPane, listing.path)
          : {
              history: latestPane.history,
              historyIndex: latestPane.historyIndex,
            };
        const preserveSelection =
          !options.pushToHistory && latestPane.currentPath === listing.path;
        const availablePaths = new Set(
          listing.entries.map((entry) => entry.path),
        );
        const selectedPaths = preserveSelection
          ? latestPane.selectedPaths.filter((entryPath) =>
              availablePaths.has(entryPath),
            )
          : [];
        const nextFilterQuery =
          latestPane.currentPath === listing.path ? latestPane.filterQuery : "";
        const selectionAnchorPath =
          preserveSelection &&
          latestPane.selectionAnchorPath &&
          availablePaths.has(latestPane.selectionAnchorPath)
            ? latestPane.selectionAnchorPath
            : null;
        const nextPane: SftpPaneState = {
          ...latestPane,
          currentPath: listing.path,
          lastLocalPath:
            latestPane.sourceKind === "local"
              ? listing.path
              : latestPane.lastLocalPath,
          entries: listing.entries,
          selectedPaths,
          selectionAnchorPath,
          filterQuery: nextFilterQuery,
          isLoading: false,
          connectingHostId: null,
          connectingEndpointId: null,
          connectionProgress: null,
          connectionDiagnostic: null,
          errorMessage: undefined,
          warningMessages: listing.warnings ?? [],
          ...historyPatch,
          endpoint:
            latestPane.sourceKind === "host" && latestPane.endpoint
              ? {
                  ...latestPane.endpoint,
                  path: listing.path,
                }
              : latestPane.endpoint,
        };

        return {
          sftp: updatePaneState(state, paneId, nextPane),
        };
      });
    } catch (error) {
      set((state) => ({
        sftp: updatePaneState(state, paneId, {
          ...getPane(state, paneId),
          isLoading: false,
          connectingHostId: null,
          connectingEndpointId: null,
          connectionProgress: null,
          connectionDiagnostic: null,
          errorMessage:
            error instanceof Error
              ? error.message
              : "SFTP 목록을 읽지 못했습니다.",
          warningMessages: [],
        }),
      }));
    }
  };

  const setSftpPaneWarnings = (
    set: StoreSetter,
    paneId: SftpPaneId,
    warnings: string[],
  ) => {
    set((state) => ({
      sftp: updatePaneState(state, paneId, {
        ...getPane(state, paneId),
        warningMessages: warnings,
      }),
    }));
  };

  const setSftpPaneConnectionProgress = (
    set: StoreSetter,
    paneId: SftpPaneId,
    progress: any,
  ) => {
    set((state) => ({
      sftp: updatePaneState(state, paneId, {
        ...getPane(state, paneId),
        connectionProgress: progress,
      }),
    }));
  };

  const buildSftpTransferEndpoint = (
    pane: SftpPaneState,
    targetPath: string,
  ) => {
    if (pane.sourceKind === "local") {
      return {
        kind: "local" as const,
        path: targetPath,
      };
    }
    if (!pane.endpoint) {
      return null;
    }
    return {
      kind: "remote" as const,
      endpointId: pane.endpoint.id,
      path: targetPath,
    };
  };

  const startSftpTransferForItems = async (
    set: StoreSetter,
    input: {
      sourcePane: SftpPaneState;
      targetPane: SftpPaneState;
      targetPath: string;
      items: FileEntry[];
    },
  ) => {
    if (input.items.length === 0) {
      return;
    }

    const source = buildSftpTransferEndpoint(
      input.sourcePane,
      input.sourcePane.currentPath,
    );
    const target = buildSftpTransferEndpoint(
      input.targetPane,
      input.targetPath,
    );
    if (!source || !target) {
      return;
    }

    const destinationListing: DirectoryListing =
      input.targetPane.sourceKind === "local"
        ? await api.files.list(input.targetPath)
        : await api.sftp.list({
            endpointId: input.targetPane.endpoint?.id ?? "",
            path: input.targetPath,
          });

    const conflicts = input.items
      .filter((item) =>
        destinationListing.entries.some((entry) => entry.name === item.name),
      )
      .map((item) => item.name);
    const settings = get().settings;
    const conflictPolicy = settings.sftpConflictPolicy ?? "ask";
    const conflictResolution =
      conflicts.length > 0 && conflictPolicy !== "ask"
        ? conflictPolicy
        : "overwrite";

    const transferInput: TransferStartInput = {
      source,
      target,
      items: input.items.map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
          size: item.size,
        })),
      conflictResolution,
      preserveMetadata: {
        mtime: settings.sftpPreserveMtime ?? true,
        permissions: settings.sftpPreservePermissions ?? false,
      },
    };

    if (conflicts.length > 0 && conflictPolicy === "ask") {
      set((state) => ({
        activeWorkspaceTab: "sftp",
        sftp: {
          ...state.sftp,
          pendingConflictDialog: {
            input: transferInput,
            names: conflicts,
          },
        },
      }));
      return;
    }

    const job = await api.sftp.startTransfer(transferInput);
    set((state) => ({
      activeWorkspaceTab: "sftp",
      sftp: {
        ...state.sftp,
        transfers: upsertTransferJob(state.sftp.transfers, job),
      },
    }));
  };

  const resolveLocalTransferItemsFromPaths = async (paths: string[]) => {
    const uniquePaths = Array.from(
      new Set(paths.filter((targetPath) => targetPath.length > 0)),
    );
    const listingCache = new Map<string, DirectoryListing>();
    const items: FileEntry[] = [];
    const warnings: string[] = [];

    for (const targetPath of uniquePaths) {
      const parent = await api.files.getParentPath(targetPath);
      const cacheKey = parent;
      let listing = listingCache.get(cacheKey);
      if (!listing) {
        listing = await api.files.list(parent);
        listingCache.set(cacheKey, listing);
      }
      const matched = listing.entries.find((entry) =>
        pathsReferToSameDroppedItem(entry.path, targetPath),
      );
      if (!matched) {
        warnings.push(`${basenameFromPath(targetPath)} 항목을 읽지 못했습니다.`);
        continue;
      }
      items.push(matched);
    }

    return { items, warnings };
  };

  const connectTrustedHostPane = async (
    set: StoreSetter,
    get: StoreGetter,
    input: {
      paneId: SftpPaneId;
      hostId: string;
      endpointId: string;
      secrets?: HostSecretInput;
    },
  ): Promise<boolean> => {
    const pane = getPane(get(), input.paneId);
    if (pane.endpoint) {
      await api.sftp.disconnect(pane.endpoint.id);
    }
    set((state) => ({
      activeWorkspaceTab: "sftp",
      sftp: updatePaneState(state, input.paneId, {
        ...getPane(state, input.paneId),
        sourceKind: "host",
        endpoint: null,
        connectingHostId: input.hostId,
        connectingEndpointId: input.endpointId,
        connectionDiagnostic: null,
        entries: [],
        isLoading: true,
        errorMessage: undefined,
        selectedPaths: [],
        selectionAnchorPath: null,
        selectedHostId: input.hostId,
      }),
    }));
    try {
      const endpoint = await api.sftp.connect({
        hostId: input.hostId,
        endpointId: input.endpointId,
        secrets: input.secrets,
      });
      set((state) => ({
        sftp: updatePaneState(state, input.paneId, {
          ...getPane(state, input.paneId),
          sourceKind: "host",
          endpoint,
          connectingHostId: input.hostId,
          connectingEndpointId: input.endpointId,
          connectionProgress: getPane(state, input.paneId).connectionProgress,
          connectionDiagnostic: null,
          currentPath: endpoint.path,
          history: [endpoint.path],
          historyIndex: 0,
          selectedPaths: [],
          selectionAnchorPath: null,
          errorMessage: undefined,
          warningMessages: [],
        }),
      }));
      await loadPaneListing(set, get, input.paneId, endpoint.path, {
        pushToHistory: false,
      });
      if (hasProvidedSecrets(input.secrets)) {
        await refreshHostAndKeychainState(set);
      }
      return true;
    } catch (error) {
      const host = get().hosts.find((item) => item.id === input.hostId);
      const message =
        error instanceof Error ? error.message : "SFTP 연결에 실패했습니다.";
      const shouldPromptCredentialRetry = resolveCredentialRetryKind(host, message);
      const shouldPromptAwsConfig = shouldPromptAwsSftpConfigRetry(host, message);
      if (shouldPromptCredentialRetry && host && isSshHostRecord(host)) {
        set({
          pendingCredentialRetry: {
            hostId: input.hostId,
            source: "sftp",
            authType:
              host.authType === "certificate"
                ? "certificate"
                : host.authType === "privateKey"
                  ? "privateKey"
                  : "password",
            paneId: input.paneId,
            message,
            initialUsername: host.username,
          },
        });
      } else if (host && shouldPromptAwsConfig && isAwsEc2HostRecord(host)) {
        set({
          pendingAwsSftpConfigRetry: {
            hostId: input.hostId,
            paneId: input.paneId,
            message,
            suggestedUsername: host.awsSshUsername?.trim() ?? "",
            suggestedPort: getAwsEc2HostSshPort(host),
          },
        });
      }
      set((state) => {
        const currentPane = getPane(state, input.paneId);
        const diagnostic = resolveAwsSftpFailureDiagnostic({
          host,
          pane: currentPane,
          endpointId: input.endpointId,
          message,
        });
        return {
          sftp: updatePaneState(state, input.paneId, {
            ...currentPane,
            sourceKind: "host",
            endpoint: null,
            connectingHostId: null,
            connectingEndpointId: null,
            connectionProgress: null,
            connectionDiagnostic: diagnostic,
            entries: [],
            isLoading: false,
            errorMessage:
              shouldPromptCredentialRetry || shouldPromptAwsConfig
                ? undefined
                : message,
            warningMessages: [],
          }),
        };
      });
      return false;
    }
  };

  // 터미널 파일 드롭(SFTP 업로드)용 endpoint를 확보한다.
  //  1) 사용자가 이미 SFTP 패널에 같은 호스트를 열어둔 경우 그 연결 재사용
  //  2) 이전에 만든 백그라운드 업로드 endpoint 재사용(유효성 확인 후, 끊겼으면 폐기)
  //  3) 없으면 패널/워크스페이스 전환 없이 새 연결(자격증명은 main 리졸버=keychain/
  //     런타임 시크릿 캐시에 위임 — 없으면 connect가 던지고 호출자가 안내한다)
  const ensureSftpEndpointForHost = async (
    set: StoreSetter,
    get: StoreGetter,
    hostId: string,
    onProgress?: (message: string) => void,
    options: {
      endpointId?: string;
      trustAction?: PendingHostKeyPrompt["action"];
      skipHostTrustPrompt?: boolean;
      forceReconnect?: boolean;
    } = {},
  ): Promise<SftpEndpointSummary> => {
    const state = get();
    // forceReconnect(연결 끊김 자동 복구)면 재사용을 건너뛰고 무조건 새로 맺는다 — 열린
    // pane 엔드포인트나 캐시가 죽은 상태일 수 있기 때문.
    if (!options.forceReconnect) {
      for (const pane of [state.sftp.leftPane, state.sftp.rightPane]) {
        if (
          pane.sourceKind === "host" &&
          pane.endpoint &&
          pane.endpoint.hostId === hostId
        ) {
          return pane.endpoint;
        }
      }

      const cached = state.sftp.terminalUploadEndpoints[hostId];
      if (cached) {
        try {
          await api.sftp.list({ endpointId: cached.id, path: cached.path });
          scheduleTerminalUploadIdleDisconnect(set, hostId);
          return cached;
        } catch {
          clearTerminalUploadIdleTracking(hostId);
          set((current) => {
            const next = { ...current.sftp.terminalUploadEndpoints };
            delete next[hostId];
            return { sftp: { ...current.sftp, terminalUploadEndpoints: next } };
          });
        }
      }
    }

    const endpointId = options.endpointId ?? globalThis.crypto.randomUUID();
    // 연결 단계(SSM 터널/핸드셰이크/SFTP 채널 등)를 호출자에게 흘려 준다.
    const unsubscribeProgress = onProgress
      ? api.sftp.onConnectionProgress((event) => {
          if (event.endpointId === endpointId) {
            onProgress(event.message);
          }
        })
      : null;
    try {
      if (!options.skipHostTrustPrompt && options.trustAction) {
        onProgress?.("SSH 호스트 키를 확인하는 중입니다.");
        const trusted = await ensureTrustedHost(set, {
          hostId,
          endpointId,
          skipProbeIfAlreadyTrusted: true,
          action: options.trustAction,
        });
        if (!trusted) {
          throw new TerminalUploadAwaitingHostTrustError();
        }
      }
      const endpoint = await api.sftp.connect({ hostId, endpointId });
      set((current) => ({
        sftp: {
          ...current.sftp,
          terminalUploadEndpoints: {
            ...current.sftp.terminalUploadEndpoints,
            [hostId]: endpoint,
          },
        },
      }));
      scheduleTerminalUploadIdleDisconnect(set, hostId);
      return endpoint;
    } finally {
      unsubscribeProgress?.();
    }
  };

  const hasActiveTerminalUpload = (hostId: string): boolean => {
    const jobIds = terminalUploadJobIdsByHost.get(hostId);
    if (!jobIds || jobIds.size === 0) {
      return false;
    }
    const activeIds = new Set(
      get()
        .sftp.transfers.filter((job) => ACTIVE_TRANSFER_STATUSES.has(job.status))
        .map((job) => job.id),
    );
    for (const jobId of [...jobIds]) {
      if (!activeIds.has(jobId)) {
        jobIds.delete(jobId);
      }
    }
    return jobIds.size > 0;
  };

  const scheduleTerminalUploadIdleDisconnect = (
    set: StoreSetter,
    hostId: string,
  ): void => {
    const existing = terminalUploadIdleTimers.get(hostId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      terminalUploadIdleTimers.delete(hostId);
      const cached = get().sftp.terminalUploadEndpoints[hostId];
      if (!cached) {
        terminalUploadJobIdsByHost.delete(hostId);
        return;
      }
      if (hasActiveTerminalUpload(hostId)) {
        scheduleTerminalUploadIdleDisconnect(set, hostId);
        return;
      }
      terminalUploadJobIdsByHost.delete(hostId);
      set((current) => {
        const next = { ...current.sftp.terminalUploadEndpoints };
        delete next[hostId];
        return { sftp: { ...current.sftp, terminalUploadEndpoints: next } };
      });
      void api.sftp.disconnect(cached.id).catch(() => undefined);
    }, TERMINAL_UPLOAD_IDLE_TIMEOUT_MS);
    terminalUploadIdleTimers.set(hostId, timer);
  };

  // 터미널 패널에 드롭한 로컬 파일을 호스트의 targetPath(없으면 홈)로 SFTP 업로드한다.
  // SFTP 패널/워크스페이스로 전환하지 않고 전송 잡만 등록한다(충돌은 대화상자 없이 정책 적용).
  const uploadFilesToHostPath = async (
    set: StoreSetter,
    get: StoreGetter,
    input: TerminalUploadInput,
    onProgress?: (message: string) => void,
  ): Promise<TerminalUploadResult> => {
    const host = get().hosts.find((item) => item.id === input.hostId);
    if (
      !host ||
      !(
        isSshHostRecord(host) ||
        isAwsEc2HostRecord(host) ||
        isWarpgateSshHostRecord(host)
      )
    ) {
      return { ok: false, reason: "unsupported" };
    }

    let endpoint: SftpEndpointSummary;
    const endpointId = input.endpointId ?? globalThis.crypto.randomUUID();
    try {
      endpoint = await ensureSftpEndpointForHost(
        set,
        get,
        input.hostId,
        onProgress,
        {
          endpointId,
          skipHostTrustPrompt: input.skipHostTrustPrompt,
          forceReconnect: input.forceReconnect,
          trustAction: input.skipHostTrustPrompt
            ? undefined
            : {
                kind: "terminalUpload",
                hostId: input.hostId,
                endpointId,
                targetPath: input.targetPath,
                localPaths: input.localPaths,
              },
        },
      );
    } catch (error) {
      if (isTerminalUploadAwaitingHostTrustError(error)) {
        return {
          ok: false,
          reason: "awaiting-host-trust",
          message: "호스트 키를 저장하면 업로드를 계속합니다.",
        };
      }
      return {
        ok: false,
        reason: "connect-failed",
        message:
          error instanceof Error ? error.message : "SFTP 연결에 실패했습니다.",
      };
    }

    const usedHomeFallback = !(input.targetPath && input.targetPath.length > 0);
    const targetPath = usedHomeFallback
      ? endpoint.path
      : (input.targetPath as string);

    const { items, warnings } = await resolveLocalTransferItemsFromPaths(
      input.localPaths,
    );
    if (items.length === 0) {
      return {
        ok: false,
        reason: "no-items",
        message: warnings[0] ?? "드롭한 항목 경로를 읽지 못했습니다.",
      };
    }

    const settings = get().settings;
    const conflictPolicy = settings.sftpConflictPolicy ?? "ask";
    const conflictResolution =
      conflictPolicy !== "ask" ? conflictPolicy : "overwrite";

    const transferInput: TransferStartInput = {
      source: { kind: "local", path: "" },
      target: { kind: "remote", endpointId: endpoint.id, path: targetPath },
      items: items.map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        size: item.size,
      })),
      conflictResolution,
      preserveMetadata: {
        mtime: settings.sftpPreserveMtime ?? true,
        permissions: settings.sftpPreservePermissions ?? false,
      },
    };

    const job = await api.sftp.startTransfer(transferInput);
    markTerminalUploadJob(job.id);
    registerTerminalUploadJob(input.hostId, job.id);
    scheduleTerminalUploadIdleDisconnect(set, input.hostId);
    set((state) => ({
      sftp: {
        ...state.sftp,
        transfers: upsertTransferJob(state.sftp.transfers, job),
      },
    }));

    return {
      ok: true,
      job,
      hostLabel: endpoint.title,
      targetPath,
      usedHomeFallback,
      warnings,
    };
  };

  const getHostIdForTerminalUploadJob = (jobId: string): string | null => {
    for (const [hostId, jobIds] of terminalUploadJobIdsByHost) {
      if (jobIds.has(jobId)) {
        return hostId;
      }
    }
    return null;
  };

  // connection_lost로 죽은 터미널 업로드를 자동 복구한다: 죽은 엔드포인트를 무효화하고
  // 실패 항목을 새 엔드포인트(새 SSM 세션)로 재업로드한다. 재수립된 재시도는
  // markAutoRecoveredTransferJob으로 표식해 한 번만 재시도(무한 루프 방지).
  const recoverTerminalUploadTransfer = async (
    set: StoreSetter,
    get: StoreGetter,
    job: TransferJob,
  ): Promise<void> => {
    const hostId = getHostIdForTerminalUploadJob(job.id);
    if (!hostId) {
      return;
    }
    const request = job.request;
    const remoteTarget = request?.target.kind === "remote" ? request.target : null;
    const deadEndpointId = remoteTarget?.endpointId ?? null;
    const failedLocalPaths = (job.failedItems ?? [])
      .map((failed) => failed.item.path)
      .filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
    // 재시도 여부와 무관하게 죽은 엔드포인트는 먼저 정리한다 — 남겨 두면 다음 드래그
    // 업로드가 그 캐시를 한 번 찔러 보고 실패한 뒤에야 재수립한다.
    clearTerminalUploadIdleTracking(hostId);
    set((current) => {
      const next = { ...current.sftp.terminalUploadEndpoints };
      delete next[hostId];
      return { sftp: { ...current.sftp, terminalUploadEndpoints: next } };
    });
    if (deadEndpointId) {
      void api.sftp.disconnect(deadEndpointId).catch(() => undefined);
    }

    // 원래 업로드 대상을 모르면 재시도하지 않는다 — targetPath 가 null 이면
    // uploadFilesToHostPath 가 홈 디렉터리로 폴백해 엉뚱한 곳에 올리고 성공으로 보고한다.
    if (!remoteTarget || failedLocalPaths.length === 0) {
      return;
    }
    const targetPath = remoteTarget.path;

    const result = await uploadFilesToHostPath(set, get, {
      hostId,
      targetPath,
      localPaths: failedLocalPaths,
      skipHostTrustPrompt: true,
      forceReconnect: true,
    });
    if (result.ok) {
      markAutoRecoveredTransferJob(result.job.id);
    }
  };

  return {
    loadPaneListing,
    setSftpPaneWarnings,
    setSftpPaneConnectionProgress,
    startSftpTransferForItems,
    resolveLocalTransferItemsFromPaths,
    connectTrustedHostPane,
    ensureSftpEndpointForHost,
    uploadFilesToHostPath,
    recoverTerminalUploadTransfer,
    refreshHostAndKeychainState,
    promptForMissingUsername,
    ensureTrustedHost,
  };
}
