import { useEffect, useMemo, useState } from 'react';
import {
  buildGroupOptions,
  getGroupLabel,
  getParentGroupPath,
  getHostSecretRef,
  isSshHostRecord,
  normalizeGroupPath,
  type AuthState,
  type HostDraft,
  type HomeHostViewMode,
  type SshKeyGenerateInput,
} from '@shared';
import { AwsImportDialog } from '../components/AwsImportDialog';
import { HostBrowser } from '../components/HostBrowser';
import { HostDrawer } from '../components/HostDrawer';
import { getJumpHostCandidates } from '../components/HostForm';
import { LogsPanel } from '../components/LogsPanel';
import { OpenSshImportDialog } from '../components/OpenSshImportDialog';
import { PortForwardingPanel } from '../components/PortForwardingPanel';
import { SnippetsPanel } from '../components/SnippetsPanel';
import type { SecretEditDialogRequest } from '../components/SecretEditDialog';
import { SettingsPanel } from '../components/SettingsPanel';
import { TermiusImportDialog } from '../components/TermiusImportDialog';
import { WarpgateImportDialog } from '../components/WarpgateImportDialog';
import { XshellImportDialog } from '../components/XshellImportDialog';
import { cn } from '../lib/cn';
import {
  buildQuickSshHostLabel,
  findExistingQuickSshHost,
  type ParsedQuickSshCommand,
} from '../lib/quick-connect';
import { ArrowLeft } from '../ui/icons';
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
  const [detailTab, setDetailTab] = useState<'overview' | 'connection'>('overview');
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

  // ⌘K / Ctrl+K로 호스트 검색에 포커스. 홈의 hosts 화면이 활성일 때만 동작(터미널 등과 충돌 방지).
  useEffect(() => {
    if (!active || homeViewModel.homeSection !== 'hosts') {
      return;
    }
    function handleSearchShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')) {
        const input = document.getElementById('host-search');
        if (input instanceof HTMLInputElement) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      }
    }
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, [active, homeViewModel.homeSection]);

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
  const jumpHostOptions = useMemo(
    () => getJumpHostCandidates(homeViewModel.hosts, currentHost?.id ?? null),
    [homeViewModel.hosts, currentHost?.id],
  );
  const isDrawerOpen =
    active &&
    homeViewModel.homeSection === 'hosts' &&
    homeViewModel.hostDrawer.mode !== 'closed';
  const highlightedHostId = editingHostId ?? selectedHostId;
  const sectionTitle =
    homeViewModel.homeSection === 'portForwarding'
      ? 'Port Forwarding'
      : homeViewModel.homeSection === 'snippets'
        ? 'Snippets'
        : homeViewModel.homeSection === 'logs'
          ? 'Logs'
          : 'Settings';

  function resetHostBrowserMessages() {
    setHostBrowserError(null);
    setHostBrowserStatus(null);
  }

  function handleHostViewModeChange(mode: HomeHostViewMode) {
    void settingsViewModel.updateSettings({ homeHostViewMode: mode }).catch((error) => {
      setHostBrowserError(
        error instanceof Error
          ? error.message
          : '호스트 레이아웃 설정을 저장하지 못했습니다.',
      );
    });
  }

  async function handleQuickConnectSsh(input: ParsedQuickSshCommand) {
    resetHostBrowserMessages();
    const existing = findExistingQuickSshHost(input, homeViewModel.hosts);
    if (existing) {
      setSelectedHostId(existing.id);
      await homeViewModel.connectHost(existing.id, 120, 32);
      return;
    }

    const draft: Extract<HostDraft, { kind: 'ssh' }> = {
      kind: 'ssh',
      label: buildQuickSshHostLabel(
        input,
        homeViewModel.hosts,
        homeViewModel.currentGroupPath,
      ),
      groupName: homeViewModel.currentGroupPath,
      tags: [],
      terminalThemeId: null,
      hostname: input.hostname,
      port: input.port,
      username: input.username,
      authType: 'password',
      privateKeyPath: null,
      certificatePath: null,
      secretRef: null,
      jumpHostId: null,
      jumpHostIds: [],
      startupCommand: null,
      useMosh: null,
      agentForwarding: null,
      env: [],
    };

    const created = await homeViewModel.saveHost(null, draft);
    homeViewModel.closeHostDrawer();
    setSelectedHostId(created.id);
    setHostBrowserStatus(`Saved ${created.label}. Connecting...`);
    await homeViewModel.connectHost(created.id, 120, 32);
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
    // 편집/생성 중에는 다른 호스트를 눌러도 이동/전환하지 않는다(작업 중 실수로 벗어나는 것 방지).
    // 다른 호스트로 가려면 먼저 편집 폼을 닫거나, 우클릭 → 수정으로 명시적으로 전환한다.
    if (homeViewModel.hostDrawer.mode !== 'closed') {
      return;
    }
    resetHostBrowserMessages();
    setSelectedHostId(hostId);
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

  async function handleGenerateAndInstallSshKey(
    hostId: string,
    input: SshKeyGenerateInput,
  ) {
    const host = findHost(homeViewModel.hosts, hostId);
    if (!host || !isSshHostRecord(host)) {
      throw new Error('SSH host를 찾지 못했습니다.');
    }
    const key = await settingsViewModel.generateSshKey(input);
    const result = await settingsViewModel.installSshPublicKey({
      secretRef: key.secretRef,
      hostIds: [host.id],
      mode: 'installAndUse',
      passphraseOverride:
        input.passphrase && !input.savePassphrase ? input.passphrase : undefined,
    });
    const failed = result.results.find((entry) => entry.status === 'failed');
    if (failed) {
      throw new Error(failed.message ?? 'SSH 공개 키를 설치하지 못했습니다.');
    }
    setHostBrowserStatus(`${host.label} 호스트가 새 SSH 키를 사용하도록 전환되었습니다.`);
  }

  // 호스트 편집/생성 폼은 별도 오버레이가 아니라 우측 상세 영역(HostBrowser aside) 안에 표시한다.
  const hostEditor = isDrawerOpen ? (
    <HostDrawer
      open={isDrawerOpen}
      mode={homeViewModel.hostDrawer.mode === 'create' ? 'create' : 'edit'}
      host={currentHost}
      keychainEntries={settingsViewModel.keychainEntries}
      groupOptions={groupOptions}
      jumpHostOptions={jumpHostOptions}
      snippets={homeViewModel.snippets}
      defaultGroupPath={
        homeViewModel.hostDrawer.mode === 'create'
          ? homeViewModel.hostDrawer.defaultGroupPath
          : homeViewModel.currentGroupPath
      }
      createKind={
        homeViewModel.hostDrawer.mode === 'create'
          ? homeViewModel.hostDrawer.kind
          : 'ssh'
      }
      desktopPlatform={desktopPlatform}
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
  ) : null;

  return (
    <section
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col transition-[opacity,transform] duration-180',
        active
          ? 'pointer-events-auto opacity-100 scale-100'
          : 'pointer-events-none opacity-0 scale-[0.995]',
      )}
    >
      {authState.status === 'offline-authenticated' && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        {homeViewModel.homeSection === 'hosts' ? (
          <HostBrowser
            hostEditor={hostEditor}
            desktopPlatform={desktopPlatform}
            hosts={homeViewModel.hosts}
            groups={homeViewModel.groups}
            keychainEntries={settingsViewModel.keychainEntries}
            currentGroupPath={homeViewModel.currentGroupPath}
            searchQuery={homeViewModel.searchQuery}
            hostViewMode={settingsViewModel.settings.homeHostViewMode ?? 'grid'}
            selectedHostId={highlightedHostId}
            errorMessage={hostBrowserError}
            statusMessage={hostBrowserStatus}
            onSearchChange={homeViewModel.setSearchQuery}
            onHostViewModeChange={handleHostViewModeChange}
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
            onOpenSerialImport={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              homeViewModel.openCreateSerialDrawer();
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
            onSetHostFavorite={homeViewModel.setHostFavorite}
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
            onConnectHostTmux={async (hostId) => {
              try {
                setHostBrowserError(null);
                setSelectedHostId(hostId);
                await homeViewModel.connectHost(hostId, 120, 32, undefined, true);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : 'tmux 연결을 시작하지 못했습니다.',
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
            activityLogs={settingsViewModel.activityLogs}
            snippets={homeViewModel.snippets}
            onActivateSftp={homeViewModel.activateSftp}
            onActivateContainers={homeViewModel.activateContainers}
            onOpenSettingsSection={homeViewModel.openSettingsSection}
            onQuickConnectSsh={async (input) => {
              try {
                await handleQuickConnectSsh(input);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : 'Quick Connect를 시작하지 못했습니다.',
                );
              }
            }}
            onOpenSftp={(hostId) => {
              resetHostBrowserMessages();
              setSelectedHostId(hostId);
              void homeViewModel.connectSftpHost('right', hostId).catch((error) => {
                setHostBrowserError(
                  error instanceof Error ? error.message : 'SFTP를 열지 못했습니다.',
                );
              });
            }}
            onSelectSection={homeViewModel.openHomeSection}
            detailTab={detailTab}
            onDetailTabChange={setDetailTab}
            onOpenReplay={openSessionReplay}
            onGenerateAndInstallSshKey={handleGenerateAndInstallSshKey}
            onInstallSshPublicKey={settingsViewModel.installSshPublicKey}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-3 border-b border-[var(--border)] px-[1.1rem] py-[0.9rem]">
              <button
                type="button"
                onClick={() => homeViewModel.openHomeSection('hosts')}
                className="group inline-flex items-center gap-[0.4rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] py-[0.5rem] pl-[0.65rem] pr-[0.9rem] text-[0.82rem] font-semibold text-[var(--text-soft)] transition-[color,border-color,background-color] duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_38%,var(--border)_62%)] hover:bg-[var(--selection-tint)] hover:text-[var(--accent-strong)]"
              >
                <ArrowLeft
                  className="h-[0.95rem] w-[0.95rem] transition-transform duration-140 group-hover:-translate-x-[2px]"
                  aria-hidden="true"
                />
                Hosts
              </button>
              <h2 className="text-[1rem] font-bold text-[var(--text)]">{sectionTitle}</h2>
            </div>
            <main className="min-h-0 flex-1 overflow-auto px-[1.1rem] pb-[1.3rem] pt-[1.1rem]">
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

        {homeViewModel.homeSection === 'snippets' ? (
          <SnippetsPanel
            snippets={homeViewModel.snippets}
            onSave={homeViewModel.saveSnippet}
            onRemove={homeViewModel.removeSnippet}
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
            savedCredentialsSearchQuery={settingsViewModel.savedCredentialsSearchQuery}
            currentUserEmail={authState.session?.user.email ?? null}
            desktopPlatform={desktopPlatform}
            onSelectSection={settingsViewModel.openSettingsSection}
            onSavedCredentialsSearchQueryChange={
              settingsViewModel.setSavedCredentialsSearchQuery
            }
            onUpdateSettings={settingsViewModel.updateSettings}
            onRemoveKnownHost={settingsViewModel.removeKnownHost}
            onRemoveSecret={handleRemoveSecret}
            onEditSecret={openKeychainSecretEditor}
            onGenerateSshKey={settingsViewModel.generateSshKey}
            onCopySshPublicKey={settingsViewModel.copySshPublicKey}
            onInstallSshPublicKey={settingsViewModel.installSshPublicKey}
            onLogout={loginController.logout}
          />
        ) : null}
            </main>
          </div>
        )}

      </div>

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
