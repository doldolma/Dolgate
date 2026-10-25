import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  getHostSecretRef,
  getParentGroupPath,
  normalizeGroupPath,
  type ActivityLogRecord,
  type GroupRemoveMode,
  type SavedWorkspaceRecord,
} from "@shared";
import { cn } from "../lib/cn";
import { DialogBackdrop } from "./DialogBackdrop";
import { HostDeleteConfirmDialog } from "./HostDeleteConfirmDialog";
import {
  Button,
  ErrorBoundary,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from "../ui";
import {
  AppWindow,
  Columns2,
  Container,
  Copy,
  Download,
  Folder,
  FolderPlus,
  Link,
  Pencil,
  Plus,
  Share2,
  SquareTerminal,
  Trash2,
  Users,
} from "../ui/icons";
import { isTeamVaultId, PERSONAL_VAULT_ID } from "../store/utils";
import { HomeSidebar } from "./host-browser/HomeSidebar";
import { HostListPanel } from "./host-browser/HostListPanel";
import { HostDetailPanel } from "./host-browser/HostDetailPanel";
import { WorkspaceActionDialogs } from "./WorkspaceActionDialogs";
import { WorkspaceDetailPanel } from "./WorkspaceDetailPanel";
import {
  orderHomeAssetKeys,
  parseHomeAssetKey,
  partitionHomeAssetKeys,
  type HomeAssetKey,
} from "./host-browser/homeAssets";
import {
  hostSupportsContainers,
  hostSupportsSftp,
  hostSupportsTmux,
} from "./host-browser/hostCapabilities";
import {
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS,
  useHostBrowser,
  type GroupDeleteTarget,
  type UseHostBrowserParams,
} from "./host-browser/useHostBrowser";

// 외부(테스트/SftpWorkspace)에서 쓰던 헬퍼 재노출 — import 경로 호환 유지.
export {
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS,
};
export {
  buildVisibleGroups,
  collectGroupPaths,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getGroupLabel,
  getHostTagsToggleLabel,
  getParentGroupPath,
  isDirectHostChild,
  isGroupWithinPath,
  normalizeGroupPath,
  rebaseGroupPath,
} from "@shared";
import { useTranslation } from "react-i18next";

export type HostBrowserProps = UseHostBrowserParams & {
  /** 편집/생성 중일 때 우측 상세 영역에 detail 대신 표시할 에디터(HostDrawer). */
  hostEditor?: ReactNode;
  /** 단축키 안내 모달에 실제 설정된 tmux 프리픽스를 보여주기 위해 전달한다. */
  tmuxPrefixKey?: string;
  /**
   * 포트 포워딩 화면에서 지금 쓰이고 있는 항목 수(다섯 탭 합계). 사이드바 배지가 쓴다.
   *
   * 이 서브트리는 스토어를 읽지 않고 prop 으로만 받는다 — host-browser 아래에 useAppStore 가
   * 한 번도 없다. 그 경계를 지키려고 여기까지 흘린다.
   */
  activePortForwardEntryCount?: number;
  workspaceActivityLogs?: readonly ActivityLogRecord[];
  onOpenSavedWorkspace?: (workspaceId: string) => void | Promise<unknown>;
  onRenameSavedWorkspace?: (
    workspaceId: string,
    name: string,
  ) => void | Promise<unknown>;
  onDuplicateSavedWorkspace?: (workspaceId: string) => void | Promise<unknown>;
  onSetSavedWorkspaceFavorite?: (
    workspaceId: string,
    favorite: boolean,
  ) => void | Promise<unknown>;
  onRemoveSavedWorkspace?: (workspaceId: string) => void | Promise<unknown>;
};

// 우클릭 컨텍스트 메뉴 아이템 공통 스타일(아이콘+라벨, 그룹 사이 divider).
const CTX_ITEM =
  "flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.6rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent";
const CTX_DANGER =
  "flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.6rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent";
const CTX_ICON = "h-[1.05rem] w-[1.05rem] shrink-0 text-[var(--text-soft)]";

export function HostBrowser({
  hostEditor,
  tmuxPrefixKey,
  activePortForwardEntryCount = 0,
  savedWorkspaces = [],
  workspaceActivityLogs = [],
  onOpenSavedWorkspace,
  onRenameSavedWorkspace,
  onDuplicateSavedWorkspace,
  onSetSavedWorkspaceFavorite,
  onRemoveSavedWorkspace,
  ...props
}: HostBrowserProps) {
  const { t: translate } = useTranslation();
  const [workspaceRenameTarget, setWorkspaceRenameTarget] =
    useState<SavedWorkspaceRecord | null>(null);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] =
    useState<SavedWorkspaceRecord | null>(null);
  const [mixedDeleteAssetKeys, setMixedDeleteAssetKeys] = useState<
    HomeAssetKey[] | null
  >(null);
  const [mixedDeleteError, setMixedDeleteError] = useState<string | null>(null);
  // 여러 자산을 지울 때의 "미사용 자격증명도 삭제" 상태는 이 대화상자가 직접 들고 있어야 한다.
  // hb.removeUnusedSecretsOnHostDelete 를 같이 쓰던 동안, 그 값을 정하는 효과는 단일 호스트
  // 대상(hostDeleteTarget)만 보고 있었고 이 경로에서는 그것이 null 이라 항상 false 로 떠 있었다 —
  // 호스트 하나를 지우면 체크된 채, 둘 이상을 지우면 체크가 풀린 채 나와 고아 자격증명이 남았다.
  const [mixedRemoveUnusedSecrets, setMixedRemoveUnusedSecrets] = useState(true);
  const [isMixedDeleting, setIsMixedDeleting] = useState(false);
  const hb = useHostBrowser({
    ...props,
    savedWorkspaces,
  });
  const {
    contextMenu,
    contextMenuStyle,
    groupModalState,
    groupDeleteTarget,
    hostDeleteTarget,
  } = hb;
  const focusedAsset = hb.focusedAssetKey
    ? hb.visibleAssets.find((asset) => asset.key === hb.focusedAssetKey) ?? null
    : null;
  const selectedWorkspace =
    focusedAsset?.kind === "workspace" ? focusedAsset.record : null;

  const contextMenuAssetKeys =
    contextMenu?.kind === "asset"
      ? orderHomeAssetKeys(contextMenu.assetKeys, hb.visibleAssets)
      : [];
  const {
    hostIds: contextMenuHostIds,
    workspaceIds: contextMenuWorkspaceIds,
  } = partitionHomeAssetKeys(contextMenuAssetKeys);
  const contextMenuHosts = hb.hosts.filter((entry) =>
    contextMenuHostIds.includes(entry.id),
  );
  const contextMenuWorkspaces = savedWorkspaces.filter((workspace) =>
    contextMenuWorkspaceIds.includes(workspace.id),
  );
  const sftpTargetIds = contextMenuHosts
    .filter(hostSupportsSftp)
    .map((entry) => entry.id);
  const tmuxTargetIds = contextMenuHosts
    .filter(hostSupportsTmux)
    .map((entry) => entry.id);
  const containersTargetIds = contextMenuHosts
    .filter(hostSupportsContainers)
    .map((entry) => entry.id);
  const mixedDeleteTargets = partitionHomeAssetKeys(
    mixedDeleteAssetKeys ?? [],
  );
  // 실패분만 재시도해도 먼저 삭제한 Host의 정리 후보를 잃지 않는다.
  const [mixedDeleteUnusedLocalSecretRefs, setMixedDeleteUnusedLocalSecretRefs] = useState<string[]>([]);
  const mixedDeletedHostIds = useRef(new Set<string>());
  const latestHosts = useRef(hb.hosts);
  latestHosts.current = hb.hosts;
  const groupExportAssetKeys =
    contextMenu?.kind === "group"
      ? hb.getAssetKeysInGroupTrees(contextMenu.groupPaths, contextMenu.vaultId)
      : [];
  // 볼트 줄 메뉴의 볼트. 다시 들어와야 하는 팀은 팀 키가 없어 쓸 수 없으니 "팀 관리" 만 남긴다.
  // 볼트 사이 복사(공유) — 한 볼트의 호스트들·워크스페이스들·그룹들, 넣을 다른 볼트가 있을 때만 메뉴에 보인다.
  const assetCopy =
    contextMenu?.kind === "asset" ? hb.copySelectionOfAssets(contextMenuAssetKeys) : null;
  const assetCopySourceVaultId = assetCopy?.sourceVaultId ?? null;
  const showAssetCopy =
    assetCopySourceVaultId !== null && hb.hasCopyTargetFrom(assetCopySourceVaultId);
  const showGroupCopy =
    contextMenu?.kind === "group" && hb.hasCopyTargetFrom(contextMenu.vaultId);
  const contextMenuVault =
    contextMenu?.kind === "vault"
      ? (hb.vaults?.find((vault) => vault.id === contextMenu.vaultId) ?? null)
      : null;
  const contextMenuVaultWritable = contextMenuVault?.blocked !== "needs-rejoin";

  function openAssets(assetKeys: readonly HomeAssetKey[]) {
    hb.setContextMenu(null);
    // 세션을 여는 순간 스토어가 호스트 편집기를 닫는다 — 저장하지 않은 편집이 있으면 먼저 묻는다.
    // 배치 전체를 한 번만 감싼다(항목마다 감싸면 확인 대화상자가 서로를 덮어쓴다).
    hb.withLeaveHostEditor(() => void openAssetsNow(assetKeys));
  }

  async function openAssetsNow(assetKeys: readonly HomeAssetKey[]) {
    for (const key of orderHomeAssetKeys(assetKeys, hb.visibleAssets)) {
      const ref = parseHomeAssetKey(key);
      try {
        if (ref.kind === "host") {
          await hb.onConnectHost(ref.id);
        } else {
          await onOpenSavedWorkspace?.(ref.id);
        }
      } catch {
        // Each connection owns its error UI; one failure must not stop the rest.
      }
    }
  }

  async function duplicateAssets(assetKeys: readonly HomeAssetKey[]) {
    hb.setContextMenu(null);
    const ordered = orderHomeAssetKeys(assetKeys, hb.visibleAssets);
    const { hostIds, workspaceIds } = partitionHomeAssetKeys(ordered);
    if (hostIds.length > 0) {
      try {
        await hb.onDuplicateHosts(hostIds);
      } catch {
        // Workspace duplication must still continue after a Host batch failure.
      }
    }
    for (const workspaceId of workspaceIds) {
      try {
        await onDuplicateSavedWorkspace?.(workspaceId);
      } catch {
        // Preserve the rest of the Workspace batch when one copy fails.
      }
    }
  }

  function exportAssets(assetKeys: readonly HomeAssetKey[]) {
    hb.setContextMenu(null);
    hb.onExportAssets(
      orderHomeAssetKeys(assetKeys, hb.visibleAssets).map(parseHomeAssetKey),
    );
  }

  /**
   * 그룹들을 지운다. 실패하면 삭제 창에 무엇이 안 됐는지 띄운다 — 묻지 않고 지우던 길이었으면 그때 처음 창이 열려
   * 다시 시도하거나 그만둘 수 있다.
   */
  async function removeGroups(target: GroupDeleteTarget, mode: GroupRemoveMode) {
    try {
      hb.setIsRemovingGroup(true);
      for (const path of target.paths) {
        await hb.removeGroupIn(path, mode, target.vaultId);
      }
      hb.setSelectedGroupPaths((current) =>
        current.filter((path) => !target.paths.includes(path)),
      );
      hb.setGroupDeleteTarget(null);
      hb.setGroupDeleteError(null);
    } catch (error) {
      hb.setGroupDeleteTarget(target);
      hb.setGroupDeleteError(
        error instanceof Error
          ? error.message
          : translate("hostBrowser.error.groupDeleteFailed"),
      );
    } finally {
      hb.setIsRemovingGroup(false);
    }
  }

  function requestDeleteAssets(assetKeys: readonly HomeAssetKey[]) {
    const ordered = orderHomeAssetKeys(assetKeys, hb.visibleAssets);
    const { hostIds, workspaceIds } = partitionHomeAssetKeys(ordered);
    hb.setContextMenu(null);
    if (hostIds.length === 1 && workspaceIds.length === 0) {
      hb.setHostDeleteTarget(hb.buildHostDeleteTarget(hostIds));
      hb.setHostDeleteError(null);
      return;
    }
    if (workspaceIds.length === 1 && hostIds.length === 0) {
      const workspace = savedWorkspaces.find(
        (entry) => entry.id === workspaceIds[0],
      );
      if (workspace) {
        setWorkspaceDeleteTarget(workspace);
      }
      return;
    }
    setMixedRemoveUnusedSecrets(
      hb.getUnusedLocalSecretRefsAfterHostDeletion(hostIds).length > 0,
    );
    mixedDeletedHostIds.current = new Set();
    setMixedDeleteUnusedLocalSecretRefs(hb.getUnusedLocalSecretRefsAfterHostDeletion(hostIds));
    setMixedDeleteAssetKeys(ordered);
    setMixedDeleteError(null);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)_minmax(360px,400px)] max-[1320px]:grid-cols-[220px_minmax(0,1fr)_340px] max-[1040px]:grid-cols-1">
      <HomeSidebar
        hb={hb}
        activeSection="hosts"
        activePortForwardEntryCount={activePortForwardEntryCount}
        workspaceCount={savedWorkspaces.length}
        favoriteWorkspaceCount={hb.favoriteWorkspaceCount}
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {hb.statusMessage ? (
          <NoticeCard tone="info" className="mx-[1.1rem] mt-[0.9rem]">
            {hb.statusMessage}
          </NoticeCard>
        ) : null}
        {hb.errorMessage ? (
          <NoticeCard
            tone="danger"
            className="mx-[1.1rem] mt-[0.9rem]"
            role="alert"
          >
            {hb.errorMessage}
          </NoticeCard>
        ) : null}
        <HostListPanel
          hb={hb}
          workspaces={hb.visibleWorkspaces}
          onOpenWorkspace={onOpenSavedWorkspace ?? (() => undefined)}
          onToggleWorkspaceFavorite={
            onSetSavedWorkspaceFavorite ?? (() => undefined)
          }
        />
      </div>

      <aside
        className={cn(
          "h-full min-h-0 overflow-hidden",
          hostEditor
            ? "max-[1040px]:fixed max-[1040px]:inset-0 max-[1040px]:z-[20]"
            : "border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--app-bg)_8%)] max-[1040px]:hidden",
        )}
      >
        {/* 상세 패널이 못 그려져도 목록은 계속 쓸 수 있어야 한다 — 이 빌드가 모르는 모양의 호스트를
            고른 것뿐인데 앱 전체가 멈추면 그 호스트를 고칠 방법도 없다. 호스트를 바꾸면 자동 복구. */}
        {
          // 경계는 **상세 슬롯 전체**를 감싼다 — 편집기까지 포함해서. 예전에는 HostDetailPanel
          // 분기만 감쌌고, Workspace 상세(저장된 트리를 재귀로 훑는다)와 편집기(원본 호스트
          // 레코드를 그대로 읽는다 — 1.8.10 의 username.trim() 크래시가 그 부류다)가 밖에
          // 있었다. 거기서 throw 하면 Home 이 통째로 멈춰, 목록으로 돌아가 그 레코드를 고칠
          // 방법도 없어진다.
          <ErrorBoundary
            label="host-detail"
            resetKey={`${hb.selectedHostId ?? ""}|${selectedWorkspace?.id ?? ""}|${Boolean(hostEditor)}`}
            fallback={() => (
              <NoticeCard tone="danger" className="m-[0.9rem]" role="alert">
                {selectedWorkspace
                  ? translate("errorBoundary.workspaceDetail", {
                      label: selectedWorkspace.name,
                    })
                  : translate("errorBoundary.hostRow", {
                      label:
                        hb.hosts.find((entry) => entry.id === hb.selectedHostId)
                          ?.label ??
                        hb.selectedHostId ??
                        "?",
                    })}
              </NoticeCard>
            )}
          >
            {hostEditor ?? (selectedWorkspace ? (
              <WorkspaceDetailPanel
                workspace={selectedWorkspace}
                hosts={props.hosts}
                activityLogs={workspaceActivityLogs}
                onOpen={onOpenSavedWorkspace ?? (() => undefined)}
                onRename={setWorkspaceRenameTarget}
                onDuplicate={onDuplicateSavedWorkspace ?? (() => undefined)}
                onToggleFavorite={
                  onSetSavedWorkspaceFavorite ?? (() => undefined)
                }
                onDelete={setWorkspaceDeleteTarget}
                favoriteHint={
                  hb.teamOfAsset(`workspace:${selectedWorkspace.id}`)
                    ? translate("teams.perPerson.favorite")
                    : null
                }
              />
            ) : (
              <HostDetailPanel hb={hb} tmuxPrefixKey={tmuxPrefixKey} />
            ))}
          </ErrorBoundary>
        }
      </aside>

      {contextMenu
        ? createPortal(
            <div
              // 크기를 재서 화면 안으로 접어 넣는다(useHostBrowser 의 layout effect). 이 ref 가
              // 없으면 높이를 알 수 없어 아래쪽 호스트의 메뉴가 잘린다.
              ref={hb.contextMenuRef}
              className="fixed z-[24] min-w-[148px] rounded-[10px] border border-[var(--border)] bg-[var(--dialog-surface)] p-[0.4rem] shadow-[var(--shadow-floating)]"
              style={contextMenuStyle ?? undefined}
              role="menu"
            >
              {contextMenu.kind === "asset" ? (
                <>
                  {/* 연결류 */}
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={() => {
                      openAssets(contextMenuAssetKeys);
                    }}
                  >
                    <SquareTerminal className={CTX_ICON} aria-hidden />
                    {contextMenuWorkspaceIds.length === 0
                      ? contextMenuHostIds.length === 1
                        ? translate("hostBrowser.menu.connect")
                        : translate("hostBrowser.menu.connectMany", {
                            count: contextMenuHostIds.length,
                          })
                      : contextMenuHostIds.length === 0 &&
                          contextMenuWorkspaceIds.length === 1
                        ? translate("savedWorkspace.open")
                        : translate("homeAssets.menu.openMany", {
                            count: contextMenuAssetKeys.length,
                          })}
                  </button>
                  {contextMenuHostIds.length > 0 &&
                  hb.onOpenHostInNewWindow ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={async () => {
                        hb.setContextMenu(null);
                        for (const hostId of contextMenuHostIds) {
                          try {
                            await hb.onOpenHostInNewWindow?.(hostId);
                          } catch {
                            // Keep opening the remaining selected Hosts.
                          }
                        }
                      }}
                    >
                      <AppWindow className={CTX_ICON} aria-hidden />
                      {contextMenuAssetKeys.length > contextMenuHostIds.length
                        ? translate(
                            "homeAssets.menu.connectNewWindowHostSubset",
                            { count: contextMenuHostIds.length },
                          )
                        : contextMenuHostIds.length === 1
                          ? translate("hostBrowser.menu.connectNewWindow")
                          : translate("homeAssets.menu.connectNewWindowMany", {
                              count: contextMenuHostIds.length,
                            })}
                    </button>
                  ) : null}
                  {sftpTargetIds.length > 0 && hb.onOpenSftp ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      // SFTP 는 탭 하나에 호스트 하나라 대상이 정확히 1대일 때만 연다. 여러 대가
                      // 대상이면 어느 쪽을 열지 정할 근거가 없다(tmux·컨테이너처럼 순회할 수 없다).
                      disabled={sftpTargetIds.length !== 1}
                      onClick={() => {
                        const targetHostId = sftpTargetIds[0];
                        hb.setContextMenu(null);
                        if (!targetHostId) {
                          return;
                        }
                        void hb.onOpenSftp?.(targetHostId);
                      }}
                    >
                      <Folder className={CTX_ICON} aria-hidden />
                      {sftpTargetIds.length === 1
                        ? contextMenuAssetKeys.length > sftpTargetIds.length
                          ? translate("homeAssets.menu.sftpHostSubset", {
                              count: sftpTargetIds.length,
                            })
                          : translate("hostBrowser.menu.sftp")
                        : translate("homeAssets.menu.sftpSelectOne", {
                            count: sftpTargetIds.length,
                          })}
                    </button>
                  ) : null}
                  {tmuxTargetIds.length > 0 && hb.onConnectHostTmux ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        hb.setContextMenu(null);
                        hb.withLeaveHostEditor(() => {
                          void hb.runForOrderedHosts(tmuxTargetIds, hb.onConnectHostTmux!);
                        });
                      }}
                    >
                      <Columns2 className={CTX_ICON} aria-hidden />
                      {contextMenuAssetKeys.length > tmuxTargetIds.length
                        ? translate("homeAssets.menu.tmuxHostSubset", {
                            count: tmuxTargetIds.length,
                          })
                        : tmuxTargetIds.length === 1
                          ? translate("hostBrowser.menu.tmux")
                          : translate("hostBrowser.menu.tmuxMany", {
                              count: tmuxTargetIds.length,
                            })}
                    </button>
                  ) : null}
                  {containersTargetIds.length > 0 ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        hb.setContextMenu(null);
                        hb.withLeaveHostEditor(() => {
                          void hb.runForOrderedHosts(containersTargetIds, hb.onOpenHostContainers);
                        });
                      }}
                    >
                      <Container className={CTX_ICON} aria-hidden />
                      {contextMenuAssetKeys.length > containersTargetIds.length
                        ? translate("homeAssets.menu.containersHostSubset", {
                            count: containersTargetIds.length,
                          })
                        : containersTargetIds.length === 1
                          ? translate("hostBrowser.menu.containers")
                          : translate("hostBrowser.menu.containersMany", {
                              count: containersTargetIds.length,
                            })}
                    </button>
                  ) : null}

                  <div
                    role="separator"
                    className="my-[0.35rem] h-px bg-[var(--border)]"
                  />

                  {/* 관리 */}
                  {contextMenuHostIds.length === 1 ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        const targetHostId = contextMenuHostIds[0];
                        hb.setContextMenu(null);
                        if (targetHostId) {
                          hb.onEditHost(targetHostId);
                        }
                      }}
                    >
                      <Pencil className={CTX_ICON} aria-hidden />
                      {contextMenuAssetKeys.length > contextMenuHostIds.length
                        ? translate("homeAssets.menu.editHostSubset", {
                            count: contextMenuHostIds.length,
                          })
                        : translate("hostBrowser.menu.edit")}
                    </button>
                  ) : null}
                  {contextMenuWorkspaces.length === 1 ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        hb.setContextMenu(null);
                        setWorkspaceRenameTarget(contextMenuWorkspaces[0]!);
                      }}
                    >
                      <Pencil className={CTX_ICON} aria-hidden />
                      {contextMenuAssetKeys.length > 1
                        ? translate(
                            "homeAssets.menu.renameWorkspaceSubset",
                            { count: contextMenuWorkspaceIds.length },
                          )
                        : translate("homeAssets.menu.renameWorkspace")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={() => {
                      void duplicateAssets(contextMenuAssetKeys);
                    }}
                  >
                    <Copy className={CTX_ICON} aria-hidden />
                    {contextMenuAssetKeys.length === 1
                      ? translate("common.duplicate")
                      : translate("hostBrowser.menu.copyMany", {
                          count: contextMenuAssetKeys.length,
                        })}
                  </button>
                  {showAssetCopy && assetCopy ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        hb.setContextMenu(null);
                        hb.requestVaultCopy({ ...assetCopy, target: null });
                      }}
                    >
                      <Share2 className={CTX_ICON} aria-hidden />
                      {/* 개인 것은 팀에 내놓는 것이라 "공유", 팀 것은 어디로든 사본이라 "볼트로 복사". */}
                      {translate(
                        assetCopySourceVaultId === PERSONAL_VAULT_ID
                          ? "hostBrowser.menu.share"
                          : "hostBrowser.menu.copyToVault",
                      )}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={() => exportAssets(contextMenuAssetKeys)}
                  >
                    <Download className={CTX_ICON} aria-hidden />
                    {contextMenuAssetKeys.length === 1
                      ? translate("hostBrowser.menu.export")
                      : translate("hostBrowser.menu.exportMany", {
                          count: contextMenuAssetKeys.length,
                        })}
                  </button>

                  <div
                    role="separator"
                    className="my-[0.35rem] h-px bg-[var(--border)]"
                  />

                  <button
                    type="button"
                    className={CTX_DANGER}
                    onClick={() => requestDeleteAssets(contextMenuAssetKeys)}
                  >
                    <Trash2
                      className="h-[1.05rem] w-[1.05rem] shrink-0"
                      aria-hidden
                    />
                    {contextMenuAssetKeys.length === 1
                      ? translate("common.delete")
                      : translate("homeAssets.menu.deleteMany", {
                          count: contextMenuAssetKeys.length,
                        })}
                  </button>
                </>
              ) : contextMenu.kind === "vault" ? (
                <>
                  {contextMenuVault?.kind === "team" &&
                  contextMenuVaultWritable &&
                  hb.onOpenTeamInvite ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        hb.setContextMenu(null);
                        hb.onOpenTeamInvite?.(contextMenu.vaultId);
                      }}
                    >
                      <Link className={CTX_ICON} aria-hidden />
                      {translate("hostBrowser.vaultMenu.invite")}
                    </button>
                  ) : null}
                  {contextMenuVaultWritable && hb.onCreateHostInVault ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => hb.createHostInVault(contextMenu.vaultId)}
                    >
                      <Plus className={CTX_ICON} aria-hidden />
                      {translate("hostBrowser.vaultMenu.newHost")}
                    </button>
                  ) : null}
                  {contextMenuVaultWritable ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => hb.openCreateGroupInVault(contextMenu.vaultId)}
                    >
                      <FolderPlus className={CTX_ICON} aria-hidden />
                      {translate("hostBrowser.vaultMenu.newGroup")}
                    </button>
                  ) : null}
                  {isTeamVaultId(contextMenu.vaultId) && hb.onManageTeam ? (
                    <>
                      {contextMenuVaultWritable ? (
                        <div
                          role="separator"
                          className="my-[0.35rem] h-px bg-[var(--border)]"
                        />
                      ) : null}
                      <button
                        type="button"
                        className={CTX_ITEM}
                        onClick={() => {
                          hb.setContextMenu(null);
                          hb.onManageTeam?.(contextMenu.vaultId);
                        }}
                      >
                        <Users className={CTX_ICON} aria-hidden />
                        {translate("hostBrowser.vaultMenu.manageTeam")}
                      </button>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex w-full items-center rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={contextMenu.groupPaths.length !== 1}
                    onClick={() => {
                      const targetGroupPath = contextMenu.groupPaths[0];
                      hb.setContextMenu(null);
                      if (!targetGroupPath) {
                        return;
                      }
                      hb.openCreateSubgroupModal(
                        targetGroupPath,
                        contextMenu.vaultId,
                      );
                    }}
                  >
                    {translate("hostBrowser.menu.newSubgroup")}
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={contextMenu.groupPaths.length !== 1}
                    onClick={() => {
                      const targetGroupPath = contextMenu.groupPaths[0];
                      hb.setContextMenu(null);
                      if (!targetGroupPath) {
                        return;
                      }
                      hb.openRenameGroupModal(
                        targetGroupPath,
                        contextMenu.vaultId,
                      );
                    }}
                  >
                    {translate("hostBrowser.menu.rename")}
                  </button>
                  {showGroupCopy ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                      disabled={contextMenu.groupPaths.length === 0}
                      onClick={() => {
                        hb.setContextMenu(null);
                        hb.requestVaultCopy({
                          sourceVaultId: contextMenu.vaultId,
                          selection: { kind: "groups", groupPaths: contextMenu.groupPaths },
                          target: null,
                        });
                      }}
                    >
                      <Share2 className={CTX_ICON} aria-hidden />
                      {translate(
                        contextMenu.vaultId === PERSONAL_VAULT_ID
                          ? "hostBrowser.menu.share"
                          : "hostBrowser.menu.copyToVault",
                      )}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={groupExportAssetKeys.length === 0}
                    onClick={() => {
                      if (groupExportAssetKeys.length > 0) {
                        exportAssets(groupExportAssetKeys);
                      }
                    }}
                  >
                    <Download className={CTX_ICON} aria-hidden />
                    {translate("hostBrowser.menu.exportGroup", {
                      count: groupExportAssetKeys.length,
                    })}
                  </button>

                  <div
                    role="separator"
                    className="my-[0.35rem] h-px bg-[var(--border)]"
                  />

                  <button
                    type="button"
                    className="flex w-full items-center rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)]"
                    onClick={() => {
                      const target = hb.buildGroupDeleteTarget(
                        contextMenu.groupPaths,
                        contextMenu.vaultId,
                      );
                      hb.setGroupDeleteError(null);
                      hb.setContextMenu(null);
                      // 함께 지워질 호스트·Workspace 가 없으면 남길지 물을 것이 없다 — 빈 하위 그룹까지 바로 지운다.
                      if (target.hostCount + target.workspaceCount === 0) {
                        void removeGroups(target, "delete-subtree");
                        return;
                      }
                      hb.setGroupDeleteTarget(target);
                    }}
                  >
                    {translate("common.delete")}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}

      {groupModalState ? (
        <DialogBackdrop
          data-testid="host-browser-modal-backdrop"
          onDismiss={hb.closeGroupModal}
        >
          <ModalShell
            data-host-browser-modal="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby={
              groupModalState.mode === "create"
                ? "new-group-title"
                : "rename-group-title"
            }
          >
            <ModalHeader className="block">
              <SectionLabel>
                {groupModalState.mode === "create" ? "Create" : "Rename"}
              </SectionLabel>
              <h3
                id={
                  groupModalState.mode === "create"
                    ? "new-group-title"
                    : "rename-group-title"
                }
              >
                {groupModalState.mode === "create"
                  ? "New Group"
                  : "Rename Group"}
              </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              <Input
                value={hb.newGroupName}
                onChange={(event) => {
                  hb.setNewGroupName(event.target.value);
                  hb.setGroupError(null);
                }}
                placeholder="Group name"
                autoFocus
              />
              {hb.groupError ? (
                <p className="text-sm text-[var(--danger-text)]">
                  {hb.groupError}
                </p>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" onClick={hb.closeGroupModal}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    if (groupModalState.mode === "create") {
                      // parentPath 미지정(루트 + 버튼)이면 store가 currentGroupPath를 쓰고,
                      // 그룹 우클릭 "하위 그룹 생성"이면 그 그룹 아래에 만든다.
                      await hb.createGroupIn(
                        hb.newGroupName,
                        groupModalState.parentPath,
                        groupModalState.vaultId,
                      );
                    } else {
                      const nextGroupPath = normalizeGroupPath(
                        getParentGroupPath(groupModalState.path)
                          ? `${getParentGroupPath(groupModalState.path)}/${hb.newGroupName.trim()}`
                          : hb.newGroupName.trim(),
                      );
                      await hb.renameGroupIn(
                        groupModalState.path,
                        hb.newGroupName,
                        groupModalState.vaultId,
                      );
                      if (nextGroupPath) {
                        hb.applyGroupPathUiMutation(
                          groupModalState.path,
                          nextGroupPath,
                          groupModalState.vaultId ?? PERSONAL_VAULT_ID,
                        );
                      }
                    }
                    hb.closeGroupModal();
                  } catch (error) {
                    hb.setGroupError(
                      error instanceof Error
                        ? error.message
                        : groupModalState.mode === "create"
                          ? translate("hostBrowser.error.groupCreateFailed")
                          : translate("hostBrowser.error.groupRenameFailed"),
                    );
                  }
                }}
              >
                {groupModalState.mode === "create"
                  ? "Create group"
                  : "Rename group"}
              </Button>
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {hostDeleteTarget ? (
        <HostDeleteConfirmDialog
          open
          backdropTestId="host-browser-modal-backdrop"
          title={
            hostDeleteTarget.hostCount === 1
              ? translate("hostBrowser.delete.hostSingle", {
                  title: hostDeleteTarget.title,
                })
              : translate("hostBrowser.delete.hostMany", {
                  count: hostDeleteTarget.hostCount,
                })
          }
          unusedLocalSecretCount={hb.hostDeleteUnusedLocalSecretRefs.length}
          removeUnusedSecrets={hb.removeUnusedSecretsOnHostDelete}
          onToggleRemoveUnusedSecrets={hb.setRemoveUnusedSecretsOnHostDelete}
          errorMessage={hb.hostDeleteError}
          isDeleting={hb.isRemovingHost}
          onClose={() => {
            if (hb.isRemovingHost) {
              return;
            }
            hb.setHostDeleteTarget(null);
            hb.setHostDeleteError(null);
          }}
          onConfirm={async () => {
            try {
              hb.setIsRemovingHost(true);
              await hb.onRemoveHosts(hostDeleteTarget.hostIds);
            } catch (error) {
              hb.setHostDeleteError(
                error instanceof Error
                  ? error.message
                  : translate("hostBrowser.error.hostDeleteFailed"),
              );
              // 다시 누르거나 닫을 수 있어야 한다 — 지우는 중으로 남으면 창이 잠긴다.
              hb.setIsRemovingHost(false);
              return;
            }

            try {
              if (hb.removeUnusedSecretsOnHostDelete && hb.hostDeleteUnusedLocalSecretRefs.length > 0) {
                await hb.onRemoveSecrets(hb.hostDeleteUnusedLocalSecretRefs);
              }
              hb.clearSelections();
              hb.setHostDeleteTarget(null);
              hb.setHostDeleteError(null);
            } catch (error) {
              hb.setHostDeleteError(
                error instanceof Error
                  ? error.message
                  : translate("hostBrowser.error.unusedSecretDeleteFailed"),
              );
            } finally {
              hb.setIsRemovingHost(false);
            }
          }}
        />
      ) : null}

      {groupDeleteTarget ? (
        <DialogBackdrop data-testid="host-browser-modal-backdrop">
          <ModalShell
            data-host-browser-modal="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-group-title"
          >
            <ModalHeader className="block">
              <SectionLabel>Delete</SectionLabel>
              <h3 id="delete-group-title">
                {groupDeleteTarget.groupCount === 1
                  ? translate("hostBrowser.delete.groupSingle", {
                      title: groupDeleteTarget.title,
                    })
                  : translate("hostBrowser.delete.groupMany", {
                      count: groupDeleteTarget.groupCount,
                    })}
              </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              {hb.groupDeleteDialogVariant === "with-descendants" ? (
                <p className="text-sm leading-6 text-[var(--text-soft)]">
                  {translate("hostBrowser.delete.groupImpact", {
                    groups: groupDeleteTarget.childGroupCount,
                    hosts: groupDeleteTarget.hostCount,
                    workspaces: groupDeleteTarget.workspaceCount,
                  })}
                </p>
              ) : (
                <p className="text-sm leading-6 text-[var(--text-soft)]">
                  {translate("hostBrowser.delete.groupEmpty")}
                </p>
              )}
              {hb.groupDeleteError ? (
                <p className="text-sm text-[var(--danger-text)]">
                  {hb.groupDeleteError}
                </p>
              ) : null}
            </ModalBody>
            <ModalFooter
              className={
                hb.groupDeleteDialogVariant === "with-descendants"
                  ? "flex-nowrap gap-[0.9rem]"
                  : undefined
              }
            >
              <Button
                variant="secondary"
                className={
                  hb.groupDeleteDialogVariant === "with-descendants"
                    ? "shrink-0 whitespace-nowrap"
                    : undefined
                }
                onClick={() => {
                  hb.setGroupDeleteTarget(null);
                  hb.setGroupDeleteError(null);
                }}
                disabled={hb.isRemovingGroup}
              >
                {translate("common.cancel")}
              </Button>
              {hb.groupDeleteDialogVariant === "with-descendants" ? (
                <>
                  <Button
                    variant="secondary"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={hb.isRemovingGroup}
                    onClick={() =>
                      void removeGroups(groupDeleteTarget, "reparent-descendants")
                    }
                  >
                    {translate("hostBrowser.delete.keepChildren")}
                  </Button>
                  <Button
                    variant="danger"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={hb.isRemovingGroup}
                    onClick={() => void removeGroups(groupDeleteTarget, "delete-subtree")}
                  >
                    {translate("hostBrowser.delete.deleteChildren")}
                  </Button>
                </>
              ) : (
                // 빈 그룹(하위 그룹만 있을 수 있다)은 묻지 않고 지운다 — 이 창은 그러다 실패했을 때만 열린다. 다시
                // 누르면 처음과 같이 하위 그룹까지 지운다.
                <Button
                  variant="danger"
                  disabled={hb.isRemovingGroup}
                  onClick={() => void removeGroups(groupDeleteTarget, "delete-subtree")}
                >
                  {translate("common.delete")}
                </Button>
              )}
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}

      {mixedDeleteAssetKeys ? (
        <HostDeleteConfirmDialog
          open
          backdropTestId="host-browser-modal-backdrop"
          title={translate("homeAssets.delete.title", {
            count: mixedDeleteAssetKeys.length,
            hosts: mixedDeleteTargets.hostIds.length,
            workspaces: mixedDeleteTargets.workspaceIds.length,
          })}
          unusedLocalSecretCount={mixedDeleteUnusedLocalSecretRefs.length}
          removeUnusedSecrets={mixedRemoveUnusedSecrets}
          onToggleRemoveUnusedSecrets={setMixedRemoveUnusedSecrets}
          errorMessage={mixedDeleteError}
          isDeleting={isMixedDeleting}
          onClose={() => {
            if (isMixedDeleting) {
              return;
            }
            setMixedDeleteAssetKeys(null);
            setMixedDeleteError(null);
          }}
          onConfirm={async () => {
            const failedKeys: HomeAssetKey[] = [];
            setIsMixedDeleting(true);
            const targets = mixedDeleteAssetKeys.map((key) => ({ key, ref: parseHomeAssetKey(key) }));
            // Host는 한 번에 지운다 — 함께 성공하거나 함께 실패한다.
            const hostTargets = targets.filter(({ ref }) => ref.kind === "host");
            if (hostTargets.length > 0) {
              try {
                await hb.onRemoveHosts(hostTargets.map(({ ref }) => ref.id));
                for (const { ref } of hostTargets) {
                  mixedDeletedHostIds.current.add(ref.id);
                }
              } catch {
                failedKeys.push(...hostTargets.map(({ key }) => key));
              }
            }
            for (const { key, ref } of targets) {
              if (ref.kind === "host") {
                continue;
              }
              try {
                if (onRemoveSavedWorkspace) {
                  await onRemoveSavedWorkspace(ref.id);
                } else {
                  failedKeys.push(key);
                }
              } catch {
                failedKeys.push(key);
              }
            }

            // 삭제에 성공한 Host의 자격증명은 실패한 다른 Host 때문에 유실하지 않는다.
            // 실패한 Host나 그 사이 추가된 Host가 쓰는 자격증명은 남긴다.
            const remainingRefs: string[] = [];
            let secretError: unknown;
            if (mixedRemoveUnusedSecrets) {
              const unusedRefs: string[] = [];
              for (const secretRef of mixedDeleteUnusedLocalSecretRefs) {
                const stillUsed = latestHosts.current.some((host) =>
                  !mixedDeletedHostIds.current.has(host.id) && getHostSecretRef(host) === secretRef,
                );
                (stillUsed ? remainingRefs : unusedRefs).push(secretRef);
              }
              // 한 번에 지운다 — 하나씩 지우다 화면이 죽자 83개 중 11개만 지워지고 남았다.
              if (unusedRefs.length > 0) {
                try {
                  await hb.onRemoveSecrets(unusedRefs);
                } catch (error) {
                  remainingRefs.push(...unusedRefs);
                  secretError = error;
                }
              }
            }
            setMixedDeleteUnusedLocalSecretRefs(remainingRefs);
            setIsMixedDeleting(false);
            if (failedKeys.length > 0 || secretError) {
              setMixedDeleteAssetKeys(failedKeys);
              setMixedDeleteError(failedKeys.length > 0
                ? translate("homeAssets.delete.failed", { count: failedKeys.length })
                : secretError instanceof Error ? secretError.message : translate("hostBrowser.error.unusedSecretDeleteFailed"));
              return;
            }
            hb.clearSelections();
            setMixedDeleteAssetKeys(null);
            setMixedDeleteError(null);
          }}
        />
      ) : null}

      <WorkspaceActionDialogs
        renameTarget={workspaceRenameTarget}
        deleteTarget={workspaceDeleteTarget}
        onClose={() => {
          setWorkspaceRenameTarget(null);
          setWorkspaceDeleteTarget(null);
        }}
        onRename={onRenameSavedWorkspace ?? (() => undefined)}
        onDelete={onRemoveSavedWorkspace ?? (() => undefined)}
      />
    </div>
  );
}
