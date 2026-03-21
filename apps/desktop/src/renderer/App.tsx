import { useEffect, useMemo, useState } from 'react';
import type { AppTheme, HostRecord, UpdateState } from '@dolssh/shared';
import { AppTitleBar } from './components/AppTitleBar';
import { HomeNavigation } from './components/HomeNavigation';
import { HostBrowser } from './components/HostBrowser';
import { HostDrawer } from './components/HostDrawer';
import { KeychainPanel } from './components/KeychainPanel';
import { KnownHostPromptDialog } from './components/KnownHostPromptDialog';
import { KnownHostsPanel } from './components/KnownHostsPanel';
import { LogsPanel } from './components/LogsPanel';
import { PortForwardingPanel } from './components/PortForwardingPanel';
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

function createDefaultUpdateState(): UpdateState {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: '0.0.0',
    dismissedVersion: null,
    release: null,
    progress: null,
    checkedAt: null,
    errorMessage: null
  };
}

export function App() {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>(createDefaultUpdateState);
  const [isUpdateInstallConfirmOpen, setIsUpdateInstallConfirmOpen] = useState(false);
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const tabs = useAppStore((state) => state.tabs);
  const portForwards = useAppStore((state) => state.portForwards);
  const portForwardRuntimes = useAppStore((state) => state.portForwardRuntimes);
  const knownHosts = useAppStore((state) => state.knownHosts);
  const activityLogs = useAppStore((state) => state.activityLogs);
  const keychainEntries = useAppStore((state) => state.keychainEntries);
  const activeWorkspaceTab = useAppStore((state) => state.activeWorkspaceTab);
  const homeSection = useAppStore((state) => state.homeSection);
  const hostDrawer = useAppStore((state) => state.hostDrawer);
  const currentGroupPath = useAppStore((state) => state.currentGroupPath);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const settings = useAppStore((state) => state.settings);
  const pendingHostKeyPrompt = useAppStore((state) => state.pendingHostKeyPrompt);
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
  const savePortForward = useAppStore((state) => state.savePortForward);
  const removePortForward = useAppStore((state) => state.removePortForward);
  const startPortForward = useAppStore((state) => state.startPortForward);
  const stopPortForward = useAppStore((state) => state.stopPortForward);
  const removeKnownHost = useAppStore((state) => state.removeKnownHost);
  const clearLogs = useAppStore((state) => state.clearLogs);
  const removeKeychainSecret = useAppStore((state) => state.removeKeychainSecret);
  const acceptPendingHostKeyPrompt = useAppStore((state) => state.acceptPendingHostKeyPrompt);
  const dismissPendingHostKeyPrompt = useAppStore((state) => state.dismissPendingHostKeyPrompt);
  const handleCoreEvent = useAppStore((state) => state.handleCoreEvent);
  const handleTransferEvent = useAppStore((state) => state.handleTransferEvent);
  const handlePortForwardEvent = useAppStore((state) => state.handlePortForwardEvent);
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
    void bootstrap();
    const offCore = window.dolssh.ssh.onEvent(handleCoreEvent);
    const offTransfer = window.dolssh.sftp.onTransferEvent(handleTransferEvent);
    const offForward = window.dolssh.portForwards.onEvent(handlePortForwardEvent);
    return () => {
      offCore();
      offTransfer();
      offForward();
    };
  }, [bootstrap, handleCoreEvent, handleTransferEvent, handlePortForwardEvent]);

  useEffect(() => {
    let isMounted = true;
    void window.dolssh.updater.getState().then((state) => {
      if (isMounted) {
        setUpdateState(state);
      }
    });

    const offUpdater = window.dolssh.updater.onEvent((event) => {
      setUpdateState(event.state);
    });

    return () => {
      isMounted = false;
      offUpdater();
    };
  }, []);

  useEffect(() => {
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
    if (selectedHostId && !hosts.some((host) => host.id === selectedHostId)) {
      setSelectedHostId(null);
    }
  }, [hosts, selectedHostId]);

  const resolvedTheme = useMemo(() => resolveTheme(settings.theme, prefersDark), [prefersDark, settings.theme]);

  useEffect(() => {
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
  const hasActiveTransfers = sftp.transfers.some((job) => job.status === 'queued' || job.status === 'running');
  const hasActivePortForwards = portForwardRuntimes.some((runtime) => runtime.status === 'starting' || runtime.status === 'running');
  const hasBlockingUpdateInstall = tabs.length > 0 || hasActiveTransfers || hasActivePortForwards;

  function handleSelectHost(hostId: string) {
    setSelectedHostId(hostId);
    if (hostDrawer.mode === 'edit') {
      openEditHostDrawer(hostId);
    }
  }

  function handleEditHost(hostId: string) {
    setSelectedHostId(hostId);
    openEditHostDrawer(hostId);
  }

  async function runUpdaterAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      setUpdateState((current) => ({
        ...current,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '업데이트 작업 중 오류가 발생했습니다.'
      }));
    }
  }

  async function handleInstallUpdate() {
    if (hasBlockingUpdateInstall) {
      setIsUpdateInstallConfirmOpen(true);
      return;
    }

    await runUpdaterAction(() => window.dolssh.updater.installAndRestart());
  }

  return (
    <div className={`app-frame ${isHomeActive ? 'home-active' : 'session-active'}`}>
      <AppTitleBar
        tabs={tabs}
        activeWorkspaceTab={activeWorkspaceTab}
        updateState={updateState}
        onSelectHome={activateHome}
        onSelectSftp={activateSftp}
        onSelectSession={activateSession}
        onCloseSession={disconnectTab}
        onCheckForUpdates={async () => runUpdaterAction(() => window.dolssh.updater.check())}
        onDownloadUpdate={async () => runUpdaterAction(() => window.dolssh.updater.download())}
        onInstallUpdate={handleInstallUpdate}
        onDismissUpdate={async (version) => {
          await runUpdaterAction(() => window.dolssh.updater.dismissAvailable(version));
        }}
        onOpenReleasePage={async (url) => {
          await runUpdaterAction(() => window.dolssh.shell.openExternal(url));
        }}
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
            ) : null}

            {homeSection === 'portForwarding' ? (
              <PortForwardingPanel
                hosts={hosts}
                rules={portForwards}
                runtimes={portForwardRuntimes}
                onSave={savePortForward}
                onRemove={removePortForward}
                onStart={startPortForward}
                onStop={stopPortForward}
              />
            ) : null}

            {homeSection === 'knownHosts' ? <KnownHostsPanel records={knownHosts} onRemove={removeKnownHost} /> : null}

            {homeSection === 'logs' ? <LogsPanel logs={activityLogs} onClear={clearLogs} /> : null}

            {homeSection === 'keychain' ? <KeychainPanel entries={keychainEntries} onRemoveSecret={removeKeychainSecret} /> : null}

            {homeSection === 'settings' ? (
              <SettingsPanel
                settings={settings}
                onChangeTheme={async (theme) => {
                  await updateSettings({ theme });
                }}
              />
            ) : null}
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
          <TerminalWorkspace sessionIds={tabs.map((tab) => tab.sessionId)} activeTabId={activeSessionId} theme={resolvedTheme} />
        </section>
      </div>

      <KnownHostPromptDialog pending={pendingHostKeyPrompt} onAccept={acceptPendingHostKeyPrompt} onCancel={dismissPendingHostKeyPrompt} />

      {isUpdateInstallConfirmOpen ? (
        <div className="modal-backdrop">
          <div className="modal-card update-install-dialog" role="dialog" aria-modal="true" aria-labelledby="update-install-title">
            <div className="modal-card__header">
              <div>
                <div className="eyebrow">Update Ready</div>
                <h3 id="update-install-title">업데이트를 적용하려면 재시작이 필요합니다.</h3>
              </div>
            </div>
            <div className="modal-card__body">
              <p className="update-install-dialog__message">
                현재 열려 있는 SSH 세션, 진행 중인 전송, 활성 포트 포워딩은 모두 종료됩니다. 계속하면 dolssh가 정리 후 재시작되며 새 버전이
                적용됩니다.
              </p>
            </div>
            <div className="modal-card__footer">
              <button type="button" className="secondary-button" onClick={() => setIsUpdateInstallConfirmOpen(false)}>
                취소
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  setIsUpdateInstallConfirmOpen(false);
                  await runUpdaterAction(() => window.dolssh.updater.installAndRestart());
                }}
              >
                재시작 후 업데이트
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
