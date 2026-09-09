import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Fuse from "fuse.js";
import { resolveContextMenuPosition } from "./contextMenuPosition";
import {
  collectGroupPaths,
  countHostsInGroupTree,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getGroupLabel,
  getHostSearchText,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath,
} from "@shared";
import type {
  ActivityLogRecord,
  GroupRecord,
  GroupRemoveMode,
  HomeHostViewMode,
  HostRecord,
  SecretMetadataRecord,
  SnippetRecord,
  SavedWorkspaceRecord,
  SshKeyGenerateInput,
  SshKeyInstallInput,
  SshKeyInstallResult,
} from "@shared";
import type { HomeSection, SettingsSection } from "../../store/types";
import { listSavedWorkspaceLeaves } from "../../store/utils";
import { getUnusedSavedCredentialsAfterHostDeletion } from "../../lib/host-secret-cleanup";
import {
  getKeyboardLayoutSearchQueries,
  matchesKeyboardLayoutQuery,
} from "../../lib/keyboard-layout-search";
import { useResponsiveCardGrid } from "../../lib/useResponsiveCardGrid";
import type { ParsedQuickSshCommand } from "@shared";
import type { DesktopPlatform } from "../DesktopWindowControls";
import { t } from "../../i18n";
import { buildLastConnectedByHostId } from "../../lib/last-connected";
import {
  buildHomeAssets,
  getHomeAssetRange,
  orderHomeAssetKeys,
  parseHomeAssetKey,
  partitionHomeAssetKeys,
  sortHomeAssets,
  toHomeAssetKey,
  type HomeAsset,
  type HomeAssetKey,
  type HomeAssetRef,
} from "./homeAssets";

export const HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX = 235;
export const HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX = 460;
export const HOME_BROWSER_CARD_GAP_PX = 13.6;
export const HOST_DRAG_MIME_TYPE = "application/x-dolssh-host-id";
export const HOSTS_DRAG_MIME_TYPE = "application/x-dolssh-host-ids";
export const HOME_ASSETS_DRAG_MIME_TYPE =
  "application/x-dolgate-home-assets";
export const GROUP_DRAG_MIME_TYPE = "application/x-dolssh-group-path";

// Serial·RDP 는 여기 없다 — 가져오기가 아니라 새로 만들기라서, New Host 폼 맨 위의
// 종류 셀렉터(SSH/Serial/RDP)로 옮겼다.
export const HOST_BROWSER_IMPORT_MENU_LABELS = [
  "Import Dolgate",
  "Import OpenSSH",
  "Import from Termius",
  "Import from Xshell",
  "Import from Warpgate",
  "Import via AWS SSM",
] as const;

export function getHostBrowserVisibleImportMenuLabels(
  desktopPlatform: DesktopPlatform,
): string[] {
  return desktopPlatform === "win32"
    ? [...HOST_BROWSER_IMPORT_MENU_LABELS]
    : HOST_BROWSER_IMPORT_MENU_LABELS.filter(
        (label) => label !== "Import from Xshell",
      );
}

export function getHostBrowserEmptyCalloutMessage(
  hostCount: number,
  searchQuery: string,
): string {
  return hostCount === 0
    ? t("hostBrowserEmpty.noHostsHint")
    : searchQuery
      ? t("hostBrowserEmpty.searchHint")
      : t("hostBrowserEmpty.addHint");
}

export type HostSortKey = "name" | "recent" | "group" | "lastConnected";

// 그룹 사이드바 정렬: 이름순 / 최근 사용순 / 호스트 많은 순.
/**
 * `manual` 은 사용자가 끌어서 정한 순서다(GroupRecord.sortRank).
 *
 * 기본값이다. 아무도 순서를 바꾼 적이 없으면 랭크가 전부 비어 있고, 그때 비교 규칙은
 * 이름순으로 떨어지므로 **예전과 같은 화면**이 나온다. 기본을 'name' 으로 두면 끌었을 때
 * 아무 일도 일어나지 않아, 사용자가 정렬 메뉴를 먼저 찾아야 한다.
 */
export type GroupSortKey = "manual" | "name" | "recent" | "count";
export type HostViewMode = HomeHostViewMode;

export interface GroupDeleteTarget {
  paths: string[];
  groupCount: number;
  title: string;
  hostCount: number;
  workspaceCount: number;
  childGroupCount: number;
}

export interface HostDeleteTarget {
  hostIds: string[];
  title: string;
  hostCount: number;
}

export interface AssetContextMenuState {
  kind: "asset";
  assetKeys: HomeAssetKey[];
  x: number;
  y: number;
}

export interface GroupContextMenuState {
  kind: "group";
  groupPaths: string[];
  x: number;
  y: number;
}

export type ContextMenuState = AssetContextMenuState | GroupContextMenuState;

export type GroupModalState =
  | { mode: "create"; parentPath?: string | null }
  | { mode: "rename"; path: string };

export interface GroupTreeRow {
  path: string;
  label: string;
  depth: number;
  parentPath: string | null;
  hasChildren: boolean;
  assetCount: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * savedWorkspaces 는 필수다 — 기본값 `[]` 를 두면 인자를 빼먹어도 컴파일이 통과하고, 그룹
 * 개수만 조용히 줄어든다(빈 그룹 숨김·그룹 삭제 경고가 Workspace 만 든 그룹을 놓친다).
 */
export function buildGroupTreeRows(
  groupPaths: string[],
  groups: GroupRecord[],
  hosts: HostRecord[],
  savedWorkspaces: readonly SavedWorkspaceRecord[],
): GroupTreeRow[] {
  const explicitGroupMap = new Map(groups.map((group) => [group.path, group]));
  const groupPathSet = new Set(groupPaths);
  return groupPaths.map((path) => ({
    path,
    label: explicitGroupMap.get(path)?.name ?? getGroupLabel(path),
    depth: Math.max(0, path.split("/").length - 1),
    parentPath: normalizeGroupPath(
      path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
    ),
    hasChildren: [...groupPathSet].some((candidate) =>
      candidate.startsWith(`${path}/`),
    ),
    assetCount:
      countHostsInGroupTree(hosts, path) +
      savedWorkspaces.filter((workspace) =>
        isGroupWithinPath(normalizeGroupPath(workspace.groupName), path),
      ).length,
  }));
}

// 그룹 트리를 계층 구조를 유지하며 정렬한다(부모 → 자식 DFS 순서). 같은 부모의 형제들만
// 정렬 키로 재배열하므로 들여쓰기/펼침 동작이 깨지지 않는다.
export function sortGroupTreeRows(
  rows: GroupTreeRow[],
  sortKey: GroupSortKey,
  recentByPath: Map<string, number>,
): GroupTreeRow[] {
  const byParent = new Map<string | null, GroupTreeRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentPath);
    if (siblings) {
      siblings.push(row);
    } else {
      byParent.set(row.parentPath, [row]);
    }
  }
  // 직접 순서는 들어온 배열이 이미 갖고 있다 — collectGroupPaths 가 랭크로 정렬하고
  // buildGroupTreeRows 가 그 순서를 유지한다. 여기서 다시 손대면 그 순서를 덮는다.
  if (sortKey === "manual") {
    return rows;
  }

  const compare = (a: GroupTreeRow, b: GroupTreeRow): number => {
    if (sortKey === "count") {
      return b.assetCount - a.assetCount || a.label.localeCompare(b.label);
    }
    if (sortKey === "recent") {
      return (
        (recentByPath.get(b.path) ?? 0) - (recentByPath.get(a.path) ?? 0) ||
        a.label.localeCompare(b.label)
      );
    }
    return a.label.localeCompare(b.label);
  };
  const ordered: GroupTreeRow[] = [];
  const walk = (parentPath: string | null) => {
    const children = (byParent.get(parentPath) ?? []).slice().sort(compare);
    for (const child of children) {
      ordered.push(child);
      walk(child.path);
    }
  };
  walk(null);
  return ordered;
}

export function isAdditiveSelectionEvent(
  event:
    | Pick<MouseEvent, "ctrlKey" | "metaKey">
    | Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return event.ctrlKey || event.metaKey;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

export function getHostNavigationStep(
  key: string,
  columns: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return -1;
    case "ArrowRight":
      return 1;
    case "ArrowUp":
      return -columns;
    case "ArrowDown":
      return columns;
    default:
      return null;
  }
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function getSelectionRange<T extends string>(
  items: T[],
  anchor: T | null,
  target: T,
): T[] {
  const targetIndex = items.indexOf(target);
  if (targetIndex < 0) {
    return [target];
  }
  const anchorIndex = anchor ? items.indexOf(anchor) : -1;
  if (anchorIndex < 0) {
    return [target];
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return items.slice(start, end + 1);
}

export function normalizeGroupSelectionForDelete(
  groupPaths: string[],
): string[] {
  return [...groupPaths]
    .filter(
      (path) =>
        !groupPaths.some(
          (candidate) =>
            candidate !== path && isGroupWithinPath(path, candidate),
        ),
    )
    .sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    );
}

export function buildNextGroupPath(
  groupPath: string,
  targetParentPath: string | null,
): string | null {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  if (!normalizedGroupPath) {
    return null;
  }
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  return normalizeGroupPath(
    normalizedTargetParentPath
      ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedGroupPath)}`
      : getGroupLabel(normalizedGroupPath),
  );
}

export function canReparentGroup(
  groupPath: string,
  targetParentPath: string | null,
): boolean {
  const normalizedGroupPath = normalizeGroupPath(groupPath);
  const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
  if (!normalizedGroupPath) {
    return false;
  }
  if (
    normalizedTargetParentPath &&
    isGroupWithinPath(normalizedTargetParentPath, normalizedGroupPath)
  ) {
    return false;
  }
  const nextGroupPath = buildNextGroupPath(
    normalizedGroupPath,
    normalizedTargetParentPath,
  );
  return Boolean(nextGroupPath && nextGroupPath !== normalizedGroupPath);
}

export function parseHostDragIds(payload: string): string[] {
  if (!payload) {
    return [];
  }
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

// 정렬 키별 기본 방향: 이름/그룹은 오름차순(가나다), 시간 계열은 내림차순(최신 먼저).
export function defaultHostSortDirection(key: HostSortKey): "asc" | "desc" {
  return key === "name" || key === "group" ? "asc" : "desc";
}

function sortHosts(
  hosts: HostRecord[],
  sortKey: HostSortKey,
  sortDirection: "asc" | "desc",
  lastConnectedByHostId: Map<string, number>,
): HostRecord[] {
  // 각 비교자는 오름차순 기준이고 방향(dir)으로 부호를 뒤집는다. 동률은 항상 이름 오름차순.
  const dir = sortDirection === "desc" ? -1 : 1;
  const byName = (a: HostRecord, b: HostRecord) =>
    a.label.localeCompare(b.label);
  if (sortKey === "group") {
    return [...hosts].sort(
      (a, b) =>
        dir *
          (normalizeGroupPath(a.groupName) ?? "").localeCompare(
            normalizeGroupPath(b.groupName) ?? "",
          ) || byName(a, b),
    );
  }
  if (sortKey === "lastConnected") {
    return [...hosts].sort((a, b) => {
      const ta = lastConnectedByHostId.get(a.id) ?? 0;
      const tb = lastConnectedByHostId.get(b.id) ?? 0;
      return dir * (ta - tb) || byName(a, b);
    });
  }
  if (sortKey === "recent") {
    return [...hosts].sort(
      (a, b) =>
        dir * (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "") ||
        byName(a, b),
    );
  }
  return [...hosts].sort((a, b) => dir * byName(a, b));
}

/**
 * 명령 팔레트 후보 순서: 즐겨찾기 → 최근 사용 → 이름. **목록 정렬과 별개다** — 팔레트는 이름을
 * 쳐서 건너가는 곳이라, 목록 정렬을 이름 역순으로 바꾼 순간 기본 후보가 z 로 시작하는 것들로
 * 바뀌면 안 된다(호스트 쪽 getDefaultHostCandidates 와 같은 성격).
 */
function compareWorkspacesForPalette(
  left: SavedWorkspaceRecord,
  right: SavedWorkspaceRecord,
): number {
  const favoriteDifference = Number(right.favorite) - Number(left.favorite);
  if (favoriteDifference !== 0) {
    return favoriteDifference;
  }
  const rightRecent = Date.parse(right.lastOpenedAt ?? "") || 0;
  const leftRecent = Date.parse(left.lastOpenedAt ?? "") || 0;
  return rightRecent - leftRecent || left.name.localeCompare(right.name);
}

export interface UseHostBrowserParams {
  desktopPlatform: DesktopPlatform;
  hosts: HostRecord[];
  savedWorkspaces?: readonly SavedWorkspaceRecord[];
  groups: GroupRecord[];
  keychainEntries: SecretMetadataRecord[];
  currentGroupPath: string | null;
  /**
   * 홈의 호스트 화면이 지금 보이는 화면인지. 홈 셸은 세션 탭이 활성일 때도 마운트된 채
   * 숨겨지기만 하므로, 창 전역 키 처리는 이 값을 봐야 터미널을 쓰는 중에 끼어들지 않는다.
   */
  active?: boolean;
  searchQuery: string;
  hostViewMode?: HostViewMode;
  selectedHostId: string | null;
  /**
   * 단일 선택을 상위가 막을 수 있게 한다. false 를 주면 내부 선택도 움직이지 않는다.
   *
   * 편집 중에는 상위가 "저장하지 않은 변경" 을 물어본 뒤에 선택을 옮긴다. 내부 상태만 먼저
   * 움직이면 목록 하이라이트와 우측 패널이 서로 다른 호스트를 가리킨다(실제로 그랬다).
   */
  canSelectHost?: (
    hostId: string,
    options?: { reason?: "click" | "menu" },
  ) => boolean;
  /**
   * 호스트가 아닌 항목(Workspace)을 고르려면 호스트 편집기를 떠나야 한다 — 상위가 가로챈다.
   *
   * canSelectHost 가 hostId 를 받는 탓에 예전에는 host 분기에만 가드가 걸려 있었고, Workspace
   * 카드를 누르면 저장 확인이 뜨지 않은 채 선택만 반쯤 움직였다(센터는 Workspace, 우측은 옛 호스트
   * 편집기).
   *
   * **거부가 아니라 "이어서 실행" 이다**(onLeaveGroupScope 와 같은 모양). 거부만 하면 확인을 받은
   * 뒤 선택을 다시 실행할 주체가 없어 편집기만 닫히고 사용자의 클릭이 사라진다. 상위는 물어볼
   * 필요가 없으면 즉시, 물어봤으면 사용자가 답한 뒤에 `proceed()` 를 부른다. 우클릭(menu)처럼
   * 물어보지 않기로 한 경우에는 아무것도 부르지 않는다.
   */
  onLeaveHostEditor?: (
    proceed: () => void,
    options?: { reason?: "click" | "menu" },
  ) => void;
  /**
   * 그룹 이동(그룹 카드·트리 클릭, All Hosts 복귀)을 상위가 가로챈다.
   *
   * **거부가 아니라 "이어서 실행" 이다.** 거부만 하면 확인을 받은 뒤 이동을 다시 실행할 주체가
   * 없어서 편집기만 닫히고 이동이 사라진다(실제로 그랬다). 상위는 물어볼 필요가 없으면 즉시,
   * 물어봤으면 사용자가 답한 뒤에 `proceed()` 를 부른다.
   */
  onLeaveGroupScope?: (proceed: () => void) => void;
  activityLogs?: ActivityLogRecord[];
  snippets?: SnippetRecord[];
  onSetHostFavorite: (
    hostId: string,
    favorite: boolean,
  ) => void | Promise<void>;
  errorMessage?: string | null;
  statusMessage?: string | null;
  onSearchChange: (query: string) => void;
  onHostViewModeChange?: (mode: HostViewMode) => void | Promise<void>;
  onOpenLocalTerminal: () => void;
  onCreateHost: () => void;
  onOpenDolgateImport: () => void;
  onOpenAwsImport: () => void;
  onOpenOpenSshImport: () => void;
  onOpenXshellImport: () => void;
  onOpenTermiusImport: () => void;
  onOpenWarpgateImport: () => void;
  onCreateGroup: (name: string, parentPath?: string | null) => Promise<void>;
  onRemoveGroup: (path: string, mode: GroupRemoveMode) => Promise<void>;
  onMoveGroup: (path: string, targetParentPath: string | null) => Promise<void>;
  /** 직접 정렬에서 자리를 옮긴다(부모가 바뀌면 이동까지 함께). */
  onReorderGroup: (
    path: string,
    targetParentPath: string | null,
    targetIndex: number,
  ) => Promise<void>;
  onRenameGroup: (path: string, name: string) => Promise<void>;
  onNavigateGroup: (path: string | null) => void;
  onClearHostSelection: () => void;
  onSelectHost: (hostId: string) => void;
  onEditHost: (hostId: string) => void;
  onDuplicateHosts: (hostIds: string[]) => Promise<void>;
  onExportAssets: (assets: HomeAssetRef[]) => void;
  onMoveHostToGroup: (
    hostId: string,
    groupPath: string | null,
  ) => Promise<void>;
  onMoveSavedWorkspaceToGroup: (
    workspaceId: string,
    groupPath: string | null,
  ) => Promise<unknown>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onRemoveSecret: (secretRef: string) => Promise<void>;
  onConnectHost: (hostId: string) => Promise<void>;
  onOpenHostInNewWindow?: (hostId: string) => Promise<void>;
  onConnectHostTmux?: (hostId: string) => Promise<void>;
  onOpenHostContainers: (hostId: string) => Promise<void>;
  onOpenSftp?: (hostId: string) => void | Promise<void>;
  onSelectSection?: (section: HomeSection) => void;
  onActivateSftp?: () => void | Promise<void>;
  onActivateContainers?: () => void | Promise<void>;
  onOpenSettingsSection?: (section: SettingsSection) => void | Promise<void>;
  onQuickConnectSsh?: (input: ParsedQuickSshCommand) => Promise<void>;
  detailTab?: "overview" | "connection";
  onDetailTabChange?: (tab: "overview" | "connection") => void;
  onOpenReplay?: (recordingId: string) => void | Promise<void>;
  onGenerateAndInstallSshKey?: (
    hostId: string,
    input: SshKeyGenerateInput,
  ) => Promise<void>;
  onInstallSshPublicKey?: (
    input: SshKeyInstallInput,
  ) => Promise<SshKeyInstallResult>;
}

/**
 * 홈 호스트 브라우저의 모든 상호작용 상태(선택/드래그/컨텍스트메뉴/모달)와 파생값,
 * 핸들러를 한 곳에 모은 훅. 사이드바·호스트 목록·상세 패널 세 region이 이 모델을
 * 공유한다. 드래그 hover 등 고빈도·렌더결합·비영속 상태라 Zustand로 올리지 않는다.
 */
export function useHostBrowser(params: UseHostBrowserParams) {
  const {
    hosts,
    savedWorkspaces = [],
    groups,
    keychainEntries,
    currentGroupPath,
    searchQuery,
    selectedHostId,
    canSelectHost,
    onLeaveHostEditor,
    onLeaveGroupScope,
    onClearHostSelection,
    onSelectHost,
    onNavigateGroup,
    onMoveGroup,
    onReorderGroup,
    onMoveHostToGroup,
    onMoveSavedWorkspaceToGroup,
  } = params;

  const [groupModalState, setGroupModalState] =
    useState<GroupModalState | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const initialFocusedAssetKey = selectedHostId
    ? (`host:${selectedHostId}` as const)
    : null;
  const [selectedAssetKeys, setSelectedAssetKeys] = useState<HomeAssetKey[]>(
    initialFocusedAssetKey ? [initialFocusedAssetKey] : [],
  );
  const [focusedAssetKey, setFocusedAssetKey] =
    useState<HomeAssetKey | null>(initialFocusedAssetKey);
  const [assetSelectionAnchorKey, setAssetSelectionAnchorKey] =
    useState<HomeAssetKey | null>(initialFocusedAssetKey);
  // 편집 전환처럼 상위가 Host 선택을 직접 바꾸는 경로만 Home Asset 포커스로 동기화한다.
  // Workspace를 고르며 상위 Host 선택을 비우는 경우에는 Workspace 선택을 지우지 않는다.
  useEffect(() => {
    if (!selectedHostId) {
      // Workspace 포커스를 위해 Host 선택만 비운 경우는 유지한다.
      // New Host·가져오기 등 상위에서 Host 선택을 해제한 경우는 카드도 비운다.
      if (!focusedAssetKey?.startsWith("workspace:")) {
        setSelectedAssetKeys([]);
        setFocusedAssetKey(null);
        setAssetSelectionAnchorKey(null);
      }
      return;
    }
    const key = `host:${selectedHostId}` as HomeAssetKey;
    setSelectedAssetKeys((current) =>
      current.includes(key) ? current : [key],
    );
    setFocusedAssetKey(key);
    setAssetSelectionAnchorKey(key);
  }, [selectedHostId]);
  const [selectedGroupPaths, setSelectedGroupPaths] = useState<string[]>([]);
  const [groupSelectionAnchor, setGroupSelectionAnchor] = useState<
    string | null
  >(null);
  const [groupDeleteTarget, setGroupDeleteTarget] =
    useState<GroupDeleteTarget | null>(null);
  const [groupDeleteError, setGroupDeleteError] = useState<string | null>(null);
  const [isRemovingGroup, setIsRemovingGroup] = useState(false);
  const [hostDeleteTarget, setHostDeleteTarget] =
    useState<HostDeleteTarget | null>(null);
  const [hostDeleteError, setHostDeleteError] = useState<string | null>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [removeUnusedSecretsOnHostDelete, setRemoveUnusedSecretsOnHostDelete] =
    useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuStyle, setContextMenuStyle] =
    useState<CSSProperties | null>(null);
  const [dragTargetGroupPath, setDragTargetGroupPath] = useState<string | null>(
    null,
  );
  const [draggedAssetKeys, setDraggedAssetKeys] = useState<HomeAssetKey[]>([]);
  const [draggedGroupPath, setDraggedGroupPath] = useState<string | null>(null);
  const [isRootDragTarget, setIsRootDragTarget] = useState(false);
  /**
   * 형제 사이에 놓을 자리 표시. `직접` 정렬일 때만 쓴다 — 다른 정렬에서는 놓아도 그 기준대로
   * 다시 배치되므로 있지도 않은 자리를 그리게 된다.
   */
  const [groupDropEdge, setGroupDropEdge] = useState<{
    path: string;
    edge: "before" | "after";
  } | null>(null);
  const [expandedHostTags, setExpandedHostTags] = useState<string[]>([]);
  const [isImportMenuOpen, setIsImportMenuOpen] = useState(false);
  const [collapsedTreeGroupPaths, setCollapsedTreeGroupPaths] = useState<
    string[]
  >([]);
  // 신규: 태그 필터 / 정렬 / 뷰 모드.
  const [activeTagFilter, setActiveTagFilter] = useState<string[]>([]);
  const [favoritesFilterActive, setFavoritesFilterActive] = useState(false);
  const [sortKey, setSortKey] = useState<HostSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  function setSort(key: HostSortKey, direction?: "asc" | "desc") {
    setSortKey(key);
    setSortDirection(direction ?? defaultHostSortDirection(key));
  }
  // 테이블 헤더 클릭: 같은 키면 방향 토글, 다른 키면 그 키의 기본 방향으로.
  function toggleSort(key: HostSortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
    }
  }
  const [groupSortKey, setGroupSortKey] = useState<GroupSortKey>("manual");
  const [hideEmptyGroups, setHideEmptyGroups] = useState(false);
  const viewMode = params.hostViewMode ?? "grid";
  const setViewMode: (mode: HostViewMode) => void | Promise<void> =
    params.onHostViewModeChange ?? (() => undefined);
  const importMenuRef = useRef<HTMLDivElement | null>(null);

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

  // 현재 그룹 안에서는 그 하위 트리만 검색하고, 루트에서는 전체 호스트를 그대로 보여준다.
  const scopedHosts = useMemo(
    () => filterHostsInGroupTree(hosts, currentGroupPath),
    [currentGroupPath, hosts],
  );

  const searchableHosts = useMemo(
    () =>
      scopedHosts.map((host) => ({
        ...host,
        searchText: getHostSearchText(host).join(" "),
      })),
    [scopedHosts],
  );

  const fuse = useMemo(
    () =>
      new Fuse(searchableHosts, {
        keys: ["label", "groupName", "searchText"],
        threshold: 0.32,
      }),
    [searchableHosts],
  );
  const searchQueries = useMemo(
    () => getKeyboardLayoutSearchQueries(searchQuery),
    [searchQuery],
  );

  const searchedHosts = useMemo<HostRecord[]>(() => {
    if (searchQueries.length > 0) {
      const seenHostIds = new Set<string>();
      return searchQueries.flatMap((query) =>
        fuse.search(query).flatMap((result) => {
          if (seenHostIds.has(result.item.id)) {
            return [];
          }
          seenHostIds.add(result.item.id);
          const { searchText: _searchText, ...host } = result.item;
          return [host];
        }),
      );
    }
    return searchableHosts.map(({ searchText: _searchText, ...host }) => host);
  }, [fuse, searchableHosts, searchQueries]);

  // 태그 집계(현재 그룹 스코프 기준).
  const tagCounts = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    for (const host of scopedHosts) {
      for (const tag of host.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [scopedHosts]);

  // 즐겨찾기는 호스트 레코드의 favorite 필드에서 파생(영속·동기화됨).
  const favoriteHostIds = useMemo(
    () => hosts.filter((host) => host.favorite === true).map((host) => host.id),
    [hosts],
  );
  const favoriteHostIdSet = useMemo(
    () => new Set(favoriteHostIds),
    [favoriteHostIds],
  );

  // 활동 로그에서 호스트별 마지막 연결 시각(ms). "최근 연결순" 정렬에 쓴다.
  const lastConnectedByHostId = useMemo(
    () => buildLastConnectedByHostId(params.activityLogs),
    [params.activityLogs],
  );

  // 검색 → 즐겨찾기 → 태그 필터 → 정렬 순으로 최종 표시 목록을 만든다.
  const visibleHosts = useMemo(() => {
    let next = searchedHosts;
    if (favoritesFilterActive) {
      next = next.filter((host) => favoriteHostIdSet.has(host.id));
    }
    if (activeTagFilter.length > 0) {
      next = next.filter((host) =>
        activeTagFilter.every((tag) => (host.tags ?? []).includes(tag)),
      );
    }
    return sortHosts(next, sortKey, sortDirection, lastConnectedByHostId);
  }, [
    searchedHosts,
    favoritesFilterActive,
    favoriteHostIdSet,
    activeTagFilter,
    sortKey,
    sortDirection,
    lastConnectedByHostId,
  ]);

  const searchedWorkspaces = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) {
      return [...savedWorkspaces];
    }
    return savedWorkspaces.filter((workspace) => {
      const labels = listSavedWorkspaceLeaves(workspace.root).map(
        (leaf) => leaf.target.label,
      );
      return matchesKeyboardLayoutQuery(
        [workspace.name, ...labels].join(" "),
        query,
      );
    });
  }, [savedWorkspaces, searchQuery]);

  /**
   * 명령 팔레트가 쓰는 Workspace 후보. **검색어만** 적용하고 그룹 스코프·태그·즐겨찾기 필터는
   * 적용하지 않는다 — 팔레트의 호스트 항목은 hb.hosts(전체)에서 나오므로 여기만 좁히면 같은
   * 드롭다운이 종류마다 다른 범위로 동작한다. 실제로 그룹 안에서는 다른 그룹의 호스트는 뜨는데
   * Workspace 는 안 떴다.
   */
  const paletteWorkspaces = useMemo(
    () => [...searchedWorkspaces].sort(compareWorkspacesForPalette),
    [searchedWorkspaces],
  );

  const favoriteWorkspaceCount = useMemo(
    () => savedWorkspaces.filter((workspace) => workspace.favorite).length,
    [savedWorkspaces],
  );

  const visibleWorkspaces = useMemo(() => {
    // 태그는 호스트만 가진 필드다 — 태그를 고르면 Workspace 는 보이지 않는다(의도된 동작).
    if (activeTagFilter.length > 0) {
      return [];
    }
    let next = currentGroupPath
      ? searchedWorkspaces.filter((workspace) =>
          isGroupWithinPath(
            normalizeGroupPath(workspace.groupName),
            currentGroupPath,
          ),
        )
      : searchedWorkspaces;
    if (favoritesFilterActive) {
      next = next.filter((workspace) => workspace.favorite);
    }
    // 정렬하지 않는다 — 화면 순서는 호스트와 한 벌로 visibleAssets 에서 정한다.
    return next;
  }, [
    activeTagFilter,
    currentGroupPath,
    favoritesFilterActive,
    searchedWorkspaces,
  ]);

  // 정렬은 **여기서 한 번만** 걸린다. 종류별로 정렬해 이어 붙이면 목록이 "Workspace 전부 →
  // 호스트 전부" 두 덩어리가 되어, 머리글에 정렬 화살표가 켜져 있는데도 이름순 Z 인 Workspace 가
  // A 인 호스트보다 위에 남는다(sortHomeAssets 주석 참고).
  const visibleAssets = useMemo(
    () =>
      sortHomeAssets(
        buildHomeAssets(visibleWorkspaces, visibleHosts),
        sortKey,
        sortDirection,
        lastConnectedByHostId,
      ),
    [
      lastConnectedByHostId,
      sortDirection,
      sortKey,
      visibleHosts,
      visibleWorkspaces,
    ],
  );
  const visibleAssetKeys = useMemo(
    () => visibleAssets.map((asset) => asset.key),
    [visibleAssets],
  );
  const { hostIds: selectedHostIds, workspaceIds: selectedWorkspaceIds } =
    partitionHomeAssetKeys(selectedAssetKeys);

  const allGroupPaths = useMemo(
    () => collectGroupPaths(groups, hosts, savedWorkspaces),
    [groups, hosts, savedWorkspaces],
  );
  const groupTreeRows = useMemo(
    () => buildGroupTreeRows(allGroupPaths, groups, hosts, savedWorkspaces),
    [allGroupPaths, groups, hosts, savedWorkspaces],
  );
  // 그룹별 최근 사용 시각(ms): 그룹 서브트리 내 호스트 활동의 최댓값(조상 경로에도 전파).
  const groupRecentByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const host of hosts) {
      const ms = lastConnectedByHostId.get(host.id) ?? 0;
      if (ms <= 0) {
        continue;
      }
      let path = normalizeGroupPath(host.groupName ?? null);
      while (path) {
        map.set(path, Math.max(map.get(path) ?? 0, ms));
        path = normalizeGroupPath(
          path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
        );
      }
    }
    return map;
  }, [hosts, lastConnectedByHostId]);
  const sortedGroupTreeRows = useMemo(
    () => sortGroupTreeRows(groupTreeRows, groupSortKey, groupRecentByPath),
    [groupTreeRows, groupSortKey, groupRecentByPath],
  );

  /** 끌어서 순서를 바꿀 수 있는 상태인가. 다른 정렬에서는 놓자마자 제자리로 튄다. */
  const canReorderGroups = groupSortKey === "manual";

  /**
   * "이 행 위/아래" 를 부모와 index 로 옮긴다.
   *
   * index 는 **끌고 있는 그룹을 뺀 뒤**의 형제 목록 기준이다 — 스토어의 planGroupReorder 가
   * 먼저 빼고 끼워 넣으므로, 그대로 세면 아래로 옮길 때 한 칸 어긋난다.
   */
  const resolveGroupDropTarget = useCallback(
    (rowPath: string, edge: "before" | "after", draggedPath: string) => {
      const row = sortedGroupTreeRows.find(
        (candidate) => candidate.path === rowPath,
      );
      if (!row) {
        return null;
      }
      const siblings = sortedGroupTreeRows.filter(
        (candidate) =>
          candidate.parentPath === row.parentPath &&
          candidate.path !== draggedPath,
      );
      const anchor = siblings.findIndex(
        (candidate) => candidate.path === rowPath,
      );
      if (anchor < 0) {
        return null;
      }
      return {
        parentPath: row.parentPath,
        index: edge === "before" ? anchor : anchor + 1,
      };
    },
    [sortedGroupTreeRows],
  );
  const expandAllGroups = () => setCollapsedTreeGroupPaths([]);
  const collapseAllGroups = () =>
    setCollapsedTreeGroupPaths(
      groupTreeRows.filter((row) => row.hasChildren).map((row) => row.path),
    );
  const collapsedTreeGroupPathSet = useMemo(
    () => new Set(collapsedTreeGroupPaths),
    [collapsedTreeGroupPaths],
  );
  const visibleGroupTreeRows = useMemo(
    () =>
      sortedGroupTreeRows.filter((group) => {
        if (hideEmptyGroups && group.assetCount === 0) {
          return false;
        }
        let ancestorPath = group.parentPath;
        while (ancestorPath) {
          if (collapsedTreeGroupPathSet.has(ancestorPath)) {
            return false;
          }
          ancestorPath = normalizeGroupPath(
            ancestorPath.includes("/")
              ? ancestorPath.slice(0, ancestorPath.lastIndexOf("/"))
              : null,
          );
        }
        return true;
      }),
    [collapsedTreeGroupPathSet, sortedGroupTreeRows, hideEmptyGroups],
  );
  // 화면 순서에서 호스트만 걸러 낸다. visibleHosts 를 따로 정렬해 쓰면 두 순서가 갈릴 수
  // 있는데, 이 값은 "화면에 보이는 순서" 로 쓰인다(선택 순회·삭제 대화상자 목록).
  const visibleHostIds = useMemo(
    () =>
      visibleAssets.flatMap((asset) =>
        asset.kind === "host" ? [asset.id] : [],
      ),
    [visibleAssets],
  );
  const visibleGroupPaths = useMemo(
    () => visibleGroupTreeRows.map((group) => group.path),
    [visibleGroupTreeRows],
  );

  const {
    ref: hostGridRef,
    style: hostGridStyle,
    layout: hostGridLayout,
  } = useResponsiveCardGrid({
    itemCount: visibleHosts.length + visibleWorkspaces.length,
    minWidth: HOME_BROWSER_HOST_CARD_MIN_WIDTH_PX,
    maxWidth: HOME_BROWSER_HOST_CARD_MAX_WIDTH_PX,
    gap: HOME_BROWSER_CARD_GAP_PX,
  });
  const clampedHostCardStyle =
    hostGridLayout.justifyContent === "start" && hostGridLayout.cardWidth
      ? { width: "100%", maxWidth: `${hostGridLayout.cardWidth}px` }
      : undefined;

  const currentGroupPathLabel = currentGroupPath
    ? currentGroupPath.split("/").join(" / ")
    : "All Groups";
  const searchPlaceholder = currentGroupPath
    ? `Search hosts inside ${currentGroupPathLabel}`
    : "Search hosts and Workspaces";
  const emptyMessage =
    hosts.length === 0
      ? t("hostBrowserEmpty.noHosts")
      : searchQuery
        ? t("hostBrowserEmpty.noResults")
        : t("hostBrowserEmpty.noHostsHere");
  const groupDeleteDialogVariant = groupDeleteTarget
    ? getGroupDeleteDialogVariant(
        groupDeleteTarget.childGroupCount,
        groupDeleteTarget.hostCount + groupDeleteTarget.workspaceCount,
      )
    : null;
  const hostDeleteUnusedLocalSecretRefs = useMemo(
    () =>
      hostDeleteTarget
        ? getUnusedSavedCredentialsAfterHostDeletion(
            hosts,
            keychainEntries,
            hostDeleteTarget.hostIds,
          )
        : [],
    [hostDeleteTarget, hosts, keychainEntries],
  );
  /**
   * 메뉴가 뜨면 **실제로 렌더된 크기를 재서** 화면 안으로 접어 넣는다.
   *
   * 항목 수가 대상(호스트/그룹)과 선택 개수에 따라 달라지므로 상수 추정은 맞을 수가 없다 — 예전에는
   * 높이를 72px 로 어림해서, 목록 아래쪽 호스트를 우클릭하면 메뉴가 화면 밖으로 잘렸다.
   *
   * useLayoutEffect 라 paint 전에 보정 위치가 적용돼 깜빡임이 없다(SFTP 판의 메뉴와 같은 방식).
   */
  useLayoutEffect(() => {
    if (!contextMenu) {
      setContextMenuStyle(null);
      return;
    }
    const element = contextMenuRef.current;
    const placement = resolveContextMenuPosition({
      x: contextMenu.x,
      y: contextMenu.y,
      width: element?.offsetWidth || 196,
      // scrollHeight 를 함께 본다: 앞서 열린 메뉴가 화면보다 커서 maxHeight 로 접혔다면 이번 첫
      // 프레임에도 그 값이 남아 있어 offsetHeight 가 접힌 높이로 나온다. 그 값으로 자리를 잡으면
      // 실제보다 짧다고 보고 아래로 펼쳐서 다시 잘린다.
      height:
        Math.max(element?.scrollHeight ?? 0, element?.offsetHeight ?? 0) || 220,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setContextMenuStyle({
      left: placement.left,
      top: placement.top,
      maxHeight: placement.maxHeight,
      // 화면보다 큰 메뉴만 스크롤된다. 잘라 버리면 마지막 항목을 누를 방법이 없다.
      overflowY: "auto",
    });
  }, [contextMenu]);

  useEffect(() => {
    setCollapsedTreeGroupPaths((current) =>
      current.filter((path) => allGroupPaths.includes(path)),
    );
  }, [allGroupPaths]);

  useEffect(() => {
    setSelectedAssetKeys((current) =>
      current.filter((key) => visibleAssetKeys.includes(key)),
    );
  }, [visibleAssetKeys]);

  useEffect(() => {
    if (focusedAssetKey && !visibleAssetKeys.includes(focusedAssetKey)) {
      const nextFocus =
        selectedAssetKeys.find((key) => visibleAssetKeys.includes(key)) ?? null;
      setFocusedAssetKey(nextFocus);
      // 포커스를 옮기는 다른 모든 경로처럼 상위의 선택도 같이 옮긴다. 이것만 빠져 있어서,
      // 동기화가 포커스된 항목을 지우면 목록은 다음 항목을 고른 것처럼 보이는데 우측 상세는
      // "선택된 것이 없습니다" 를 그리거나 이미 없는 호스트를 가리켰다.
      const focusedRef = nextFocus ? parseHomeAssetKey(nextFocus) : null;
      if (focusedRef?.kind === "host") {
        onSelectHost(focusedRef.id);
      } else {
        onClearHostSelection();
      }
    }
  }, [focusedAssetKey, selectedAssetKeys, visibleAssetKeys]);

  const keyboardActive = params.active !== false;

  useEffect(() => {
    if (!keyboardActive) {
      return;
    }
    const handleSelectAllAssets = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLocaleLowerCase() !== "a" ||
        isEditableKeyboardTarget(event.target) ||
        // alertdialog 도 모달이다. 파괴적인 확인창(Workspace 삭제)이 그 role 을 쓰는데,
        // dialog 만 보던 동안 그 창이 떠 있어도 이 전역 키 처리가 계속 돌아 뒤쪽 목록의 선택을
        // 바꾸고 포커스를 카드로 끌어갔다(그래서 Enter 가 확인을 누르지 못했다).
        document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        )
      ) {
        return;
      }

      event.preventDefault();
      setSelectedAssetKeys(visibleAssetKeys);
      setSelectedGroupPaths([]);
      setAssetSelectionAnchorKey(visibleAssetKeys[0] ?? null);
      setFocusedAssetKey((current) => current ?? visibleAssetKeys[0] ?? null);
      setGroupSelectionAnchor(null);
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleSelectAllAssets);
    return () => window.removeEventListener("keydown", handleSelectAllAssets);
  }, [keyboardActive, visibleAssetKeys]);

  useEffect(() => {
    if (!keyboardActive) {
      return;
    }
    const handleArrowNavigation = (event: KeyboardEvent) => {
      const step = getHostNavigationStep(
        event.key,
        viewMode === "list" ? 1 : Math.max(1, hostGridLayout.columns),
      );
      if (
        step === null ||
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        isEditableKeyboardTarget(event.target) ||
        // alertdialog 도 모달이다. 파괴적인 확인창(Workspace 삭제)이 그 role 을 쓰는데,
        // dialog 만 보던 동안 그 창이 떠 있어도 이 전역 키 처리가 계속 돌아 뒤쪽 목록의 선택을
        // 바꾸고 포커스를 카드로 끌어갔다(그래서 Enter 가 확인을 누르지 못했다).
        document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        )
      ) {
        return;
      }
      if (selectedGroupPaths.length > 0 || selectedAssetKeys.length > 1) {
        return;
      }
      const currentKey = focusedAssetKey ?? selectedAssetKeys[0];
      if (!currentKey) {
        return;
      }
      const currentIndex = visibleAssetKeys.indexOf(currentKey);
      if (currentIndex < 0) {
        return;
      }
      const nextIndex = Math.min(
        Math.max(currentIndex + step, 0),
        visibleAssetKeys.length - 1,
      );
      event.preventDefault();
      if (nextIndex === currentIndex) {
        return;
      }
      const nextKey = visibleAssetKeys[nextIndex];
      selectSingleAsset(parseHomeAssetKey(nextKey));
      requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>(
          `[data-home-asset-key="${cssEscape(nextKey)}"]`,
        );
        element?.scrollIntoView?.({ block: "nearest" });
        element?.focus?.({ preventScroll: true });
      });
    };

    window.addEventListener("keydown", handleArrowNavigation);
    return () => window.removeEventListener("keydown", handleArrowNavigation);
    // 가드(canSelectHost/canLeaveHostEditor)는 상위가 렌더마다 새로 만들어 넘긴다. 여기 넣지
    // 않으면 리스너가 호스트 편집기가 닫혀 있던 시절의 가드를 붙들고 있어, 편집 중에 방향키로
    // 선택을 옮길 때 저장 확인이 뜨지 않는다.
  }, [
    canSelectHost,
    focusedAssetKey,
    onLeaveHostEditor,
    hostGridLayout.columns,
    keyboardActive,
    selectedAssetKeys,
    selectedGroupPaths,
    viewMode,
    visibleAssetKeys,
  ]);

  useEffect(() => {
    setSelectedGroupPaths((current) =>
      current.filter((groupPath) => visibleGroupPaths.includes(groupPath)),
    );
  }, [visibleGroupPaths]);

  useEffect(() => {
    if (
      assetSelectionAnchorKey &&
      !visibleAssetKeys.includes(assetSelectionAnchorKey)
    ) {
      setAssetSelectionAnchorKey(null);
    }
  }, [assetSelectionAnchorKey, visibleAssetKeys]);

  useEffect(() => {
    if (
      groupSelectionAnchor &&
      !visibleGroupPaths.includes(groupSelectionAnchor)
    ) {
      setGroupSelectionAnchor(null);
    }
  }, [groupSelectionAnchor, visibleGroupPaths]);

  useEffect(() => {
    setExpandedHostTags((current) =>
      current.filter((hostId) =>
        hosts.some(
          (host) => host.id === hostId && (host.tags?.length ?? 0) > 0,
        ),
      ),
    );
  }, [hosts]);

  useEffect(() => {
    // 태그가 사라지면 필터에서 제거.
    const known = new Set(tagCounts.map((entry) => entry.tag));
    setActiveTagFilter((current) => current.filter((tag) => known.has(tag)));
  }, [tagCounts]);

  useEffect(() => {
    setRemoveUnusedSecretsOnHostDelete(
      hostDeleteUnusedLocalSecretRefs.length > 0,
    );
  }, [hostDeleteTarget, hostDeleteUnusedLocalSecretRefs.length]);

  useEffect(() => {
    if (!isImportMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!importMenuRef.current?.contains(event.target as Node)) {
        setIsImportMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsImportMenuOpen(false);
      }
    };
    const handleResize = () => setIsImportMenuOpen(false);
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [isImportMenuOpen]);

  function clearSelections() {
    setSelectedAssetKeys([]);
    setSelectedGroupPaths([]);
    setAssetSelectionAnchorKey(null);
    setFocusedAssetKey(null);
    setGroupSelectionAnchor(null);
    setContextMenu(null);
    onClearHostSelection();
  }

  function buildGroupDeleteTarget(groupPaths: string[]): GroupDeleteTarget {
    const normalizedPaths = normalizeGroupSelectionForDelete(groupPaths);
    const normalizedPathSet = new Set(normalizedPaths);
    const hostCount = hosts.filter((host) =>
      normalizedPaths.some((path) =>
        isGroupWithinPath(normalizeGroupPath(host.groupName), path),
      ),
    ).length;
    const workspaceCount = savedWorkspaces.filter((workspace) =>
      normalizedPaths.some((path) =>
        isGroupWithinPath(normalizeGroupPath(workspace.groupName), path),
      ),
    ).length;
    const childGroupCount = allGroupPaths.filter(
      (candidatePath) =>
        !normalizedPathSet.has(candidatePath) &&
        normalizedPaths.some((path) => candidatePath.startsWith(`${path}/`)),
    ).length;

    return {
      paths: normalizedPaths,
      groupCount: normalizedPaths.length,
      title:
        normalizedPaths.length === 1
          ? (groups.find((group) => group.path === normalizedPaths[0])?.name ??
            normalizedPaths[0])
          : `${normalizedPaths.length} groups`,
      hostCount,
      workspaceCount,
      childGroupCount,
    };
  }

  function getAssetKeysInGroupTrees(groupPaths: string[]): HomeAssetKey[] {
    const normalizedPaths = normalizeGroupSelectionForDelete(groupPaths);
    return buildHomeAssets(savedWorkspaces, hosts)
      .filter((asset) =>
        normalizedPaths.some((path) =>
          isGroupWithinPath(normalizeGroupPath(asset.groupName), path),
        ),
      )
      .map((asset) => asset.key);
  }

  function getUnusedLocalSecretRefsAfterHostDeletion(
    hostIds: readonly string[],
  ): string[] {
    return getUnusedSavedCredentialsAfterHostDeletion(
      hosts,
      keychainEntries,
      [...hostIds],
    );
  }

  function buildHostDeleteTarget(hostIds: string[]): HostDeleteTarget {
    const orderedHostIds = getOrderedSelectedHostIds(hostIds);
    const targetHosts = orderedHostIds
      .map((hostId) => hosts.find((host) => host.id === hostId))
      .filter((host): host is HostRecord => Boolean(host));

    return {
      hostIds: targetHosts.map((host) => host.id),
      hostCount: targetHosts.length,
      title:
        targetHosts.length === 1
          ? targetHosts[0].label
          : t("hostBrowserEmpty.selectedHosts", { count: targetHosts.length }),
    };
  }

  /**
   * 이 항목으로 선택을 옮겨도 되는가. **선택을 움직이는 모든 경로가 여기를 지난다** — 평범한
   * 클릭(selectSingleAsset), shift 범위(selectAssetRange), Cmd 추가(toggleAssetSelection),
   * 방향키(리스너가 selectSingleAsset 을 부른다). 종류별 분기를 호출부에 흩어 두면 새 경로가
   * 늘 때 가드가 빠진 채 추가된다.
   */
  function withSelectionGuard(
    ref: HomeAssetRef,
    reason: "click" | "menu",
    apply: () => void,
  ): boolean {
    if (ref.kind === "host") {
      if (canSelectHost && !canSelectHost(ref.id, { reason })) {
        return false;
      }
      apply();
      return true;
    }
    if (onLeaveHostEditor) {
      // 상위가 즉시 이어서 실행했는지를 돌려준다. 확인을 띄운 경우에는 false 를 돌려주고,
      // 사용자가 답한 뒤 상위가 apply 를 부른다(클릭이 사라지지 않는다).
      let appliedNow = false;
      onLeaveHostEditor(() => {
        appliedNow = true;
        apply();
      }, { reason });
      return appliedNow;
    }
    apply();
    return true;
  }

  /**
   * 홈을 떠나 세션을 여는 동작(호스트 연결·Workspace 열기)도 편집기를 떠난다. 스토어가 세션 탭을
   * 만들 때 hostDrawer 를 닫으므로(store/services/session.ts, sessionSlice.openSavedWorkspace)
   * 감싸지 않으면 저장하지 않은 편집이 묻지도 않고 사라진다.
   *
   * 여러 개를 한 번에 열 때는 배치 전체를 한 번만 감싼다 — 항목마다 감싸면 확인 대화상자가
   * 서로를 덮어써서 마지막 하나만 열린다.
   */
  function withLeaveHostEditor(run: () => void): void {
    if (!onLeaveHostEditor) {
      run();
      return;
    }
    // 메뉴 "항목 실행" 은 메뉴를 여는 동작이 아니다 — menu 로 넘기면 조용히 무시된다.
    onLeaveHostEditor(run, { reason: "click" });
  }

  function selectAssetRange(ref: HomeAssetRef) {
    // shift 범위도 selectedHostId 를 움직이므로(아래 onSelectHost/onClearHostSelection) 평범한
    // 클릭과 같은 가드를 지나야 한다. 예전에는 selectSingleAsset 만 지나서, 편집 중에 shift 로
    // 고르면 저장 확인 없이 선택이 반쯤 움직였다.
    withSelectionGuard(ref, "click", () => applyAssetRange(ref));
  }

  function applyAssetRange(ref: HomeAssetRef) {
    const key = toHomeAssetKey(ref);
    const next = getHomeAssetRange(
      visibleAssets,
      assetSelectionAnchorKey,
      key,
    );
    setSelectedAssetKeys(next);
    setSelectedGroupPaths([]);
    // 포커스가 새 선택 밖에 있으면 옮긴다. `!focusedAssetKey` 만 보던 동안, 범위가 이전 포커스를
    // 포함하지 않으면 포커스가 선택되지 않은 항목에 남아 우측 상세가 그 항목을 계속 보여주고
    // 방향키도 거기서부터 움직였다(toggleAssetSelection 은 이미 이 경우를 처리한다).
    if (!focusedAssetKey || !next.includes(focusedAssetKey)) {
      const nextFocus = next.includes(key) ? key : (next[0] ?? null);
      setFocusedAssetKey(nextFocus);
      const focused = nextFocus ? parseHomeAssetKey(nextFocus) : null;
      if (focused?.kind === "host") {
        onSelectHost(focused.id);
      } else {
        onClearHostSelection();
      }
    }
  }

  function toggleAssetSelection(ref: HomeAssetRef) {
    // Cmd/Ctrl 추가·해제도 포커스와 selectedHostId 를 움직인다(마지막 항목을 해제하면
    // onClearHostSelection). 같은 가드를 지난다.
    withSelectionGuard(ref, "click", () => applyAssetToggle(ref));
  }

  function applyAssetToggle(ref: HomeAssetRef) {
    const key = toHomeAssetKey(ref);
    const next = selectedAssetKeys.includes(key)
      ? selectedAssetKeys.filter((entry) => entry !== key)
      : orderHomeAssetKeys([...selectedAssetKeys, key], visibleAssets);
    setSelectedAssetKeys(next);
    setSelectedGroupPaths([]);
    setAssetSelectionAnchorKey(key);
    if (next.length === 0) {
      setFocusedAssetKey(null);
      onClearHostSelection();
      return;
    }
    if (!focusedAssetKey || !next.includes(focusedAssetKey)) {
      const nextFocus = next[0] ?? null;
      setFocusedAssetKey(nextFocus);
      if (nextFocus) {
        const focused = parseHomeAssetKey(nextFocus);
        if (focused.kind === "host") {
          onSelectHost(focused.id);
        } else {
          onClearHostSelection();
        }
      }
    }
  }

  /**
   * 이 항목으로 선택을 옮겨도 되는가. **목록의 모든 종류가 여기를 지난다** — 종류별 분기를
   * 호출부에 흩어 두면(예전처럼) 새 종류가 늘 때 가드가 빠진 채 추가된다.
   */
  function selectSingleAsset(
    ref: HomeAssetRef,
    reason: "click" | "menu" = "click",
  ) {
    return withSelectionGuard(ref, reason, () => applySingleAsset(ref));
  }

  function applySingleAsset(ref: HomeAssetRef) {
    const key = toHomeAssetKey(ref);
    setSelectedAssetKeys([key]);
    setSelectedGroupPaths([]);
    setAssetSelectionAnchorKey(key);
    setFocusedAssetKey(key);
    setGroupSelectionAnchor(null);
    if (ref.kind === "host") {
      onSelectHost(ref.id);
    } else {
      onClearHostSelection();
    }
  }

  function handleAssetSelection(
    ref: HomeAssetRef,
    event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">,
  ) {
    setContextMenu(null);
    const key = toHomeAssetKey(ref);
    if (event.shiftKey) {
      selectAssetRange(ref);
      return;
    }
    if (isAdditiveSelectionEvent(event)) {
      toggleAssetSelection(ref);
      return;
    }
    if (selectedAssetKeys.length === 1 && selectedAssetKeys[0] === key) {
      clearSelections();
      return;
    }
    selectSingleAsset(ref);
  }

  function selectSingleHost(
    hostId: string,
    reason: "click" | "menu" = "click",
  ) {
    return selectSingleAsset({ kind: "host", id: hostId }, reason);
  }

  function selectGroupRange(groupPath: string) {
    setSelectedGroupPaths(
      getSelectionRange(visibleGroupPaths, groupSelectionAnchor, groupPath),
    );
    setGroupSelectionAnchor(groupPath);
  }

  function toggleGroupSelection(groupPath: string) {
    setSelectedGroupPaths((current) =>
      current.includes(groupPath)
        ? current.filter((entry) => entry !== groupPath)
        : [...current, groupPath],
    );
    setGroupSelectionAnchor(groupPath);
  }

  function selectSingleGroup(groupPath: string) {
    setSelectedGroupPaths([groupPath]);
    setSelectedAssetKeys([]);
    setFocusedAssetKey(null);
    setGroupSelectionAnchor(groupPath);
    setAssetSelectionAnchorKey(null);
    onClearHostSelection();
  }

  function handleGroupSelection(
    groupPath: string,
    event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">,
  ) {
    setContextMenu(null);
    if (event.shiftKey) {
      selectGroupRange(groupPath);
      return;
    }
    if (isAdditiveSelectionEvent(event)) {
      toggleGroupSelection(groupPath);
      return;
    }
    // 이미 단독 선택된 그룹을 다시 누르면 선택을 해제하고 루트로 복귀한다(호스트 재클릭 해제와 동일한 UX).
    if (
      selectedGroupPaths.length === 1 &&
      selectedGroupPaths[0] === groupPath
    ) {
      handleNavigateRoot();
      return;
    }
    // 상위가 편집 중이면 확인을 받은 뒤에 이 계속(continuation)을 부른다. 내부 상태 변경도 그
    // 안에 있어서, 확인 중에 하이라이트만 먼저 움직이는 일이 없다.
    leaveGroupScope(() => {
      selectSingleGroup(groupPath);
      // 그룹을 고르면 즐겨찾기 스코프는 해제(즐겨찾기/그룹/All Hosts는 상호배타 스코프).
      setFavoritesFilterActive(false);
      onNavigateGroup(groupPath);
    });
  }

  /** 편집 중이면 상위가 물어본 뒤에 이어서 실행한다. 편집 중이 아니면 그 자리에서 실행한다. */
  function leaveGroupScope(proceed: () => void) {
    if (onLeaveGroupScope) {
      onLeaveGroupScope(proceed);
      return;
    }
    proceed();
  }

  function handleNavigateRoot() {
    setContextMenu(null);
    leaveGroupScope(() => {
      setSelectedGroupPaths([]);
      setSelectedAssetKeys([]);
      setFocusedAssetKey(null);
      setGroupSelectionAnchor(null);
      setAssetSelectionAnchorKey(null);
      setFavoritesFilterActive(false);
      onClearHostSelection();
      onNavigateGroup(null);
    });
  }

  function handleToggleGroupBranch(groupPath: string) {
    setCollapsedTreeGroupPaths((current) =>
      current.includes(groupPath)
        ? current.filter((path) => path !== groupPath)
        : [...current, groupPath],
    );
  }

  function getOrderedSelectedHostIds(hostIds: string[]): string[] {
    const selectedHostIdSet = new Set(hostIds);
    return visibleHostIds.filter((hostId) => selectedHostIdSet.has(hostId));
  }

  async function runForOrderedHosts(
    hostIds: string[],
    action: (hostId: string) => Promise<void>,
  ) {
    const orderedHostIds = getOrderedSelectedHostIds(hostIds);
    setContextMenu(null);
    for (const hostId of orderedHostIds) {
      try {
        await action(hostId);
      } catch {
        // Individual actions surface their own failure; keep processing the batch.
      }
    }
  }

  function applyGroupPathUiMutation(
    previousGroupPath: string,
    nextGroupPath: string,
  ) {
    setSelectedGroupPaths((current) => {
      const nextSelected = current
        .map((groupPath) =>
          rebaseGroupPath(groupPath, previousGroupPath, nextGroupPath),
        )
        .filter((groupPath): groupPath is string => Boolean(groupPath));
      return [...new Set(nextSelected)];
    });
    setGroupSelectionAnchor((current) =>
      rebaseGroupPath(current, previousGroupPath, nextGroupPath),
    );
    setCollapsedTreeGroupPaths((current) => {
      const nextCollapsed = current
        .map((groupPath) =>
          rebaseGroupPath(groupPath, previousGroupPath, nextGroupPath),
        )
        .filter((groupPath): groupPath is string => Boolean(groupPath));
      return [...new Set(nextCollapsed)];
    });
  }

  function openCreateGroupModal() {
    setGroupModalState({ mode: "create" });
    setNewGroupName("");
    setGroupError(null);
  }

  function openCreateSubgroupModal(parentPath: string) {
    setGroupModalState({ mode: "create", parentPath });
    setNewGroupName("");
    setGroupError(null);
  }

  function openRenameGroupModal(groupPath: string) {
    setGroupModalState({ mode: "rename", path: groupPath });
    setNewGroupName(getGroupLabel(groupPath));
    setGroupError(null);
  }

  function closeGroupModal() {
    setGroupModalState(null);
    setNewGroupName("");
    setGroupError(null);
  }

  function clearDragState() {
    setDragTargetGroupPath(null);
    setDraggedAssetKeys([]);
    setDraggedGroupPath(null);
    setIsRootDragTarget(false);
  }

  const selectedAssetKeySet = new Set(selectedAssetKeys);
  const selectedHostIdSet = new Set(selectedHostIds);
  const selectedWorkspaceIdSet = new Set(selectedWorkspaceIds);
  const selectedGroupPathSet = new Set(selectedGroupPaths);

  function getActiveDraggedAssetKeys(
    dataTransfer: DataTransfer,
  ): HomeAssetKey[] {
    const stateKeys = orderHomeAssetKeys(draggedAssetKeys, visibleAssets);
    if (stateKeys.length > 0) {
      return stateKeys;
    }
    try {
      const parsed = JSON.parse(
        dataTransfer.getData(HOME_ASSETS_DRAG_MIME_TYPE) || "[]",
      ) as unknown;
      if (Array.isArray(parsed)) {
        const keys = parsed.flatMap((value) => {
          if (!value || typeof value !== "object") {
            return [];
          }
          const ref = value as Partial<HomeAssetRef>;
          return (ref.kind === "host" || ref.kind === "workspace") &&
            typeof ref.id === "string"
            ? [toHomeAssetKey({ kind: ref.kind, id: ref.id })]
            : [];
        });
        const ordered = orderHomeAssetKeys(keys, visibleAssets);
        if (ordered.length > 0) {
          return ordered;
        }
      }
    } catch {
      // Fall through to legacy Host drag payloads.
    }
    const payloadHostIds = getOrderedSelectedHostIds(
      parseHostDragIds(dataTransfer.getData(HOSTS_DRAG_MIME_TYPE)),
    );
    if (payloadHostIds.length > 0) {
      return payloadHostIds.map((id) => `host:${id}` as HomeAssetKey);
    }
    const singleHostId = dataTransfer.getData(HOST_DRAG_MIME_TYPE);
    return singleHostId ? [`host:${singleHostId}`] : [];
  }

  function getNextDraggedAssetKeys(ref: HomeAssetRef): HomeAssetKey[] {
    const key = toHomeAssetKey(ref);
    if (!selectedAssetKeySet.has(key)) {
      return [key];
    }
    const ordered = orderHomeAssetKeys(selectedAssetKeys, visibleAssets);
    return ordered.length > 0 ? ordered : [key];
  }

  async function moveAssetsToGroup(
    assetKeys: readonly HomeAssetKey[],
    groupPath: string | null,
  ) {
    for (const key of orderHomeAssetKeys(assetKeys, visibleAssets)) {
      const ref = parseHomeAssetKey(key);
      if (ref.kind === "host") {
        await onMoveHostToGroup(ref.id, groupPath);
      } else {
        await onMoveSavedWorkspaceToGroup(ref.id, groupPath);
      }
    }
  }

  function toggleTagFilter(tag: string) {
    setActiveTagFilter((current) =>
      current.includes(tag)
        ? current.filter((entry) => entry !== tag)
        : [...current, tag],
    );
  }

  function toggleFavorite(hostId: string) {
    const host = hosts.find((entry) => entry.id === hostId);
    void params.onSetHostFavorite(hostId, !(host?.favorite === true));
  }

  function toggleFavoritesFilter() {
    const next = !favoritesFilterActive;
    setFavoritesFilterActive(next);
    if (next) {
      // 즐겨찾기는 그룹과 무관하게 전체에서 보여준다 → 그룹 스코프/선택을 해제.
      setSelectedGroupPaths([]);
      setSelectedAssetKeys([]);
      setFocusedAssetKey(null);
      setAssetSelectionAnchorKey(null);
      onClearHostSelection();
      onNavigateGroup(null);
    }
  }

  return {
    // passthrough params (callbacks + data used directly by the regions)
    ...params,
    // search / scope
    scopedHosts,
    searchPlaceholder,
    visibleHosts,
    visibleHostIds,
    visibleWorkspaces,
    paletteWorkspaces,
    emptyMessage,
    // tags / sort / view / favorites (UI only)
    tagCounts,
    activeTagFilter,
    toggleTagFilter,
    setActiveTagFilter,
    favoriteHostIds,
    favoriteHostIdSet,
    favoriteWorkspaceCount,
    toggleFavorite,
    favoritesFilterActive,
    toggleFavoritesFilter,
    setFavoritesFilterActive,
    sortKey,
    setSortKey,
    sortDirection,
    setSort,
    toggleSort,
    lastConnectedByHostId,
    viewMode,
    setViewMode,
    // group tree
    allGroupPaths,
    groupTreeRows,
    visibleGroupTreeRows,
    visibleGroupPaths,
    collapsedTreeGroupPathSet,
    groupSortKey,
    setGroupSortKey,
    hideEmptyGroups,
    setHideEmptyGroups,
    expandAllGroups,
    collapseAllGroups,
    // selection state
    visibleAssets,
    visibleAssetKeys,
    selectedAssetKeys,
    setSelectedAssetKeys,
    selectedAssetKeySet,
    focusedAssetKey,
    setFocusedAssetKey,
    assetSelectionAnchorKey,
    setAssetSelectionAnchorKey,
    selectedHostIds,
    selectedWorkspaceIds,
    selectedGroupPaths,
    setSelectedGroupPaths,
    selectedHostIdSet,
    selectedWorkspaceIdSet,
    selectedGroupPathSet,
    setGroupSelectionAnchor,
    expandedHostTags,
    setExpandedHostTags,
    // selection handlers
    handleAssetSelection,
    selectSingleAsset,
    selectSingleHost,
    toggleAssetSelection,
    selectAssetRange,
    withLeaveHostEditor,
    handleGroupSelection,
    selectSingleGroup,
    handleNavigateRoot,
    handleToggleGroupBranch,
    runForOrderedHosts,
    getAssetKeysInGroupTrees,
    clearSelections,
    // drag state + helpers
    draggedGroupPath,
    setDraggedGroupPath,
    draggedAssetKeys,
    setDraggedAssetKeys,
    dragTargetGroupPath,
    setDragTargetGroupPath,
    groupDropEdge,
    setGroupDropEdge,
    onReorderGroup,
    canReorderGroups,
    resolveGroupDropTarget,
    isRootDragTarget,
    setIsRootDragTarget,
    getActiveDraggedAssetKeys,
    getNextDraggedAssetKeys,
    moveAssetsToGroup,
    clearDragState,
    canReparentGroup,
    buildNextGroupPath,
    applyGroupPathUiMutation,
    setCollapsedTreeGroupPaths,
    // context menu
    contextMenu,
    setContextMenu,
    contextMenuStyle,
    // 크기를 재려면 실제 노드가 필요하다(항목 수가 대상마다 다르다).
    contextMenuRef,
    // import menu
    isImportMenuOpen,
    setIsImportMenuOpen,
    importMenuRef,
    // grid
    hostGridRef,
    hostGridStyle,
    hostGridLayout,
    clampedHostCardStyle,
    // group modal
    groupModalState,
    openCreateGroupModal,
    openCreateSubgroupModal,
    openRenameGroupModal,
    closeGroupModal,
    newGroupName,
    setNewGroupName,
    groupError,
    setGroupError,
    // group delete
    groupDeleteTarget,
    setGroupDeleteTarget,
    buildGroupDeleteTarget,
    groupDeleteDialogVariant,
    groupDeleteError,
    setGroupDeleteError,
    isRemovingGroup,
    setIsRemovingGroup,
    // host delete
    hostDeleteTarget,
    setHostDeleteTarget,
    buildHostDeleteTarget,
    getUnusedLocalSecretRefsAfterHostDeletion,
    hostDeleteUnusedLocalSecretRefs,
    removeUnusedSecretsOnHostDelete,
    setRemoveUnusedSecretsOnHostDelete,
    hostDeleteError,
    setHostDeleteError,
    isRemovingHost,
    setIsRemovingHost,
    // exposed for clarity
    selectedHostId,
    currentGroupPath,
    hosts,
    groups,
  };
}

export type HostBrowserModel = ReturnType<typeof useHostBrowser>;
