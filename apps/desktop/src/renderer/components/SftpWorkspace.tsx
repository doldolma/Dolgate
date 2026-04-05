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
import { HostCard } from "./HostCard";
import { TerminalInteractiveAuthOverlay } from "./terminal-workspace/TerminalInteractiveAuthOverlay";
import {
  Button,
  Card,
  EmptyState,
  FilterRow,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
  TabButton,
  Tabs,
  Toolbar,
} from "../ui";
import { cn } from "../lib/cn";

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
    <div className="flex min-h-0 flex-1 flex-col gap-[0.85rem] px-4 pb-4">
      <Toolbar className="justify-between">
        <Tabs
          className="shrink-0 border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_92%,transparent_8%)] p-1"
          role="tablist"
          aria-label="SFTP source kind"
        >
          <TabButton active={pane.sourceKind === "local"} role="tab" aria-selected={pane.sourceKind === "local"} onClick={() => void onActivatePaneSource("local")}>
            Local
          </TabButton>
          <TabButton active={pane.sourceKind === "host"} role="tab" aria-selected={pane.sourceKind === "host"} onClick={() => void onActivatePaneSource("host")}>
            Host
          </TabButton>
        </Tabs>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <IconButton
            size="sm"
            className="h-[2.3rem] w-[2.3rem] flex-none rounded-[12px]"
            onClick={() => void onNavigateBack()}
            disabled={pane.historyIndex <= 0}
          >
            ←
          </IconButton>
          <IconButton
            size="sm"
            className="h-[2.3rem] w-[2.3rem] flex-none rounded-[12px]"
            onClick={() => void onNavigateForward()}
            disabled={pane.historyIndex >= pane.history.length - 1}
          >
            →
          </IconButton>
          <IconButton
            size="sm"
            className="h-[2.3rem] w-[2.3rem] flex-none rounded-[12px]"
            onClick={() => void onNavigateParent()}
          >
            ↑
          </IconButton>
          <Button
            variant="secondary"
            size="sm"
            className="flex-none rounded-[12px]"
            onClick={onOpenCreateDirectoryDialog}
            disabled={pane.isLoading}
          >
            새 폴더
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-none rounded-[12px]"
            onClick={() => void onRefresh()}
            disabled={pane.isLoading}
          >
            {pane.isLoading ? "새로고침 중..." : "새로고침"}
          </Button>
        </div>
      </Toolbar>

      <div className="flex flex-wrap items-center gap-2">
        {breadcrumbParts(pane.currentPath).map((part) => (
          <Button
            key={part.path}
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-[12px]"
            onClick={() => void onNavigateBreadcrumb(part.path)}
          >
            {part.label}
          </Button>
        ))}
      </div>

      <FilterRow className="p-0 border-0 bg-transparent">
        <Input
          className="flex-1"
          value={pane.filterQuery}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="Filter"
          aria-label="Filter files"
        />
      </FilterRow>

      {pane.warningMessages && pane.warningMessages.length > 0 ? (
        <div className="grid gap-[0.55rem]">
          {pane.warningMessages.map((warning) => (
            <NoticeCard
              key={warning}
              tone="warning"
              className="rounded-[16px] px-[0.9rem] py-[0.58rem] shadow-none"
            >
              <span className="text-[0.92rem] leading-[1.6]">{warning}</span>
            </NoticeCard>
          ))}
        </div>
      ) : null}

      {pane.errorMessage ? (
        <NoticeCard
          tone="danger"
          className="rounded-[16px] px-[0.9rem] py-[0.58rem] shadow-none"
        >
          <span className="text-[0.92rem] leading-[1.6]">
            {pane.errorMessage}
          </span>
        </NoticeCard>
      ) : null}

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-auto rounded-[20px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_95%,transparent_5%)] transition-[opacity,border-color,box-shadow]",
          pane.isLoading && "opacity-[0.82]",
          isDropTargetActive &&
            "border-[color-mix(in_srgb,var(--accent-strong)_62%,var(--border)_38%)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_38%,transparent_62%)]",
        )}
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
        <table className="w-full table-fixed border-collapse" style={tableStyle}>
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
                <th
                  key={column.key}
                  className="group/header sticky top-0 z-[1] border-b border-[color-mix(in_srgb,var(--border)_90%,transparent_10%)] bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] px-[0.9rem] py-[0.8rem] text-left text-[0.85rem] font-semibold text-[var(--text-soft)]"
                >
                  <div className="relative flex min-h-[1.4rem] items-center">
                    <span
                      className="min-w-0 overflow-hidden text-ellipsis"
                      title={column.label}
                    >
                      {column.label}
                    </span>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label} column`}
                      className={cn(
                        "absolute inset-y-[-0.8rem] right-[-0.95rem] z-[2] w-[14px] cursor-col-resize touch-none after:absolute after:top-[0.85rem] after:bottom-[0.85rem] after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[color-mix(in_srgb,var(--accent-strong)_42%,var(--border)_58%)] after:opacity-0 after:transition-opacity group-hover/header:after:opacity-100",
                        resizingColumnKey === column.key && "after:opacity-100",
                      )}
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
                className={cn(
                  "cursor-default transition-colors hover:bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)]",
                  pane.selectedPaths.includes(entry.path) &&
                    "bg-[color-mix(in_srgb,var(--accent-strong)_10%,transparent_90%)]",
                )}
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
                <td
                  title={entry.name}
                  className="border-b border-[color-mix(in_srgb,var(--border)_90%,transparent_10%)] px-[0.9rem] py-[0.8rem] text-left whitespace-nowrap"
                >
                  <div className="flex min-w-0 items-center gap-[0.6rem]">
                    <span
                      className={cn(
                        "inline-grid h-[1.8rem] w-[1.8rem] place-items-center rounded-[12px] text-[0.72rem] font-bold",
                        entry.isDirectory
                          ? "bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent_88%)] text-[var(--accent-strong)]"
                          : "bg-[color-mix(in_srgb,var(--accent)_14%,transparent_86%)] text-[var(--accent)]",
                      )}
                    >
                      {entry.isDirectory ? "D" : "F"}
                    </span>
                    <span className="min-w-0 overflow-hidden text-ellipsis">
                      {entry.name}
                    </span>
                  </div>
                </td>
                <td
                  title={formatDate(entry.mtime)}
                  className="border-b border-[color-mix(in_srgb,var(--border)_90%,transparent_10%)] px-[0.9rem] py-[0.8rem] text-left overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {formatDate(entry.mtime)}
                </td>
                <td
                  title={entry.isDirectory ? "--" : formatSize(entry.size)}
                  className="border-b border-[color-mix(in_srgb,var(--border)_90%,transparent_10%)] px-[0.9rem] py-[0.8rem] text-left overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {entry.isDirectory ? "--" : formatSize(entry.size)}
                </td>
                <td
                  title={entry.kind}
                  className="border-b border-[color-mix(in_srgb,var(--border)_90%,transparent_10%)] px-[0.9rem] py-[0.8rem] text-left overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {entry.kind}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pane.isLoading ? (
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-full bg-[color-mix(in_srgb,var(--accent-strong)_12%,var(--surface-strong))] px-[0.7rem] py-[0.45rem] text-[0.82rem] font-semibold text-[var(--accent-strong)]">
            목록을 새로 읽는 중...
          </div>
        ) : null}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="fixed z-[24] min-w-[148px] rounded-[16px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.45rem] shadow-[0_20px_60px_rgba(18,30,44,0.24)]"
              style={contextMenuStyle ?? undefined}
              role="menu"
            >
              <button
                type="button"
                className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
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
                className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
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
                className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
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
                className="flex w-full items-center rounded-[12px] px-[0.8rem] py-[0.75rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
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
      className="relative flex min-h-0 flex-1 flex-col gap-[0.85rem] px-4 pb-4"
      aria-busy={isConnecting}
    >
      <Toolbar className="justify-start">
        <Tabs
          className="border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[color-mix(in_srgb,var(--surface-strong)_92%,transparent_8%)] p-1"
          role="tablist"
          aria-label="SFTP source kind"
        >
          <TabButton
            type="button"
            active={pane.sourceKind === "local"}
            role="tab"
            aria-selected={pane.sourceKind === "local"}
            onClick={() => void onActivatePaneSource("local")}
            disabled={isConnecting}
          >
            Local
          </TabButton>
          <TabButton
            type="button"
            active={pane.sourceKind === "host"}
            role="tab"
            aria-selected={pane.sourceKind === "host"}
            onClick={() => void onActivatePaneSource("host")}
            disabled={isConnecting}
          >
            Host
          </TabButton>
        </Tabs>
      </Toolbar>

      <FilterRow className="p-0 border-0 bg-transparent">
        <Input
          id={`${pane.id}-host-search`}
          value={pane.hostSearchQuery}
          onChange={(event) => onHostSearchChange(event.target.value)}
          aria-label="Search hosts"
          placeholder="Search hosts..."
          disabled={isConnecting}
        />
      </FilterRow>

      {breadcrumbs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {breadcrumbs.map((crumb) => (
            <Button
              key={crumb.path ?? "root"}
              type="button"
              variant={crumb.path === pane.hostGroupPath ? "secondary" : "ghost"}
              size="sm"
              active={crumb.path === pane.hostGroupPath}
              className="rounded-[12px]"
              onClick={() => onNavigateHostGroup(crumb.path)}
              disabled={isConnecting}
            >
              {crumb.label}
            </Button>
          ))}
        </div>
      ) : null}

      {pane.errorMessage ? (
        <NoticeCard
          tone="danger"
          className="rounded-[16px] px-[0.9rem] py-[0.58rem] shadow-none"
        >
          <span className="text-[0.92rem] leading-[1.6]">
            {pane.errorMessage}
          </span>
        </NoticeCard>
      ) : null}

      <div
        className="flex min-h-0 flex-1 flex-col gap-[0.85rem] overflow-y-auto pr-[0.1rem]"
        aria-label={`Available hosts for ${pane.id} pane`}
      >
        {visibleGroups.length > 0 ? (
          <div
            data-group-grid="true"
            className="grid content-start gap-[0.75rem]"
            ref={groupGridRef}
            style={groupGridStyle}
          >
            {visibleGroups.map((group) => (
              <article
                key={group.path}
                data-group-card="true"
                className={cn(
                  'relative flex min-h-[96px] select-none items-center gap-[0.7rem] rounded-[22px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-[0.9rem] py-[0.82rem] shadow-[var(--shadow-soft)] transition-[background-color,border-color,box-shadow,opacity] duration-150',
                  isConnecting
                    ? 'cursor-default opacity-65'
                    : 'cursor-pointer hover:border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border)_66%)] hover:bg-[color-mix(in_srgb,var(--surface-elevated)_90%,var(--accent-strong)_10%)]',
                )}
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
                <div className="inline-grid h-[2.45rem] w-[2.45rem] shrink-0 place-items-center rounded-[14px] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent-strong)_90%,white_10%),color-mix(in_srgb,var(--chrome-bg)_84%,var(--accent-strong)_16%))] text-[0.92rem] font-bold text-white">
                  {group.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <strong>{group.name}</strong>
                  <span className="block text-[var(--text-soft)]">
                    {group.hostCount} hosts
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        <div
          data-host-grid="true"
          className="grid content-start gap-[0.75rem]"
          ref={hostGridRef}
          style={hostGridStyle}
        >
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
              const hint = disabledReason
                ? disabledReason
                : awsMetadataStatusLabel
                  ? `${awsMetadataStatusLabel}${
                      awsHost?.awsSshMetadataStatus === "error" &&
                      awsHost.awsSshMetadataError
                        ? ` · ${awsHost.awsSshMetadataError}`
                        : ""
                    }`
                  : undefined;
              return (
                <HostCard
                  key={host.id}
                  selected={isSelected}
                  busy={isBusy}
                  disabled={Boolean(disabledReason)}
                  badgeLabel={badgeLabel}
                  title={host.label}
                  subtitle={getHostSubtitle(host)}
                  groupLabel={host.groupName || "Ungrouped"}
                  hint={hint}
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
                  actions={
                    isBusy ? (
                      <StatusBadge
                        tone="starting"
                        aria-label="Connecting selected host"
                      >
                        연결 중
                      </StatusBadge>
                    ) : canOpenHostSettings && onOpenHostSettings ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="rounded-[12px] whitespace-nowrap"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenHostSettings(host.id);
                        }}
                      >
                        설정 열기
                      </Button>
                    ) : null
                  }
                />
              );
            })
          )}
        </div>
      </div>

      {matchingInteractiveAuth ? (
        <div
          className="absolute inset-0 z-[3] grid place-items-center rounded-[20px] bg-[rgba(12,20,32,0.18)]"
          role="status"
          aria-live="polite"
          aria-label="SFTP interactive authentication required"
        >
          <TerminalInteractiveAuthOverlay
            interactiveAuth={matchingInteractiveAuth}
            promptResponses={promptResponses}
            onPromptResponseChange={(index, value) => {
              const nextResponses = [...promptResponses];
              nextResponses[index] = value;
              setPromptResponses(nextResponses);
            }}
            onSubmit={() => {
              void onRespondInteractiveAuth(
                matchingInteractiveAuth.challengeId,
                promptResponses,
              );
            }}
            onCopyApprovalUrl={async () => {
              await navigator.clipboard.writeText(
                matchingInteractiveAuth.approvalUrl ?? "",
              );
            }}
            onReopenApprovalUrl={() => {
              void onReopenInteractiveAuthUrl();
            }}
            onClose={() => {
              setDismissedInteractiveEndpointId(
                matchingInteractiveAuth.endpointId,
              );
              onClearInteractiveAuth();
            }}
          />
        </div>
      ) : shouldShowConnectingOverlay ? (
        <div
          className="absolute inset-0 z-[3] grid place-items-center rounded-[20px] bg-[rgba(12,20,32,0.18)]"
          role="status"
          aria-live="polite"
          aria-label="SFTP host connection in progress"
        >
          <Card className="grid max-w-[20rem] justify-items-center gap-[0.45rem] px-[1.1rem] py-4 text-center">
            <div
              aria-hidden="true"
              className="h-5 w-5 animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--accent-strong)_18%,var(--border)_82%)] border-t-[var(--accent-strong)]"
            />
            <strong>
              {selectedHost
                ? `${selectedHost.label} 연결 중...`
                : "SFTP 연결 중..."}
            </strong>
            <span className="font-semibold text-[var(--text)]">
              {formatConnectionProgressStageLabel(
                pane.connectionProgress?.stage,
              )}
            </span>
            <span className="text-[0.9rem] leading-[1.5] text-[var(--text-soft)]">
              {pane.connectionProgress?.message ??
                "원격 파일 목록을 준비하고 있습니다."}
            </span>
          </Card>
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
    <div className="flex items-stretch gap-2 overflow-x-auto pb-[0.2rem]">
      {transfers.slice(0, 6).map((job) => {
        const progress =
          job.bytesTotal > 0
            ? Math.min(
                100,
                Math.round((job.bytesCompleted / job.bytesTotal) * 100),
              )
            : 0;
        return (
          <Card
            key={job.id}
            as="article"
            className={cn(
              "min-w-[360px] max-w-[360px] flex-none flex-col items-stretch justify-start gap-[0.35rem] rounded-[18px] px-[0.95rem] py-[0.85rem]",
              job.status === "failed" &&
                "border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border))]",
              job.status === "completed" &&
                "border-[color-mix(in_srgb,var(--success-text)_24%,var(--border))]",
            )}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[0.75rem]">
              <strong
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                title={buildTransferCardTitle(job)}
              >
                {buildTransferCardTitle(job)}
              </strong>
              <span
                className="min-w-0 justify-self-end whitespace-nowrap text-right"
                title={job.status}
              >
                {job.status}
              </span>
            </div>
            <div className="mt-[0.35rem] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[0.75rem] text-[0.86rem] text-[var(--text-soft)]">
              <span
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                title={buildTransferDirection(job)}
              >
                {buildTransferDirection(job)}
              </span>
              <span className="min-w-0 justify-self-end whitespace-nowrap text-right">
                {job.bytesTotal > 0 ? `${progress}%` : "--"}
              </span>
            </div>
            <div className="mt-[0.55rem] h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--surface-muted)_90%,transparent_10%)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress}%`,
                  background:
                    "linear-gradient(90deg, var(--accent-strong), color-mix(in srgb, var(--accent-strong) 60%, white 40%))",
                }}
              />
            </div>
            <div className="mt-[0.35rem] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[0.85rem] gap-y-[0.35rem] text-[0.86rem] text-[var(--text-soft)]">
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {formatSize(job.bytesCompleted)} / {formatSize(job.bytesTotal)}
              </span>
              {job.status === "running" ? (
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {formatTransferSpeed(job.speedBytesPerSecond) ??
                    "속도 계산 중"}
                  {formatEta(job.etaSeconds)
                    ? ` · ${formatEta(job.etaSeconds)}`
                    : ""}
                </span>
              ) : null}
              {job.status === "running" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="col-start-2 row-span-2 row-start-1 justify-self-end rounded-[12px] whitespace-nowrap"
                  onClick={() => void onCancelTransfer(job.id)}
                >
                  취소
                </Button>
              ) : null}
              {job.status === "failed" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="col-start-2 row-span-2 row-start-1 justify-self-end rounded-[12px] whitespace-nowrap"
                  onClick={() => void onRetryTransfer(job.id)}
                >
                  재시도
                </Button>
              ) : null}
              {job.status !== "running" && job.status !== "queued" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="col-start-2 row-span-2 row-start-1 justify-self-end rounded-[12px] whitespace-nowrap"
                  onClick={() => onDismissTransfer(job.id)}
                >
                  닫기
                </Button>
              ) : null}
            </div>
          </Card>
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
    <DialogBackdrop dismissOnBackdrop={false}>
      <ModalShell size="md">
        <ModalHeader>
          <div>
            <SectionLabel>Conflict</SectionLabel>
            <h3 className="m-0">같은 이름의 파일이 이미 존재합니다</h3>
          </div>
        </ModalHeader>
        <ModalBody>
          <p>{pendingConflictDialog.names.join(", ")}</p>
        </ModalBody>
        <ModalFooter>
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
    <DialogBackdrop onDismiss={onClose} dismissDisabled={dialog.isSubmitting}>
      <ModalShell size="md">
        <ModalHeader>
          <div>
            <SectionLabel>
              {dialog.mode === "mkdir" ? "New Folder" : "Rename"}
            </SectionLabel>
            <h3 className="m-0">{dialog.title}</h3>
          </div>
        </ModalHeader>
        <ModalBody>
          <Input
            value={dialog.value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={dialog.placeholder}
            autoFocus
            disabled={dialog.isSubmitting}
          />
        </ModalBody>
        <ModalFooter>
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
    <DialogBackdrop onDismiss={onClose} dismissDisabled={dialog.isSubmitting}>
      <ModalShell size="md">
        <ModalHeader>
          <div>
            <SectionLabel>Permissions</SectionLabel>
            <h3 className="m-0">{dialog.name} 권한 수정</h3>
          </div>
        </ModalHeader>
        <ModalBody>
          <div className="mt-4 grid grid-cols-[minmax(72px,auto)_repeat(3,minmax(54px,1fr))] items-center gap-x-[0.8rem] gap-y-[0.65rem]">
            <div />
            {columns.map((column) => (
              <strong key={column.key} className="text-center">
                {column.label}
              </strong>
            ))}
            {rows.map((row) => (
              <Fragment key={row.section}>
                <span>{row.label}</span>
                {columns.map((column) => (
                  <label
                    key={`${row.section}-${column.key}`}
                    className="grid place-items-center"
                  >
                    <input
                      type="checkbox"
                      className="m-0 h-4 w-4"
                      checked={dialog.matrix[row.section][column.key]}
                      onChange={() => onToggle(row.section, column.key)}
                      disabled={dialog.isSubmitting}
                    />
                  </label>
                ))}
              </Fragment>
            ))}
          </div>
          <div className="mt-[0.95rem] text-[0.9rem] text-[var(--text-soft)]">
            Mode {formatPermissionMode(mode)}
          </div>
        </ModalBody>
        <ModalFooter>
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
    <DialogBackdrop onDismiss={onClose} dismissDisabled={dialog.isSubmitting}>
      <ModalShell
        size="md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-delete-title"
        aria-label="SFTP delete confirmation"
      >
        <ModalHeader>
          <div>
            <SectionLabel>Delete</SectionLabel>
            <h3 id="sftp-delete-title" className="m-0">{title}</h3>
          </div>
        </ModalHeader>
        <ModalBody>
          {dialog.includesDirectory ? (
            <p className="rounded-[16px] border border-[color-mix(in_srgb,var(--danger-text)_22%,var(--border)_78%)] bg-[color-mix(in_srgb,var(--danger-bg)_72%,transparent_28%)] px-[0.9rem] py-[0.8rem] leading-[1.6]">
              폴더를 삭제하면 하위 항목도 함께 삭제됩니다.
            </p>
          ) : null}
          {dialog.errorMessage ? (
            <p className="text-[var(--danger-text)]">{dialog.errorMessage}</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
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
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4 max-[1040px]:grid-cols-1">
        {panes.map((pane, index) => {
          const connectActions = {
            onActivatePaneSource: (sourceKind: SftpSourceKind) =>
              onActivatePaneSource(pane.id, sourceKind),
          };

          const section = (
            <section
              key={pane.id}
              className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]"
            >
              <header className="flex items-center justify-between px-[1.1rem] pb-[0.75rem] pt-[1rem]">
                <div className="min-w-0 flex-1">
                  <h2>{getSftpPaneTitle(pane)}</h2>
                </div>
                {pane.sourceKind === "host" && pane.endpoint ? (
                  <IconButton
                    aria-label="연결 종료"
                    title="연결 종료"
                    size="sm"
                    className="h-[2.35rem] w-[2.35rem] rounded-[12px] text-[1.05rem] font-semibold"
                    onClick={() => void onDisconnectPane(pane.id)}
                  >
                    X
                  </IconButton>
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
                  className="flex min-h-0 w-14 flex-col items-center justify-center gap-[0.65rem] max-[1040px]:hidden"
                  aria-label="Pane transfer controls"
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-12 w-12 rounded-[16px] p-0 text-[1.2rem] font-bold whitespace-nowrap"
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
                    className="h-12 w-12 rounded-[16px] p-0 text-[1.2rem] font-bold whitespace-nowrap"
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
