import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopWindowState, TerminalTab, UpdateState } from '@shared';
import type {
  DynamicTabStripItem,
  WorkspaceTab,
  WorkspaceTabId
} from '../store/createAppStore';
import { DesktopWindowControls, type DesktopPlatform } from './DesktopWindowControls';
import { cn } from '../lib/cn';
import { Badge, Button, IconButton, TabButton, Tabs } from '../ui';

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

interface AppTitleBarProps {
  desktopPlatform: DesktopPlatform;
  tabs: TerminalTab[];
  workspaces: WorkspaceTab[];
  tabStrip: DynamicTabStripItem[];
  activeWorkspaceTab: WorkspaceTabId;
  draggedSession: DraggedSessionPayload | null;
  updateState: UpdateState;
  windowState: DesktopWindowState;
  onSelectHome: () => void;
  onSelectSftp: () => void;
  onSelectContainers: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCloseSession: (sessionId: string) => Promise<void>;
  onCloseWorkspace: (workspaceId: string) => Promise<void>;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onDetachSessionToStandalone: (workspaceId: string, sessionId: string) => void;
  onReorderDynamicTab: (source: DynamicTabStripItem, target: DynamicTabStripItem, placement: 'before' | 'after') => void;
  onCheckForUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onDismissUpdate: (version: string) => Promise<void>;
  onOpenReleasePage: (url: string) => Promise<void>;
  onMinimizeWindow: () => Promise<void>;
  onMaximizeWindow: () => Promise<void>;
  onRestoreWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

type TitlebarDynamicItem =
  | {
      kind: 'session';
      sessionId: string;
      title: string;
      status: TerminalTab['status'];
      active: boolean;
    }
  | {
      kind: 'workspace';
      workspaceId: string;
      title: string;
      paneCount: number;
      active: boolean;
    };

const TAB_DRAG_MIME = 'application/x-dolssh-tab-item';

function serializeDraggedTab(item: DynamicTabStripItem): string {
  if (item.kind === 'session') {
    return `session:${item.sessionId}`;
  }
  return `workspace:${item.workspaceId}`;
}

function parseDraggedTab(payload: string): DynamicTabStripItem | null {
  if (payload.startsWith('session:')) {
    const sessionId = payload.slice('session:'.length);
    return sessionId ? { kind: 'session', sessionId } : null;
  }
  if (payload.startsWith('workspace:')) {
    const workspaceId = payload.slice('workspace:'.length);
    return workspaceId ? { kind: 'workspace', workspaceId } : null;
  }
  return null;
}

function formatProgressPercent(updateState: UpdateState): string {
  if (!updateState.progress) {
    return '';
  }
  return `${Math.round(updateState.progress.percent)}%`;
}

function shouldShowBadge(updateState: UpdateState): boolean {
  if (updateState.status === 'downloading' || updateState.status === 'downloaded') {
    return true;
  }
  return updateState.status === 'available' && updateState.release?.version !== updateState.dismissedVersion;
}

export function getEmptyReleaseMessage(updateState: UpdateState): string | null {
  if (updateState.status === 'checking') {
    return 'GitHub Releases에서 새 버전을 확인하고 있습니다.';
  }
  return null;
}

function formatPublishedAt(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric'
  }).format(parsed);
}

function resolveReleaseUrl(updateState: UpdateState): string {
  const version = updateState.release?.version;
  if (!version) {
    return 'https://github.com/doldolma/dolgate/releases';
  }
  return `https://github.com/doldolma/dolgate/releases/tag/v${version}`;
}

function countWorkspacePanes(workspace: WorkspaceTab): number {
  const stack = [workspace.layout];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.kind === 'leaf') {
      count += 1;
      continue;
    }
    stack.push(node.first, node.second);
  }
  return count;
}

function getTitlebarTabClass(active: boolean): string {
  if (active) {
    return 'border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.94)] text-[var(--accent-strong)] shadow-none hover:text-[var(--accent-strong)]';
  }

  return 'border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.06)] text-[rgba(243,247,251,0.78)] shadow-none hover:bg-[rgba(255,255,255,0.1)] hover:text-white';
}

function getTitlebarDynamicTabContainerClass(active: boolean): string {
  if (active) {
    return 'border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.94)] shadow-none';
  }

  return 'border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.06)] shadow-none hover:bg-[rgba(255,255,255,0.1)]';
}

function getTitlebarDynamicTabButtonClass(active: boolean): string {
  return cn(
    'min-w-0 justify-start border-transparent bg-transparent px-4 py-[0.58rem] shadow-none hover:bg-transparent',
    active
      ? 'text-[var(--accent-strong)] hover:text-[var(--accent-strong)]'
      : 'text-[rgba(243,247,251,0.82)] hover:text-white',
  );
}

function getTitlebarCloseButtonClass(active: boolean): string {
  if (active) {
    return 'h-8 w-8 rounded-full text-[0.95rem] text-[color-mix(in_srgb,var(--accent-strong)_84%,var(--text)_16%)] hover:bg-[color-mix(in_srgb,var(--accent-strong)_12%,transparent)] hover:text-[var(--accent-strong)]';
  }

  return 'h-8 w-8 rounded-full text-[0.95rem] text-[rgba(243,247,251,0.78)] hover:bg-[rgba(255,255,255,0.12)] hover:text-white';
}

export function AppTitleBar({
  desktopPlatform,
  tabs,
  workspaces,
  tabStrip,
  activeWorkspaceTab,
  draggedSession,
  updateState,
  windowState,
  onSelectHome,
  onSelectSftp,
  onSelectContainers,
  onSelectSession,
  onSelectWorkspace,
  onCloseSession,
  onCloseWorkspace,
  onStartSessionDrag,
  onEndSessionDrag,
  onDetachSessionToStandalone,
  onReorderDynamicTab,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onDismissUpdate,
  onOpenReleasePage,
  onMinimizeWindow,
  onMaximizeWindow,
  onRestoreWindow,
  onCloseWindow
}: AppTitleBarProps) {
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const [isDetachHovering, setIsDetachHovering] = useState(false);
  const [tabDropPreview, setTabDropPreview] = useState<{ targetKey: string; placement: 'before' | 'after' } | null>(null);
  const [isTabDragging, setIsTabDragging] = useState(false);
  const draggedTabRef = useRef<DynamicTabStripItem | null>(null);
  const updateMenuRef = useRef<HTMLDivElement | null>(null);
  const titlebarTabStripRef = useRef<HTMLDivElement | null>(null);
  const titlebarTabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [showLeftTabStripFade, setShowLeftTabStripFade] = useState(false);
  const [showRightTabStripFade, setShowRightTabStripFade] = useState(false);

  const dynamicItems = useMemo<TitlebarDynamicItem[]>(
    () =>
      tabStrip
        .map((item) => {
          if (item.kind === 'session') {
            const tab = tabs.find((candidate) => candidate.sessionId === item.sessionId);
            if (!tab) {
              return null;
            }
            return {
              kind: 'session',
              sessionId: tab.sessionId,
              title: tab.title,
              status: tab.status,
              active: activeWorkspaceTab === `session:${tab.sessionId}`
            } satisfies TitlebarDynamicItem;
          }

          if (item.kind === 'workspace') {
            const workspace = workspaces.find((candidate) => candidate.id === item.workspaceId);
            if (!workspace) {
              return null;
            }
            return {
              kind: 'workspace',
              workspaceId: workspace.id,
              title: workspace.title,
              paneCount: countWorkspacePanes(workspace),
              active: activeWorkspaceTab === `workspace:${workspace.id}`
            } satisfies TitlebarDynamicItem;
          }

        })
        .filter((item): item is TitlebarDynamicItem => item !== null),
    [activeWorkspaceTab, tabStrip, tabs, workspaces]
  );

  const showBadge = shouldShowBadge(updateState);
  const publishedAt = formatPublishedAt(updateState.release?.publishedAt);
  const releaseUrl = resolveReleaseUrl(updateState);
  const showDownloadAction = updateState.status === 'available';
  const showInstallAction = updateState.status === 'downloaded';
  const showCheckAction = updateState.enabled && !showDownloadAction && !showInstallAction;
  const showDevDisabledAction = !updateState.enabled && !showDownloadAction && !showInstallAction;
  const titleText = showInstallAction
    ? '업데이트를 적용할 준비가 됐습니다'
    : showDownloadAction
      ? '새 Dolgate 버전을 사용할 수 있습니다'
      : '앱 업데이트';

  const canDetachToTabs = draggedSession?.source === 'workspace-pane' && Boolean(draggedSession.workspaceId);

  const updateTitlebarTabStripFades = useCallback(() => {
    const container = titlebarTabStripRef.current;
    if (!container) {
      setShowLeftTabStripFade(false);
      setShowRightTabStripFade(false);
      return;
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const nextShowLeft = container.scrollLeft > 1;
    const nextShowRight = container.scrollLeft < maxScrollLeft - 1;
    setShowLeftTabStripFade((previous) =>
      previous === nextShowLeft ? previous : nextShowLeft,
    );
    setShowRightTabStripFade((previous) =>
      previous === nextShowRight ? previous : nextShowRight,
    );
  }, []);

  function getTabKey(item: DynamicTabStripItem): string {
    if (item.kind === 'session') {
      return `session:${item.sessionId}`;
    }
    return `workspace:${item.workspaceId}`;
  }

  function resolveTabDropPlacement(event: React.DragEvent<HTMLDivElement>): 'before' | 'after' {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX <= rect.left + rect.width / 2 ? 'before' : 'after';
  }

  useEffect(() => {
    if (!isUpdateOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (updateMenuRef.current?.contains(target)) {
        return;
      }
      setIsUpdateOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isUpdateOpen]);

  useEffect(() => {
    updateTitlebarTabStripFades();
  }, [activeWorkspaceTab, dynamicItems.length, updateTitlebarTabStripFades]);

  useEffect(() => {
    const handleResize = () => {
      updateTitlebarTabStripFades();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateTitlebarTabStripFades]);

  useLayoutEffect(() => {
    if (isTabDragging) {
      return;
    }

    const activeItem = titlebarTabItemRefs.current[activeWorkspaceTab];
    if (!activeItem) {
      updateTitlebarTabStripFades();
      return;
    }

    if (typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    if (typeof window.requestAnimationFrame !== 'function') {
      updateTitlebarTabStripFades();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      updateTitlebarTabStripFades();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeWorkspaceTab, isTabDragging, updateTitlebarTabStripFades]);

  return (
    <header
      className={cn(
        'flex min-h-16 items-center gap-4 border-b border-[var(--chrome-border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--chrome-bg)_94%,white_6%),color-mix(in_srgb,var(--chrome-bg)_98%,black_2%))] px-[1rem] pb-[0.85rem] pt-[0.9rem] text-[#f3f7fb] shadow-[inset_0_-1px_0_rgba(255,255,255,0.03)] [-webkit-app-region:drag] max-[760px]:px-[1rem] max-[760px]:pr-[0.8rem]',
        desktopPlatform === 'darwin' && 'pl-[5.4rem] max-[1040px]:pl-[4.8rem] max-[760px]:px-[4.8rem] max-[760px]:pr-[0.8rem]',
      )}
    >
      <div
        className={cn(
          'relative min-w-0 rounded-[24px] p-[0.2rem] transition-[background-color,box-shadow] duration-140 [-webkit-app-region:no-drag]',
          isDetachHovering &&
            'bg-[rgba(142,209,194,0.08)] shadow-[inset_0_0_0_1px_rgba(142,209,194,0.16)]',
        )}
        onDragOver={(event) => {
          if (!canDetachToTabs) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setIsDetachHovering(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
          }
          setIsDetachHovering(false);
        }}
        onDrop={(event) => {
          if (!draggedSession || draggedSession.source !== 'workspace-pane' || !draggedSession.workspaceId) {
            return;
          }
          event.preventDefault();
          setIsDetachHovering(false);
          onDetachSessionToStandalone(draggedSession.workspaceId, draggedSession.sessionId);
          onEndSessionDrag();
        }}
      >
        {showLeftTabStripFade ? (
          <div
            data-testid="titlebar-tab-strip-fade-left"
            className="pointer-events-none absolute inset-y-[0.24rem] left-[0.2rem] z-[1] w-11 rounded-l-[22px] bg-[linear-gradient(90deg,color-mix(in_srgb,var(--chrome-bg)_92%,rgba(255,255,255,0.08)_8%),transparent)]"
          />
        ) : null}
        {showRightTabStripFade ? (
          <div
            data-testid="titlebar-tab-strip-fade-right"
            className="pointer-events-none absolute inset-y-[0.24rem] right-[0.2rem] z-[1] w-11 rounded-r-[22px] bg-[linear-gradient(270deg,color-mix(in_srgb,var(--chrome-bg)_92%,rgba(255,255,255,0.08)_8%),transparent)]"
          />
        ) : null}
        <div
          ref={titlebarTabStripRef}
          data-titlebar-tab-strip="true"
          className="flex min-w-0 items-center gap-[0.55rem] overflow-x-auto overflow-y-hidden px-[0.05rem] py-[0.02rem]"
          onScroll={updateTitlebarTabStripFades}
        >
          <Tabs className="shrink-0 bg-transparent p-0 shadow-none border-transparent gap-2">
            <div
              ref={(node) => {
                titlebarTabItemRefs.current.home = node;
              }}
              className="shrink-0"
            >
              <TabButton
                active={activeWorkspaceTab === 'home'}
                className={getTitlebarTabClass(activeWorkspaceTab === 'home')}
                onClick={onSelectHome}
              >
                Home
              </TabButton>
            </div>
            <div
              ref={(node) => {
                titlebarTabItemRefs.current.sftp = node;
              }}
              className="shrink-0"
            >
              <TabButton
                active={activeWorkspaceTab === 'sftp'}
                className={getTitlebarTabClass(activeWorkspaceTab === 'sftp')}
                onClick={onSelectSftp}
              >
                SFTP
              </TabButton>
            </div>
            <div
              ref={(node) => {
                titlebarTabItemRefs.current.containers = node;
              }}
              className="shrink-0"
            >
              <TabButton
                active={activeWorkspaceTab === 'containers'}
                className={getTitlebarTabClass(activeWorkspaceTab === 'containers')}
                onClick={onSelectContainers}
              >
                Containers
              </TabButton>
            </div>
          </Tabs>
          {dynamicItems.map((item) => {
          if (item.kind === 'session') {
            const target = { kind: 'session', sessionId: item.sessionId } as const;
            const targetKey = getTabKey(target);
            return (
              <div
                key={item.sessionId}
                ref={(node) => {
                  titlebarTabItemRefs.current[targetKey] = node;
                }}
                className={cn(
                  'group relative flex flex-none items-center gap-1 rounded-[22px] border pr-1.5 transition-[box-shadow,background-color,border-color] duration-150',
                  getTitlebarDynamicTabContainerClass(item.active),
                  tabDropPreview?.targetKey === targetKey &&
                    tabDropPreview.placement === 'before' &&
                    'before:absolute before:-left-1 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[var(--accent-strong)]',
                  tabDropPreview?.targetKey === targetKey &&
                    tabDropPreview.placement === 'after' &&
                    'after:absolute after:-right-1 after:top-2 after:bottom-2 after:w-[3px] after:rounded-full after:bg-[var(--accent-strong)]',
                )}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-dolssh-session-id', item.sessionId);
                  event.dataTransfer.setData(TAB_DRAG_MIME, serializeDraggedTab({ kind: 'session', sessionId: item.sessionId }));
                  const nextDraggedTab = { kind: 'session', sessionId: item.sessionId } as const;
                  draggedTabRef.current = nextDraggedTab;
                  setIsTabDragging(true);
                  onStartSessionDrag(item.sessionId);
                }}
                onDragEnd={() => {
                  draggedTabRef.current = null;
                  setTabDropPreview(null);
                  setIsTabDragging(false);
                  setIsDetachHovering(false);
                  onEndSessionDrag();
                }}
                onDragOver={(event) => {
                  if (!draggedTabRef.current) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setTabDropPreview({
                    targetKey,
                    placement: resolveTabDropPlacement(event)
                  });
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                    return;
                  }
                  setTabDropPreview((current) => (current?.targetKey === targetKey ? null : current));
                }}
                onDrop={(event) => {
                  const payload = parseDraggedTab(event.dataTransfer.getData(TAB_DRAG_MIME));
                  const sourceTab = payload ?? draggedTabRef.current;
                  if (!sourceTab) {
                    return;
                  }
                  event.preventDefault();
                  const placement = resolveTabDropPlacement(event);
                  setTabDropPreview(null);
                  onReorderDynamicTab(sourceTab, target, placement);
                }}
              >
                <TabButton
                  active={item.active}
                  className={cn(
                    'min-w-[8.5rem]',
                    getTitlebarDynamicTabButtonClass(item.active),
                  )}
                  onClick={() => onSelectSession(item.sessionId)}
                >
                  <span className="truncate">{item.title}</span>
                </TabButton>
                <IconButton
                  size="sm"
                  tone="ghost"
                  className={getTitlebarCloseButtonClass(item.active)}
                  aria-label={`${item.title} 세션 종료`}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await onCloseSession(item.sessionId);
                  }}
                  disabled={item.status === 'disconnecting'}
                >
                  ×
                </IconButton>
              </div>
            );
          }

          const target = { kind: 'workspace', workspaceId: item.workspaceId } as const;
          const targetKey = getTabKey(target);
          return (
            <div
              key={item.workspaceId}
              ref={(node) => {
                titlebarTabItemRefs.current[targetKey] = node;
              }}
              className={cn(
                'group relative flex flex-none items-center gap-1 rounded-[22px] border pr-1.5 transition-[box-shadow,background-color,border-color] duration-150',
                getTitlebarDynamicTabContainerClass(item.active),
                tabDropPreview?.targetKey === targetKey &&
                  tabDropPreview.placement === 'before' &&
                  'before:absolute before:-left-1 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[var(--accent-strong)]',
                tabDropPreview?.targetKey === targetKey &&
                  tabDropPreview.placement === 'after' &&
                  'after:absolute after:-right-1 after:top-2 after:bottom-2 after:w-[3px] after:rounded-full after:bg-[var(--accent-strong)]',
              )}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.title);
                event.dataTransfer.setData(TAB_DRAG_MIME, serializeDraggedTab({ kind: 'workspace', workspaceId: item.workspaceId }));
                const nextDraggedTab = { kind: 'workspace', workspaceId: item.workspaceId } as const;
                draggedTabRef.current = nextDraggedTab;
                setIsTabDragging(true);
              }}
              onDragEnd={() => {
                draggedTabRef.current = null;
                setTabDropPreview(null);
                setIsTabDragging(false);
                setIsDetachHovering(false);
              }}
              onDragOver={(event) => {
                if (!draggedTabRef.current) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setTabDropPreview({
                  targetKey,
                  placement: resolveTabDropPlacement(event)
                });
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                  return;
                }
                setTabDropPreview((current) => (current?.targetKey === targetKey ? null : current));
              }}
              onDrop={(event) => {
                const payload = parseDraggedTab(event.dataTransfer.getData(TAB_DRAG_MIME));
                const sourceTab = payload ?? draggedTabRef.current;
                if (!sourceTab) {
                  return;
                }
                event.preventDefault();
                const placement = resolveTabDropPlacement(event);
                setTabDropPreview(null);
                onReorderDynamicTab(sourceTab, target, placement);
              }}
            >
              <TabButton
                active={item.active}
                className={cn(
                  'min-w-[10.5rem] gap-2',
                  getTitlebarDynamicTabButtonClass(item.active),
                )}
                onClick={() => onSelectWorkspace(item.workspaceId)}
              >
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full text-[0.88rem]',
                    item.active
                      ? 'bg-[color-mix(in_srgb,var(--accent-strong)_12%,white_88%)] text-[var(--accent-strong)]'
                      : 'bg-[rgba(255,255,255,0.08)] text-[rgba(243,247,251,0.78)]',
                  )}
                  aria-hidden="true"
                >
                  ⊞
                </span>
                <span className="truncate">{item.title}</span>
                <span
                  className={cn(
                    'ml-auto inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-[0.72rem] font-semibold',
                    item.active
                      ? 'bg-[color-mix(in_srgb,var(--accent-strong)_12%,white_88%)] text-[var(--accent-strong)]'
                      : 'bg-[rgba(255,255,255,0.08)] text-[rgba(243,247,251,0.78)]',
                  )}
                >
                  {item.paneCount}
                </span>
              </TabButton>
              <IconButton
                size="sm"
                tone="ghost"
                className={getTitlebarCloseButtonClass(item.active)}
                aria-label={`${item.title} 닫기`}
                onClick={async (event) => {
                  event.stopPropagation();
                  await onCloseWorkspace(item.workspaceId);
                }}
              >
                ×
              </IconButton>
            </div>
          );
        })}
        {isTabDragging && dynamicItems.length > 0 ? (
          <div
            className={cn(
              'h-10 w-6 flex-none rounded-[999px] transition-[background-color,box-shadow] duration-150',
              tabDropPreview?.targetKey === '__tail__'
                ? 'bg-[rgba(255,255,255,0.12)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]'
                : 'bg-transparent'
            )}
            onDragOver={(event) => {
              if (!draggedTabRef.current) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setTabDropPreview({
                targetKey: '__tail__',
                placement: 'after'
              });
            }}
            onDragLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                return;
              }
              setTabDropPreview((current) => (current?.targetKey === '__tail__' ? null : current));
            }}
            onDrop={(event) => {
              const payload = parseDraggedTab(event.dataTransfer.getData(TAB_DRAG_MIME));
              const sourceTab = payload ?? draggedTabRef.current;
              const lastItem = tabStrip[tabStrip.length - 1];
              if (!sourceTab || !lastItem) {
                return;
              }
              event.preventDefault();
              setTabDropPreview(null);
              onReorderDynamicTab(sourceTab, lastItem, 'after');
            }}
          />
        ) : null}
        </div>
      </div>
      <div className="min-w-16 flex-1" />
      <div className="relative flex items-center gap-[0.55rem] [-webkit-app-region:no-drag]">
        <div className="relative [-webkit-app-region:no-drag]" ref={updateMenuRef}>
          <IconButton
            tone="default"
            active={isUpdateOpen}
            className="relative h-12 w-12 rounded-full border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.06)] text-[1.1rem] text-white shadow-none hover:bg-[rgba(255,255,255,0.1)]"
            aria-label="업데이트 상태 보기"
            onClick={() => setIsUpdateOpen((current) => !current)}
          >
            <span aria-hidden="true">
              🔔
            </span>
            {showBadge ? <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[var(--accent-strong)] ring-2 ring-[var(--chrome-bg)]" /> : null}
          </IconButton>

          {isUpdateOpen ? (
            <div
              data-testid="update-popover"
              className="absolute right-0 top-[calc(100%+0.8rem)] z-20 w-[min(24rem,calc(100vw-2rem))] rounded-[26px] border border-[var(--border)] bg-[var(--dialog-surface)] p-5 shadow-[var(--shadow-floating)]"
            >
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 text-[var(--text)]">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent-strong)_14%,var(--surface))] text-[var(--accent-strong)]" aria-hidden="true">
                      ↗
                    </span>
                    <strong>{titleText}</strong>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.82rem] text-[var(--text-soft)]">
                    {publishedAt ? <span>{publishedAt}</span> : null}
                    {updateState.release?.version ? <span>Version {updateState.release.version}</span> : null}
                  </div>
                </div>
                <Badge>{updateState.currentVersion}</Badge>
              </div>

              <div className="space-y-3 pb-4 text-[0.93rem] leading-[1.55] text-[var(--text-soft)]">
                {!updateState.enabled ? (
                  <p>자동 업데이트는 패키지된 릴리즈 빌드에서만 동작합니다.</p>
                ) : null}

                {!updateState.release && getEmptyReleaseMessage(updateState) ? (
                  <p>{getEmptyReleaseMessage(updateState)}</p>
                ) : null}

                {updateState.status === 'upToDate' ? <p>현재 최신 버전을 사용 중입니다.</p> : null}
                {updateState.status === 'downloading' ? (
                  <p>업데이트를 다운로드하는 중입니다. {formatProgressPercent(updateState)}</p>
                ) : null}
                {updateState.status === 'downloaded' ? (
                  <p>업데이트가 준비되었습니다. 재시작하면 새 버전이 적용됩니다.</p>
                ) : null}
                {updateState.status === 'error' && updateState.errorMessage ? (
                  <p className="text-[var(--danger-text)]">{updateState.errorMessage}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[color-mix(in_srgb,var(--border)_82%,white_18%)] pt-4">
                <Button variant="secondary" onClick={async () => {
                  await onOpenReleasePage(releaseUrl);
                }}>
                  Changelog ↗
                </Button>
                {showCheckAction ? (
                  <Button variant="primary" onClick={onCheckForUpdates}>
                    업데이트 확인
                  </Button>
                ) : null}
                {showDevDisabledAction ? (
                  <Button variant="secondary" disabled>
                    개발 실행에서는 비활성
                  </Button>
                ) : null}
                {showDownloadAction ? (
                  <>
                    <Button variant="primary" onClick={onDownloadUpdate}>
                      다운로드
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (updateState.release?.version) {
                          await onDismissUpdate(updateState.release.version);
                        }
                      }}
                    >
                      나중에
                    </Button>
                  </>
                ) : null}
                {showInstallAction ? (
                  <Button variant="primary" onClick={onInstallUpdate}>
                    재시작 후 업데이트
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <DesktopWindowControls
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          onMinimizeWindow={onMinimizeWindow}
          onMaximizeWindow={onMaximizeWindow}
          onRestoreWindow={onRestoreWindow}
          onCloseWindow={onCloseWindow}
        />
      </div>
    </header>
  );
}
