import { useEffect, useMemo, useState } from 'react';
import type { AppTheme, HostRecord } from '@keyterm/shared';
import { AppTitleBar } from './components/AppTitleBar';
import { HomeNavigation } from './components/HomeNavigation';
import { HostBrowser } from './components/HostBrowser';
import { HostDrawer } from './components/HostDrawer';
import { SettingsPanel } from './components/SettingsPanel';
import { SftpWorkspace } from './components/SftpWorkspace';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { useAppStore } from './store/appStore';

function findHost(hosts: HostRecord[], hostId: string | null): HostRecord | null {
  return hostId ? hosts.find((host) => host.id === hostId) ?? null : null;
}

function resolveTheme(theme: AppTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }
  return prefersDark ? 'dark' : 'light';
}

export function App() {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const tabs = useAppStore((state) => state.tabs);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const homeSection = useAppStore((state) => state.homeSection);
  const hostDrawer = useAppStore((state) => state.hostDrawer);
  const currentGroupPath = useAppStore((state) => state.currentGroupPath);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const settings = useAppStore((state) => state.settings);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const activateHome = useAppStore((state) => state.activateHome);
  const activateSession = useAppStore((state) => state.activateSession);
  const openHomeSection = useAppStore((state) => state.openHomeSection);
  const openCreateHostDrawer = useAppStore((state) => state.openCreateHostDrawer);
  const openEditHostDrawer = useAppStore((state) => state.openEditHostDrawer);
  const closeHostDrawer = useAppStore((state) => state.closeHostDrawer);
  const navigateGroup = useAppStore((state) => state.navigateGroup);
  const createGroup = useAppStore((state) => state.createGroup);
  const saveHost = useAppStore((state) => state.saveHost);
  const removeHost = useAppStore((state) => state.removeHost);
  const connectHost = useAppStore((state) => state.connectHost);
  const disconnectTab = useAppStore((state) => state.disconnectTab);
  const activateSftp = useAppStore((state) => state.activateSftp);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const handleCoreEvent = useAppStore((state) => state.handleCoreEvent);
  const handleTransferEvent = useAppStore((state) => state.handleTransferEvent);
  const sftp = useAppStore((state) => state.sftp);
  const setSftpPaneSource = useAppStore((state) => state.setSftpPaneSource);
  const setSftpPaneFilter = useAppStore((state) => state.setSftpPaneFilter);
  const setSftpHostSearchQuery = useAppStore((state) => state.setSftpHostSearchQuery);
  const selectSftpHost = useAppStore((state) => state.selectSftpHost);
  const connectSftpHost = useAppStore((state) => state.connectSftpHost);
  const openSftpEntry = useAppStore((state) => state.openSftpEntry);
  const refreshSftpPane = useAppStore((state) => state.refreshSftpPane);
  const navigateSftpBack = useAppStore((state) => state.navigateSftpBack);
  const navigateSftpForward = useAppStore((state) => state.navigateSftpForward);
  const navigateSftpParent = useAppStore((state) => state.navigateSftpParent);
  const navigateSftpBreadcrumb = useAppStore((state) => state.navigateSftpBreadcrumb);
  const selectSftpEntry = useAppStore((state) => state.selectSftpEntry);
  const createSftpDirectory = useAppStore((state) => state.createSftpDirectory);
  const renameSftpSelection = useAppStore((state) => state.renameSftpSelection);
  const deleteSftpSelection = useAppStore((state) => state.deleteSftpSelection);
  const prepareSftpTransfer = useAppStore((state) => state.prepareSftpTransfer);
  const resolveSftpConflict = useAppStore((state) => state.resolveSftpConflict);
  const dismissSftpConflict = useAppStore((state) => state.dismissSftpConflict);
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const retryTransfer = useAppStore((state) => state.retryTransfer);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    // 앱 최초 진입 시 DB/코어 상태를 로드하고, 이후 코어 이벤트를 계속 구독한다.
    void bootstrap();
    const offCore = window.keyterm.ssh.onEvent(handleCoreEvent);
    const offTransfer = window.keyterm.sftp.onTransferEvent(handleTransferEvent);
    return () => {
      offCore();
      offTransfer();
    };
  }, [bootstrap, handleCoreEvent, handleTransferEvent]);

  useEffect(() => {
    // system 테마를 지원하기 위해 OS 라이트/다크 모드 변경을 감지한다.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    // 삭제 등으로 선택된 호스트가 사라지면 카드 선택 상태도 함께 정리한다.
    if (selectedHostId && !hosts.some((host) => host.id === selectedHostId)) {
      setSelectedHostId(null);
    }
  }, [hosts, selectedHostId]);

  const resolvedTheme = useMemo(() => resolveTheme(settings.theme, prefersDark), [prefersDark, settings.theme]);

  useEffect(() => {
    // CSS와 xterm이 같은 토큰 집합을 사용하도록 루트 dataset에 테마를 반영한다.
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = settings.theme;
  }, [resolvedTheme, settings.theme]);

  const isHomeActive = activeWorkspaceTab === 'home';
  const isSftpActive = activeWorkspaceTab === 'sftp';
  const activeSessionId = isHomeActive || isSftpActive ? null : activeWorkspaceTab;
  const editingHostId = hostDrawer.mode === 'edit' ? hostDrawer.hostId : null;
  const currentHost = findHost(hosts, editingHostId);
  const isDrawerOpen = isHomeActive && homeSection === 'hosts' && hostDrawer.mode !== 'closed';
  const highlightedHostId = editingHostId ?? selectedHostId;

  function handleSelectHost(hostId: string) {
    setSelectedHostId(hostId);
    // 이미 편집 드로어가 열린 상태라면 한 번 클릭만으로 편집 대상을 전환한다.
    if (hostDrawer.mode === 'edit') {
      openEditHostDrawer(hostId);
    }
  }

  function handleEditHost(hostId: string) {
    setSelectedHostId(hostId);
    openEditHostDrawer(hostId);
  }

  return (
    <div className={`app-frame ${isHomeActive ? 'home-active' : 'session-active'}`}>
      <AppTitleBar
        tabs={tabs}
        activeWorkspaceTab={activeWorkspaceTab}
        onSelectHome={activateHome}
        onSelectSftp={activateSftp}
        onSelectSession={activateSession}
        onCloseSession={disconnectTab}
      />

      <div className="workspace-shell">
        <section className={`home-shell ${isHomeActive ? 'active' : 'hidden'} ${isDrawerOpen ? 'drawer-open' : ''}`}>
          <HomeNavigation activeSection={homeSection} onSelectSection={openHomeSection} />

          <main className="home-main">
            {homeSection === 'hosts' ? (
              <HostBrowser
                hosts={hosts}
                groups={groups}
                tabs={tabs}
                currentGroupPath={currentGroupPath}
                searchQuery={searchQuery}
                selectedHostId={highlightedHostId}
                onSearchChange={setSearchQuery}
                onCreateHost={() => {
                  setSelectedHostId(null);
                  openCreateHostDrawer();
                }}
                onCreateGroup={createGroup}
                onNavigateGroup={(path) => {
                  setSelectedHostId(null);
                  navigateGroup(path);
                }}
                onSelectHost={handleSelectHost}
                onEditHost={handleEditHost}
                onOpenSession={activateSession}
                onConnectHost={async (hostId) => {
                  setSelectedHostId(hostId);
                  await connectHost(hostId, 120, 32);
                }}
              />
            ) : (
              <SettingsPanel
                settings={settings}
                onChangeTheme={async (theme) => {
                  await updateSettings({ theme });
                }}
              />
            )}
          </main>

          <HostDrawer
            open={isDrawerOpen}
            mode={hostDrawer.mode === 'create' ? 'create' : 'edit'}
            host={currentHost}
            defaultGroupPath={hostDrawer.mode === 'create' ? hostDrawer.defaultGroupPath : currentGroupPath}
            onClose={closeHostDrawer}
            onSubmit={async (draft, secrets) => {
              await saveHost(hostDrawer.mode === 'edit' ? currentHost?.id ?? null : null, draft, secrets);
            }}
            onDelete={
              currentHost
                ? async () => {
                  await removeHost(currentHost.id);
                  setSelectedHostId(null);
                  closeHostDrawer();
                }
                : undefined
            }
          />
        </section>

        <section className={`sftp-shell ${isSftpActive ? 'active' : 'hidden'}`}>
          <SftpWorkspace
            hosts={hosts}
            sftp={sftp}
            onActivatePaneSource={setSftpPaneSource}
            onPaneFilterChange={setSftpPaneFilter}
            onHostSearchChange={setSftpHostSearchQuery}
            onSelectHost={selectSftpHost}
            onConnectHost={connectSftpHost}
            onOpenEntry={openSftpEntry}
            onRefreshPane={refreshSftpPane}
            onNavigateBack={navigateSftpBack}
            onNavigateForward={navigateSftpForward}
            onNavigateParent={navigateSftpParent}
            onNavigateBreadcrumb={navigateSftpBreadcrumb}
            onSelectEntry={selectSftpEntry}
            onCreateDirectory={createSftpDirectory}
            onRenameSelection={renameSftpSelection}
            onDeleteSelection={deleteSftpSelection}
            onPrepareTransfer={prepareSftpTransfer}
            onResolveConflict={resolveSftpConflict}
            onDismissConflict={dismissSftpConflict}
            onCancelTransfer={cancelTransfer}
            onRetryTransfer={retryTransfer}
          />
        </section>

        <section className={`session-shell ${isHomeActive || isSftpActive ? 'hidden' : 'active'}`}>
          {/* 세션 워크스페이스는 숨겨질 때도 언마운트하지 않아야 터미널 버퍼와 DOM 상태를 최대한 유지할 수 있다. */}
          <TerminalWorkspace
            sessionIds={tabs.map((tab) => tab.sessionId)}
            activeTabId={activeSessionId}
            theme={resolvedTheme}
          />
        </section>
      </div>
    </div>
  );
}
