import { useState } from 'react';
import type { TerminalTab, UpdateState } from '@dolssh/shared';

interface AppTitleBarProps {
  tabs: TerminalTab[];
  activeWorkspaceTab: 'home' | 'sftp' | string;
  updateState: UpdateState;
  onSelectHome: () => void;
  onSelectSftp: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => Promise<void>;
  onCheckForUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onDismissUpdate: (version: string) => Promise<void>;
  onOpenReleasePage: (url: string) => Promise<void>;
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

export function AppTitleBar({
  tabs,
  activeWorkspaceTab,
  updateState,
  onSelectHome,
  onSelectSftp,
  onSelectSession,
  onCloseSession,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onDismissUpdate,
  onOpenReleasePage
}: AppTitleBarProps) {
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
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

  return (
    <header className="app-titlebar">
      {/* 타이틀바 전체는 드래그 가능하지만, 실제 상호작용 요소들만 명시적으로 no-drag 처리한다. */}
      <div className="titlebar-brand">dolssh</div>
      <div className="titlebar-tabs">
        <button type="button" className={`workspace-tab home ${activeWorkspaceTab === 'home' ? 'active' : ''}`} onClick={onSelectHome}>
          Home
        </button>
        <button type="button" className={`workspace-tab sftp ${activeWorkspaceTab === 'sftp' ? 'active' : ''}`} onClick={onSelectSftp}>
          SFTP
        </button>
        {tabs.map((tab) => (
          <div key={tab.id} className={`workspace-tab-shell ${activeWorkspaceTab === tab.id ? 'active' : ''}`}>
            <button
              type="button"
              className={`workspace-tab ${activeWorkspaceTab === tab.id ? 'active' : ''}`}
              onClick={() => onSelectSession(tab.id)}
            >
              <span className="workspace-tab__title">{tab.title}</span>
            </button>
            <button
              type="button"
              className="workspace-tab__close"
              aria-label={`${tab.title} 세션 종료`}
              onClick={async (event) => {
                event.stopPropagation();
                await onCloseSession(tab.sessionId);
              }}
              disabled={tab.status === 'disconnecting'}
            >
              ×
            </button>
          </div>
        ))}
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

                {updateState.release ? (
                  <>
                    {updateState.release.releaseName ? <div className="update-popover__release-name">{updateState.release.releaseName}</div> : null}
                    {updateState.release.releaseNotes ? <p className="update-popover__notes">{updateState.release.releaseNotes}</p> : null}
                  </>
                ) : (
                  <p className="update-popover__message">{getEmptyReleaseMessage(updateState)}</p>
                )}

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
