import { useEffect, useMemo, useState } from 'react';
import { listTailnets } from '../services/desktop/tailnet';
import {
  buildGroupOptions,
  getGroupLabel,
  getParentGroupPath,
  getHostSecretRef,
  isAwsEc2HostRecord,
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
import { DolgateImportDialog, HostExportDialog } from '../components/HostTransferDialogs';
import { changeVaultPassphrase, resetVault } from '../services/desktop/auth-window-updater';
import { getJumpHostCandidates } from '../components/HostForm';
import { LogsPanel } from '../components/LogsPanel';
import { OpenSshImportDialog } from '../components/OpenSshImportDialog';
import { PortForwardingPanel } from '../components/PortForwardingPanel';
import { SnippetsPanel } from '../components/SnippetsPanel';
import type { SecretEditDialogRequest } from '../components/SecretEditDialog';
import { SettingsPanel } from '../components/SettingsPanel';
import { BOOTSTRAP_TERMINAL_SIZE } from '../components/terminal-resize';
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
import { useTranslation } from 'react-i18next';

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
  const { t: translate } = useTranslation();
  const settingsViewModel = useSettingsViewModel();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'connection'>('overview');
  const [isAwsImportOpen, setIsAwsImportOpen] = useState(false);
  const [isDolgateImportOpen, setIsDolgateImportOpen] = useState(false);
  const [exportHostIds, setExportHostIds] = useState<string[] | null>(null);
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

  // 호스트 편집에서 경유할 tailnet 을 고르려면 등록된 목록이 필요하다.
  //
  // 드로어가 열릴 때마다 다시 읽는다. 마운트에 한 번만 읽으면, 설정에서 tailnet 을 추가한 뒤
  // 호스트로 돌아와도 이 셸은 재마운트되지 않아(백그라운드에 남는다) 목록이 낡은 채로 남고
  // 방금 추가한 tailnet 을 고를 수 없다.
  const [tailnetOptions, setTailnetOptions] = useState<
    Array<{ id: string; label: string }>
  >([]);
  // 점프 후보별 tailnet 이름. 폼이 "첫 홉의 tailnet 을 탄다" 를 말하려면 이게 필요하다.
  const jumpHostTailnetNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const host of homeViewModel.hosts) {
      const tailnetId = 'tailnetId' in host ? host.tailnetId?.trim() : '';
      if (!tailnetId) {
        continue;
      }
      names[host.id] =
        tailnetOptions.find((option) => option.id === tailnetId)?.label ??
        tailnetId;
    }
    return names;
  }, [homeViewModel.hosts, tailnetOptions]);
  useEffect(() => {
    if (!isDrawerOpen) {
      return;
    }
    let cancelled = false;
    // Promise 로 감싸는 이유: 브리지가 없으면 listTailnets 가 동기적으로 던지고, 그러면
    // .catch 가 잡지 못해 셸 전체가 죽는다. tailnet 을 못 읽는 것이 호스트 편집을 막을
    // 이유는 없다.
    void Promise.resolve()
      .then(listTailnets)
      .then((records) => {
        if (!cancelled) {
          setTailnetOptions(
            records.map((record) => ({ id: record.id, label: record.label })),
          );
        }
      })
      .catch(() => {
        // tailnet 을 못 읽어도 호스트 편집 자체는 되어야 한다.
      });
    return () => {
      cancelled = true;
    };
  }, [isDrawerOpen]);
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
          : translate('home.error.layoutSaveFailed'),
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
        ? translate('home.secret.deleteLinked', { count: linkedHostCount })
        : translate('home.secret.delete'),
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
    if (!host || (!isSshHostRecord(host) && !isAwsEc2HostRecord(host))) {
      throw new Error(translate('home.error.sshHostNotFound'));
    }
    // EC2는 SSH-over-SSM(EIC)로 접속해 설치만 한다 — 매 연결 임시 키를 쓰므로
    // "이 키로 접속 전환"이 없다.
    const isEc2 = isAwsEc2HostRecord(host);
    const key = await settingsViewModel.generateSshKey(input);
    const result = await settingsViewModel.installSshPublicKey({
      secretRef: key.secretRef,
      hostIds: [host.id],
      mode: isEc2 ? 'installOnly' : 'installAndUse',
      passphraseOverride:
        input.passphrase && !input.savePassphrase ? input.passphrase : undefined,
    });
    const failed = result.results.find((entry) => entry.status === 'failed');
    if (failed) {
      throw new Error(failed.message ?? translate('home.error.keyInstallFailed'));
    }
    setHostBrowserStatus(
      isEc2
        ? translate('home.key.installedAuthorizedKeys', { label: host.label })
        : translate('home.key.switched', { label: host.label }),
    );
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
      jumpHostTailnetNames={jumpHostTailnetNames}
      tailnetOptions={tailnetOptions}
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
      // 서버가 계정 데이터 수준을 저장할 수 있을 때만 RDP 를 만들 수 있다(HostDrawer 주석 참고).
      serverSupportsDataFloor={authState.capabilities?.dataFloor === true}
      onClose={homeViewModel.closeHostDrawer}
      onSubmit={async (draft, secrets) => {
        const isEdit = homeViewModel.hostDrawer.mode === 'edit';
        const saved = await homeViewModel.saveHost(
          isEdit ? currentHost?.id ?? null : null,
          draft,
          secrets,
        );
        // 새로 생성한 경우엔 편집 창으로 넘어가지 않고, saveHost가 닫은 드로어 뒤로 방금
        // 만든 호스트를 선택(상세) 화면으로 보여준다. 편집 저장은 드로어에서 기존대로 처리.
        if (!isEdit) {
          setSelectedHostId(saved.id);
        }
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
      onOpenTailnets={() => settingsViewModel.openSettingsSection('tailnet')}
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
            active={active}
            hostEditor={hostEditor}
            tmuxPrefixKey={settingsViewModel.settings.tmuxPrefixKey}
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
              // 씨앗 크기로 연다 — 여기는 pane 이 없어 실제 격자를 모른다. 정정은
              // BOOTSTRAP_TERMINAL_SIZE 주석에 적힌 두 경로가 맡는다.
              void homeViewModel
                .openLocalTerminal(
                  BOOTSTRAP_TERMINAL_SIZE.cols,
                  BOOTSTRAP_TERMINAL_SIZE.rows,
                )
                .catch((error) => {
                  setHostBrowserError(
                    error instanceof Error
                      ? error.message
                      : translate('home.error.localTerminalFailed'),
                  );
                });
            }}
            onCreateHost={() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              homeViewModel.openCreateHostDrawer();
            }}
            onOpenDolgateImport={() => {
              resetHostBrowserMessages();
              setIsDolgateImportOpen(true);
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
            onExportHosts={(hostIds) => {
              resetHostBrowserMessages();
              setExportHostIds(hostIds);
            }}
            onCreateGroup={homeViewModel.createGroup}
            onRemoveGroup={homeViewModel.removeGroup}
            onMoveGroup={async (path, targetParentPath) => {
              resetHostBrowserMessages();
              try {
                await homeViewModel.moveGroup(path, targetParentPath);
                const nextPath = buildMovedGroupPath(path, targetParentPath);
                setHostBrowserStatus(
                  nextPath ? translate('home.group.movedTo', { path: nextPath }) : translate('home.group.moved'),
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate('home.error.groupMoveFailed'),
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
                  nextPath ? translate('home.group.renamedTo', { path: nextPath }) : translate('home.group.renamed'),
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate('home.error.groupRenameFailed'),
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
                    : translate('home.error.connectFailed'),
                );
              }
            }}
            onOpenHostInNewWindow={homeViewModel.openHostInNewWindow}
            onConnectHostTmux={async (hostId) => {
              try {
                setHostBrowserError(null);
                setSelectedHostId(hostId);
                await homeViewModel.connectHost(hostId, 120, 32, undefined, true);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate('home.error.tmuxFailed'),
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
                    : translate('home.error.containersFailed'),
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
                    : translate('home.error.quickConnectFailed'),
                );
              }
            }}
            onOpenSftp={(hostId) => {
              resetHostBrowserMessages();
              setSelectedHostId(hostId);
              void homeViewModel.connectSftpHost('right', hostId).catch((error) => {
                setHostBrowserError(
                  error instanceof Error ? error.message : translate('home.error.sftpFailed'),
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
              modalViewModel.pendingInteractiveAuths.find(
                (auth) => auth.source === 'portForward',
              ) ?? null
            }
            discoveryInteractiveAuth={
              modalViewModel.pendingInteractiveAuths.find(
                (auth) => auth.source === 'containers',
              ) ?? null
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
            passwordState={
              authState.status === 'authenticated'
                ? (authState.session?.user.passwordState ?? null)
                : null
            }
            desktopPlatform={desktopPlatform}
            onSelectSection={settingsViewModel.openSettingsSection}
            onSavedCredentialsSearchQueryChange={
              settingsViewModel.setSavedCredentialsSearchQuery
            }
            onUpdateSettings={settingsViewModel.updateSettings}
            onRemoveKnownHost={settingsViewModel.removeKnownHost}
            onRevokeRdpCertificate={settingsViewModel.revokeRdpCertificateTrust}
            onRemoveSecret={handleRemoveSecret}
            onEditSecret={openKeychainSecretEditor}
            onGenerateSshKey={settingsViewModel.generateSshKey}
            onCopySshPublicKey={settingsViewModel.copySshPublicKey}
            onInstallSshPublicKey={settingsViewModel.installSshPublicKey}
            onLoadSessionReplayStorageUsage={
              settingsViewModel.loadSessionReplayStorageUsage
            }
            onLogout={loginController.logout}
            onDeleteAccount={loginController.deleteAccount}
            onChangeAccountPassword={loginController.changeAccountPassword}
            webauthnSupported={authState.capabilities?.webauthn ?? false}
            onAddPasskey={loginController.addPasskey}
            onListPasskeys={loginController.listPasskeys}
            onDeletePasskey={loginController.deletePasskey}
            vaultStatus={authState.vault?.status ?? null}
            onChangeVaultPassphrase={changeVaultPassphrase}
            onResetVault={resetVault}
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
        onImport={async (draft, secrets) => {
          // RDP 경로는 자격증명(Administrator + 암호)을 함께 만든다. saveHost 가 시크릿까지 받는다.
          await homeViewModel.saveHost(null, draft, secrets);
        }}
      />

      <HostExportDialog
        open={Boolean(exportHostIds)}
        hostIds={exportHostIds ?? []}
        onClose={() => setExportHostIds(null)}
        onExported={(result) => {
          setHostBrowserStatus(
            `${translate('home.transfer.exported', { count: result.exportedHostCount })}${
              result.skippedHostCount > 0
                ? translate('home.transfer.exportSkipped', { count: result.skippedHostCount })
                : ''
            }`,
          );
          setHostBrowserError(result.warnings[0] ?? null);
        }}
      />

      <DolgateImportDialog
        open={isDolgateImportOpen}
        onClose={() => setIsDolgateImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshSyncedWorkspaceData();
          setHostBrowserStatus(
            `${translate('home.transfer.dolgateImported', { count: result.importedHostCount })}${
              result.skippedCount > 0
                ? translate('home.transfer.dolgateSkipped', { count: result.skippedCount })
                : ''
            }`,
          );
          setHostBrowserError(result.warnings[0] ?? null);
        }}
      />

      <TermiusImportDialog
        open={isTermiusImportOpen}
        onClose={() => setIsTermiusImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshHostCatalog();
          setHostBrowserStatus(
            `${translate('home.transfer.termiusImported', {
              hosts: result.createdHostCount,
              groups: result.createdGroupCount,
              secrets: result.createdSecretCount,
            })}${
              result.skippedHostCount > 0
                ? translate('home.transfer.termiusSkipped', { count: result.skippedHostCount })
                : ''
            }`,
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
            `${translate('home.transfer.opensshImported', { count: result.createdHostCount })}${
              result.createdSecretCount > 0
                ? translate('home.transfer.opensshSecrets', { count: result.createdSecretCount })
                : ''
            }${
              result.skippedHostCount > 0
                ? translate('home.transfer.skippedHosts', { count: result.skippedHostCount })
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
            `${translate('home.transfer.xshellImported', {
              hosts: result.createdHostCount,
              groups: result.createdGroupCount,
            })}${
              result.skippedHostCount > 0
                ? translate('home.transfer.skippedHosts', { count: result.skippedHostCount })
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
