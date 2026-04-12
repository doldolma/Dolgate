import { useEffect, useMemo, useState } from 'react';
import {
  buildGroupOptions,
  getGroupLabel,
  getParentGroupPath,
  getHostSecretRef,
  isSshHostRecord,
  normalizeGroupPath,
  type AuthState,
} from '@shared';
import { AwsImportDialog } from '../components/AwsImportDialog';
import { HomeNavigation } from '../components/HomeNavigation';
import { HostBrowser } from '../components/HostBrowser';
import { HostDrawer } from '../components/HostDrawer';
import { LogsPanel } from '../components/LogsPanel';
import { OpenSshImportDialog } from '../components/OpenSshImportDialog';
import { PortForwardingPanel } from '../components/PortForwardingPanel';
import type { SecretEditDialogRequest } from '../components/SecretEditDialog';
import { SettingsPanel } from '../components/SettingsPanel';
import { TermiusImportDialog } from '../components/TermiusImportDialog';
import { WarpgateImportDialog } from '../components/WarpgateImportDialog';
import { XshellImportDialog } from '../components/XshellImportDialog';
import type { useLoginController } from '../controllers/useLoginController';
import { useSettingsViewModel } from '../view-models/appViewModels';
import { openSessionReplay } from '../services/desktop/session-replays';
import type {
  useAppModalViewModel,
  useContainersViewModel,
  useHomeViewModel,
} from '../view-models/appViewModels';
import {
  buildXshellImportStatusMessage,
  findHost,
  toLinkedHostSummary,
} from './appShellUtils';
import { OfflineModeBanner } from './OfflineModeBanner';

interface HomeShellProps {
  active: boolean;
  authState: AuthState & { session: NonNullable<AuthState['session']> };
  offlineLeaseExpiryLabel: string | null;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  containersViewModel: ReturnType<typeof useContainersViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
  onRequestSecretEditor: (request: SecretEditDialogRequest) => void;
}

export function HomeShell({
  active,
  authState,
  offlineLeaseExpiryLabel,
  desktopPlatform,
  homeViewModel,
  containersViewModel,
  modalViewModel,
  loginController,
  onRequestSecretEditor,
}: HomeShellProps) {
  const settingsViewModel = useSettingsViewModel();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [isAwsImportOpen, setIsAwsImportOpen] = useState(false);
  const [isOpenSshImportOpen, setIsOpenSshImportOpen] = useState(false);
  const [isXshellImportOpen, setIsXshellImportOpen] = useState(false);
  const [isTermiusImportOpen, setIsTermiusImportOpen] = useState(false);
  const [isWarpgateImportOpen, setIsWarpgateImportOpen] = useState(false);
  const [hostBrowserError, setHostBrowserError] = useState<string | null>(null);
  const [hostBrowserStatus, setHostBrowserStatus] = useState<string | null>(null);

  useEffect(() => {
    if (
      selectedHostId &&
      !homeViewModel.hosts.some((host) => host.id === selectedHostId)
    ) {
      setSelectedHostId(null);
    }
  }, [homeViewModel.hosts, selectedHostId]);

  const editingHostId =
    homeViewModel.hostDrawer.mode === 'edit'
      ? homeViewModel.hostDrawer.hostId
      : null;
  const currentHost = findHost(homeViewModel.hosts, editingHostId);
  const groupOptions = useMemo(
    () =>
      buildGroupOptions(homeViewModel.groups, homeViewModel.hosts, [
        currentHost?.groupName,
        homeViewModel.hostDrawer.mode === 'create'
          ? homeViewModel.hostDrawer.defaultGroupPath
          : homeViewModel.currentGroupPath,
      ]),
    [
      currentHost?.groupName,
      homeViewModel.currentGroupPath,
      homeViewModel.groups,
      homeViewModel.hostDrawer,
      homeViewModel.hosts,
    ],
  );
  const isDrawerOpen =
    active &&
    homeViewModel.homeSection === 'hosts' &&
    homeViewModel.hostDrawer.mode !== 'closed';
  const highlightedHostId = editingHostId ?? selectedHostId;

  function resetHostBrowserMessages() {
    setHostBrowserError(null);
    setHostBrowserStatus(null);
  }

  function buildMovedGroupPath(path: string, targetParentPath: string | null): string | null {
    const normalizedPath = normalizeGroupPath(path);
    if (!normalizedPath) {
      return null;
    }
    const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
    return normalizeGroupPath(
      normalizedTargetParentPath ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedPath)}` : getGroupLabel(normalizedPath)
    );
  }

  function buildRenamedGroupPath(path: string, name: string): string | null {
    const normalizedPath = normalizeGroupPath(path);
    if (!normalizedPath) {
      return null;
    }
    const parentPath = getParentGroupPath(normalizedPath);
    return normalizeGroupPath(parentPath ? `${parentPath}/${name.trim()}` : name.trim());
  }

  function handleSelectHost(hostId: string) {
    resetHostBrowserMessages();
    setSelectedHostId(hostId);
    if (homeViewModel.hostDrawer.mode === 'edit') {
      homeViewModel.openEditHostDrawer(hostId);
    }
  }

  function handleEditHost(hostId: string) {
    resetHostBrowserMessages();
    setSelectedHostId(hostId);
    homeViewModel.openEditHostDrawer(hostId);
  }

  function openHostSecretEditor(secretRef: string) {
    if (!currentHost || !isSshHostRecord(currentHost)) {
      return;
    }
    const entry = settingsViewModel.keychainEntries.find(
      (item) => item.secretRef === secretRef,
    );
    onRequestSecretEditor({
      source: 'host',
      secretRef,
      label: entry?.label ?? currentHost.label,
      linkedHosts: homeViewModel.hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: 'clone-for-host',
      initialHostId: currentHost.id,
    });
  }

  function openKeychainSecretEditor(secretRef: string) {
    const entry = settingsViewModel.keychainEntries.find(
      (item) => item.secretRef === secretRef,
    );
    if (!entry) {
      return;
    }
    onRequestSecretEditor({
      source: 'keychain',
      secretRef,
      label: entry.label,
      linkedHosts: homeViewModel.hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: 'update-shared',
      initialHostId: null,
    });
  }

  async function handleRemoveSecret(secretRef: string) {
    const entry = settingsViewModel.keychainEntries.find(
      (item) => item.secretRef === secretRef,
    );
    const linkedHostCount = entry?.linkedHostCount ?? 0;
    const confirmed = window.confirm(
      linkedHostCount > 0
        ? `이 secret을 삭제하면 ${linkedHostCount}개 호스트와의 secret 연결이 해제됩니다. 호스트 자체는 삭제되지 않습니다. 계속할까요?`
        : '이 secret을 삭제할까요?',
    );
    if (!confirmed) {
      return;
    }
    await settingsViewModel.removeKeychainSecret(secretRef);
  }

  return (
    <section
      className={[
        'absolute inset-0 grid min-h-0 gap-0 transition-[opacity,transform] duration-180',
        active ? 'pointer-events-auto opacity-100 scale-100' : 'pointer-events-none opacity-0 scale-[0.995]',
        isDrawerOpen
          ? 'grid-cols-[220px_minmax(0,1fr)_380px] max-[1320px]:grid-cols-[200px_minmax(0,1fr)_340px] max-[1040px]:grid-cols-1'
          : 'grid-cols-[220px_minmax(0,1fr)_0] max-[1320px]:grid-cols-[200px_minmax(0,1fr)_0] max-[1040px]:grid-cols-1',
      ].join(' ')}
    >
      <HomeNavigation
        activeSection={homeViewModel.homeSection}
        onSelectSection={homeViewModel.openHomeSection}
      />

      <main className="flex min-h-0 min-w-0 flex-col overflow-auto px-[1.2rem] pb-[1.25rem] pt-[1.15rem]">
        {authState.status === 'offline-authenticated' && authState.offline ? (
          <OfflineModeBanner
            expiryLabel={offlineLeaseExpiryLabel}
            isRetrying={loginController.isRetryingOnline}
            onRetry={() => {
              void loginController.retryOnline();
            }}
          />
        ) : null}

        {homeViewModel.homeSection === 'hosts' ? (
          <HostBrowser
            desktopPlatform={desktopPlatform}
            hosts={homeViewModel.hosts}
            groups={homeViewModel.groups}
            keychainEntries={settingsViewModel.keychainEntries}
            currentGroupPath={homeViewModel.currentGroupPath}
            searchQuery={homeViewModel.searchQuery}
            selectedHostId={highlightedHostId}
            errorMessage={hostBrowserError}
            statusMessage={hostBrowserStatus}
            onSearchChange={homeViewModel.setSearchQuery}
            onOpenLocalTerminal={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              void homeViewModel.openLocalTerminal(120, 32).catch((error) => {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : '로컬 터미널을 시작하지 못했습니다.',
                );
              });
            }}
            onCreateHost={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              homeViewModel.openCreateHostDrawer();
            }}
            onOpenAwsImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              setIsAwsImportOpen(true);
            }}
            onOpenOpenSshImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              setIsOpenSshImportOpen(true);
            }}
            onOpenXshellImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              setIsXshellImportOpen(true);
            }}
            onOpenTermiusImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              setIsTermiusImportOpen(true);
            }}
            onOpenWarpgateImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              setIsWarpgateImportOpen(true);
            }}
            onCreateGroup={homeViewModel.createGroup}
            onRemoveGroup={homeViewModel.removeGroup}
            onMoveGroup={async (path, targetParentPath) => {
              resetHostBrowserMessages();
              try {
                await homeViewModel.moveGroup(path, targetParentPath);
                const nextPath = buildMovedGroupPath(path, targetParentPath);
                setHostBrowserStatus(
                  nextPath ? `그룹을 ${nextPath}(으)로 이동했습니다.` : '그룹을 이동했습니다.',
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : '그룹을 이동하지 못했습니다.',
                );
                throw error;
              }
            }}
            onRenameGroup={async (path, name) => {
              resetHostBrowserMessages();
              try {
                await homeViewModel.renameGroup(path, name);
                const nextPath = buildRenamedGroupPath(path, name);
                setHostBrowserStatus(
                  nextPath ? `그룹 이름을 ${nextPath}(으)로 변경했습니다.` : '그룹 이름을 변경했습니다.',
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : '그룹 이름을 변경하지 못했습니다.',
                );
                throw error;
              }
            }}
            onNavigateGroup={(path) => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              homeViewModel.navigateGroup(path);
            }}
            onClearHostSelection={() => {
              setSelectedHostId(null);
            }}
            onSelectHost={handleSelectHost}
            onEditHost={handleEditHost}
            onDuplicateHosts={async (hostIds) => {
              resetHostBrowserMessages();
              try {
                await homeViewModel.duplicateHosts(hostIds);
                setHostBrowserStatus(
                  hostIds.length === 1
                    ? 'Copied 1 host.'
                    : `Copied ${hostIds.length} hosts.`,
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : 'Failed to copy the selected hosts.',
                );
              }
            }}
            onMoveHostToGroup={homeViewModel.moveHostToGroup}
            onRemoveHost={homeViewModel.removeHost}
            onRemoveSecret={settingsViewModel.removeKeychainSecret}
            onConnectHost={async (hostId) => {
              try {
                setHostBrowserError(null);
                setSelectedHostId(hostId);
                await homeViewModel.connectHost(hostId, 120, 32);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : '호스트 연결을 시작하지 못했습니다.',
                );
              }
            }}
            onOpenHostContainers={async (hostId) => {
              try {
                resetHostBrowserMessages();
                setSelectedHostId(hostId);
                await homeViewModel.openHostContainersTab(hostId);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : '컨테이너 페이지를 열지 못했습니다.',
                );
              }
            }}
          />
        ) : null}

        {homeViewModel.homeSection === 'portForwarding' ? (
          <PortForwardingPanel
            hosts={homeViewModel.hosts}
            containerTabs={containersViewModel.containerTabs}
            rules={homeViewModel.portForwards}
            dnsOverrides={homeViewModel.dnsOverrides}
            runtimes={homeViewModel.portForwardRuntimes}
            interactiveAuth={
              modalViewModel.pendingInteractiveAuth?.source === 'portForward'
                ? modalViewModel.pendingInteractiveAuth
                : null
            }
            discoveryInteractiveAuth={
              modalViewModel.pendingInteractiveAuth?.source === 'containers'
                ? modalViewModel.pendingInteractiveAuth
                : null
            }
            onSave={homeViewModel.savePortForward}
            onSaveDnsOverride={homeViewModel.saveDnsOverride}
            onSetStaticDnsOverrideActive={homeViewModel.setStaticDnsOverrideActive}
            onRemoveDnsOverride={homeViewModel.removeDnsOverride}
            onRemove={homeViewModel.removePortForward}
            onStart={homeViewModel.startPortForward}
            onStop={homeViewModel.stopPortForward}
            onRespondInteractiveAuth={modalViewModel.respondInteractiveAuth}
            onReopenInteractiveAuthUrl={modalViewModel.reopenInteractiveAuthUrl}
            onClearInteractiveAuth={modalViewModel.clearPendingInteractiveAuth}
          />
        ) : null}

        {homeViewModel.homeSection === 'logs' ? (
          <LogsPanel
            logs={settingsViewModel.activityLogs}
            onClear={settingsViewModel.clearLogs}
            onOpenReplay={openSessionReplay}
          />
        ) : null}

        {homeViewModel.homeSection === 'settings' ? (
          <SettingsPanel
            activeSection={settingsViewModel.settingsSection}
            hosts={settingsViewModel.hosts}
            settings={settingsViewModel.settings}
            knownHosts={settingsViewModel.knownHosts}
            keychainEntries={settingsViewModel.keychainEntries}
            currentUserEmail={authState.session?.user.email ?? null}
            desktopPlatform={desktopPlatform}
            onSelectSection={settingsViewModel.openSettingsSection}
            onUpdateSettings={settingsViewModel.updateSettings}
            onRemoveKnownHost={settingsViewModel.removeKnownHost}
            onRemoveSecret={handleRemoveSecret}
            onEditSecret={openKeychainSecretEditor}
            onLogout={loginController.logout}
          />
        ) : null}
      </main>

      <HostDrawer
        open={isDrawerOpen}
        mode={homeViewModel.hostDrawer.mode === 'create' ? 'create' : 'edit'}
        host={currentHost}
        keychainEntries={settingsViewModel.keychainEntries}
        groupOptions={groupOptions}
        defaultGroupPath={
          homeViewModel.hostDrawer.mode === 'create'
            ? homeViewModel.hostDrawer.defaultGroupPath
            : homeViewModel.currentGroupPath
        }
        onClose={homeViewModel.closeHostDrawer}
        onSubmit={async (draft, secrets) => {
          await homeViewModel.saveHost(
            homeViewModel.hostDrawer.mode === 'edit' ? currentHost?.id ?? null : null,
            draft,
            secrets,
          );
        }}
        onConnect={
          currentHost
            ? async (hostId) => {
                await homeViewModel.connectHost(hostId, 120, 32);
                homeViewModel.closeHostDrawer();
              }
            : undefined
        }
        onEditExistingSecret={openHostSecretEditor}
        onOpenSecrets={() => settingsViewModel.openSettingsSection('secrets')}
      />

      <AwsImportDialog
        open={isAwsImportOpen}
        currentGroupPath={homeViewModel.currentGroupPath}
        onClose={() => setIsAwsImportOpen(false)}
        onImport={async (draft) => {
          await homeViewModel.saveHost(null, draft);
        }}
      />

      <TermiusImportDialog
        open={isTermiusImportOpen}
        onClose={() => setIsTermiusImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshHostCatalog();
          setHostBrowserStatus(
            `Termius에서 ${result.createdHostCount}개 호스트, ${result.createdGroupCount}개 그룹, ${result.createdSecretCount}개 secret을 가져왔습니다.${result.skippedHostCount > 0 ? ` 불완전 호스트 ${result.skippedHostCount}개는 건너뛰었습니다.` : ''}`,
          );
          setHostBrowserError(result.warnings[0]?.message ?? null);
        }}
      />

      <OpenSshImportDialog
        open={isOpenSshImportOpen}
        currentGroupPath={homeViewModel.currentGroupPath}
        onClose={() => setIsOpenSshImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshHostCatalog();
          setHostBrowserStatus(
            `OpenSSH에서 호스트 ${result.createdHostCount}개를 가져왔습니다.${
              result.createdSecretCount > 0
                ? ` 인증 정보 ${result.createdSecretCount}개를 함께 가져왔습니다.`
                : ''
            }${
              result.skippedHostCount > 0
                ? ` 건너뛴 호스트 ${result.skippedHostCount}개가 있습니다.`
                : ''
            }`,
          );
          setHostBrowserError(result.warnings[0]?.message ?? null);
        }}
      />

      <XshellImportDialog
        open={isXshellImportOpen}
        onClose={() => setIsXshellImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshHostCatalog();
          queueMicrotask(() =>
            setHostBrowserStatus(buildXshellImportStatusMessage(result)),
          );
          setHostBrowserStatus(
            `Xshell에서 호스트 ${result.createdHostCount}개와 그룹 ${result.createdGroupCount}개를 가져왔습니다.${
              result.skippedHostCount > 0
                ? ` 건너뛴 호스트 ${result.skippedHostCount}개가 있습니다.`
                : ''
            }`,
          );
          setHostBrowserError(result.warnings[0]?.message ?? null);
        }}
      />

      <WarpgateImportDialog
        open={isWarpgateImportOpen}
        currentGroupPath={homeViewModel.currentGroupPath}
        onClose={() => setIsWarpgateImportOpen(false)}
        onImport={async (draft) => {
          await homeViewModel.saveHost(null, draft);
        }}
      />
    </section>
  );
}
