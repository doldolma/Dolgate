import { useMemo, useRef, useState } from 'react';
import type { DesktopWindowState, TerminalTab, UpdateState } from '@shared';
import type { DynamicTabStripItem, WorkspaceTab, WorkspaceTabId } from '../store/createAppStore';
import { DesktopWindowControls, type DesktopPlatform } from './DesktopWindowControls';

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
  return item.kind === 'session' ? `session:${item.sessionId}` : `workspace:${item.workspaceId}`;
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
    return 'https://github.com/doldolma/dolssh/releases';
  }
  return `https://github.com/doldolma/dolssh/releases/tag/v${version}`;
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
      ? '새 dolssh 버전을 사용할 수 있습니다'
      : '앱 업데이트';

  const canDetachToTabs = draggedSession?.source === 'workspace-pane' && Boolean(draggedSession.workspaceId);

  function getTabKey(item: DynamicTabStripItem): string {
    return item.kind === 'session' ? `session:${item.sessionId}` : `workspace:${item.workspaceId}`;
  }

  function resolveTabDropPlacement(event: React.DragEvent<HTMLDivElement>): 'before' | 'after' {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX <= rect.left + rect.width / 2 ? 'before' : 'after';
  }

  return (
    <header className="app-titlebar">
      <div
        className={`titlebar-tabs ${isDetachHovering ? 'detach-hover' : ''}`}
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
        <button type="button" className={`workspace-tab home ${activeWorkspaceTab === 'home' ? 'active' : ''}`} onClick={onSelectHome}>
          Home
        </button>
        <button type="button" className={`workspace-tab sftp ${activeWorkspaceTab === 'sftp' ? 'active' : ''}`} onClick={onSelectSftp}>
          SFTP
        </button>
        {dynamicItems.map((item) => {
          if (item.kind === 'session') {
            const target = { kind: 'session', sessionId: item.sessionId } as const;
            const targetKey = getTabKey(target);
            return (
              <div
                key={item.sessionId}
                className={`workspace-tab-shell ${item.active ? 'active' : ''} ${
                  tabDropPreview?.targetKey === targetKey && tabDropPreview.placement === 'before'
                    ? 'workspace-tab-shell--drop-before'
                    : ''
                } ${
                  tabDropPreview?.targetKey === targetKey && tabDropPreview.placement === 'after'
                    ? 'workspace-tab-shell--drop-after'
                    : ''
                }`}
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
                <button
                  type="button"
                  className={`workspace-tab ${item.active ? 'active' : ''}`}
                  onClick={() => onSelectSession(item.sessionId)}
                >
                  <span className="workspace-tab__title">{item.title}</span>
                </button>
                <button
                  type="button"
                  className="workspace-tab__close"
                  aria-label={`${item.title} 세션 종료`}
                  onClick={async (event) => {
                    event.stopPropagation();
                    await onCloseSession(item.sessionId);
                  }}
                  disabled={item.status === 'disconnecting'}
                >
                  ×
                </button>
              </div>
            );
          }

          const target = { kind: 'workspace', workspaceId: item.workspaceId } as const;
          const targetKey = getTabKey(target);
          return (
            <div
              key={item.workspaceId}
              className={`workspace-tab-shell workspace-tab-shell--workspace ${item.active ? 'active' : ''} ${
                tabDropPreview?.targetKey === targetKey && tabDropPreview.placement === 'before'
                  ? 'workspace-tab-shell--drop-before'
                  : ''
              } ${
                tabDropPreview?.targetKey === targetKey && tabDropPreview.placement === 'after'
                  ? 'workspace-tab-shell--drop-after'
                  : ''
              }`}
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
              <button
                type="button"
                className={`workspace-tab workspace-tab--workspace ${item.active ? 'active' : ''}`}
                onClick={() => onSelectWorkspace(item.workspaceId)}
              >
                <span className="workspace-tab__glyph" aria-hidden="true">
                  ⊞
                </span>
                <span className="workspace-tab__title">{item.title}</span>
                <span className="workspace-tab__count">{item.paneCount}</span>
              </button>
              <button
                type="button"
                className="workspace-tab__close"
                aria-label={`${item.title} 닫기`}
                onClick={async (event) => {
                  event.stopPropagation();
                  await onCloseWorkspace(item.workspaceId);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {isTabDragging && dynamicItems.length > 0 ? (
          <div
            className={`titlebar-tabs__tail-drop ${tabDropPreview?.targetKey === '__tail__' ? 'active' : ''}`}
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
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <div className="update-menu">
          <button
            type="button"
            className={`titlebar-action ${isUpdateOpen ? 'active' : ''}`}
            aria-label="업데이트 상태 보기"
            onClick={() => setIsUpdateOpen((current) => !current)}
          >
            <span className="titlebar-action__icon" aria-hidden="true">
              🔔
            </span>
            {showBadge ? <span className="titlebar-action__badge" /> : null}
          </button>

          {isUpdateOpen ? (
            <div className="update-popover">
              <div className="update-popover__header">
                <div className="update-popover__title-group">
                  <div className="update-popover__headline">
                    <span className="update-popover__glyph" aria-hidden="true">
                      ↗
                    </span>
                    <strong>{titleText}</strong>
                  </div>
                  <div className="update-popover__subline">
                    {publishedAt ? <span>{publishedAt}</span> : null}
                    {updateState.release?.version ? <span>Version {updateState.release.version}</span> : null}
                  </div>
                </div>
                <span className="status-pill">{updateState.currentVersion}</span>
              </div>

              <div className="update-popover__body">
                {!updateState.enabled ? (
                  <p className="update-popover__message">자동 업데이트는 패키지된 릴리즈 빌드에서만 동작합니다.</p>
                ) : null}

                {!updateState.release && getEmptyReleaseMessage(updateState) ? (
                  <p className="update-popover__message">{getEmptyReleaseMessage(updateState)}</p>
                ) : null}

                {updateState.status === 'upToDate' ? <p className="update-popover__message">현재 최신 버전을 사용 중입니다.</p> : null}
                {updateState.status === 'downloading' ? (
                  <p className="update-popover__message">업데이트를 다운로드하는 중입니다. {formatProgressPercent(updateState)}</p>
                ) : null}
                {updateState.status === 'downloaded' ? (
                  <p className="update-popover__message">업데이트가 준비되었습니다. 재시작하면 새 버전이 적용됩니다.</p>
                ) : null}
                {updateState.status === 'error' && updateState.errorMessage ? (
                  <p className="update-popover__error">{updateState.errorMessage}</p>
                ) : null}
              </div>

              <div className="update-popover__footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    await onOpenReleasePage(releaseUrl);
                  }}
                >
                  Changelog ↗
                </button>
                {showCheckAction ? (
                  <button type="button" className="primary-button" onClick={onCheckForUpdates}>
                    업데이트 확인
                  </button>
                ) : null}
                {showDevDisabledAction ? (
                  <button type="button" className="secondary-button" disabled>
                    개발 실행에서는 비활성
                  </button>
                ) : null}
                {showDownloadAction ? (
                  <>
                    <button type="button" className="primary-button" onClick={onDownloadUpdate}>
                      다운로드
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={async () => {
                        if (updateState.release?.version) {
                          await onDismissUpdate(updateState.release.version);
                        }
                      }}
                    >
                      나중에
                    </button>
                  </>
                ) : null}
                {showInstallAction ? (
                  <button type="button" className="primary-button" onClick={onInstallUpdate}>
                    재시작 후 업데이트
                  </button>
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
