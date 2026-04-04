import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  buildVisibleGroups,
  filterHostsInGroupTree,
  getAwsEc2HostSftpDisabledReason,
  getAwsEc2HostSshMetadataStatusLabel,
  getHostBadgeLabel,
  getHostSearchText,
  getHostSubtitle,
  isAwsEc2HostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  MIN_SFTP_BROWSER_COLUMN_WIDTHS,
  normalizeSftpBrowserColumnWidths,
  normalizeGroupPath,
} from "@shared";
import type {
  AppSettings,
  FileEntry,
  GroupRecord,
  HostRecord,
  SftpBrowserColumnKey,
  SftpBrowserColumnWidths,
  SftpPaneId,
  TransferJob,
} from "@shared";
import type {
  PendingConflictDialog,
  PendingSftpInteractiveAuth,
  SftpEntrySelectionInput,
  SftpPaneState,
  SftpSourceKind,
  SftpState,
} from "../store/createAppStore";
import { formatConnectionProgressStageLabel } from "../lib/connection-progress";
import { useResponsiveCardGrid } from "../lib/useResponsiveCardGrid";
import { DialogBackdrop } from "./DialogBackdrop";
import {
  Button,
  EmptyState,
  IconButton,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
  StatusBadge,
  TabButton,
  Tabs,
} from "../ui";

const SFTP_HOST_PICKER_GROUP_CARD_MIN_WIDTH_PX = 220;
const SFTP_HOST_PICKER_GROUP_CARD_MAX_WIDTH_PX = 280;
const SFTP_HOST_PICKER_HOST_CARD_MIN_WIDTH_PX = 220;
const SFTP_HOST_PICKER_HOST_CARD_MAX_WIDTH_PX = 460;
const SFTP_HOST_PICKER_CARD_GAP_PX = 12;

interface SftpWorkspaceProps {
  hosts: HostRecord[];
  groups: GroupRecord[];
  sftp: SftpState;
  settings: AppSettings;
  interactiveAuth: PendingSftpInteractiveAuth | null;
  onActivatePaneSource: (
    paneId: SftpPaneId,
    sourceKind: SftpSourceKind,
  ) => Promise<void>;
  onDisconnectPane: (paneId: SftpPaneId) => Promise<void>;
  onPaneFilterChange: (paneId: SftpPaneId, query: string) => void;
  onHostSearchChange: (paneId: SftpPaneId, query: string) => void;
  onNavigateHostGroup: (paneId: SftpPaneId, path: string | null) => void;
  onSelectHost: (paneId: SftpPaneId, hostId: string) => void;
  onConnectHost: (paneId: SftpPaneId, hostId: string) => Promise<void>;
  onOpenHostSettings?: (hostId: string) => void;
  onOpenEntry: (paneId: SftpPaneId, entryPath: string) => Promise<void>;
  onRefreshPane: (paneId: SftpPaneId) => Promise<void>;
  onNavigateBack: (paneId: SftpPaneId) => Promise<void>;
  onNavigateForward: (paneId: SftpPaneId) => Promise<void>;
  onNavigateParent: (paneId: SftpPaneId) => Promise<void>;
  onNavigateBreadcrumb: (paneId: SftpPaneId, nextPath: string) => Promise<void>;
  onSelectEntry: (paneId: SftpPaneId, input: SftpEntrySelectionInput) => void;
  onCreateDirectory: (paneId: SftpPaneId, name: string) => Promise<void>;
  onRenameSelection: (paneId: SftpPaneId, nextName: string) => Promise<void>;
  onChangeSelectionPermissions: (
    paneId: SftpPaneId,
    mode: number,
  ) => Promise<void>;
  onDeleteSelection: (paneId: SftpPaneId) => Promise<void>;
  onDownloadSelection: (paneId: SftpPaneId) => Promise<void>;
  onPrepareTransfer: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
    targetPath: string,
    draggedPath?: string | null,
  ) => Promise<void>;
  onPrepareExternalTransfer: (
    targetPaneId: SftpPaneId,
    targetPath: string,
    droppedPaths: string[],
  ) => Promise<void>;
  onTransferSelectionToPane: (
    sourcePaneId: SftpPaneId,
    targetPaneId: SftpPaneId,
  ) => Promise<void>;
  onResolveConflict: (
    resolution: "overwrite" | "skip" | "keepBoth",
  ) => Promise<void>;
  onDismissConflict: () => void;
  onCancelTransfer: (jobId: string) => Promise<void>;
  onRetryTransfer: (jobId: string) => Promise<void>;
  onDismissTransfer: (jobId: string) => void;
  onRespondInteractiveAuth: (
    challengeId: string,
    responses: string[],
  ) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void>;
  onClearInteractiveAuth: () => void;
  onUpdateSettings: (input: Partial<AppSettings>) => Promise<void>;
}

type SftpConnectableHostRecord = Extract<
  HostRecord,
  { kind: "ssh" | "warpgate-ssh" | "aws-ec2" }
>;

type ActionDialogState =
  | {
      paneId: SftpPaneId;
      mode: "mkdir";
      title: string;
      placeholder: string;
      submitLabel: string;
      value: string;
      isSubmitting: boolean;
    }
  | {
      paneId: SftpPaneId;
      mode: "rename";
      title: string;
      placeholder: string;
      submitLabel: string;
      value: string;
      isSubmitting: boolean;
    };

type PermissionSection = "owner" | "group" | "other";
type PermissionKey = "read" | "write" | "execute";

export interface PermissionMatrixState {
  owner: Record<PermissionKey, boolean>;
  group: Record<PermissionKey, boolean>;
  other: Record<PermissionKey, boolean>;
}

interface PermissionDialogState {
  paneId: SftpPaneId;
  path: string;
  name: string;
  matrix: PermissionMatrixState;
  isSubmitting: boolean;
}

interface ContextMenuState {
  paneId: SftpPaneId;
  entryPath: string;
  x: number;
  y: number;
}

interface DeleteDialogState {
  paneId: SftpPaneId;
  itemCount: number;
  primaryLabel: string | null;
  includesDirectory: boolean;
  errorMessage: string | null;
  isSubmitting: boolean;
}

export function groupHosts(
  hosts: SftpConnectableHostRecord[],
): Array<[string, SftpConnectableHostRecord[]]> {
  const grouped = new Map<string, SftpConnectableHostRecord[]>();
  for (const host of hosts) {
    const key = host.groupName || "Ungrouped";
    const bucket = grouped.get(key) ?? [];
    bucket.push(host);
    grouped.set(key, bucket);
  }
  return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));
}

export function hostPickerBreadcrumbs(
  groupPath: string | null,
): Array<{ label: string; path: string | null }> {
  const normalizedPath = normalizeGroupPath(groupPath);
  if (!normalizedPath) {
    return [{ label: "Hosts", path: null }];
  }
  const segments = normalizedPath.split("/");
  return [
    { label: "Hosts", path: null },
    ...segments.map((segment, index) => ({
      label: segment,
      path: segments.slice(0, index + 1).join("/"),
    })),
  ];
}

export function visibleHostPickerHosts(
  hosts: SftpConnectableHostRecord[],
  groupPath: string | null,
  query: string,
): SftpConnectableHostRecord[] {
  const scopedHosts = filterHostsInGroupTree(hosts, groupPath);
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    return scopedHosts.filter((host) =>
      getHostSearchText(host).join(" ").toLowerCase().includes(normalizedQuery),
    );
  }
  return scopedHosts;
}

export function getSftpHostPickerDisabledReason(
  host: SftpConnectableHostRecord,
): string | null {
  if (isAwsEc2HostRecord(host)) {
    return getAwsEc2HostSftpDisabledReason(host);
  }
  return null;
}

function fallbackEntryLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function buildDeleteDialogState(pane: SftpPaneState): DeleteDialogState | null {
  if (pane.selectedPaths.length === 0) {
    return null;
  }

  const selectedEntries = pane.selectedPaths.map((selectedPath) => {
    const existingEntry = pane.entries.find(
      (entry) => entry.path === selectedPath,
    );
    if (existingEntry) {
      return existingEntry;
    }
    return {
      name: fallbackEntryLabel(selectedPath),
      path: selectedPath,
      isDirectory: false,
      size: 0,
      mtime: "",
      kind: "unknown" as const,
      permissions: undefined,
    };
  });

  return {
    paneId: pane.id,
    itemCount: selectedEntries.length,
    primaryLabel:
      selectedEntries.length === 1 ? (selectedEntries[0]?.name ?? null) : null,
    includesDirectory: selectedEntries.some((entry) => entry.isDirectory),
    errorMessage: null,
    isSubmitting: false,
  };
}

export function getSftpPaneTitle(
  pane: Pick<SftpPaneState, "sourceKind" | "endpoint">,
): string {
  return pane.sourceKind === "local"
    ? "Local"
    : (pane.endpoint?.title ?? "Host");
}

export function visibleEntries(pane: SftpPaneState): FileEntry[] {
  if (!pane.filterQuery.trim()) {
    return pane.entries;
  }
  const query = pane.filterQuery.trim().toLowerCase();
  return pane.entries.filter((entry) =>
    entry.name.toLowerCase().includes(query),
  );
}

export function breadcrumbParts(
  targetPath: string,
): Array<{ label: string; path: string }> {
  if (!targetPath || targetPath === "/") {
    return [{ label: "/", path: "/" }];
  }
  const parts = targetPath.split("/").filter(Boolean);
  const result: Array<{ label: string; path: string }> = [
    { label: "/", path: "/" },
  ];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push({
      label: part,
      path: current,
    });
  }
  return result;
}

function normalizePermissionString(value?: string | null): string {
  const normalized = (value ?? "---------").trim();
  if (normalized.length >= 9) {
    return normalized.slice(-9);
  }
  return normalized.padEnd(9, "-").slice(0, 9);
}

export function permissionMatrixFromString(
  value?: string | null,
): PermissionMatrixState {
  const normalized = normalizePermissionString(value);
  return {
    owner: {
      read: normalized[0] === "r",
      write: normalized[1] === "w",
      execute: normalized[2] === "x",
    },
    group: {
      read: normalized[3] === "r",
      write: normalized[4] === "w",
      execute: normalized[5] === "x",
    },
    other: {
      read: normalized[6] === "r",
      write: normalized[7] === "w",
      execute: normalized[8] === "x",
    },
  };
}

export function permissionMatrixToMode(matrix: PermissionMatrixState): number {
  const sections: PermissionSection[] = ["owner", "group", "other"];
  return sections.reduce((mode, section, index) => {
    const value =
      (matrix[section].read ? 4 : 0) +
      (matrix[section].write ? 2 : 0) +
      (matrix[section].execute ? 1 : 0);
    return mode | (value << ((2 - index) * 3));
  }, 0);
}

function formatPermissionMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function formatSize(size: number): string {
  if (!size) {
    return "--";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatTransferSpeed(
  bytesPerSecond?: number | null,
): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return null;
  }
  return `${formatSize(bytesPerSecond)}/s`;
}

export function formatEta(seconds?: number | null): string | null {
  if (!seconds || seconds <= 0) {
    return null;
  }
  if (seconds < 60) {
    return `남은 시간 ${seconds}초`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder > 0
      ? `남은 시간 ${minutes}분 ${remainder}초`
      : `남은 시간 ${minutes}분`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0
    ? `남은 시간 ${hours}시간 ${minuteRemainder}분`
    : `남은 시간 ${hours}시간`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function buildTransferDirection(job: TransferJob): string {
  return `${job.sourceLabel} -> ${job.targetLabel}`;
}

export function buildTransferCardTitle(job: TransferJob): string {
  const firstRequestedItemName = job.request?.items[0]?.name?.trim();
  if (firstRequestedItemName) {
    if (job.itemCount > 1) {
      return `${firstRequestedItemName} 외 ${job.itemCount - 1}개`;
    }
    return firstRequestedItemName;
  }

  if (job.activeItemName) {
    return job.activeItemName;
  }

  return buildTransferDirection(job);
}

function isBrowsablePane(pane: SftpPaneState): boolean {
  return (
    pane.sourceKind === "local" ||
    (Boolean(pane.endpoint) && !pane.connectingHostId)
  );
}

export function canTransferBetweenSftpPanes(
  leftPane: SftpPaneState,
  rightPane: SftpPaneState,
): boolean {
  return isBrowsablePane(leftPane) && isBrowsablePane(rightPane);
}

export function isSftpTransferArrowDisabled(
  sourcePane: SftpPaneState,
  targetPane: SftpPaneState,
): boolean {
  return (
    !canTransferBetweenSftpPanes(sourcePane, targetPane) ||
    sourcePane.selectedPaths.length === 0
  );
}

function extractDroppedAbsolutePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => (file as File & { path?: string }).path)
    .filter((value): value is string => Boolean(value));
}

interface InternalTransferPayload {
  sourcePaneId: SftpPaneId;
  draggedPath: string;
}

export function encodeInternalTransferPayload(
  payload: InternalTransferPayload,
): string {
  return `dolssh-transfer:${JSON.stringify(payload)}`;
}

export function parseInternalTransferPayload(
  dataTransfer: Pick<DataTransfer, "getData">,
): InternalTransferPayload | null {
  const directPayload = dataTransfer.getData("application/x-dolssh-transfer");
  if (directPayload) {
    try {
      return JSON.parse(directPayload) as InternalTransferPayload;
    } catch {
      return null;
    }
  }

  const textPayload = dataTransfer.getData("text/plain");
  if (!textPayload.startsWith("dolssh-transfer:")) {
    return null;
  }
  try {
    return JSON.parse(
      textPayload.slice("dolssh-transfer:".length),
    ) as InternalTransferPayload;
  } catch {
    return null;
  }
}

export function hasInternalTransferData(
  dataTransfer: Pick<DataTransfer, "types">,
): boolean {
  const types = Array.from(dataTransfer.types ?? []);
  return (
    types.includes("application/x-dolssh-transfer") ||
    types.includes("text/plain")
  );
}

const SFTP_BROWSER_COLUMNS: Array<{
  key: SftpBrowserColumnKey;
  label: string;
}> = [
  { key: "name", label: "Name" },
  { key: "dateModified", label: "Date Modified" },
  { key: "size", label: "Size" },
  { key: "kind", label: "Kind" },
];

function areSftpBrowserColumnWidthsEqual(
  left: SftpBrowserColumnWidths,
  right: SftpBrowserColumnWidths,
): boolean {
  return SFTP_BROWSER_COLUMNS.every(
    (column) => left[column.key] === right[column.key],
  );
}

const SFTP_BROWSER_RESIZE_BODY_CLASS = "sftp-column-resizing";

interface ColumnResizeState {
  key: SftpBrowserColumnKey;
  startClientX: number;
  startWidth: number;
  originalWidths: SftpBrowserColumnWidths;
}

interface PaneBrowserProps {
  pane: SftpPaneState;
  columnWidths: SftpBrowserColumnWidths;
  resizingColumnKey: SftpBrowserColumnKey | null;
  onStartColumnResize: (
    columnKey: SftpBrowserColumnKey,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  onActivatePaneSource: (sourceKind: SftpSourceKind) => Promise<void>;
  onFilterChange: (query: string) => void;
  onNavigateBack: () => Promise<void>;
  onNavigateForward: () => Promise<void>;
  onNavigateParent: () => Promise<void>;
  onNavigateBreadcrumb: (nextPath: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectEntry: (input: SftpEntrySelectionInput) => void;
  onOpenEntry: (entryPath: string) => Promise<void>;
  onOpenCreateDirectoryDialog: () => void;
  onOpenRenameDialog: () => void;
  onOpenPermissionsDialog: () => void;
  onDeleteSelection: () => void;
  onDownloadSelection: () => Promise<void>;
  onPrepareTransfer: (
    sourcePaneId: SftpPaneId,
    targetPath: string,
    draggedPath?: string | null,
  ) => Promise<void>;
  onPrepareExternalTransfer: (
    targetPath: string,
    droppedPaths: string[],
  ) => Promise<void>;
}

function PaneBrowser({
  pane,
  columnWidths,
  resizingColumnKey,
  onStartColumnResize,
  onActivatePaneSource,
  onFilterChange,
  onNavigateBack,
  onNavigateForward,
  onNavigateParent,
  onNavigateBreadcrumb,
  onRefresh,
  onSelectEntry,
  onOpenEntry,
  onOpenCreateDirectoryDialog,
  onOpenRenameDialog,
  onOpenPermissionsDialog,
  onDeleteSelection,
  onDownloadSelection,
  onPrepareTransfer,
  onPrepareExternalTransfer,
}: PaneBrowserProps) {
  const entries = useMemo(() => visibleEntries(pane), [pane]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const tableStyle = useMemo<CSSProperties>(
    () => ({
      width: `${Object.values(columnWidths).reduce((total, width) => total + width, 0)}px`,
      minWidth: "100%",
    }),
    [columnWidths],
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const selectedEntry =
    pane.selectedPaths.length === 1
      ? (pane.entries.find((entry) => entry.path === pane.selectedPaths[0]) ??
        null)
      : null;
  const canDownloadSelection =
    pane.sourceKind === "host" &&
    Boolean(pane.endpoint) &&
    Boolean(selectedEntry) &&
    !selectedEntry?.isDirectory;
  const contextMenuStyle = contextMenu
    ? {
        left: `${Math.max(12, Math.min(contextMenu.x, window.innerWidth - 196))}px`,
        top: `${Math.max(12, Math.min(contextMenu.y, window.innerHeight - 220))}px`,
      }
    : null;

  const handleInternalDrop = (event: DragEvent, targetPath: string) => {
    const parsed = parseInternalTransferPayload(event.dataTransfer);
    if (!parsed) {
      return false;
    }
    if (parsed.sourcePaneId === pane.id && targetPath === pane.currentPath) {
      return false;
    }
    void onPrepareTransfer(parsed.sourcePaneId, targetPath, parsed.draggedPath);
    return true;
  };

  const handleExternalDrop = (event: DragEvent, targetPath: string) => {
    if (pane.sourceKind !== "host" || !pane.endpoint) {
      return false;
    }
    const droppedPaths = extractDroppedAbsolutePaths(event.dataTransfer);
    void onPrepareExternalTransfer(targetPath, droppedPaths);
    return true;
  };

  return (
    <div className="sftp-pane__content sftp-pane__content--browser">
      <div className="sftp-pane__toolbar">
        <Tabs className="sftp-source-toggle" role="tablist" aria-label="SFTP source kind">
          <TabButton active={pane.sourceKind === "local"} role="tab" aria-selected={pane.sourceKind === "local"} onClick={() => void onActivatePaneSource("local")}>
            Local
          </TabButton>
          <TabButton active={pane.sourceKind === "host"} role="tab" aria-selected={pane.sourceKind === "host"} onClick={() => void onActivatePaneSource("host")}>
            Host
          </TabButton>
        </Tabs>
        <div className="sftp-pane__toolbar-actions">
          <IconButton
            size="sm"
            className="sftp-mini-button"
            onClick={() => void onNavigateBack()}
            disabled={pane.historyIndex <= 0}
          >
            ←
          </IconButton>
          <IconButton
            size="sm"
            className="sftp-mini-button"
            onClick={() => void onNavigateForward()}
            disabled={pane.historyIndex >= pane.history.length - 1}
          >
            →
          </IconButton>
          <IconButton
            size="sm"
            className="sftp-mini-button"
            onClick={() => void onNavigateParent()}
          >
            ↑
          </IconButton>
          <Button
            variant="secondary"
            size="sm"
            className="sftp-action-button"
            onClick={onOpenCreateDirectoryDialog}
            disabled={pane.isLoading}
          >
            새 폴더
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="sftp-action-button"
            onClick={() => void onRefresh()}
            disabled={pane.isLoading}
          >
            {pane.isLoading ? "새로고침 중..." : "새로고침"}
          </Button>
        </div>
      </div>

      <div className="sftp-breadcrumbs">
        {breadcrumbParts(pane.currentPath).map((part) => (
          <button
            key={part.path}
            type="button"
            className="sftp-breadcrumb"
            onClick={() => void onNavigateBreadcrumb(part.path)}
          >
            {part.label}
          </button>
        ))}
      </div>

      <div className="sftp-filter-row">
        <input
          value={pane.filterQuery}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="Filter"
          aria-label="Filter files"
        />
      </div>

      {pane.warningMessages && pane.warningMessages.length > 0 ? (
        <div className="sftp-pane__warnings">
          {pane.warningMessages.map((warning) => (
            <div key={warning} className="terminal-warning-banner">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {pane.errorMessage ? (
        <div className="terminal-error-banner">{pane.errorMessage}</div>
      ) : null}

      <div
        className={`sftp-table-shell ${pane.isLoading ? "loading" : ""} ${isDropTargetActive ? "drop-target" : ""}`}
        data-pane-id={pane.id}
        aria-label={`SFTP browser ${pane.id}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onSelectEntry({ entryPath: null });
          }
        }}
        onDragOver={(event) => {
          const hasInternal = hasInternalTransferData(event.dataTransfer);
          const hasExternalFiles =
            event.dataTransfer.files.length > 0 &&
            pane.sourceKind === "host" &&
            Boolean(pane.endpoint);
          if (!hasInternal && !hasExternalFiles) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setIsDropTargetActive(true);
        }}
        onDragLeave={(event) => {
          if (
            event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            return;
          }
          setIsDropTargetActive(false);
        }}
        onDrop={(event) => {
          setIsDropTargetActive(false);
          const hasInternal = handleInternalDrop(event, pane.currentPath);
          if (!hasInternal) {
            const handledExternal = handleExternalDrop(event, pane.currentPath);
            if (!handledExternal) {
              return;
            }
          }
          event.preventDefault();
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            onSelectEntry({ entryPath: null });
            setContextMenu(null);
          }
        }}
      >
        <table className="sftp-table" style={tableStyle}>
          <colgroup>
            {SFTP_BROWSER_COLUMNS.map((column) => (
              <col
                key={column.key}
                data-column-key={column.key}
                style={{ width: `${columnWidths[column.key]}px` }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {SFTP_BROWSER_COLUMNS.map((column) => (
                <th key={column.key}>
                  <div className="sftp-table__header-cell">
                    <span
                      className="sftp-table__header-label"
                      title={column.label}
                    >
                      {column.label}
                    </span>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label} column`}
                      className={`sftp-column-resize-handle ${resizingColumnKey === column.key ? "active" : ""}`}
                      onMouseDown={(event) =>
                        onStartColumnResize(column.key, event)
                      }
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.path}
                className={
                  pane.selectedPaths.includes(entry.path) ? "selected" : ""
                }
                draggable
                onDragStart={(event) => {
                  const payload = JSON.stringify({
                    sourcePaneId: pane.id,
                    draggedPath: entry.path,
                  });
                  event.dataTransfer.setData(
                    "application/x-dolssh-transfer",
                    payload,
                  );
                  event.dataTransfer.setData(
                    "text/plain",
                    encodeInternalTransferPayload({
                      sourcePaneId: pane.id,
                      draggedPath: entry.path,
                    }),
                  );
                  event.dataTransfer.effectAllowed = "copyMove";
                }}
                onClick={(event) =>
                  onSelectEntry({
                    entryPath: entry.path,
                    visibleEntryPaths: entries.map((item) => item.path),
                    toggle: event.metaKey || event.ctrlKey,
                    range: event.shiftKey,
                  })
                }
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!pane.selectedPaths.includes(entry.path)) {
                    onSelectEntry({
                      entryPath: entry.path,
                      visibleEntryPaths: entries.map((item) => item.path),
                    });
                  }
                  setContextMenu({
                    paneId: pane.id,
                    entryPath: entry.path,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onDoubleClick={() => void onOpenEntry(entry.path)}
                onDragOver={(event) => {
                  const hasInternal = hasInternalTransferData(
                    event.dataTransfer,
                  );
                  const hasExternalFiles =
                    event.dataTransfer.files.length > 0 &&
                    pane.sourceKind === "host" &&
                    Boolean(pane.endpoint);
                  if (
                    !entry.isDirectory ||
                    (!hasInternal && !hasExternalFiles)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setIsDropTargetActive(true);
                }}
                onDrop={(event) => {
                  setIsDropTargetActive(false);
                  if (!entry.isDirectory) {
                    return;
                  }
                  const hasInternal = handleInternalDrop(event, entry.path);
                  if (!hasInternal) {
                    const handledExternal = handleExternalDrop(
                      event,
                      entry.path,
                    );
                    if (!handledExternal) {
                      return;
                    }
                  }
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <td title={entry.name}>
                  <div className="sftp-entry-name">
                    <span
                      className={`sftp-entry-icon ${entry.isDirectory ? "directory" : "file"}`}
                    >
                      {entry.isDirectory ? "D" : "F"}
                    </span>
                    <span className="sftp-entry-label">{entry.name}</span>
                  </div>
                </td>
                <td title={formatDate(entry.mtime)}>
                  {formatDate(entry.mtime)}
                </td>
                <td title={entry.isDirectory ? "--" : formatSize(entry.size)}>
                  {entry.isDirectory ? "--" : formatSize(entry.size)}
                </td>
                <td title={entry.kind}>{entry.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pane.isLoading ? (
          <div className="sftp-loading-indicator">목록을 새로 읽는 중...</div>
        ) : null}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="context-menu"
              style={contextMenuStyle ?? undefined}
              role="menu"
            >
              <button
                type="button"
                className="context-menu__item"
                disabled={pane.selectedPaths.length !== 1}
                onClick={() => {
                  setContextMenu(null);
                  onOpenRenameDialog();
                }}
              >
                이름 변경
              </button>
              <button
                type="button"
                className="context-menu__item"
                disabled={pane.selectedPaths.length !== 1}
                onClick={() => {
                  setContextMenu(null);
                  onOpenPermissionsDialog();
                }}
              >
                권한 수정
              </button>
              <button
                type="button"
                className="context-menu__item"
                disabled={!canDownloadSelection}
                onClick={() => {
                  setContextMenu(null);
                  void onDownloadSelection();
                }}
              >
                다운로드
              </button>
              <button
                type="button"
                className="context-menu__item context-menu__item--danger"
                disabled={pane.selectedPaths.length === 0}
                onClick={() => {
                  setContextMenu(null);
                  onDeleteSelection();
                }}
              >
                삭제
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface HostPickerProps {
  pane: SftpPaneState;
  groups: GroupRecord[];
  hosts: SftpConnectableHostRecord[];
  interactiveAuth: PendingSftpInteractiveAuth | null;
  onActivatePaneSource: (sourceKind: SftpSourceKind) => Promise<void>;
  onHostSearchChange: (query: string) => void;
  onNavigateHostGroup: (path: string | null) => void;
  onSelectHost: (hostId: string) => void;
  onConnectHost: (hostId: string) => Promise<void>;
  onOpenHostSettings?: (hostId: string) => void;
  onRespondInteractiveAuth: (
    challengeId: string,
    responses: string[],
  ) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void>;
  onClearInteractiveAuth: () => void;
}

function HostPicker({
  pane,
  groups,
  hosts,
  interactiveAuth,
  onActivatePaneSource,
  onHostSearchChange,
  onNavigateHostGroup,
  onSelectHost,
  onConnectHost,
  onOpenHostSettings,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearInteractiveAuth,
}: HostPickerProps) {
  const scopedHosts = useMemo(
    () => filterHostsInGroupTree(hosts, pane.hostGroupPath),
    [hosts, pane.hostGroupPath],
  );
  const visibleGroups = useMemo(
    () => buildVisibleGroups(groups, scopedHosts, pane.hostGroupPath),
    [groups, pane.hostGroupPath, scopedHosts],
  );
  const visibleHosts = useMemo(
    () =>
      visibleHostPickerHosts(hosts, pane.hostGroupPath, pane.hostSearchQuery),
    [hosts, pane.hostGroupPath, pane.hostSearchQuery],
  );
  const breadcrumbs = useMemo(
    () => hostPickerBreadcrumbs(pane.hostGroupPath),
    [pane.hostGroupPath],
  );
  const [promptResponses, setPromptResponses] = useState<string[]>([]);
  const [dismissedInteractiveEndpointId, setDismissedInteractiveEndpointId] =
    useState<string | null>(null);
  const isConnecting =
    pane.sourceKind === "host" &&
    Boolean(pane.connectingHostId) &&
    pane.isLoading;
  const activeEndpointId =
    pane.connectingEndpointId ?? pane.endpoint?.id ?? null;
  const matchingInteractiveAuth =
    interactiveAuth &&
    interactiveAuth.paneId === pane.id &&
    interactiveAuth.endpointId === activeEndpointId &&
    interactiveAuth.endpointId !== dismissedInteractiveEndpointId
      ? interactiveAuth
      : null;
  const selectedHostId = pane.connectingHostId ?? pane.selectedHostId;
  const selectedHost = selectedHostId
    ? (hosts.find((host) => host.id === selectedHostId) ?? null)
    : null;
  const isEmpty = visibleGroups.length === 0 && visibleHosts.length === 0;
  const shouldShowConnectingOverlay =
    isConnecting &&
    !matchingInteractiveAuth &&
    pane.connectingEndpointId !== dismissedInteractiveEndpointId;
  const { ref: groupGridRef, style: groupGridStyle } = useResponsiveCardGrid({
    itemCount: visibleGroups.length,
    minWidth: SFTP_HOST_PICKER_GROUP_CARD_MIN_WIDTH_PX,
    maxWidth: SFTP_HOST_PICKER_GROUP_CARD_MAX_WIDTH_PX,
    gap: SFTP_HOST_PICKER_CARD_GAP_PX,
  });
  const { ref: hostGridRef, style: hostGridStyle } = useResponsiveCardGrid({
    itemCount: visibleHosts.length,
    minWidth: SFTP_HOST_PICKER_HOST_CARD_MIN_WIDTH_PX,
    maxWidth: SFTP_HOST_PICKER_HOST_CARD_MAX_WIDTH_PX,
    gap: SFTP_HOST_PICKER_CARD_GAP_PX,
  });

  useEffect(() => {
    setPromptResponses(matchingInteractiveAuth?.prompts.map(() => "") ?? []);
  }, [matchingInteractiveAuth?.challengeId]);

  useEffect(() => {
    if (
      !dismissedInteractiveEndpointId ||
      (isConnecting && activeEndpointId === dismissedInteractiveEndpointId)
    ) {
      return;
    }
    setDismissedInteractiveEndpointId(null);
  }, [activeEndpointId, dismissedInteractiveEndpointId, isConnecting]);

  return (
    <div
      className="sftp-pane__content sftp-host-picker"
      aria-busy={isConnecting}
    >
      <div className="sftp-pane__toolbar">
        <div className="sftp-source-toggle">
          <button
            type="button"
            className={pane.sourceKind === "local" ? "active" : ""}
            onClick={() => void onActivatePaneSource("local")}
            disabled={isConnecting}
          >
            Local
          </button>
          <button
            type="button"
            className={pane.sourceKind === "host" ? "active" : ""}
            onClick={() => void onActivatePaneSource("host")}
            disabled={isConnecting}
          >
            Host
          </button>
        </div>
      </div>

      <div className="search-panel">
        <input
          id={`${pane.id}-host-search`}
          value={pane.hostSearchQuery}
          onChange={(event) => onHostSearchChange(event.target.value)}
          aria-label="Search hosts"
          placeholder="Search hosts..."
          disabled={isConnecting}
        />
      </div>

      {breadcrumbs.length > 0 ? (
        <div className="host-browser__breadcrumbs">
          {breadcrumbs.map((crumb) => (
            <button
              key={crumb.path ?? "root"}
              type="button"
              className={`host-browser__breadcrumb ${crumb.path === pane.hostGroupPath ? "active" : ""}`}
              onClick={() => onNavigateHostGroup(crumb.path)}
              disabled={isConnecting}
            >
              {crumb.label}
            </button>
          ))}
        </div>
      ) : null}

      {pane.errorMessage ? (
        <div className="terminal-error-banner">{pane.errorMessage}</div>
      ) : null}

      <div
        className="sftp-host-picker__results"
        aria-label={`Available hosts for ${pane.id} pane`}
      >
        {visibleGroups.length > 0 ? (
          <div className="group-grid" ref={groupGridRef} style={groupGridStyle}>
            {visibleGroups.map((group) => (
              <article
                key={group.path}
                className={`group-card group-card--interactive ${isConnecting ? "disabled" : ""}`}
                onDoubleClick={() => {
                  if (isConnecting) {
                    return;
                  }
                  onNavigateHostGroup(group.path);
                }}
                role="button"
                aria-disabled={isConnecting}
                tabIndex={isConnecting ? -1 : 0}
                onKeyDown={(event) => {
                  if (isConnecting) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onNavigateHostGroup(group.path);
                  }
                }}
              >
                <div className="group-card__icon">
                  {group.name.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <strong>{group.name}</strong>
                  <span>{group.hostCount} hosts</span>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        <div className="host-grid" ref={hostGridRef} style={hostGridStyle}>
          {isEmpty ? (
            <EmptyState
              title={
                hosts.length === 0
                  ? "표시할 host가 없습니다."
                  : pane.hostSearchQuery
                    ? "검색 결과가 없습니다."
                    : "이 위치에는 아직 host가 없습니다."
              }
              description={
                hosts.length === 0
                  ? "Home에서 원격 host를 추가한 뒤 다시 확인해보세요."
                  : pane.hostSearchQuery
                    ? "검색어를 지우거나 다른 이름으로 다시 찾아보세요."
                    : "다른 그룹으로 이동하거나 Home에서 호스트 구성을 확인해보세요."
              }
            />
          ) : (
            visibleHosts.map((host) => {
              const awsHost = isAwsEc2HostRecord(host) ? host : null;
              const badgeLabel = getHostBadgeLabel(host);
              const disabledReason = getSftpHostPickerDisabledReason(host);
              const canOpenHostSettings = awsHost
                ? !awsHost.awsSshUsername?.trim() || awsHost.awsSshMetadataStatus === "error"
                : false;
              const awsMetadataStatusLabel = awsHost
                ? getAwsEc2HostSshMetadataStatusLabel(awsHost.awsSshMetadataStatus)
                : null;
              const isSelected = pane.selectedHostId === host.id;
              const isBusy = isConnecting && isSelected;
              return (
                <article
                  key={host.id}
                  className={`host-browser-card ${isSelected ? "active" : ""} ${isBusy ? "connecting" : ""} ${disabledReason ? "disabled" : ""}`}
                  aria-busy={isBusy}
                  onClick={() => {
                    if (isConnecting) {
                      return;
                    }
                    onSelectHost(host.id);
                  }}
                  onDoubleClick={() => {
                    if (isConnecting || disabledReason) {
                      return;
                    }
                    void onConnectHost(host.id);
                  }}
                >
                  <div
                    className={`host-browser-card__icon ${badgeLabel.length > 3 ? "host-browser-card__icon--compact" : ""}`}
                  >
                    {badgeLabel}
                  </div>
                  <div className="host-browser-card__meta">
                    <strong>{host.label}</strong>
                    <span>{getHostSubtitle(host)}</span>
                    <small>{host.groupName || "Ungrouped"}</small>
                    {awsMetadataStatusLabel ? (
                      <small className="host-browser-card__hint">
                        {awsMetadataStatusLabel}
                        {awsHost?.awsSshMetadataStatus === "error" &&
                        awsHost.awsSshMetadataError
                          ? ` · ${awsHost.awsSshMetadataError}`
                          : ""}
                      </small>
                    ) : null}
                    {disabledReason ? (
                      <small className="host-browser-card__hint">
                        {disabledReason}
                      </small>
                    ) : null}
                  </div>
                  {isBusy ? (
                    <div className="host-browser-card__status">
                      <StatusBadge
                        tone="starting"
                        aria-label="Connecting selected host"
                      >
                        연결 중
                      </StatusBadge>
                    </div>
                  ) : canOpenHostSettings && onOpenHostSettings ? (
                    <div className="host-browser-card__status">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="sftp-inline-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenHostSettings(host.id);
                        }}
                      >
                        설정 열기
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </div>

      {matchingInteractiveAuth ? (
        <div
          className="sftp-host-picker__overlay"
          role="status"
          aria-live="polite"
          aria-label="SFTP interactive authentication required"
        >
          <div className="sftp-host-picker__overlay-card terminal-interactive-auth">
            {matchingInteractiveAuth.provider === "warpgate" ? (
              <>
                <SectionLabel className="terminal-interactive-auth__label">
                  Warpgate Approval
                </SectionLabel>
                <strong>Warpgate 승인을 기다리는 중입니다.</strong>
                <p>
                  브라우저에서 Warpgate 로그인 뒤 <code>Authorize</code>를
                  눌러주세요. 가능한 입력은 자동으로 처리됩니다.
                </p>
                {matchingInteractiveAuth.authCode ? (
                  <p className="terminal-interactive-auth__code">
                    인증 코드 <code>{matchingInteractiveAuth.authCode}</code>는
                    자동으로 입력됩니다.
                  </p>
                ) : null}
                <div className="terminal-interactive-auth__actions">
                  {matchingInteractiveAuth.approvalUrl ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        void onReopenInteractiveAuthUrl();
                      }}
                    >
                      브라우저 다시 열기
                    </Button>
                  ) : null}
                  {matchingInteractiveAuth.approvalUrl ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          matchingInteractiveAuth.approvalUrl ?? "",
                        );
                      }}
                    >
                      링크 복사
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDismissedInteractiveEndpointId(
                        matchingInteractiveAuth.endpointId,
                      );
                      onClearInteractiveAuth();
                    }}
                  >
                    닫기
                  </Button>
                </div>
                <pre className="terminal-interactive-auth__raw">
                  {matchingInteractiveAuth.instruction}
                </pre>
              </>
            ) : (
              <form
                className="terminal-interactive-auth__form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onRespondInteractiveAuth(
                    matchingInteractiveAuth.challengeId,
                    promptResponses,
                  );
                }}
              >
                <SectionLabel className="terminal-interactive-auth__label">
                  Additional Authentication
                </SectionLabel>
                <strong>추가 인증 입력이 필요합니다.</strong>
                {matchingInteractiveAuth.instruction ? (
                  <p>{matchingInteractiveAuth.instruction}</p>
                ) : null}
                {matchingInteractiveAuth.prompts.map((prompt, index) => (
                  <label
                    key={`${matchingInteractiveAuth.challengeId}:${index}`}
                    className="terminal-interactive-auth__field"
                  >
                    <span>{prompt.label || `Prompt ${index + 1}`}</span>
                    <input
                      type={prompt.echo ? "text" : "password"}
                      value={promptResponses[index] ?? ""}
                      onChange={(inputEvent) => {
                        const nextResponses = [...promptResponses];
                        nextResponses[index] = inputEvent.target.value;
                        setPromptResponses(nextResponses);
                      }}
                    />
                  </label>
                ))}
                <div className="terminal-interactive-auth__actions">
                  <Button type="submit" variant="primary" size="sm">
                    응답 보내기
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDismissedInteractiveEndpointId(
                        matchingInteractiveAuth.endpointId,
                      );
                      onClearInteractiveAuth();
                    }}
                  >
                    닫기
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : shouldShowConnectingOverlay ? (
        <div
          className="sftp-host-picker__overlay"
          role="status"
          aria-live="polite"
          aria-label="SFTP host connection in progress"
        >
          <div className="sftp-host-picker__overlay-card">
            <div className="sftp-host-picker__spinner" aria-hidden="true" />
            <strong>
              {selectedHost
                ? `${selectedHost.label} 연결 중...`
                : "SFTP 연결 중..."}
            </strong>
            <span className="sftp-host-picker__overlay-stage">
              {formatConnectionProgressStageLabel(
                pane.connectionProgress?.stage,
              )}
            </span>
            <span>
              {pane.connectionProgress?.message ??
                "원격 파일 목록을 준비하고 있습니다."}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TransferBar({
  transfers,
  onCancelTransfer,
  onRetryTransfer,
  onDismissTransfer,
}: {
  transfers: TransferJob[];
  onCancelTransfer: (jobId: string) => Promise<void>;
  onRetryTransfer: (jobId: string) => Promise<void>;
  onDismissTransfer: (jobId: string) => void;
}) {
  if (transfers.length === 0) {
    return null;
  }

  return (
    <div className="sftp-transfer-bar">
      {transfers.slice(0, 6).map((job) => {
        const progress =
          job.bytesTotal > 0
            ? Math.min(
                100,
                Math.round((job.bytesCompleted / job.bytesTotal) * 100),
              )
            : 0;
        return (
          <article key={job.id} className={`transfer-card ${job.status}`}>
            <div className="transfer-card__top">
              <strong
                className="transfer-card__name"
                title={buildTransferCardTitle(job)}
              >
                {buildTransferCardTitle(job)}
              </strong>
              <span className="transfer-card__status" title={job.status}>
                {job.status}
              </span>
            </div>
            <div className="transfer-card__meta">
              <span
                className="transfer-card__direction"
                title={buildTransferDirection(job)}
              >
                {buildTransferDirection(job)}
              </span>
              <span className="transfer-card__percent">
                {job.bytesTotal > 0 ? `${progress}%` : "--"}
              </span>
            </div>
            <div className="transfer-card__progress">
              <div style={{ width: `${progress}%` }} />
            </div>
            <div className="transfer-card__actions">
              <span className="transfer-card__bytes">
                {formatSize(job.bytesCompleted)} / {formatSize(job.bytesTotal)}
              </span>
              {job.status === "running" ? (
                <span className="transfer-card__speed">
                  {formatTransferSpeed(job.speedBytesPerSecond) ??
                    "속도 계산 중"}
                  {formatEta(job.etaSeconds)
                    ? ` · ${formatEta(job.etaSeconds)}`
                    : ""}
                </span>
              ) : null}
              {job.status === "running" ? (
                <Button variant="secondary" size="sm" className="sftp-inline-button" onClick={() => void onCancelTransfer(job.id)}>
                  취소
                </Button>
              ) : null}
              {job.status === "failed" ? (
                <Button variant="secondary" size="sm" className="sftp-inline-button" onClick={() => void onRetryTransfer(job.id)}>
                  재시도
                </Button>
              ) : null}
              {job.status !== "running" && job.status !== "queued" ? (
                <Button variant="secondary" size="sm" className="sftp-inline-button" onClick={() => onDismissTransfer(job.id)}>
                  닫기
                </Button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ConflictDialog({
  pendingConflictDialog,
  onResolveConflict,
  onDismissConflict,
}: {
  pendingConflictDialog: PendingConflictDialog | null;
  onResolveConflict: (
    resolution: "overwrite" | "skip" | "keepBoth",
  ) => Promise<void>;
  onDismissConflict: () => void;
}) {
  if (!pendingConflictDialog) {
    return null;
  }

  return (
    <DialogBackdrop
      className="sftp-modal-backdrop"
      dismissOnBackdrop={false}
    >
      <ModalShell className="sftp-modal" size="md">
        <ModalHeader className="sftp-modal__header">
          <div>
            <SectionLabel>Conflict</SectionLabel>
            <h3 className="m-0">같은 이름의 파일이 이미 존재합니다</h3>
          </div>
        </ModalHeader>
        <ModalBody className="sftp-modal__body">
          <p>{pendingConflictDialog.names.join(", ")}</p>
        </ModalBody>
        <ModalFooter className="sftp-modal__actions">
          <Button variant="secondary" onClick={onDismissConflict}>
            취소
          </Button>
          <Button variant="secondary" onClick={() => void onResolveConflict("skip")}>
            건너뛰기
          </Button>
          <Button variant="secondary" onClick={() => void onResolveConflict("keepBoth")}>
            이름 바꿔 저장
          </Button>
          <Button variant="primary" onClick={() => void onResolveConflict("overwrite")}>
            덮어쓰기
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

function ActionDialog({
  dialog,
  onChange,
  onClose,
  onSubmit,
}: {
  dialog: ActionDialogState | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  if (!dialog) {
    return null;
  }

  return (
    <DialogBackdrop
      className="sftp-modal-backdrop"
      onDismiss={onClose}
      dismissDisabled={dialog.isSubmitting}
    >
      <ModalShell className="sftp-modal" size="md">
        <ModalHeader className="sftp-modal__header">
          <div>
            <SectionLabel>
              {dialog.mode === "mkdir" ? "New Folder" : "Rename"}
            </SectionLabel>
            <h3 className="m-0">{dialog.title}</h3>
          </div>
        </ModalHeader>
        <ModalBody className="sftp-modal__body">
          <input
            value={dialog.value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={dialog.placeholder}
            autoFocus
            disabled={dialog.isSubmitting}
          />
        </ModalBody>
        <ModalFooter className="sftp-modal__actions">
          <Button variant="secondary" onClick={onClose} disabled={dialog.isSubmitting}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => void onSubmit()}
            disabled={!dialog.value.trim() || dialog.isSubmitting}
          >
            {dialog.submitLabel}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

function PermissionDialog({
  dialog,
  onToggle,
  onClose,
  onSubmit,
}: {
  dialog: PermissionDialogState | null;
  onToggle: (section: PermissionSection, key: PermissionKey) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  if (!dialog) {
    return null;
  }

  const mode = permissionMatrixToMode(dialog.matrix);
  const rows: Array<{ section: PermissionSection; label: string }> = [
    { section: "owner", label: "Owner" },
    { section: "group", label: "Group" },
    { section: "other", label: "Other" },
  ];
  const columns: Array<{ key: PermissionKey; label: string }> = [
    { key: "read", label: "Read" },
    { key: "write", label: "Write" },
    { key: "execute", label: "Execute" },
  ];

  return (
    <DialogBackdrop
      className="sftp-modal-backdrop"
      onDismiss={onClose}
      dismissDisabled={dialog.isSubmitting}
    >
      <ModalShell className="sftp-modal" size="md">
        <ModalHeader className="sftp-modal__header">
          <div>
            <SectionLabel>Permissions</SectionLabel>
            <h3 className="m-0">{dialog.name} 권한 수정</h3>
          </div>
        </ModalHeader>
        <ModalBody className="sftp-modal__body">
          <div className="sftp-permissions-grid">
          <div />
          {columns.map((column) => (
            <strong key={column.key}>{column.label}</strong>
          ))}
          {rows.map((row) => (
            <Fragment key={row.section}>
              <span>{row.label}</span>
              {columns.map((column) => (
                <label
                  key={`${row.section}-${column.key}`}
                  className="sftp-permissions-toggle"
                >
                  <input
                    type="checkbox"
                    checked={dialog.matrix[row.section][column.key]}
                    onChange={() => onToggle(row.section, column.key)}
                    disabled={dialog.isSubmitting}
                  />
                </label>
              ))}
            </Fragment>
          ))}
          </div>
          <div className="sftp-permissions-preview">
            Mode {formatPermissionMode(mode)}
          </div>
        </ModalBody>
        <ModalFooter className="sftp-modal__actions">
          <Button variant="secondary" onClick={onClose} disabled={dialog.isSubmitting}>
            취소
          </Button>
          <Button
            variant="primary"
            onClick={() => void onSubmit()}
            disabled={dialog.isSubmitting}
          >
            적용
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

function DeleteDialog({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: DeleteDialogState | null;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  if (!dialog) {
    return null;
  }

  const title = dialog.primaryLabel
    ? `"${dialog.primaryLabel}"을 삭제할까요?`
    : `선택한 ${dialog.itemCount}개 항목을 삭제할까요?`;

  return (
    <DialogBackdrop
      className="sftp-modal-backdrop"
      onDismiss={onClose}
      dismissDisabled={dialog.isSubmitting}
    >
      <ModalShell
        className="sftp-modal"
        size="md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-delete-title"
        aria-label="SFTP delete confirmation"
      >
        <ModalHeader className="sftp-modal__header">
          <div>
            <SectionLabel>Delete</SectionLabel>
            <h3 id="sftp-delete-title" className="m-0">{title}</h3>
          </div>
        </ModalHeader>
        <ModalBody className="sftp-modal__body">
          {dialog.includesDirectory ? (
            <p className="sftp-modal__warning">
              폴더를 삭제하면 하위 항목도 함께 삭제됩니다.
            </p>
          ) : null}
          {dialog.errorMessage ? (
            <p className="sftp-modal__error">{dialog.errorMessage}</p>
          ) : null}
        </ModalBody>
        <ModalFooter className="sftp-modal__actions">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={dialog.isSubmitting}
          >
            취소
          </Button>
          <Button
            variant="danger"
            onClick={() => void onSubmit()}
            disabled={dialog.isSubmitting}
          >
            삭제
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}

export function SftpWorkspace({
  hosts,
  groups,
  sftp,
  settings,
  interactiveAuth,
  onActivatePaneSource,
  onDisconnectPane,
  onPaneFilterChange,
  onHostSearchChange,
  onNavigateHostGroup,
  onSelectHost,
  onConnectHost,
  onOpenHostSettings,
  onOpenEntry,
  onRefreshPane,
  onNavigateBack,
  onNavigateForward,
  onNavigateParent,
  onNavigateBreadcrumb,
  onSelectEntry,
  onCreateDirectory,
  onRenameSelection,
  onChangeSelectionPermissions,
  onDeleteSelection,
  onDownloadSelection,
  onPrepareTransfer,
  onPrepareExternalTransfer,
  onTransferSelectionToPane,
  onResolveConflict,
  onDismissConflict,
  onCancelTransfer,
  onRetryTransfer,
  onDismissTransfer,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearInteractiveAuth,
  onUpdateSettings,
}: SftpWorkspaceProps) {
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(
    null,
  );
  const [permissionDialog, setPermissionDialog] =
    useState<PermissionDialogState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [columnWidths, setColumnWidths] = useState<SftpBrowserColumnWidths>(
    () => normalizeSftpBrowserColumnWidths(settings.sftpBrowserColumnWidths),
  );
  const [columnResize, setColumnResize] = useState<ColumnResizeState | null>(
    null,
  );
  const columnWidthsRef = useRef(columnWidths);
  const panes = [sftp.leftPane, sftp.rightPane] as const;
  const connectableHosts = useMemo(
    () =>
      hosts.filter(
        (host): host is SftpConnectableHostRecord =>
          isSshHostRecord(host) ||
          isWarpgateSshHostRecord(host) ||
          isAwsEc2HostRecord(host),
      ),
    [hosts],
  );
  const leftPane = sftp.leftPane;
  const rightPane = sftp.rightPane;
  const canTransferBetweenPanes = canTransferBetweenSftpPanes(
    leftPane,
    rightPane,
  );

  useEffect(() => {
    columnWidthsRef.current = columnWidths;
  }, [columnWidths]);

  useEffect(() => {
    if (columnResize) {
      return;
    }
    const normalizedWidths = normalizeSftpBrowserColumnWidths(
      settings.sftpBrowserColumnWidths,
    );
    setColumnWidths((current) => {
      if (areSftpBrowserColumnWidthsEqual(current, normalizedWidths)) {
        return current;
      }
      columnWidthsRef.current = normalizedWidths;
      return normalizedWidths;
    });
  }, [columnResize, settings.sftpBrowserColumnWidths]);

  useEffect(() => {
    if (!columnResize) {
      document.body.classList.remove(SFTP_BROWSER_RESIZE_BODY_CLASS);
      return;
    }

    document.body.classList.add(SFTP_BROWSER_RESIZE_BODY_CLASS);
    const handlePointerMove = (event: MouseEvent) => {
      const nextWidth = Math.max(
        MIN_SFTP_BROWSER_COLUMN_WIDTHS[columnResize.key],
        Math.round(
          columnResize.startWidth + (event.clientX - columnResize.startClientX),
        ),
      );
      const nextWidths =
        columnWidthsRef.current[columnResize.key] === nextWidth
          ? columnWidthsRef.current
          : {
              ...columnWidthsRef.current,
              [columnResize.key]: nextWidth,
            };
      columnWidthsRef.current = nextWidths;
      setColumnWidths((current) =>
        current[columnResize.key] === nextWidth ? current : nextWidths,
      );
    };

    const handlePointerUp = () => {
      document.body.classList.remove(SFTP_BROWSER_RESIZE_BODY_CLASS);
      const nextWidths = columnWidthsRef.current;
      const changed = SFTP_BROWSER_COLUMNS.some(
        (column) =>
          nextWidths[column.key] !== columnResize.originalWidths[column.key],
      );
      setColumnResize(null);
      if (changed) {
        void onUpdateSettings({
          sftpBrowserColumnWidths: nextWidths,
        });
      }
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      document.body.classList.remove(SFTP_BROWSER_RESIZE_BODY_CLASS);
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [columnResize, onUpdateSettings]);

  const handleStartColumnResize = (
    columnKey: SftpBrowserColumnKey,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnResize({
      key: columnKey,
      startClientX: event.clientX,
      startWidth: columnWidthsRef.current[columnKey],
      originalWidths: { ...columnWidthsRef.current },
    });
  };

  const handleConfirmDelete = async () => {
    if (!deleteDialog) {
      return;
    }

    setDeleteDialog((current) =>
      current
        ? {
            ...current,
            isSubmitting: true,
            errorMessage: null,
          }
        : current,
    );

    try {
      await onDeleteSelection(deleteDialog.paneId);
      setDeleteDialog(null);
    } catch (error) {
      setDeleteDialog((current) =>
        current
          ? {
              ...current,
              isSubmitting: false,
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "선택한 항목을 삭제하지 못했습니다.",
            }
          : current,
      );
    }
  };

  return (
    <div className="sftp-workspace">
      <div className="sftp-workspace__panes">
        {panes.map((pane, index) => {
          const connectActions = {
            onActivatePaneSource: (sourceKind: SftpSourceKind) =>
              onActivatePaneSource(pane.id, sourceKind),
          };

          const section = (
            <section key={pane.id} className="sftp-pane">
              <header className="sftp-pane__header">
                <div className="sftp-pane__header-main">
                  <h2>{getSftpPaneTitle(pane)}</h2>
                </div>
                {pane.sourceKind === "host" && pane.endpoint ? (
                  <button
                    type="button"
                    className="icon-button sftp-pane__disconnect"
                    aria-label="연결 종료"
                    title="연결 종료"
                    onClick={() => void onDisconnectPane(pane.id)}
                  >
                    X
                  </button>
                ) : null}
              </header>

              {pane.sourceKind === "host" &&
              (!pane.endpoint || pane.connectingHostId) ? (
                <HostPicker
                  pane={pane}
                  groups={groups}
                  hosts={connectableHosts}
                  interactiveAuth={
                    interactiveAuth?.paneId === pane.id ? interactiveAuth : null
                  }
                  onActivatePaneSource={connectActions.onActivatePaneSource}
                  onHostSearchChange={(query) =>
                    onHostSearchChange(pane.id, query)
                  }
                  onNavigateHostGroup={(path) =>
                    onNavigateHostGroup(pane.id, path)
                  }
                  onSelectHost={(hostId) => onSelectHost(pane.id, hostId)}
                  onConnectHost={(hostId) => onConnectHost(pane.id, hostId)}
                  onOpenHostSettings={onOpenHostSettings}
                  onRespondInteractiveAuth={onRespondInteractiveAuth}
                  onReopenInteractiveAuthUrl={onReopenInteractiveAuthUrl}
                  onClearInteractiveAuth={onClearInteractiveAuth}
                />
              ) : (
                <PaneBrowser
                  pane={pane}
                  columnWidths={columnWidths}
                  resizingColumnKey={columnResize?.key ?? null}
                  onStartColumnResize={handleStartColumnResize}
                  onActivatePaneSource={connectActions.onActivatePaneSource}
                  onFilterChange={(query) => onPaneFilterChange(pane.id, query)}
                  onNavigateBack={() => onNavigateBack(pane.id)}
                  onNavigateForward={() => onNavigateForward(pane.id)}
                  onNavigateParent={() => onNavigateParent(pane.id)}
                  onNavigateBreadcrumb={(nextPath) =>
                    onNavigateBreadcrumb(pane.id, nextPath)
                  }
                  onRefresh={() => onRefreshPane(pane.id)}
                  onSelectEntry={(input) => onSelectEntry(pane.id, input)}
                  onOpenEntry={(entryPath) => onOpenEntry(pane.id, entryPath)}
                  onOpenCreateDirectoryDialog={() => {
                    setActionDialog({
                      paneId: pane.id,
                      mode: "mkdir",
                      title: "새 폴더 이름",
                      placeholder: "예: uploads",
                      submitLabel: "생성",
                      value: "",
                      isSubmitting: false,
                    });
                  }}
                  onOpenRenameDialog={() => {
                    const selected = pane.entries.find((entry) =>
                      pane.selectedPaths.includes(entry.path),
                    );
                    if (!selected) {
                      return;
                    }
                    setActionDialog({
                      paneId: pane.id,
                      mode: "rename",
                      title: "이름 변경",
                      placeholder: "새 이름",
                      submitLabel: "변경",
                      value: selected.name,
                      isSubmitting: false,
                    });
                  }}
                  onOpenPermissionsDialog={() => {
                    const selected = pane.entries.find((entry) =>
                      pane.selectedPaths.includes(entry.path),
                    );
                    if (!selected) {
                      return;
                    }
                    setPermissionDialog({
                      paneId: pane.id,
                      path: selected.path,
                      name: selected.name,
                      matrix: permissionMatrixFromString(selected.permissions),
                      isSubmitting: false,
                    });
                  }}
                  onDeleteSelection={async () => {
                    const nextDialog = buildDeleteDialogState(pane);
                    if (!nextDialog) {
                      return;
                    }
                    setDeleteDialog(nextDialog);
                    return;
                    if (pane.selectedPaths.length === 0) {
                      return;
                    }
                    const selectedEntries = pane.entries.filter((entry) =>
                      pane.selectedPaths.includes(entry.path),
                    );
                    const message =
                      selectedEntries.length === 1 && selectedEntries[0]
                        ? `"${selectedEntries[0].name}" 항목을 삭제할까요?`
                        : `선택한 ${pane.selectedPaths.length}개 항목을 삭제할까요?`;
                    if (!window.confirm(message)) {
                      return;
                    }
                    return;
                  }}
                  onDownloadSelection={() => onDownloadSelection(pane.id)}
                  onPrepareTransfer={(sourcePaneId, targetPath, draggedPath) =>
                    onPrepareTransfer(
                      sourcePaneId,
                      pane.id,
                      targetPath,
                      draggedPath,
                    )
                  }
                  onPrepareExternalTransfer={(targetPath, droppedPaths) =>
                    onPrepareExternalTransfer(pane.id, targetPath, droppedPaths)
                  }
                />
              )}
            </section>
          );

          if (index === 0) {
            return (
              <Fragment key={pane.id}>
                {section}
                <div
                  className="sftp-transfer-gutter"
                  aria-label="Pane transfer controls"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    className="sftp-transfer-arrow"
                    aria-label="Transfer selection from left pane to right pane"
                    onClick={() =>
                      void onTransferSelectionToPane("left", "right")
                    }
                    disabled={isSftpTransferArrowDisabled(leftPane, rightPane)}
                    title={
                      canTransferBetweenPanes
                        ? "왼쪽 선택 항목을 오른쪽 현재 폴더로 전송"
                        : "양쪽 pane이 모두 파일 브라우저일 때 사용할 수 있습니다."
                    }
                  >
                    →
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="sftp-transfer-arrow"
                    aria-label="Transfer selection from right pane to left pane"
                    onClick={() =>
                      void onTransferSelectionToPane("right", "left")
                    }
                    disabled={isSftpTransferArrowDisabled(rightPane, leftPane)}
                    title={
                      canTransferBetweenPanes
                        ? "오른쪽 선택 항목을 왼쪽 현재 폴더로 전송"
                        : "양쪽 pane이 모두 파일 브라우저일 때 사용할 수 있습니다."
                    }
                  >
                    ←
                  </Button>
                </div>
              </Fragment>
            );
          }

          return <Fragment key={pane.id}>{section}</Fragment>;
        })}
      </div>

      <TransferBar
        transfers={sftp.transfers}
        onCancelTransfer={onCancelTransfer}
        onRetryTransfer={onRetryTransfer}
        onDismissTransfer={onDismissTransfer}
      />

      <ConflictDialog
        pendingConflictDialog={sftp.pendingConflictDialog}
        onResolveConflict={onResolveConflict}
        onDismissConflict={onDismissConflict}
      />

      <ActionDialog
        dialog={actionDialog}
        onChange={(value) => {
          setActionDialog((current) =>
            current ? { ...current, value } : current,
          );
        }}
        onClose={() => {
          setActionDialog((current) =>
            current?.isSubmitting ? current : null,
          );
        }}
        onSubmit={async () => {
          if (!actionDialog?.value.trim() || actionDialog.isSubmitting) {
            return;
          }
          setActionDialog((current) =>
            current ? { ...current, isSubmitting: true } : current,
          );
          try {
            if (actionDialog.mode === "mkdir") {
              await onCreateDirectory(
                actionDialog.paneId,
                actionDialog.value.trim(),
              );
            } else {
              await onRenameSelection(
                actionDialog.paneId,
                actionDialog.value.trim(),
              );
            }
            setActionDialog(null);
          } catch (error) {
            setActionDialog((current) =>
              current ? { ...current, isSubmitting: false } : current,
            );
            throw error;
          }
        }}
      />

      <PermissionDialog
        dialog={permissionDialog}
        onToggle={(section, key) => {
          setPermissionDialog((current) =>
            current
              ? {
                  ...current,
                  matrix: {
                    ...current.matrix,
                    [section]: {
                      ...current.matrix[section],
                      [key]: !current.matrix[section][key],
                    },
                  },
                }
              : current,
          );
        }}
        onClose={() => {
          setPermissionDialog((current) =>
            current?.isSubmitting ? current : null,
          );
        }}
        onSubmit={async () => {
          if (!permissionDialog || permissionDialog.isSubmitting) {
            return;
          }
          setPermissionDialog((current) =>
            current ? { ...current, isSubmitting: true } : current,
          );
          try {
            await onChangeSelectionPermissions(
              permissionDialog.paneId,
              permissionMatrixToMode(permissionDialog.matrix),
            );
            setPermissionDialog(null);
          } catch (error) {
            setPermissionDialog((current) =>
              current ? { ...current, isSubmitting: false } : current,
            );
            throw error;
          }
        }}
      />

      <DeleteDialog
        dialog={deleteDialog}
        onClose={() => {
          if (deleteDialog?.isSubmitting) {
            return;
          }
          setDeleteDialog(null);
        }}
        onSubmit={handleConfirmDelete}
      />
    </div>
  );
}
