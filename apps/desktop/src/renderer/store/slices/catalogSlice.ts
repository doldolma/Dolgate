import type { SliceDeps } from "../services/context";
import type { CatalogSlice } from "../types";
import {
  AWS_SFTP_DEFAULT_PORT,
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  getAwsEc2SftpDisabledMessage,
  getAwsEc2HostSshPort,
  getParentGroupPath,
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isLinkedDnsOverrideRecord,
  isSshHostDraft,
  isGroupWithinPath,
  isSshHostRecord,
  isWarpgateSshHostRecord,
  normalizeGroupPath,
  rebaseGroupPath,
  stripRemovedGroupSegment,
  mergeContainerLogLines,
  normalizeRemoteInvokeErrorMessage,
  normalizeErrorMessage,
  isAwsSsoAuthenticationErrorMessage,
  arePortForwardRuntimeRecordsEqual,
  areEcsTunnelTabStatesEqual,
  areContainerTunnelTabStatesEqual,
  normalizeContainerTunnelTabStateForPersistence,
  normalizeHomeSectionInput,
  detectRendererPlatform,
  resolveRendererDefaultTerminalFontFamily,
  defaultSettings,
  createEmptyPane,
  isPendingSessionInteractiveAuth,
  isPendingSftpInteractiveAuth,
  isPendingContainersInteractiveAuth,
  isPendingPortForwardInteractiveAuth,
  resolveSftpPaneIdByEndpoint,
  resolveContainersHostIdByEndpoint,
  createContainerConnectionProgress,
  buildSftpHostPickerPane,
  defaultSftpState,
  sortHosts,
  toHostDraft,
  findSshHostMissingUsername,
  getDuplicateHostBaseLabel,
  buildDuplicateHostLabel,
  normalizeTagValue,
  matchesSelectedTags,
  hasProvidedSecrets,
  sortGroups,
  sortPortForwards,
  sortDnsOverrides,
  sortKnownHosts,
  sortLogs,
  sortKeychainEntries,
  asSessionTabId,
  asWorkspaceTabId,
  asTmuxSessionGroupTabId,
  findTmuxGroupForWorkspace,
  buildContainersEndpointId,
  buildContainersTabTitle,
  DEFAULT_CONTAINER_LOGS_TAIL_WINDOW,
  CONTAINER_LOGS_TAIL_INCREMENT,
  MAX_CONTAINER_LOGS_TAIL_WINDOW,
  MAX_CONTAINER_METRICS_SAMPLES,
  ECS_UTILIZATION_HISTORY_WINDOW_MS,
  classifyContainerLogsErrorMessage,
  trimContainerMetricsSamples,
  createEmptyContainersTabState,
  clearEcsServiceUtilization,
  mergeEcsClusterUtilizationSnapshot,
  createEcsUtilizationHistoryState,
  mergeMetricHistory,
  mergeEcsUtilizationHistoryState,
  upsertContainersTab,
  resolveNextContainerHostId,
  createWorkspaceLeaf,
  directionAxis,
  createWorkspaceSplit,
  listWorkspaceSessionIds,
  countWorkspaceSessions,
  findFirstWorkspaceSessionId,
  insertSessionIntoWorkspaceLayout,
  removeSessionFromWorkspaceLayout,
  moveSessionWithinWorkspaceLayout,
  updateWorkspaceSplitRatio,
  buildSessionTitle,
  PENDING_SESSION_PREFIX,
  createPendingSessionId,
  isPendingSessionId,
  createConnectionProgress,
  createInactiveSessionShareState,
  normalizeSessionShareState,
  setSessionShareState,
  clearSessionShareChatNotifications,
  appendSessionShareChatNotification,
  dismissSessionShareChatNotification,
  createPendingSessionTab,
  findPendingConnectionAttempt,
  findPendingConnectionAttemptByHost,
  isPendingEcsShellAttempt,
  normalizeEcsExecShellPermissionMessage,
  replaceSessionIdInLayout,
  replaceSessionReferencesInState,
  removeSessionFromState,
  activateSessionContextInState,
  buildWorkspaceTitle,
  resolveNextVisibleTab,
  resolveAdjacentTarget,
  dynamicTabMatches,
  findContainersTab,
  parentPath,
  resolveCurrentGroupPathAfterGroupMutation,
  resolveCurrentGroupPathAfterGroupRemoval,
  resolveCredentialRetryKind,
  shouldPromptAwsSftpConfigRetry,
  resolveHostKeyCheckProgress,
  resolveAwaitingHostTrustProgress,
  resolveConnectingProgress,
  resolveLocalStartingProgress,
  resolveWaitingShellProgress,
  resolveLocalWaitingShellProgress,
  resolveCredentialRetryProgress,
  resolveErrorProgress,
  normalizeInteractiveText,
  parseWarpgateApprovalUrl,
  parseWarpgateAuthCode,
  isWarpgateCompletionPrompt,
  isWarpgateCodePrompt,
  shouldTreatAsWarpgate,
  resolveInteractiveAuthUiState,
  buildInteractiveBrowserChallengeKey,
  upsertTransferJob,
  upsertForwardRuntime,
  basenameFromPath,
  resolveSftpVisibleEntryPaths,
  resolveNextSftpSelection,
  resolveTransferItemsFromPane,
  isBrowsableSftpPane,
  pushHistory,
  getPane,
  updatePaneState,
  toTrustInput,
} from "../utils";
import { createBootstrapSyncServices } from "../services/bootstrap-sync";
import { releaseTerminalUploadEndpoints } from "../services/sftp";

export function createCatalogSlice(deps: SliceDeps): CatalogSlice {
  const { api, set, get } = deps;
  const services = createBootstrapSyncServices(deps);

  const {
    syncOperationalData,
    syncSyncedWorkspaceData,
    refreshHostAndKeychainState,
  } = services;

  return {
    hosts: [],
    groups: [],
    activeWorkspaceTab: "home",
    homeSection: "hosts",
    settingsSection: "general",
    savedCredentialsSearchQuery: "",
    hostDrawer: { mode: "closed" },
    currentGroupPath: null,
    searchQuery: "",
    selectedHostTags: [],
    isReady: false,
    setSearchQuery: (value) => set({ searchQuery: value }),
    setSavedCredentialsSearchQuery: (value) =>
            set({ savedCredentialsSearchQuery: value }),
    toggleHostTag: (tag) =>
            set((state) => {
              const key = normalizeTagValue(tag);
              const alreadySelected = state.selectedHostTags.some(
                (value) => normalizeTagValue(value) === key,
              );
              return {
                selectedHostTags: alreadySelected
                  ? state.selectedHostTags.filter(
                      (value) => normalizeTagValue(value) !== key,
                    )
                  : [...state.selectedHostTags, tag],
              };
            }),
    clearHostTagFilter: () => set({ selectedHostTags: [] }),
    activateHome: () => {
            // 다른 탭에서 오면 홈 탭으로 전환하되 마지막 홈 섹션(로그 등)을 유지한다
            // (세션 갔다 Home 복귀 시 보던 섹션 보존). 이미 홈 탭인데 다시 Home을 누르면
            // 홈(호스트) 랜딩으로 리셋한다(홈 섹션에서 Home = 홈으로 가기).
            if (get().activeWorkspaceTab === "home") {
              get().openHomeSection("hosts");
            } else {
              set({ activeWorkspaceTab: "home" });
            }
          },
    activateSftp: () => set({ activeWorkspaceTab: "sftp" }),
    activateSession: (sessionId) =>
            set({ activeWorkspaceTab: asSessionTabId(sessionId) }),
    activateWorkspace: (workspaceId) => {
            // tmux workspace(=tmux window) 로 전환하면 control 채널의 select-window 로도
            // 동기화해, 원격 tmux 의 활성 window 가 따라오게 한다. window id 는 workspace 에,
            // 대상 control 세션은 그 workspace 의 pane 가상 sessionId 로 식별한다.
            const workspace = get().workspaces.find(
              (item) => item.id === workspaceId,
            );
            if (workspace?.tmux && workspace.activeSessionId.startsWith("tmux:")) {
              void api.ssh.tmuxSelectWindow(
                workspace.activeSessionId,
                workspace.tmux.windowId,
              );
            }
            // tmux 윈도우면 상단 세션 탭(tmuxgrp:)을 활성 유지하고 그룹의 활성
            // 윈도우만 옮긴다(세션 탭 강조 + 윈도우 바·화면 일치 보장).
            const group = findTmuxGroupForWorkspace(get().tmuxGroups, workspace);
            if (group) {
              set((state) => ({
                activeWorkspaceTab: asTmuxSessionGroupTabId(group.id),
                tmuxGroups: state.tmuxGroups.map((g) =>
                  g.id === group.id
                    ? { ...g, activeWorkspaceId: workspaceId }
                    : g,
                ),
              }));
              return;
            }
            set({ activeWorkspaceTab: asWorkspaceTabId(workspaceId) });
          },
    activateTmuxGroup: (tmuxGroupId) => {
            // tmux 세션 그룹 상단 탭으로 전환한다. 그룹 내 활성 window 전환은
            // selectTmuxWindow 가 담당하므로 여기선 active 탭만 그룹으로 바꾼다.
            set({ activeWorkspaceTab: asTmuxSessionGroupTabId(tmuxGroupId) });
          },
    activateContainers: () =>
            set((state) => ({
              activeWorkspaceTab: "containers",
              activeContainerHostId:
                state.activeContainerHostId ?? state.containerTabs[0]?.hostId ?? null,
            })),
    focusHostContainersTab: (hostId) =>
            set((state) => {
              if (!state.containerTabs.some((tab) => tab.hostId === hostId)) {
                return state;
              }
              return {
                activeWorkspaceTab: "containers",
                activeContainerHostId: hostId,
              };
            }),
    openHomeSection: (section) =>
            set((state) => {
              const nextSection = normalizeHomeSectionInput(section);
              return {
                activeWorkspaceTab: "home",
                homeSection: nextSection.homeSection,
                settingsSection:
                  nextSection.homeSection === "settings"
                    ? (nextSection.settingsSection ?? state.settingsSection)
                    : state.settingsSection,
                hostDrawer:
                  nextSection.homeSection === "hosts"
                    ? get().hostDrawer
                    : { mode: "closed" },
              };
            }),
    openSettingsSection: (section) =>
            // 호스트 드로어는 닫지 않는다. 편집 중에 "Manage" 로 설정을 다녀오는 것이 정상 흐름
            // 인데, 닫아 버리면 돌아왔을 때 편집하던 호스트를 다시 찾아 들어가야 한다.
            //
            // 열어 둬도 설정 화면을 가리지 않는다 — 드로어는 HostBrowser 안에 렌더되고, 그건
            // homeSection === 'hosts' 일 때만 마운트된다.
            set({
              activeWorkspaceTab: "home",
              homeSection: "settings",
              settingsSection: section,
            }),
    // 종류(SSH·Serial·RDP)는 드로어 안 셀렉터가 정한다 — 여기서는 기본값만 정해 준다.
    openCreateHostDrawer: () =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              hostDrawer: {
                mode: "create",
                defaultGroupPath: get().currentGroupPath,
                kind: "ssh",
              },
            }),
    openEditHostDrawer: (hostId) =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              hostDrawer: { mode: "edit", hostId },
            }),
    closeHostDrawer: () => set({ hostDrawer: { mode: "closed" } }),
    navigateGroup: (path) =>
            set({
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              currentGroupPath: normalizeGroupPath(path),
              hostDrawer: { mode: "closed" },
            }),
    bootstrap: async () => {
            const [snapshot, snippets] = await Promise.all([
              api.bootstrap.getInitialSnapshot(),
              api.snippets.list(),
            ]);
            // 아래 set이 terminalUploadEndpoints 참조를 통째로 버리므로, 그 전에
            // 실제 연결을 닫아 고아 커넥션을 막는다 (첫 부트스트랩에서는 no-op).
            releaseTerminalUploadEndpoints(api, get().sftp.terminalUploadEndpoints);
            set({
              hosts: sortHosts(snapshot.hosts),
              groups: sortGroups(snapshot.groups),
              tabs: snapshot.tabs.map((tab) => ({
                ...tab,
                sessionShare: normalizeSessionShareState(tab.sessionShare),
                hasReceivedOutput:
                  tab.status === "connected"
                    ? true
                    : (tab.hasReceivedOutput ?? false),
              })),
              workspaces: [],
              tabStrip: snapshot.tabs.map((tab) => ({
                kind: "session" as const,
                sessionId: tab.sessionId,
              })),
              portForwards: sortPortForwards(snapshot.portForwardSnapshot.rules),
              dnsOverrides: sortDnsOverrides(snapshot.dnsOverrides),
              snippets,
              portForwardRuntimes: snapshot.portForwardSnapshot.runtimes,
              knownHosts: sortKnownHosts(snapshot.knownHosts),
              activityLogs: sortLogs(snapshot.activityLogs),
              keychainEntries: sortKeychainEntries(snapshot.keychainEntries),
              activeWorkspaceTab: "home",
              homeSection: "hosts",
              settingsSection: "general",
              hostDrawer: { mode: "closed" },
              currentGroupPath: null,
              selectedHostTags: [],
              settings: snapshot.settings,
              isReady: true,
              pendingHostKeyPrompt: null,
              queuedHostKeyPrompts: [],
              pendingCredentialRetry: null,
              pendingAwsSftpConfigRetry: null,
              pendingMissingUsernamePrompt: null,
              pendingInteractiveAuths: [],
              pendingConnectionAttempts: [],
              sftp: {
                localHomePath: snapshot.localHomePath,
                leftPane: {
                  ...createEmptyPane("left"),
                  sourceKind: "local",
                  currentPath: snapshot.localHomeListing.path,
                  lastLocalPath: snapshot.localHomeListing.path,
                  history: [snapshot.localHomeListing.path],
                  historyIndex: 0,
                  entries: snapshot.localHomeListing.entries,
                  warningMessages: snapshot.localHomeListing.warnings ?? [],
                },
                rightPane: createEmptyPane("right"),
                transfers: [],
                pendingConflictDialog: null,
                terminalUploadEndpoints: {},
              },
            });
          },
    refreshHostCatalog: async () => {
            const [nextHosts, nextGroups, nextKeychainEntries] = await Promise.all([
              api.hosts.list(),
              api.groups.list(),
              api.keychain.list(),
            ]);
            set({
              hosts: sortHosts(nextHosts),
              groups: sortGroups(nextGroups),
              keychainEntries: sortKeychainEntries(nextKeychainEntries),
            });
          },
    refreshOperationalData: async () => {
            await syncOperationalData(set);
          },
    refreshSyncedWorkspaceData: async () => {
            await syncSyncedWorkspaceData(set);
          },
    clearSyncedWorkspaceData: () =>
            set({
              hosts: [],
              groups: [],
              portForwards: [],
              dnsOverrides: [],
              portForwardRuntimes: [],
              knownHosts: [],
              activityLogs: [],
              keychainEntries: [],
            }),
    createGroup: async (name, parentPath) => {
            const next = await api.groups.create(
              name,
              parentPath !== undefined ? parentPath : get().currentGroupPath,
            );
            set((state) => ({
              groups: sortGroups([
                ...state.groups.filter((group) => group.id !== next.id),
                next,
              ]),
            }));
          },
    removeGroup: async (path, mode) => {
            const result = await api.groups.remove(path, mode);
            set((state) => ({
              groups: sortGroups(result.groups),
              hosts: sortHosts(result.hosts),
              currentGroupPath: resolveCurrentGroupPathAfterGroupRemoval(
                state.currentGroupPath,
                path,
                mode,
              ),
            }));
          },
    moveGroup: async (path, targetParentPath) => {
            const result = await api.groups.move(path, targetParentPath);
            set((state) => ({
              groups: sortGroups(result.groups),
              hosts: sortHosts(result.hosts),
              currentGroupPath: resolveCurrentGroupPathAfterGroupMutation(
                state.currentGroupPath,
                path,
                result.nextPath,
              ),
              hostDrawer:
                state.hostDrawer.mode === "create"
                  ? {
                      ...state.hostDrawer,
                      defaultGroupPath: rebaseGroupPath(
                        state.hostDrawer.defaultGroupPath,
                        path,
                        result.nextPath,
                      ),
                    }
                  : state.hostDrawer,
            }));
          },
    renameGroup: async (path, name) => {
            const result = await api.groups.rename(path, name);
            set((state) => ({
              groups: sortGroups(result.groups),
              hosts: sortHosts(result.hosts),
              currentGroupPath: resolveCurrentGroupPathAfterGroupMutation(
                state.currentGroupPath,
                path,
                result.nextPath,
              ),
              hostDrawer:
                state.hostDrawer.mode === "create"
                  ? {
                      ...state.hostDrawer,
                      defaultGroupPath: rebaseGroupPath(
                        state.hostDrawer.defaultGroupPath,
                        path,
                        result.nextPath,
                      ),
                    }
                  : state.hostDrawer,
            }));
          },
    saveHost: async (hostId, draft, secrets) => {
            const next = hostId
              ? await api.hosts.update(hostId, draft, secrets)
              : await api.hosts.create(draft, secrets);
            set({
              hosts: sortHosts([
                ...get().hosts.filter((host) => host.id !== next.id),
                next,
              ]),
              // 편집 저장은 드로어를 편집 모드로 유지(호출부가 성공 시 닫는다). 새로 생성한
              // 경우엔 편집 창으로 넘어가지 않도록 드로어를 닫는다(호출부가 방금 만든 호스트를
              // 선택/상세 화면으로 전환). 편집창이 잠깐 스쳐 보이는 것도 막는다.
              hostDrawer: hostId
                ? { mode: "edit", hostId: next.id }
                : { mode: "closed" },
            });
            await refreshHostAndKeychainState(set);
            await syncOperationalData(set);
            return next;
          },
    duplicateHosts: async (hostIds) => {
            if (hostIds.length === 0) {
              return;
            }
    
            let workingHosts = get().hosts;
            let didCreate = false;
            for (const hostId of hostIds) {
              const current = workingHosts.find((host) => host.id === hostId);
              if (!current) {
                continue;
              }
    
              const next = await api.hosts.create(
                toHostDraft(current, buildDuplicateHostLabel(current, workingHosts)),
              );
              workingHosts = sortHosts([
                ...workingHosts.filter((host) => host.id !== next.id),
                next,
              ]);
              didCreate = true;
            }
    
            if (!didCreate) {
              return;
            }
    
            set({
              hosts: workingHosts,
            });
            await syncOperationalData(set);
          },
    moveHostToGroup: async (hostId, groupPath) => {
            const current = get().hosts.find((host) => host.id === hostId);
            if (!current) {
              return;
            }
    
            const next = await api.hosts.update(hostId, {
              ...toHostDraft(current, current.label),
              groupName: groupPath,
            });
    
            set((state) => ({
              hosts: sortHosts([
                ...state.hosts.filter((host) => host.id !== next.id),
                next,
              ]),
            }));
            await syncOperationalData(set);
          },
    setHostFavorite: async (hostId, favorite) => {
            const next = await api.hosts.setFavorite(hostId, favorite);
            if (!next) {
              return;
            }
            set((state) => ({
              hosts: sortHosts([
                ...state.hosts.filter((host) => host.id !== next.id),
                next,
              ]),
            }));
            await syncOperationalData(set);
          },
    removeHost: async (hostId) => {
            await api.hosts.remove(hostId);
            const currentDrawer = get().hostDrawer;
            set({
              hosts: get().hosts.filter((host) => host.id !== hostId),
              pendingMissingUsernamePrompt:
                get().pendingMissingUsernamePrompt?.hostId === hostId
                  ? null
                  : get().pendingMissingUsernamePrompt,
              hostDrawer:
                currentDrawer.mode === "edit" && currentDrawer.hostId === hostId
                  ? { mode: "closed" }
                  : currentDrawer,
            });
            await syncOperationalData(set);
          }
  };

}
