import {
  inferAwsSftpDiagnosticReasonCode,
  isAwsEc2HostRecord,
} from "@shared";
import type {
  HostRecord,
  SftpConnectionProgressEvent,
} from "@shared";
import type {
  AppState,
  SftpEntrySelectionInput,
  SftpPaneState,
  SftpState,
} from "../types";

export function resolveSftpPaneIdByEndpoint(
  state: Pick<AppState, "sftp">,
  endpointId: string,
): "left" | "right" | null {
  if (
    state.sftp.leftPane.endpoint?.id === endpointId ||
    state.sftp.leftPane.connectingEndpointId === endpointId
  ) {
    return "left";
  }
  if (
    state.sftp.rightPane.endpoint?.id === endpointId ||
    state.sftp.rightPane.connectingEndpointId === endpointId
  ) {
    return "right";
  }
  return null;
}

export function createEmptyPane(id: "left" | "right"): SftpPaneState {
  return {
    id,
    sourceKind: id === "left" ? "local" : "host",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    connectionProgress: null,
    connectionDiagnostic: null,
    hostGroupPath: null,
    currentPath: "",
    lastLocalPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId: null,
    hostSearchQuery: "",
    isLoading: false,
    warningMessages: [],
  };
}

export function buildSftpHostPickerPane(pane: SftpPaneState): SftpPaneState {
  return {
    ...pane,
    sourceKind: "host",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    connectionProgress: null,
    connectionDiagnostic: null,
    currentPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId:
      pane.endpoint?.hostId ?? pane.connectingHostId ?? pane.selectedHostId,
    isLoading: false,
    errorMessage: undefined,
    warningMessages: [],
  };
}

export function resolveSftpVisibleEntryPaths(
  pane: SftpPaneState,
  provided?: string[],
): string[] {
  if (provided && provided.length > 0) {
    const available = new Set(pane.entries.map((entry) => entry.path));
    return provided.filter((entryPath) => available.has(entryPath));
  }
  return pane.entries
    .filter((entry) => {
      if (!pane.filterQuery.trim()) {
        return true;
      }
      return entry.name
        .toLowerCase()
        .includes(pane.filterQuery.trim().toLowerCase());
    })
    .map((entry) => entry.path);
}

export function resolveNextSftpSelection(
  pane: SftpPaneState,
  input: SftpEntrySelectionInput,
): Pick<SftpPaneState, "selectedPaths" | "selectionAnchorPath"> {
  if (!input.entryPath) {
    return {
      selectedPaths: [],
      selectionAnchorPath: null,
    };
  }

  const entryExists = pane.entries.some(
    (entry) => entry.path === input.entryPath,
  );
  if (!entryExists) {
    return {
      selectedPaths: pane.selectedPaths,
      selectionAnchorPath: pane.selectionAnchorPath,
    };
  }

  if (input.range) {
    const visiblePaths = resolveSftpVisibleEntryPaths(
      pane,
      input.visibleEntryPaths,
    );
    const anchorPath =
      pane.selectionAnchorPath &&
      visiblePaths.includes(pane.selectionAnchorPath)
        ? pane.selectionAnchorPath
        : null;
    const targetIndex = visiblePaths.indexOf(input.entryPath);
    if (!anchorPath || targetIndex < 0) {
      return {
        selectedPaths: [input.entryPath],
        selectionAnchorPath: input.entryPath,
      };
    }
    const anchorIndex = visiblePaths.indexOf(anchorPath);
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return {
      selectedPaths: visiblePaths.slice(start, end + 1),
      selectionAnchorPath: anchorPath,
    };
  }

  if (input.toggle) {
    const nextSelected = pane.selectedPaths.includes(input.entryPath)
      ? pane.selectedPaths.filter((entryPath) => entryPath !== input.entryPath)
      : [...pane.selectedPaths, input.entryPath];
    return {
      selectedPaths: nextSelected,
      selectionAnchorPath: input.entryPath,
    };
  }

  return {
    selectedPaths: [input.entryPath],
    selectionAnchorPath: input.entryPath,
  };
}

export function getPane(
  state: Pick<AppState, "sftp">,
  paneId: "left" | "right",
): SftpPaneState {
  return paneId === "left" ? state.sftp.leftPane : state.sftp.rightPane;
}

export function updatePaneState(
  state: Pick<AppState, "sftp">,
  paneId: "left" | "right",
  nextPane: SftpPaneState,
): SftpState {
  return {
    ...state.sftp,
    leftPane: paneId === "left" ? nextPane : state.sftp.leftPane,
    rightPane: paneId === "right" ? nextPane : state.sftp.rightPane,
  };
}

export function setPaneConnectionProgress(
  state: Pick<AppState, "sftp">,
  paneId: "left" | "right",
  progress: SftpConnectionProgressEvent | null,
): SftpState {
  return updatePaneState(state, paneId, {
    ...getPane(state, paneId),
    connectionProgress: progress,
    connectionDiagnostic: progress?.reasonCode
      ? progress
      : getPane(state, paneId).connectionDiagnostic,
  });
}

export function resolveAwsSftpFailureDiagnostic(input: {
  host: HostRecord | undefined;
  pane: SftpPaneState;
  endpointId?: string | null;
  message: string;
}): SftpConnectionProgressEvent | null {
  if (!input.host || !isAwsEc2HostRecord(input.host)) {
    return null;
  }
  const progress = input.pane.connectionProgress;
  const stage = progress?.stage ?? "connecting-sftp";
  const message = progress?.reasonCode ? progress.message : input.message;
  const reasonCode =
    progress?.reasonCode ??
    inferAwsSftpDiagnosticReasonCode(stage, input.message);
  return {
    endpointId:
      progress?.endpointId ??
      input.endpointId ??
      input.pane.connectingEndpointId ??
      input.pane.endpoint?.id ??
      "",
    hostId: input.host.id,
    stage,
    message,
    reasonCode,
    diagnosticId:
      progress?.diagnosticId ??
      `aws-sftp-renderer-${Date.now().toString(36)}`,
    details: progress?.details,
  };
}
