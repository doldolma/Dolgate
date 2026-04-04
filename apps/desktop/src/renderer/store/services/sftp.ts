import type {
  DirectoryListing,
  FileEntry,
  HostSecretInput,
  SftpPaneId,
  TransferStartInput,
} from "@shared";
import type { SftpPaneState } from "../types";
import type { SliceDeps } from "./context";
import { createBootstrapSyncServices } from "./bootstrap-sync";
import { createSessionServices } from "./session";
import { createTrustAuthServices } from "./trust-auth";
import {
  basenameFromPath,
  getAwsEc2HostSshPort,
  getPane,
  hasProvidedSecrets,
  isAwsEc2HostRecord,
  pushHistory,
  resolveCredentialRetryKind,
  shouldPromptAwsSftpConfigRetry,
  updatePaneState,
  upsertTransferJob,
} from "../utils";

type StoreSetter = SliceDeps["set"];
type StoreGetter = SliceDeps["get"];

export { upsertTransferJob } from "../utils";

export function createSftpServices(deps: SliceDeps) {
  const { api } = deps;
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

    const transferInput: TransferStartInput = {
      source,
      target,
      items: input.items.map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        size: item.size,
      })),
      conflictResolution: conflicts.length > 0 ? "skip" : "overwrite",
    };

    if (conflicts.length > 0) {
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
      new Set(paths.map((targetPath) => targetPath.trim()).filter(Boolean)),
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
      const matched = listing.entries.find(
        (entry) => entry.path === targetPath,
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
  ) => {
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
    } catch (error) {
      const host = get().hosts.find((item) => item.id === input.hostId);
      const message =
        error instanceof Error ? error.message : "SFTP 연결에 실패했습니다.";
      const credentialKind = resolveCredentialRetryKind(host, message);
      const shouldPromptAwsConfig = shouldPromptAwsSftpConfigRetry(host, message);
      if (credentialKind) {
        set({
          pendingCredentialRetry: {
            hostId: input.hostId,
            source: "sftp",
            credentialKind,
            paneId: input.paneId,
            message,
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
      set((state) => ({
        sftp: updatePaneState(state, input.paneId, {
          ...getPane(state, input.paneId),
          sourceKind: "host",
          endpoint: null,
          connectingHostId: null,
          connectingEndpointId: null,
          connectionProgress: null,
          entries: [],
          isLoading: false,
          errorMessage:
            credentialKind || shouldPromptAwsConfig ? undefined : message,
          warningMessages: [],
        }),
      }));
    }
  };

  return {
    loadPaneListing,
    setSftpPaneWarnings,
    setSftpPaneConnectionProgress,
    startSftpTransferForItems,
    resolveLocalTransferItemsFromPaths,
    connectTrustedHostPane,
    refreshHostAndKeychainState,
    promptForMissingUsername,
    ensureTrustedHost,
  };
}
