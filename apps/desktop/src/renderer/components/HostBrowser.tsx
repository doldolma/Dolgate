import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getParentGroupPath, isAwsEcsHostRecord, normalizeGroupPath } from '@shared';
import { cn } from '../lib/cn';
import { DialogBackdrop } from './DialogBackdrop';
import { HostDeleteConfirmDialog } from './HostDeleteConfirmDialog';
import {
  Button,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
} from '../ui';
import { AppWindow, Columns2, Container, Copy, Download, Folder, Pencil, SquareTerminal, Trash2 } from '../ui/icons';
import { HomeSidebar } from './host-browser/HomeSidebar';
import { HostListPanel } from './host-browser/HostListPanel';
import { HostDetailPanel } from './host-browser/HostDetailPanel';
import {
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS,
  useHostBrowser,
  type UseHostBrowserParams,
} from './host-browser/useHostBrowser';

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
} from '@shared';

export type HostBrowserProps = UseHostBrowserParams & {
  /** 편집/생성 중일 때 우측 상세 영역에 detail 대신 표시할 에디터(HostDrawer). */
  hostEditor?: ReactNode;
};

// 우클릭 컨텍스트 메뉴 아이템 공통 스타일(아이콘+라벨, 그룹 사이 divider).
const CTX_ITEM =
  'flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.6rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent';
const CTX_DANGER =
  'flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.6rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent';
const CTX_ICON = 'h-[1.05rem] w-[1.05rem] shrink-0 text-[var(--text-soft)]';

export function HostBrowser({ hostEditor, ...props }: HostBrowserProps) {
  const hb = useHostBrowser(props);
  const { contextMenu, contextMenuStyle, groupModalState, groupDeleteTarget, hostDeleteTarget } =
    hb;
  // ECS 호스트는 SFTP/tmux/컨테이너를 지원하지 않아 컨텍스트 메뉴에서 숨긴다(단일 선택 기준).
  const contextMenuHost =
    contextMenu?.kind === 'host' && contextMenu.hostIds.length === 1
      ? hb.hosts.find((entry) => entry.id === contextMenu.hostIds[0]) ?? null
      : null;
  const contextMenuIsEcs = contextMenuHost ? isAwsEcsHostRecord(contextMenuHost) : false;
  const groupExportHostIds =
    contextMenu?.kind === 'group' ? hb.getHostIdsInGroupTrees(contextMenu.groupPaths) : [];

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)_minmax(360px,400px)] max-[1320px]:grid-cols-[220px_minmax(0,1fr)_340px] max-[1040px]:grid-cols-1">
      <HomeSidebar hb={hb} />

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {hb.statusMessage ? (
          <NoticeCard tone="info" className="mx-[1.1rem] mt-[0.9rem]">
            {hb.statusMessage}
          </NoticeCard>
        ) : null}
        {hb.errorMessage ? (
          <NoticeCard tone="danger" className="mx-[1.1rem] mt-[0.9rem]" role="alert">
            {hb.errorMessage}
          </NoticeCard>
        ) : null}
        <HostListPanel hb={hb} />
      </div>

      <aside
        className={cn(
          'min-h-0',
          hostEditor
            ? 'max-[1040px]:fixed max-[1040px]:inset-0 max-[1040px]:z-[20]'
            : 'border-l border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,var(--app-bg)_8%)] max-[1040px]:hidden',
        )}
      >
        {hostEditor ?? <HostDetailPanel hb={hb} />}
      </aside>

      {contextMenu
        ? createPortal(
            <div
              className="fixed z-[24] min-w-[148px] rounded-[10px] border border-[var(--border)] bg-[var(--surface-strong)] p-[0.4rem] shadow-[var(--shadow-floating)]"
              style={contextMenuStyle ?? undefined}
              role="menu"
            >
              {contextMenu.kind === 'host' ? (
                <>
                  {/* 연결류 */}
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={async () => {
                      await hb.runForOrderedHosts(contextMenu.hostIds, hb.onConnectHost);
                    }}
                  >
                    <SquareTerminal className={CTX_ICON} aria-hidden />
                    {contextMenu.hostIds.length === 1
                      ? '연결'
                      : `연결 (${contextMenu.hostIds.length}개)`}
                  </button>
                  {contextMenu.hostIds.length === 1 && hb.onOpenHostInNewWindow ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={() => {
                        const targetHostId = contextMenu.hostIds[0];
                        hb.setContextMenu(null);
                        if (targetHostId) {
                          void hb.onOpenHostInNewWindow?.(targetHostId);
                        }
                      }}
                    >
                      <AppWindow className={CTX_ICON} aria-hidden />
                      새 창에서 연결
                    </button>
                  ) : null}
                  {!contextMenuIsEcs && hb.onOpenSftp ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      disabled={contextMenu.hostIds.length !== 1}
                      onClick={() => {
                        const targetHostId = contextMenu.hostIds[0];
                        hb.setContextMenu(null);
                        if (!targetHostId) {
                          return;
                        }
                        void hb.onOpenSftp?.(targetHostId);
                      }}
                    >
                      <Folder className={CTX_ICON} aria-hidden />
                      SFTP 연결
                    </button>
                  ) : null}
                  {!contextMenuIsEcs && hb.onConnectHostTmux ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={async () => {
                        await hb.runForOrderedHosts(contextMenu.hostIds, hb.onConnectHostTmux!);
                      }}
                    >
                      <Columns2 className={CTX_ICON} aria-hidden />
                      {contextMenu.hostIds.length === 1
                        ? 'tmux로 연결'
                        : `tmux로 연결 (${contextMenu.hostIds.length}개)`}
                    </button>
                  ) : null}
                  {!contextMenuIsEcs ? (
                    <button
                      type="button"
                      className={CTX_ITEM}
                      onClick={async () => {
                        await hb.runForOrderedHosts(contextMenu.hostIds, hb.onOpenHostContainers);
                      }}
                    >
                      <Container className={CTX_ICON} aria-hidden />
                      {contextMenu.hostIds.length === 1
                        ? '컨테이너'
                        : `컨테이너 (${contextMenu.hostIds.length}개)`}
                    </button>
                  ) : null}

                  <div role="separator" className="my-[0.35rem] h-px bg-[var(--border)]" />

                  {/* 관리 */}
                  <button
                    type="button"
                    className={CTX_ITEM}
                    disabled={contextMenu.hostIds.length !== 1}
                    onClick={() => {
                      const targetHostId = contextMenu.hostIds[0];
                      hb.setContextMenu(null);
                      if (!targetHostId) {
                        return;
                      }
                      hb.onEditHost(targetHostId);
                    }}
                  >
                    <Pencil className={CTX_ICON} aria-hidden />
                    수정
                  </button>
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={async () => {
                      hb.setContextMenu(null);
                      await hb.onDuplicateHosts(hb.getOrderedSelectedHostIds(contextMenu.hostIds));
                    }}
                  >
                    <Copy className={CTX_ICON} aria-hidden />
                    {contextMenu.hostIds.length === 1
                      ? '복사'
                      : `복사 (${contextMenu.hostIds.length}개)`}
                  </button>
                  <button
                    type="button"
                    className={CTX_ITEM}
                    onClick={() => {
                      const orderedHostIds = hb.getOrderedSelectedHostIds(contextMenu.hostIds);
                      hb.setContextMenu(null);
                      hb.onExportHosts(orderedHostIds);
                    }}
                  >
                    <Download className={CTX_ICON} aria-hidden />
                    {contextMenu.hostIds.length === 1
                      ? '내보내기...'
                      : `내보내기... (${contextMenu.hostIds.length}개)`}
                  </button>

                  <div role="separator" className="my-[0.35rem] h-px bg-[var(--border)]" />

                  {/* 삭제 */}
                  <button
                    type="button"
                    className={CTX_DANGER}
                    onClick={async () => {
                      const orderedHostIds = hb.getOrderedSelectedHostIds(contextMenu.hostIds);
                      hb.setContextMenu(null);
                      if (orderedHostIds.length === 0) {
                        return;
                      }
                      hb.setHostDeleteTarget(hb.buildHostDeleteTarget(orderedHostIds));
                      hb.setHostDeleteError(null);
                    }}
                  >
                    <Trash2 className="h-[1.05rem] w-[1.05rem] shrink-0" aria-hidden />
                    삭제
                  </button>
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
                      hb.openCreateSubgroupModal(targetGroupPath);
                    }}
                  >
                    하위 그룹 생성
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
                      hb.openRenameGroupModal(targetGroupPath);
                    }}
                  >
                    이름 변경
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-[0.7rem] rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--text)] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--surface-muted)_92%,transparent_8%)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    disabled={groupExportHostIds.length === 0}
                    onClick={() => {
                      hb.setContextMenu(null);
                      if (groupExportHostIds.length > 0) {
                        hb.onExportHosts(groupExportHostIds);
                      }
                    }}
                  >
                    <Download className={CTX_ICON} aria-hidden />
                    내보내기... ({groupExportHostIds.length}개 호스트)
                  </button>

                  <div role="separator" className="my-[0.35rem] h-px bg-[var(--border)]" />

                  <button
                    type="button"
                    className="flex w-full items-center rounded-[10px] px-[0.9rem] py-[0.7rem] text-left text-[var(--danger-text)] transition-colors duration-150 hover:bg-[var(--danger-bg)]"
                    onClick={() => {
                      hb.setGroupDeleteTarget(hb.buildGroupDeleteTarget(contextMenu.groupPaths));
                      hb.setGroupDeleteError(null);
                      hb.setContextMenu(null);
                    }}
                  >
                    삭제
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}

      {groupModalState ? (
        <DialogBackdrop data-testid="host-browser-modal-backdrop" onDismiss={hb.closeGroupModal}>
          <ModalShell
            data-host-browser-modal="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby={
              groupModalState.mode === 'create' ? 'new-group-title' : 'rename-group-title'
            }
          >
            <ModalHeader className="block">
              <SectionLabel>{groupModalState.mode === 'create' ? 'Create' : 'Rename'}</SectionLabel>
              <h3 id={groupModalState.mode === 'create' ? 'new-group-title' : 'rename-group-title'}>
                {groupModalState.mode === 'create' ? 'New Group' : 'Rename Group'}
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
                <p className="text-sm text-[var(--danger-text)]">{hb.groupError}</p>
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
                    if (groupModalState.mode === 'create') {
                      // parentPath 미지정(루트 + 버튼)이면 store가 currentGroupPath를 쓰고,
                      // 그룹 우클릭 "하위 그룹 생성"이면 그 그룹 아래에 만든다.
                      await hb.onCreateGroup(hb.newGroupName, groupModalState.parentPath);
                    } else {
                      const nextGroupPath = normalizeGroupPath(
                        getParentGroupPath(groupModalState.path)
                          ? `${getParentGroupPath(groupModalState.path)}/${hb.newGroupName.trim()}`
                          : hb.newGroupName.trim(),
                      );
                      await hb.onRenameGroup(groupModalState.path, hb.newGroupName);
                      if (nextGroupPath) {
                        hb.applyGroupPathUiMutation(groupModalState.path, nextGroupPath);
                      }
                    }
                    hb.closeGroupModal();
                  } catch (error) {
                    hb.setGroupError(
                      error instanceof Error
                        ? error.message
                        : groupModalState.mode === 'create'
                          ? '그룹을 만들지 못했습니다.'
                          : '그룹 이름을 변경하지 못했습니다.',
                    );
                  }
                }}
              >
                {groupModalState.mode === 'create' ? 'Create group' : 'Rename group'}
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
              ? `${hostDeleteTarget.title} 호스트를 삭제할까요?`
              : `선택한 ${hostDeleteTarget.hostCount}개 호스트를 삭제할까요?`
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
              for (const hostId of hostDeleteTarget.hostIds) {
                await hb.onRemoveHost(hostId);
              }
            } catch (error) {
              hb.setHostDeleteError(
                error instanceof Error ? error.message : '호스트를 삭제하지 못했습니다.',
              );
              return;
            }

            try {
              if (hb.removeUnusedSecretsOnHostDelete) {
                for (const secretRef of hb.hostDeleteUnusedLocalSecretRefs) {
                  await hb.onRemoveSecret(secretRef);
                }
              }
              hb.clearSelections();
              hb.setHostDeleteTarget(null);
              hb.setHostDeleteError(null);
            } catch (error) {
              hb.setHostDeleteError(
                error instanceof Error
                  ? error.message
                  : '사용하지 않는 secret을 삭제하지 못했습니다.',
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
                  ? `${groupDeleteTarget.title} 그룹을 삭제할까요?`
                  : `선택한 ${groupDeleteTarget.groupCount}개 그룹을 삭제할까요?`}
              </h3>
            </ModalHeader>
            <ModalBody className="grid gap-4">
              {hb.groupDeleteDialogVariant === 'with-descendants' ? (
                <p className="text-sm leading-6 text-[var(--text-soft)]">
                  하위 그룹 {groupDeleteTarget.childGroupCount}개와 호스트{' '}
                  {groupDeleteTarget.hostCount}개가 함께 영향을 받습니다.
                </p>
              ) : (
                <p className="text-sm leading-6 text-[var(--text-soft)]">
                  이 그룹은 비어 있습니다. 삭제하면 바로 사라집니다.
                </p>
              )}
              {hb.groupDeleteError ? (
                <p className="text-sm text-[var(--danger-text)]">{hb.groupDeleteError}</p>
              ) : null}
            </ModalBody>
            <ModalFooter
              className={
                hb.groupDeleteDialogVariant === 'with-descendants'
                  ? 'flex-nowrap gap-[0.9rem]'
                  : undefined
              }
            >
              <Button
                variant="secondary"
                className={
                  hb.groupDeleteDialogVariant === 'with-descendants'
                    ? 'shrink-0 whitespace-nowrap'
                    : undefined
                }
                onClick={() => {
                  hb.setGroupDeleteTarget(null);
                  hb.setGroupDeleteError(null);
                }}
                disabled={hb.isRemovingGroup}
              >
                취소
              </Button>
              {hb.groupDeleteDialogVariant === 'with-descendants' ? (
                <>
                  <Button
                    variant="secondary"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={hb.isRemovingGroup}
                    onClick={async () => {
                      try {
                        hb.setIsRemovingGroup(true);
                        for (const path of groupDeleteTarget.paths) {
                          await hb.onRemoveGroup(path, 'reparent-descendants');
                        }
                        hb.setSelectedGroupPaths((current) =>
                          current.filter((path) => !groupDeleteTarget.paths.includes(path)),
                        );
                        hb.setGroupDeleteTarget(null);
                        hb.setGroupDeleteError(null);
                      } catch (error) {
                        hb.setGroupDeleteError(
                          error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.',
                        );
                      } finally {
                        hb.setIsRemovingGroup(false);
                      }
                    }}
                  >
                    하위 항목 유지
                  </Button>
                  <Button
                    variant="danger"
                    className="min-w-0 flex-1 whitespace-nowrap"
                    disabled={hb.isRemovingGroup}
                    onClick={async () => {
                      try {
                        hb.setIsRemovingGroup(true);
                        await hb.onRemoveGroup(groupDeleteTarget.paths[0], 'delete-subtree');
                        for (const path of groupDeleteTarget.paths.slice(1)) {
                          await hb.onRemoveGroup(path, 'delete-subtree');
                        }
                        hb.setSelectedGroupPaths((current) =>
                          current.filter((path) => !groupDeleteTarget.paths.includes(path)),
                        );
                        hb.setGroupDeleteTarget(null);
                        hb.setGroupDeleteError(null);
                      } catch (error) {
                        hb.setGroupDeleteError(
                          error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.',
                        );
                      } finally {
                        hb.setIsRemovingGroup(false);
                      }
                    }}
                  >
                    하위 항목까지 삭제
                  </Button>
                </>
              ) : (
                <Button
                  variant="danger"
                  disabled={hb.isRemovingGroup}
                  onClick={async () => {
                    try {
                      hb.setIsRemovingGroup(true);
                      await hb.onRemoveGroup(groupDeleteTarget.paths[0], 'reparent-descendants');
                      for (const path of groupDeleteTarget.paths.slice(1)) {
                        await hb.onRemoveGroup(path, 'reparent-descendants');
                      }
                      hb.setSelectedGroupPaths((current) =>
                        current.filter((path) => !groupDeleteTarget.paths.includes(path)),
                      );
                      hb.setGroupDeleteTarget(null);
                      hb.setGroupDeleteError(null);
                    } catch (error) {
                      hb.setGroupDeleteError(
                        error instanceof Error ? error.message : '그룹을 삭제하지 못했습니다.',
                      );
                    } finally {
                      hb.setIsRemovingGroup(false);
                    }
                  }}
                >
                  삭제
                </Button>
              )}
            </ModalFooter>
          </ModalShell>
        </DialogBackdrop>
      ) : null}
    </div>
  );
}
