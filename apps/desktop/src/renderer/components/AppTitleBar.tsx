import { useMemo, useState } from 'react';
import type { TerminalTab, UpdateState } from '@shared';
import type { DynamicTabStripItem, WorkspaceTab, WorkspaceTabId } from '../store/createAppStore';

interface DraggedSessionPayload {
  sessionId: string;
  source: 'standalone-tab' | 'workspace-pane';
  workspaceId?: string;
}

interface AppTitleBarProps {
  tabs: TerminalTab[];
  workspaces: WorkspaceTab[];
  tabStrip: DynamicTabStripItem[];
  activeWorkspaceTab: WorkspaceTabId;
  draggedSession: DraggedSessionPayload | null;
  updateState: UpdateState;
  onSelectHome: () => void;
  onSelectSftp: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCloseSession: (sessionId: string) => Promise<void>;
  onCloseWorkspace: (workspaceId: string) => Promise<void>;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onDetachSessionToStandalone: (workspaceId: string, sessionId: string) => void;
  onCheckForUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onDismissUpdate: (version: string) => Promise<void>;
  onOpenReleasePage: (url: string) => Promise<void>;
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

function getEmptyReleaseMessage(updateState: UpdateState): string {
  if (updateState.status === 'checking') {
    return 'GitHub Releases에서 새 버전을 확인하고 있습니다.';
  }

  if (updateState.status === 'idle') {
    return '아직 업데이트를 확인하지 않았습니다. 아래 버튼으로 새 릴리즈를 확인할 수 있습니다.';
  }

  return '현재 릴리즈 정보가 없습니다.';
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
  tabs,
  workspaces,
  tabStrip,
  activeWorkspaceTab,
  draggedSession,
  updateState,
  onSelectHome,
  onSelectSftp,
  onSelectSession,
  onSelectWorkspace,
  onCloseSession,
  onCloseWorkspace,
  onStartSessionDrag,
  onEndSessionDrag,
  onDetachSessionToStandalone,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onDismissUpdate,
  onOpenReleasePage
}: AppTitleBarProps) {
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const [isDetachHovering, setIsDetachHovering] = useState(false);

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
  const showCheckAction = !showDownloadAction && !showInstallAction;
  const titleText = showInstallAction
    ? '업데이트를 적용할 준비가 됐습니다'
    : showDownloadAction
      ? '새 dolssh 버전을 사용할 수 있습니다'
      : '앱 업데이트';

  const canDetachToTabs = draggedSession?.source === 'workspace-pane' && Boolean(draggedSession.workspaceId);

  return (
    <header className="app-titlebar">
      <div className="titlebar-brand">dolssh</div>
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
            return (
              <div
                key={item.sessionId}
                className={`workspace-tab-shell ${item.active ? 'active' : ''}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-dolssh-session-id', item.sessionId);
                  onStartSessionDrag(item.sessionId);
                }}
                onDragEnd={() => {
                  setIsDetachHovering(false);
                  onEndSessionDrag();
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

          return (
            <div key={item.workspaceId} className={`workspace-tab-shell workspace-tab-shell--workspace ${item.active ? 'active' : ''}`}>
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

                {!updateState.release ? (
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
      </div>
    </header>
  );
}
