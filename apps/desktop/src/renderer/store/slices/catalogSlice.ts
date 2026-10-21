import type { SliceDeps } from "../services/context";
import type { CatalogSlice } from "../types";
import type { HostRecord, SavedWorkspaceRecord } from "@shared";
import {
  collectGroupPaths,
  getGroupLabel,
  isDirectGroupChild,
  planGroupReorder,
  resolveHostDrives,
  withHostDrives,
} from "@shared";
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
  createEmptyVaultIndex,
  TEAMS_SIGNED_OUT,
} from "../utils";
import { PERSONAL_VAULT_ID, isTeamVaultId, vaultIdOfHost } from "../utils";
import { createBootstrapSyncServices } from "../services/bootstrap-sync";
import { releaseTerminalUploadEndpoints } from "../services/sftp";

export function createCatalogSlice(deps: SliceDeps): CatalogSlice {
  const { api, set, get } = deps;
  const services = createBootstrapSyncServices(deps);

  const {
    loadVaultIndex,
    loadTeamAvailability,
    syncOperationalData,
    syncSyncedWorkspaceData,
    refreshHostAndKeychainState,
  } = services;

  // ── 볼트별 그룹 쓰기 ──
  // 지금 위치의 볼트인가(All 이면 개인으로 본다 — All 일 때 지금 경로는 늘 비어 있다).
  const isCurrentVault = (vaultId: string) => (get().currentVaultId ?? PERSONAL_VAULT_ID) === vaultId;
  // 그 볼트가 지금 위치일 때만 지금 경로를 고친다 — 다른 볼트의 같은 경로를 따라 움직이지 않게.
  const followCurrentPath = (vaultId: string, next: (current: string | null) => string | null) => {
    if (isCurrentVault(vaultId)) {
      set((state) => ({ currentGroupPath: next(state.currentGroupPath) }));
    }
  };
  // 그 볼트에 만들던 새 호스트 서랍의 그룹을 옮긴 경로로 따라 바꾼다.
  const rebaseDrawerGroup = (vaultId: string, path: string, nextPath: string) => {
    set((state) =>
      state.hostDrawer.mode === "create" && state.hostDrawer.vaultId === vaultId
        ? {
            hostDrawer: {
              ...state.hostDrawer,
              defaultGroupPath: rebaseGroupPath(state.hostDrawer.defaultGroupPath, path, nextPath),
            },
          }
        : state,
    );
  };
  // 팀 볼트의 그룹·호스트·워크스페이스(직접 정렬이 형제를 만들 때).
  const teamInputsOf = (vaultId: string) => {
    const state = get();
    return {
      groups: state.vaultIndex.teams.find((team) => team.id === vaultId)?.groups ?? [],
      hosts: state.hosts.filter((host) => state.vaultIndex.teamIdByHostId[host.id] === vaultId),
      savedWorkspaces: state.savedWorkspaces.filter(
        (workspace) => state.vaultIndex.teamIdByWorkspaceId[workspace.id] === vaultId,
      ),
    };
  };
  // 개인 볼트의 호스트·워크스페이스(개인 그룹의 직접 정렬이 형제를 만들 때). 팀 레코드의 그룹 경로까지 개인 형제로
  // 세면 개인 볼트에 팀 그룹 이름의 빈 그룹이 생긴다.
  const personalInputs = () => {
    const state = get();
    return {
      hosts: state.hosts.filter((host) => !state.vaultIndex.teamIdByHostId[host.id]),
      savedWorkspaces: state.savedWorkspaces.filter(
        (workspace) => !state.vaultIndex.teamIdByWorkspaceId[workspace.id],
      ),
    };
  };
  // 개인 그룹을 바꾼 뒤의 목록. 메인이 돌려준 목록은 개인 볼트 것이다 — 그대로 덮으면 팀 레코드가 화면에서
  // 사라진다(다음에 다시 읽을 때까지). 개인 것만 바꾸고 팀 레코드는 그대로 둔다.
  const withTeamRecords = (
    state: ReturnType<typeof get>,
    personal: { hosts: HostRecord[]; savedWorkspaces?: SavedWorkspaceRecord[] | null },
  ) => ({
    hosts: sortHosts([...personal.hosts, ...state.hosts.filter((host) => state.vaultIndex.teamIdByHostId[host.id])]),
    savedWorkspaces: personal.savedWorkspaces
      ? [
          ...personal.savedWorkspaces,
          ...state.savedWorkspaces.filter((workspace) => state.vaultIndex.teamIdByWorkspaceId[workspace.id]),
        ]
      : state.savedWorkspaces,
  });
  // 팀 볼트의 그룹을 바꾼 뒤. 메인이 돌려준 목록은 그 팀 것이라 쓰지 않고, 모든 볼트의 목록과 볼트 표를
  // 다시 읽는다(그룹을 지우거나 옮기면 그 팀 호스트·워크스페이스의 그룹도 바뀐다).
  const reloadAfterTeamGroupWrite = async () => {
    const [savedWorkspaces] = await Promise.all([api.savedWorkspaces.list(), get().refreshHostCatalog()]);
    set({ savedWorkspaces });
  };

  return {
    hosts: [],
    groups: [],
    vaultIndex: createEmptyVaultIndex(),
    teamAvailability: TEAMS_SIGNED_OUT,
    activeWorkspaceTab: "home",
    homeSection: "hosts",
    settingsSection: "general",
    savedCredentialsSearchQuery: "",
    hostDrawer: { mode: "closed" },
    currentGroupPath: null,
    currentVaultId: null,
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
            g.id === group.id ? { ...g, activeWorkspaceId: workspaceId } : g,
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
    openCreateHostDrawer: (target) => {
      const state = get();
      // 지금 위치에 만든다. All 이면 개인 맨 위다(팀이 없을 때와 같다).
      set({
        activeWorkspaceTab: "home",
        homeSection: "hosts",
        hostDrawer: {
          mode: "create",
          defaultGroupPath: target ? target.groupPath : state.currentGroupPath,
          kind: "ssh",
          vaultId: target?.vaultId ?? state.currentVaultId ?? PERSONAL_VAULT_ID,
        },
      });
    },
    openEditHostDrawer: (hostId) =>
      set({
        activeWorkspaceTab: "home",
        homeSection: "hosts",
        hostDrawer: { mode: "edit", hostId },
      }),
    closeHostDrawer: () => set({ hostDrawer: { mode: "closed" } }),
    navigateGroup: (path, vaultId) => {
      const nextPath = normalizeGroupPath(path);
      set({
        activeWorkspaceTab: "home",
        homeSection: "hosts",
        currentGroupPath: nextPath,
        currentVaultId: vaultId ?? (nextPath ? PERSONAL_VAULT_ID : null),
        hostDrawer: { mode: "closed" },
      });
    },
    bootstrap: async () => {
      const [snapshot, snippets, savedWorkspaces, vaultIndex, teamAvailability] = await Promise.all([
        api.bootstrap.getInitialSnapshot(),
        api.snippets.list(),
        api.savedWorkspaces.list(),
        loadVaultIndex(),
        loadTeamAvailability(),
      ]);
      // 아래 set이 terminalUploadEndpoints 참조를 통째로 버리므로, 그 전에
      // 실제 연결을 닫아 고아 커넥션을 막는다 (첫 부트스트랩에서는 no-op).
      releaseTerminalUploadEndpoints(api, get().sftp.terminalUploadEndpoints);
      set({
        hosts: sortHosts(snapshot.hosts),
        groups: sortGroups(snapshot.groups),
        vaultIndex: vaultIndex ?? createEmptyVaultIndex(),
        teamAvailability: teamAvailability ?? TEAMS_SIGNED_OUT,
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
        savedWorkspaces,
        portForwardRuntimes: snapshot.portForwardSnapshot.runtimes,
        knownHosts: sortKnownHosts(snapshot.knownHosts),
        activityLogs: sortLogs(snapshot.activityLogs),
        keychainEntries: sortKeychainEntries(snapshot.keychainEntries),
        activeWorkspaceTab: "home",
        homeSection: "hosts",
        settingsSection: "general",
        hostDrawer: { mode: "closed" },
        currentGroupPath: null,
        currentVaultId: null,
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
      const [nextHosts, nextGroups, nextKeychainEntries, vaultIndex] = await Promise.all([
        api.hosts.list(),
        api.groups.list(),
        api.keychain.list(),
        loadVaultIndex(),
      ]);
      set({
        hosts: sortHosts(nextHosts),
        groups: sortGroups(nextGroups),
        keychainEntries: sortKeychainEntries(nextKeychainEntries),
        ...(vaultIndex ? { vaultIndex } : {}),
      });
    },
    refreshOperationalData: async () => {
      await syncOperationalData(set);
    },
    refreshSyncedWorkspaceData: async () => {
      await syncSyncedWorkspaceData(set);
    },
    refreshVaultIndex: async () => {
      const vaultIndex = await loadVaultIndex();
      if (vaultIndex) {
        set({ vaultIndex });
      }
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
        savedWorkspaces: [],
        vaultIndex: createEmptyVaultIndex(),
        teamAvailability: TEAMS_SIGNED_OUT,
      }),
    createGroup: async (name, parentPath, vaultId = PERSONAL_VAULT_ID) => {
      const parent =
        parentPath !== undefined ? parentPath : isCurrentVault(vaultId) ? get().currentGroupPath : null;
      if (isTeamVaultId(vaultId)) {
        await api.groups.create(name, parent, vaultId);
        // 팀 그룹은 볼트 표에 있다.
        await get().refreshVaultIndex();
        return;
      }
      const next = await api.groups.create(name, parent);
      set((state) => ({
        groups: sortGroups([
          ...state.groups.filter((group) => group.id !== next.id),
          next,
        ]),
      }));
    },
    removeGroup: async (path, mode, vaultId = PERSONAL_VAULT_ID) => {
      if (isTeamVaultId(vaultId)) {
        await api.groups.remove(path, mode, vaultId);
        await reloadAfterTeamGroupWrite();
        followCurrentPath(vaultId, (current) => resolveCurrentGroupPathAfterGroupRemoval(current, path, mode));
        return;
      }
      const result = await api.groups.remove(path, mode);
      set((state) => ({
        groups: sortGroups(result.groups),
        ...withTeamRecords(state, result),
        currentGroupPath: isCurrentVault(vaultId)
          ? resolveCurrentGroupPathAfterGroupRemoval(state.currentGroupPath, path, mode)
          : state.currentGroupPath,
      }));
    },
    moveGroup: async (path, targetParentPath, vaultId = PERSONAL_VAULT_ID) => {
      if (isTeamVaultId(vaultId)) {
        const result = await api.groups.move(path, targetParentPath, vaultId);
        await reloadAfterTeamGroupWrite();
        followCurrentPath(vaultId, (current) => resolveCurrentGroupPathAfterGroupMutation(current, path, result.nextPath));
        rebaseDrawerGroup(vaultId, path, result.nextPath);
        return;
      }
      const result = await api.groups.move(path, targetParentPath);
      set((state) => ({
        groups: sortGroups(result.groups),
        ...withTeamRecords(state, result),
        currentGroupPath: isCurrentVault(vaultId)
          ? resolveCurrentGroupPathAfterGroupMutation(state.currentGroupPath, path, result.nextPath)
          : state.currentGroupPath,
      }));
      rebaseDrawerGroup(vaultId, path, result.nextPath);
    },
    reorderGroup: async (path, targetParentPath, targetIndex, vaultId = PERSONAL_VAULT_ID) => {
      const nextParentPath = normalizeGroupPath(targetParentPath);
      // 팀 볼트면 그 팀의 그룹·호스트·워크스페이스로 형제를 만들고, 쓰기는 그 팀으로 보낸다.
      const team = isTeamVaultId(vaultId) ? vaultId : null;
      const teamInputs = team ? teamInputsOf(team) : null;
      let groups = teamInputs ? teamInputs.groups : get().groups;
      // hosts 도 이 동작이 소유하지 않는다. 그룹을 옮겨 호스트의 groupName 이 바뀐 경우에만 주
      // 프로세스가 준 새 목록을 쓰고, 그 밖에는 손대지 않는다 — savedWorkspaces 와 같은 이유로,
      // 아래 await 들 사이에 들어온 호스트 갱신(동기화 폴링, 이름 변경, detectedOs)을 스냅샷으로
      // 덮어써서 되돌리던 자리다.
      let movedHosts: HostRecord[] | null = null;
      let hosts = teamInputs ? teamInputs.hosts : personalInputs().hosts;
      // 이 동작은 savedWorkspaces 를 소유하지 않는다. 그룹을 옮겨 경로가 바뀐 경우에만 주 프로세스가
      // 준 새 목록을 쓰고, 그 밖에는 손대지 않는다 — 아래 await 들 사이에 들어온 갱신(touchOpened,
      // 이름 변경, 삭제)을 스냅샷으로 덮어써서 되돌리던 자리다.
      let movedSavedWorkspaces: SavedWorkspaceRecord[] | null = null;
      let movedPath = normalizeGroupPath(path);
      if (!movedPath) {
        return;
      }

      // 부모가 다르면 먼저 옮긴다 — 경로가 바뀌므로 형제 목록을 그 뒤에 만들어야 한다.
      if (getParentGroupPath(movedPath) !== nextParentPath) {
        const moved = team
          ? await api.groups.move(movedPath, nextParentPath, team)
          : await api.groups.move(movedPath, nextParentPath);
        groups = moved.groups;
        hosts = moved.hosts;
        movedHosts = moved.hosts;
        movedSavedWorkspaces = moved.savedWorkspaces ?? null;
        movedPath = moved.nextPath;
      }

      // 형제 목록을 **화면에 보이는 순서**로 만든다. planGroupReorder 가 그 순서를 전제한다.
      const siblingPaths = collectGroupPaths(
        groups,
        hosts,
        movedSavedWorkspaces ?? (teamInputs ? teamInputs.savedWorkspaces : personalInputs().savedWorkspaces),
      ).filter(
        (candidate: string) => isDirectGroupChild(candidate, nextParentPath),
      );

      // 레코드가 없는 형제(호스트의 groupName 만으로 존재)는 순서를 적을 곳이 없다.
      // 그대로 두면 랭크 없는 것으로 취급돼 맨 뒤로 밀려 목록이 흐트러지므로, 여기서
      // 레코드를 만들어 준다. 이름·경로는 이미 정해져 있어 물을 것이 없다.
      const recordByPath = new Map(
        groups.map((record) => [record.path, record]),
      );
      for (const siblingPath of siblingPaths) {
        if (recordByPath.has(siblingPath)) {
          continue;
        }
        const created = team
          ? await api.groups.create(getGroupLabel(siblingPath), nextParentPath, team)
          : await api.groups.create(getGroupLabel(siblingPath), nextParentPath);
        recordByPath.set(created.path, created);
        groups = [...groups, created];
      }

      const siblings = siblingPaths
        .map((siblingPath) => recordByPath.get(siblingPath))
        .filter((record): record is NonNullable<typeof record> =>
          Boolean(record),
        );
      const moved = recordByPath.get(movedPath);
      if (!moved) {
        return;
      }

      const assignments = planGroupReorder(siblings, moved.id, targetIndex);
      const nextGroups =
        assignments.length > 0
          ? team
            ? await api.groups.setOrder(assignments, team)
            : await api.groups.setOrder(assignments)
          : groups;
      if (team) {
        // 메인이 돌려준 목록은 그 팀 것이다 — 모든 볼트 목록과 볼트 표를 다시 읽는다.
        await reloadAfterTeamGroupWrite();
        return;
      }

      set((state) => ({
        // groups 는 이 동작이 실제로 쓴 결과다(setOrder/create 를 거친 nextGroups).
        groups: sortGroups(nextGroups),
        ...(movedHosts
          ? withTeamRecords(state, { hosts: movedHosts, savedWorkspaces: movedSavedWorkspaces })
          : { hosts: state.hosts, savedWorkspaces: movedSavedWorkspaces ?? state.savedWorkspaces }),
      }));
    },
    renameGroup: async (path, name, vaultId = PERSONAL_VAULT_ID) => {
      if (isTeamVaultId(vaultId)) {
        const result = await api.groups.rename(path, name, vaultId);
        await reloadAfterTeamGroupWrite();
        followCurrentPath(vaultId, (current) => resolveCurrentGroupPathAfterGroupMutation(current, path, result.nextPath));
        rebaseDrawerGroup(vaultId, path, result.nextPath);
        return;
      }
      const result = await api.groups.rename(path, name);
      set((state) => ({
        groups: sortGroups(result.groups),
        ...withTeamRecords(state, result),
        currentGroupPath: isCurrentVault(vaultId)
          ? resolveCurrentGroupPathAfterGroupMutation(state.currentGroupPath, path, result.nextPath)
          : state.currentGroupPath,
      }));
      rebaseDrawerGroup(vaultId, path, result.nextPath);
    },
    saveHost: async (hostId, draft, secrets, vaultId) => {
      const next = hostId
        ? await api.hosts.update(hostId, draft, secrets)
        : isTeamVaultId(vaultId)
          ? await api.hosts.create(draft, secrets, vaultId)
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

        const draft = toHostDraft(
          current,
          buildDuplicateHostLabel(current, workingHosts),
        );
        // 공유 폴더의 주인은 **기기 로컬 설정**이다. 레코드에 남아 있는 옛 값(마이그레이션
        // 전에 저장된 것)을 복제본에 실어 보내면 `/Users/...` 같은 이 기기의 경로가 다시
        // 동기화돼 다른 기기로 흘러간다. 아래에서 로컬 설정으로 옮겨 담는다.
        const outgoing = draft.kind === "rdp" ? { ...draft, drives: null } : draft;
        // 복제본은 원본과 같은 볼트에 둔다 — 팀 호스트를 개인에 복제하면 개인 레코드가 팀 비밀값을 가리킨다.
        const vaultId = vaultIdOfHost(get().vaultIndex, current.id);
        const next = isTeamVaultId(vaultId)
          ? await api.hosts.create(outgoing, undefined, vaultId)
          : await api.hosts.create(outgoing);
        // 공유 폴더는 기기 로컬 설정에 있다 — 레코드를 복사하는 것만으로는 따라오지
        // 않는다. 복제는 **같은 기기 안**에서 일어나므로 경로가 그대로 유효하고, 원본이
        // 열어 둔 폴더가 복제본에서 조용히 사라지면 왜 파일이 안 보이는지 알 수 없다.
        if (current.kind === "rdp") {
          const drives = resolveHostDrives(
            current.id,
            get().settings.rdpDrivesByHostId,
            current.drives,
          );
          if (drives.length > 0) {
            const settings = await api.settings.update({
              rdpDrivesByHostId: withHostDrives(
                get().settings.rdpDrivesByHostId,
                next.id,
                drives,
              ),
            });
            set({ settings });
          }
        }
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
    setHostDetectedOs: async (hostId, detectedOs) => {
      const next = await api.hosts.setDetectedOs(hostId, detectedOs);
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
    setHostTerminalTheme: async (hostId, terminalThemeId) => {
      const next = await api.hosts.setTerminalTheme(hostId, terminalThemeId);
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
    },
  };
}
