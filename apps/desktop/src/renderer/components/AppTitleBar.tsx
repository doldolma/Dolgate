import type { TerminalTab } from '@keyterm/shared';

interface AppTitleBarProps {
  tabs: TerminalTab[];
  activeWorkspaceTab: 'home' | 'sftp' | string;
  onSelectHome: () => void;
  onSelectSftp: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => Promise<void>;
}

export function AppTitleBar({ tabs, activeWorkspaceTab, onSelectHome, onSelectSftp, onSelectSession, onCloseSession }: AppTitleBarProps) {
  return (
    <header className="app-titlebar">
      {/* 타이틀바 전체는 드래그 가능하지만, 실제 상호작용 요소들만 명시적으로 no-drag 처리한다. */}
      <div className="titlebar-brand">KeyTerm</div>
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
    </header>
  );
}
