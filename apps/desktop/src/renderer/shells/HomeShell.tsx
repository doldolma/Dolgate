import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listTailnets, listTeamTailnets } from "../services/desktop/tailnet";
import {
  buildGroupOptions,
  getGroupLabel,
  getParentGroupPath,
  getHostSecretRef,
  detachHostDrives,
  isAwsEc2HostRecord,
  isRdpHostRecord,
  isSshHostRecord,
  normalizeGroupPath,
  resolveHostDrives,
  withHostDrives,
  type AuthState,
  type HostDraft,
  type HomeHostViewMode,
  type SecretMetadataRecord,
  type SshKeyGenerateInput,
  type VaultCopyRequest,
  type VaultCopyResult,
} from "@shared";
import { AwsImportDialog } from "../components/AwsImportDialog";
import { HostBrowser } from "../components/HostBrowser";
import { buildBrowserVaults } from "../components/host-browser/browserVaults";
import type { HomeAssetRef } from "../components/host-browser/homeAssets";
import { InviteLinkDialog } from "../components/teams/InviteLinkDialog";
import { VaultCopyDialog } from "../components/teams/VaultCopyDialog";
import type {
  MyCredentialsApi,
  VaultCopyDraft,
} from "../components/host-browser/useHostBrowser";
import { isTeamVaultId, PERSONAL_VAULT_ID } from "../store/utils";
import { listTeamSavedCredentials } from "../services/desktop/settings";
import { HostDrawer, type HostDrawerHandle } from "../components/HostDrawer";
import { HostEditSwitchConfirmDialog } from "../components/HostEditSwitchConfirmDialog";
import { LogoutConfirmDialog } from "../components/LogoutConfirmDialog";
import { isLocalOnlyAuthState } from "../lib/local-only";
import {
  DolgateImportDialog,
  HostExportDialog,
} from "../components/HostTransferDialogs";
import {
  changeVaultPassphrase,
  resetVault,
} from "../services/desktop/auth-window-updater";
import { getJumpHostCandidates } from "../components/HostForm";
import { LogsPanel } from "../components/LogsPanel";
import { OpenSshImportDialog } from "../components/OpenSshImportDialog";
import { PortForwardingPanel } from "../components/PortForwardingPanel";
import { SnippetsPanel } from "../components/SnippetsPanel";
import type { SecretEditDialogRequest } from "../components/SecretEditDialog";
import { SettingsPanel } from "../components/SettingsPanel";
import { BOOTSTRAP_TERMINAL_SIZE } from "../components/terminal-resize";
import { TermiusImportDialog } from "../components/TermiusImportDialog";
import { WarpgateImportDialog } from "../components/WarpgateImportDialog";
import { XshellImportDialog } from "../components/XshellImportDialog";
import { cn } from "../lib/cn";
import { countActivePortForwardEntries } from "../lib/port-forward-status";
import {
  buildQuickSshHostLabel,
  findExistingQuickSshHost,
  type ParsedQuickSshCommand,
} from "@shared";
import { ArrowLeft } from "../ui/icons";
import type { useLoginController } from "../controllers/useLoginController";
import { useSettingsViewModel } from "../view-models/appViewModels";
import { openSessionReplay } from "../services/desktop/session-replays";
import type {
  useAppModalViewModel,
  useContainersViewModel,
  useHomeViewModel,
} from "../view-models/appViewModels";
import {
  buildXshellImportStatusMessage,
  findHost,
  toLinkedHostSummary,
} from "./appShellUtils";
import { OfflineModeBanner } from "./OfflineModeBanner";
import { useTranslation } from "react-i18next";

// 팀 자격 증명을 읽는 동안 새 호스트 서랍에 주는 빈 목록. 렌더마다 새 배열이면 폼의 효과가 매번 다시 돈다.
const NO_KEYCHAIN_ENTRIES: SecretMetadataRecord[] = [];

interface HomeShellProps {
  active: boolean;
  /**
   * 세션이 없을 수 있다 — 계정 없이 이 기기에서만 쓰는 상태(`local-only`)가 그렇다.
   * 계정 정보를 읽는 자리는 없을 때를 다뤄야 한다.
   */
  authState: AuthState;
  offlineLeaseExpiryLabel: string | null;
  desktopPlatform: "darwin" | "win32" | "linux" | "unknown";
  homeViewModel: ReturnType<typeof useHomeViewModel>;
  containersViewModel: ReturnType<typeof useContainersViewModel>;
  modalViewModel: ReturnType<typeof useAppModalViewModel>;
  loginController: ReturnType<typeof useLoginController>;
  /** 로그인 창을 연다. 창은 셸이 하나만 띄운다 — 자리마다 만들면 로그인 판이 복제된다. */
  onRequestLogin: () => void;
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
  onRequestLogin,
  onRequestSecretEditor,
}: HomeShellProps) {
  const { t: translate } = useTranslation();
  const settingsViewModel = useSettingsViewModel();
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "connection">(
    "overview",
  );
  const [isAwsImportOpen, setIsAwsImportOpen] = useState(false);
  const [isDolgateImportOpen, setIsDolgateImportOpen] = useState(false);
  const [exportAssets, setExportAssets] = useState<HomeAssetRef[] | null>(null);
  // 내보내기 대화상자에 넘기는 id 배열은 **동일성이 안정해야 한다.** 렌더마다 새로 만들면
  // 대화상자의 미리보기 효과가 매번 다시 돌아 IPC(전체 state 복제 + 번들 빌드)를 반복하고,
  // 입력 중인 암호까지 지워졌다(HostExportDialog 의 초기화 효과 주석 참고).
  const exportHostIds = useMemo(
    () =>
      exportAssets
        ?.filter((asset) => asset.kind === "host")
        .map((asset) => asset.id) ?? [],
    [exportAssets],
  );
  const exportWorkspaceIds = useMemo(
    () =>
      exportAssets
        ?.filter((asset) => asset.kind === "workspace")
        .map((asset) => asset.id) ?? [],
    [exportAssets],
  );
  const [isOpenSshImportOpen, setIsOpenSshImportOpen] = useState(false);
  const [isXshellImportOpen, setIsXshellImportOpen] = useState(false);
  const [isTermiusImportOpen, setIsTermiusImportOpen] = useState(false);
  const [isWarpgateImportOpen, setIsWarpgateImportOpen] = useState(false);
  const [hostBrowserError, setHostBrowserError] = useState<string | null>(null);
  const [hostBrowserStatus, setHostBrowserStatus] = useState<string | null>(
    null,
  );
  /** 볼트 줄 메뉴에서 연 초대 링크 창의 팀. */
  const [inviteTeamId, setInviteTeamId] = useState<string | null>(null);
  /** 다른 볼트에 놓았거나 줄 메뉴의 공유로 연 복사 확인 창. */
  const [vaultCopyDraft, setVaultCopyDraft] = useState<VaultCopyDraft | null>(null);
  // 팀 호스트의 내 자격 증명 — 상세 칸이 읽고 쓴다. 같은 객체를 넘겨야 칸이 렌더마다 다시 읽지 않는다.
  const myCredentialsApi = useMemo<MyCredentialsApi>(
    () => ({
      load: homeViewModel.getMyHostCredentials,
      save: homeViewModel.saveMyHostCredentials,
      clear: homeViewModel.clearMyHostCredentials,
    }),
    [
      homeViewModel.clearMyHostCredentials,
      homeViewModel.getMyHostCredentials,
      homeViewModel.saveMyHostCredentials,
    ],
  );
  // 사이드바 맨 윗단의 볼트들. 팀이 없으면 비어 있고 홈은 지금 화면 그대로다.
  const browserVaults = useMemo(
    () =>
      buildBrowserVaults({
        hosts: homeViewModel.hosts,
        groups: homeViewModel.groups,
        savedWorkspaces: homeViewModel.savedWorkspaces ?? [],
        vaultIndex: homeViewModel.vaultIndex,
        personalName: translate("sidebar.personalVault"),
      }),
    [
      homeViewModel.groups,
      homeViewModel.hosts,
      homeViewModel.savedWorkspaces,
      homeViewModel.vaultIndex,
      translate,
    ],
  );
  // 지금 위치가 팀 볼트면 그 팀 id. 새 호스트(빠른 연결 포함)는 그 팀에 만들고, 가져오기는 개인 맨 위로 보낸다
  // (가져오기는 비밀값까지 개인 볼트에 쓰는 길이라 팀으로 보내지 않는다).
  const teamVaultId =
    typeof homeViewModel.currentVaultId === "string" &&
    isTeamVaultId(homeViewModel.currentVaultId)
      ? homeViewModel.currentVaultId
      : null;
  const importGroupPath = teamVaultId ? null : homeViewModel.currentGroupPath;
  const inviteTeam = inviteTeamId
    ? (browserVaults.find((vault) => vault.id === inviteTeamId) ?? null)
    : null;

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
    if (!active || homeViewModel.homeSection !== "hosts") {
      return;
    }
    function handleSearchShortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "k" || event.key === "K")
      ) {
        const input = document.getElementById("host-search");
        if (input instanceof HTMLInputElement) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      }
    }
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [active, homeViewModel.homeSection]);

  const editingHostId =
    homeViewModel.hostDrawer.mode === "edit"
      ? homeViewModel.hostDrawer.hostId
      : null;
  const editedHost = findHost(homeViewModel.hosts, editingHostId);
  /**
   * 편집기에 넘길 호스트. 공유 폴더만 **이 기기의 값**으로 갈아 끼운다.
   *
   * 드라이브는 기기 로컬 설정이지만(경로가 이 기기의 것이다) 편집 화면은 호스트 하나만 받는
   * 프롭 컴포넌트다. 폼에 설정을 따로 흘려보내는 대신 여기서 한 번 바꿔 주면, 폼은 예전과 똑같이
   * `host.drives` 만 보면 된다 — 저장은 아래 onSubmit 이 레코드가 아니라 설정으로 보낸다.
   */
  const currentHost = useMemo(() => {
    if (!editedHost || !isRdpHostRecord(editedHost)) {
      return editedHost;
    }
    return {
      ...editedHost,
      drives: resolveHostDrives(
        editedHost.id,
        settingsViewModel.settings.rdpDrivesByHostId,
        editedHost.drives,
      ),
    };
  }, [editedHost, settingsViewModel.settings.rdpDrivesByHostId]);
  const hostDrawerRef = useRef<HostDrawerHandle | null>(null);
  /**
   * 편집기를 떠나려는 동작. 저장하지 않은 변경이 있어서 확인을 기다리는 동안만 값이 있다.
   *
   * 떠나는 경로는 하나가 아니다 — 다른 호스트 선택, 그룹 이동, All Hosts 복귀, 섹션 이동. 각
   * 경로마다 따로 막으면 하나를 빠뜨리고, 빠뜨린 곳에서 편집 내용이 조용히 사라진다.
   */
  const [pendingEditorExit, setPendingEditorExit] = useState<{
    run: () => void;
  } | null>(null);
  const [isEditorExitSaving, setIsEditorExitSaving] = useState(false);
  const [editorExitError, setEditorExitError] = useState<string | null>(null);
  // 서랍의 볼트 — 만들 때는 서랍이 연 볼트, 고칠 때는 그 호스트가 든 볼트. 고르기(그룹·점프·자격 증명·AWS·
  // tailnet·스니펫)는 그 볼트 것만 보인다. 팀이 없으면 null 이고 고르기는 지금 그대로다.
  const drawerVault = useMemo(() => {
    if (browserVaults.length === 0) {
      return null;
    }
    const drawer = homeViewModel.hostDrawer;
    const vaultId =
      drawer.mode === "create"
        ? drawer.vaultId
        : drawer.mode === "edit"
          ? (browserVaults.find((vault) =>
              vault.hosts.some((host) => host.id === drawer.hostId),
            )?.id ?? PERSONAL_VAULT_ID)
          : PERSONAL_VAULT_ID;
    return browserVaults.find((vault) => vault.id === vaultId) ?? null;
  }, [browserVaults, homeViewModel.hostDrawer]);
  const drawerTeamId = drawerVault?.kind === "team" ? drawerVault.id : null;
  // 새 호스트 서랍 맨 위 Vault 의 후보. 다시 들어와야 하는 팀에는 만들 수 없다(볼트 줄 메뉴와 같다). 지금 고른 볼트는
  // 그래도 둔다 — 빠지면 고르기가 빈칸으로 보인다.
  const createVaultChoices = useMemo(() => {
    const drawer = homeViewModel.hostDrawer;
    const chosenVaultId = drawer.mode === "create" ? drawer.vaultId : null;
    return browserVaults
      .filter((vault) => vault.blocked !== "needs-rejoin" || vault.id === chosenVaultId)
      .map((vault) => ({
        id: vault.id,
        team: vault.kind === "team" ? { id: vault.id, name: vault.name } : null,
      }));
  }, [browserVaults, homeViewModel.hostDrawer]);
  const groupOptions = useMemo(
    () =>
      buildGroupOptions(
        drawerVault ? drawerVault.groups : homeViewModel.groups,
        drawerVault ? drawerVault.hosts : homeViewModel.hosts,
        [
          currentHost?.groupName,
          homeViewModel.hostDrawer.mode === "create"
            ? homeViewModel.hostDrawer.defaultGroupPath
            : homeViewModel.currentGroupPath,
        ],
      ),
    [
      currentHost?.groupName,
      drawerVault,
      homeViewModel.currentGroupPath,
      homeViewModel.groups,
      homeViewModel.hostDrawer,
      homeViewModel.hosts,
    ],
  );
  const jumpHostOptions = useMemo(
    () =>
      getJumpHostCandidates(
        drawerVault ? drawerVault.hosts : homeViewModel.hosts,
        currentHost?.id ?? null,
      ),
    [drawerVault, homeViewModel.hosts, currentHost?.id],
  );
  // 시작 스니펫도 그 볼트 것만. 볼트 표에 없는 스니펫은 개인 것이다.
  const drawerSnippets = useMemo(() => {
    if (!drawerVault) {
      return homeViewModel.snippets;
    }
    const teamIdBySnippetId = homeViewModel.vaultIndex?.teamIdBySnippetId ?? {};
    return (homeViewModel.snippets ?? []).filter(
      (snippet) =>
        (teamIdBySnippetId[snippet.id] ?? PERSONAL_VAULT_ID) === drawerVault.id,
    );
  }, [drawerVault, homeViewModel.snippets, homeViewModel.vaultIndex]);
  // 팀 호스트의 저장된 자격 증명은 그 팀 볼트에 있다 — 서랍이 열릴 때 읽는다. 개인은 스토어 목록 그대로.
  // 어느 팀 것인지 함께 둔다. 다 읽기 전에는 서랍을 띄우지 않는다(아래 hostEditor).
  const [teamKeychain, setTeamKeychain] = useState<{
    teamId: string;
    entries: SecretMetadataRecord[];
  } | null>(null);
  const isDrawerOpen =
    active &&
    homeViewModel.homeSection === "hosts" &&
    homeViewModel.hostDrawer.mode !== "closed";

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
      const tailnetId = "tailnetId" in host ? host.tailnetId?.trim() : "";
      if (!tailnetId) {
        continue;
      }
      names[host.id] =
        tailnetOptions.find((option) => option.id === tailnetId)?.label ??
        tailnetId;
    }
    return names;
  }, [homeViewModel.hosts, tailnetOptions]);
  // 드로어가 열릴 때, 그리고 폼 안의 팝업에서 tailnet 을 추가한 직후에 다시 읽는다.
  //
  // 마운트에 한 번만 읽으면 안 되는 이유는 아래 useEffect 주석에 있고, **드로어 열림에만
  // 걸어도 부족하다** — 팝업은 드로어가 이미 열린 상태에서 뜨므로 그 조건이 다시 참이 되지
  // 않는다. 추가한 tailnet 이 목록에 없으면 폼이 "이 기기에 없는 tailnet" 으로 표시한다.
  const refreshTailnetOptions = useCallback(
    async (isCancelled?: () => boolean) => {
      // Promise 로 감싸는 이유: 브리지가 없으면 listTailnets 가 동기적으로 던지고, 그러면
      // .catch 가 잡지 못해 셸 전체가 죽는다. tailnet 을 못 읽는 것이 호스트 편집을 막을
      // 이유는 없다. 팀 호스트면 그 팀의 tailnet 을 읽는다.
      await Promise.resolve()
        .then(() => (drawerTeamId ? listTeamTailnets(drawerTeamId) : listTailnets()))
        .then((records) => {
          if (isCancelled?.()) {
            return;
          }
          setTailnetOptions(
            records.map((record) => ({ id: record.id, label: record.label })),
          );
        })
        .catch(() => {
          // tailnet 을 못 읽어도 호스트 편집 자체는 되어야 한다.
        });
    },
    [drawerTeamId],
  );

  useEffect(() => {
    if (!isDrawerOpen) {
      return;
    }
    let cancelled = false;
    void refreshTailnetOptions(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isDrawerOpen, refreshTailnetOptions]);

  // 브리지가 없으면 동기적으로 던진다 — 못 읽어도 호스트 편집은 되어야 하니 빈 목록으로 연다(tailnet 과 같다).
  const readTeamKeychain = useCallback(
    (teamId: string) =>
      Promise.resolve()
        .then(() => listTeamSavedCredentials(teamId))
        .catch((): SecretMetadataRecord[] => []),
    [],
  );
  useEffect(() => {
    setTeamKeychain(null);
    if (!isDrawerOpen || !drawerTeamId) {
      return;
    }
    let cancelled = false;
    void readTeamKeychain(drawerTeamId).then((entries) => {
      if (!cancelled) {
        setTeamKeychain({ teamId: drawerTeamId, entries });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [drawerTeamId, isDrawerOpen, readTeamKeychain]);
  const highlightedHostId = editingHostId ?? selectedHostId;
  const sectionTitle =
    homeViewModel.homeSection === "portForwarding"
      ? "Port Forwarding"
      : homeViewModel.homeSection === "snippets"
        ? "Snippets"
        : homeViewModel.homeSection === "logs"
          ? "Logs"
          : "Settings";

  function resetHostBrowserMessages() {
    setHostBrowserError(null);
    setHostBrowserStatus(null);
  }

  function handleHostViewModeChange(mode: HomeHostViewMode) {
    void settingsViewModel
      .updateSettings({ homeHostViewMode: mode })
      .catch((error) => {
        setHostBrowserError(
          error instanceof Error
            ? error.message
            : translate("home.error.layoutSaveFailed"),
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

    const draft: Extract<HostDraft, { kind: "ssh" }> = {
      kind: "ssh",
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
      authType: "password",
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

    const created = teamVaultId
      ? await homeViewModel.saveHost(null, draft, undefined, teamVaultId)
      : await homeViewModel.saveHost(null, draft);
    homeViewModel.closeHostDrawer();
    setSelectedHostId(created.id);
    setHostBrowserStatus(`Saved ${created.label}. Connecting...`);
    await homeViewModel.connectHost(created.id, 120, 32);
  }

  function buildMovedGroupPath(
    path: string,
    targetParentPath: string | null,
  ): string | null {
    const normalizedPath = normalizeGroupPath(path);
    if (!normalizedPath) {
      return null;
    }
    const normalizedTargetParentPath = normalizeGroupPath(targetParentPath);
    return normalizeGroupPath(
      normalizedTargetParentPath
        ? `${normalizedTargetParentPath}/${getGroupLabel(normalizedPath)}`
        : getGroupLabel(normalizedPath),
    );
  }

  function buildRenamedGroupPath(path: string, name: string): string | null {
    const normalizedPath = normalizeGroupPath(path);
    if (!normalizedPath) {
      return null;
    }
    const parentPath = getParentGroupPath(normalizedPath);
    return normalizeGroupPath(
      parentPath ? `${parentPath}/${name.trim()}` : name.trim(),
    );
  }

  function handleSelectHost(hostId: string) {
    resetHostBrowserMessages();
    setSelectedHostId(hostId);
  }

  /** 편집 대상을 이 호스트로 옮긴다. 목록 하이라이트는 selectedHostId 를 따라온다. */
  function switchEditTargetTo(hostId: string) {
    resetHostBrowserMessages();
    setSelectedHostId(hostId);
    homeViewModel.openEditHostDrawer(hostId);
  }

  /**
   * 편집기를 떠나는 동작을 감싼다. 저장하지 않은 변경이 있으면 먼저 묻고, 없으면 그냥 실행한다.
   *
   * 반환값은 "지금 실행했는가" 다 — 호출부(선택 veto)가 내부 상태를 움직여도 되는지 판단한다.
   */
  function guardEditorExit(run: () => void): boolean {
    if (
      homeViewModel.hostDrawer.mode === "closed" ||
      !hostDrawerRef.current?.isDirty()
    ) {
      run();
      return true;
    }
    setPendingEditorExit({ run });
    setEditorExitError(null);
    return false;
  }

  /**
   * 편집 중에 목록에서 다른 호스트를 고를 수 있는가.
   *
   * 예전에는 편집 중 선택을 무시했는데, 무시한 쪽이 절반이었다 — 목록 하이라이트(HostBrowser 내부
   * 상태)는 움직이고 우측이 쓰는 selectedHostId 는 그대로여서, 편집을 닫으면 센터와 우측이 다른
   * 호스트를 가리켰다. 이제 편집 대상을 그 호스트로 갈아탄다(우리는 자동저장이 아니므로, 저장하지
   * 않은 변경이 있으면 먼저 묻는다).
   */
  function canSelectHostWhileEditing(
    hostId: string,
    options?: { reason?: "click" | "menu" },
  ): boolean {
    if (homeViewModel.hostDrawer.mode === "closed") {
      return true;
    }
    if (hostId === editingHostId) {
      return true;
    }
    // 우클릭은 메뉴를 열려는 동작이다. 그것 때문에 "저장하시겠습니까" 가 뜨면 메뉴를 한 번 열려고
    // 편집 흐름을 끊게 된다 — 편집 중에는 선택을 옮기지 않고 조용히 넘긴다(메뉴 대상 표시가
    // 무엇에 걸리는지 알려 준다).
    if (options?.reason === "menu") {
      return false;
    }
    guardEditorExit(() => switchEditTargetTo(hostId));
    // 선택은 selectedHostId 로 옮긴다(가드가 통과했으면 이미 옮겼다). 내부 상태까지 여기서 또
    // 움직이면 경로가 둘이 되고, 확인 대기 중에는 하이라이트만 먼저 튄다.
    return false;
  }

  /**
   * 호스트가 아닌 항목(Workspace)을 고르려면 편집기를 떠나야 한다.
   *
   * canSelectHostWhileEditing 의 짝이고, onLeaveGroupScope 와 같은 "이어서 실행" 모양이다 —
   * 막기만 하면 확인을 받은 뒤 선택을 다시 실행할 주체가 없어 편집기만 닫히고 클릭이 사라진다.
   * 우클릭(menu)은 아무것도 부르지 않는다: 메뉴 한 번 열려고 편집 흐름을 끊지 않는다.
   */
  function onLeaveHostEditorForAsset(
    proceed: () => void,
    options?: { reason?: "click" | "menu" },
  ): void {
    if (homeViewModel.hostDrawer.mode === "closed") {
      proceed();
      return;
    }
    if (options?.reason === "menu") {
      return;
    }
    guardEditorExit(() => {
      setSelectedHostId(null);
      homeViewModel.closeHostDrawer();
      proceed();
    });
  }

  /**
   * 복사가 끝나면 복사본이 있는 곳을 보여 준다 — 그 볼트의 놓은 그룹(그룹 하나를 복사했으면 복사된 그룹)으로 가서
   * 첫 복사본을 고른다. 편집 중이면 떠나기 전에 묻는다(다른 이동과 같다).
   */
  function showVaultCopies(request: VaultCopyRequest, result: VaultCopyResult) {
    const { selection } = request;
    const groupPath =
      selection.kind === "groups" && selection.groupPaths.length === 1
        ? [request.targetGroupPath, getGroupLabel(selection.groupPaths[0]!)]
            .filter(Boolean)
            .join("/")
        : (request.targetGroupPath ?? "");
    // 워크스페이스를 복사했으면 그 자리로만 간다 — 따라온 호스트를 고르면 무엇을 복사했는지 헷갈린다.
    const firstHostId =
      selection.kind === "hosts"
        ? result.hostIds[selection.hostIds[0] ?? ""]
        : selection.kind === "workspaces"
          ? undefined
          : Object.values(result.hostIds)[0];
    guardEditorExit(() => {
      homeViewModel.closeHostDrawer();
      resetHostBrowserMessages();
      homeViewModel.navigateGroup(groupPath || null, request.targetVaultId);
      setSelectedHostId(firstHostId ?? null);
    });
  }

  function handleEditHost(hostId: string) {
    guardEditorExit(() => switchEditTargetTo(hostId));
  }

  function openHostSecretEditor(secretRef: string) {
    if (!currentHost || !isSshHostRecord(currentHost)) {
      return;
    }
    // 팀 호스트의 자격 증명은 그 팀 목록에 있다(서랍이 읽은 것). 메인이 그 볼트에서 읽고 고친다.
    const entry = (drawerKeychainEntries ?? settingsViewModel.keychainEntries).find(
      (item) => item.secretRef === secretRef,
    );
    onRequestSecretEditor({
      source: "host",
      secretRef,
      label: entry?.label ?? currentHost.label,
      linkedHosts: homeViewModel.hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: "clone-for-host",
      initialHostId: currentHost.id,
    });
  }

  function openKeychainSecretEditor(secretRef: string, teamEntry?: SecretMetadataRecord) {
    // 팀 것은 설정 화면이 항목을 함께 준다 — 개인 목록(스토어)에는 없다.
    const entry =
      teamEntry ??
      settingsViewModel.keychainEntries.find((item) => item.secretRef === secretRef);
    if (!entry) {
      return;
    }
    onRequestSecretEditor({
      source: "keychain",
      secretRef,
      label: entry.label,
      linkedHosts: homeViewModel.hosts
        .filter(isSshHostRecord)
        .filter((host) => getHostSecretRef(host) === secretRef)
        .map(toLinkedHostSummary),
      initialMode: "update-shared",
      initialHostId: null,
    });
  }

  async function handleRemoveSecret(secretRef: string, teamEntry?: SecretMetadataRecord) {
    const entry =
      teamEntry ??
      settingsViewModel.keychainEntries.find((item) => item.secretRef === secretRef);
    const linkedHostCount = entry?.linkedHostCount ?? 0;
    const confirmed = window.confirm(
      linkedHostCount > 0
        ? translate("home.secret.deleteLinked", { count: linkedHostCount })
        : translate("home.secret.delete"),
    );
    if (!confirmed) {
      return;
    }
    await settingsViewModel.removeKeychainSecrets([secretRef]);
  }

  // 연결된 호스트가 없는 것을 한 번에 지운다. 팀 것은 멤버 모두에게서 지워진다는 것을 함께 묻는다.
  async function handleRemoveUnusedSecrets(
    entries: SecretMetadataRecord[],
    team: { id: string; name: string } | null,
  ) {
    const confirmed = window.confirm(
      team
        ? translate("home.secret.deleteUnusedTeam", { count: entries.length, team: team.name })
        : translate("home.secret.deleteUnused", { count: entries.length }),
    );
    if (!confirmed) {
      return;
    }
    await settingsViewModel.removeKeychainSecrets(entries.map((entry) => entry.secretRef));
  }

  async function handleGenerateAndInstallSshKey(
    hostId: string,
    input: SshKeyGenerateInput,
  ) {
    const host = findHost(homeViewModel.hosts, hostId);
    if (!host || (!isSshHostRecord(host) && !isAwsEc2HostRecord(host))) {
      throw new Error(translate("home.error.sshHostNotFound"));
    }
    // EC2는 SSH-over-SSM(EIC)로 접속해 설치만 한다 — 매 연결 임시 키를 쓰므로
    // "이 키로 접속 전환"이 없다.
    const isEc2 = isAwsEc2HostRecord(host);
    const key = await settingsViewModel.generateSshKey(input);
    const result = await settingsViewModel.installSshPublicKey({
      secretRef: key.secretRef,
      hostIds: [host.id],
      mode: isEc2 ? "installOnly" : "installAndUse",
      passphraseOverride:
        input.passphrase && !input.savePassphrase
          ? input.passphrase
          : undefined,
    });
    const failed = result.results.find((entry) => entry.status === "failed");
    if (failed) {
      throw new Error(
        failed.message ?? translate("home.error.keyInstallFailed"),
      );
    }
    setHostBrowserStatus(
      isEc2
        ? translate("home.key.installedAuthorizedKeys", { label: host.label })
        : translate("home.key.switched", { label: host.label }),
    );
  }

  const drawerKeychainEntries = drawerTeamId
    ? teamKeychain?.teamId === drawerTeamId
      ? teamKeychain.entries
      : null
    : settingsViewModel.keychainEntries;
  // 호스트 편집/생성 폼은 별도 오버레이가 아니라 우측 상세 영역(HostBrowser aside) 안에 표시한다.
  // 팀 호스트는 그 팀의 자격 증명을 다 읽은 뒤에 띄운다. 폼은 고른 자격 증명이 목록에 없으면 "새 자격 증명"으로
  // 되돌리므로, 빈 목록으로 먼저 뜨면 저장된 팀 비밀번호가 풀린 채로 보이고 그대로 저장하면 호스트에서 떨어진다.
  // 만들 때는 기다리지 않는다 — 풀릴 자격 증명이 없고, 서랍 맨 위에서 볼트를 바꿀 때마다 서랍이 내려갔다 뜨면
  // 적어 둔 것이 사라진다. 다 읽으면 고를 목록이 채워진다.
  const hostEditorKeychainEntries =
    drawerKeychainEntries ??
    (homeViewModel.hostDrawer.mode === "create" ? NO_KEYCHAIN_ENTRIES : null);
  const hostEditor = isDrawerOpen && hostEditorKeychainEntries ? (
    <HostDrawer
      ref={hostDrawerRef}
      open={isDrawerOpen}
      mode={homeViewModel.hostDrawer.mode === "create" ? "create" : "edit"}
      host={currentHost}
      keychainEntries={hostEditorKeychainEntries}
      groupOptions={groupOptions}
      jumpHostOptions={jumpHostOptions}
      jumpHostTailnetNames={jumpHostTailnetNames}
      tailnetOptions={tailnetOptions}
      snippets={drawerSnippets}
      vaultId={drawerTeamId}
      vaultChoices={createVaultChoices}
      onVaultChange={homeViewModel.setCreateHostVault}
      defaultGroupPath={
        homeViewModel.hostDrawer.mode === "create"
          ? homeViewModel.hostDrawer.defaultGroupPath
          : homeViewModel.currentGroupPath
      }
      createKind={
        homeViewModel.hostDrawer.mode === "create"
          ? homeViewModel.hostDrawer.kind
          : "ssh"
      }
      desktopPlatform={desktopPlatform}
      // 서버가 계정 데이터 수준을 저장할 수 있을 때만 RDP 를 만들 수 있다(HostDrawer 주석 참고).
      // 계정 없이 쓰는 동안에는 이 게이트를 끈다. 게이트가 막는 위험은 "같은 계정의 옛 기기가
      // 그 레코드를 받고 망가진다" 인데, 그때는 계정도 다른 기기도 없다 — 막을 대상이 없다.
      // 흡수할 때 다시 볼 필요도 없다: 1.9.0 미만 서버는 로그인 자체가 막히므로 로그인된
      // 계정은 언제나 데이터 수준을 판정하는 서버다.
      serverSupportsDataFloor={
        isLocalOnlyAuthState(authState) ||
        authState.capabilities?.dataFloor === true
      }
      onClose={homeViewModel.closeHostDrawer}
      onSubmit={async (draft, secrets) => {
        const isEdit = homeViewModel.hostDrawer.mode === "edit";
        // 공유 폴더는 **레코드로 내보내지 않는다.** 경로가 이 기기의 것이라 동기화되면 다른
        // 기기에서 열 수 없는 값이 된다(모니터 세부 선택과 같은 이유). 저장한 뒤 그 호스트의
        // 기기 로컬 설정에 넣는다 — 새로 만든 경우에도 id 는 저장이 끝나야 나온다.
        const { draft: outgoing, drives } = detachHostDrives(draft);
        // 만들 때는 서랍이 연 볼트에 만든다(팀 볼트 안이나 볼트 줄 메뉴). 개인은 지금처럼 부른다.
        const createVaultId =
          homeViewModel.hostDrawer.mode === "create" &&
          isTeamVaultId(homeViewModel.hostDrawer.vaultId)
            ? homeViewModel.hostDrawer.vaultId
            : null;
        const saved = createVaultId
          ? await homeViewModel.saveHost(null, outgoing, secrets, createVaultId)
          : await homeViewModel.saveHost(
              isEdit ? (currentHost?.id ?? null) : null,
              outgoing,
              secrets,
            );
        // 팀 호스트에 새 비밀번호를 넣었으면 그 팀 목록에 새 항목이 생긴다. 폼은 저장이 끝나면 호스트를 다시 채우는데
        // 그때 목록에 없으면 위와 같이 풀린다 — 끝나기 전에 다시 읽어 둔다(개인은 saveHost 가 스토어 목록을 다시 읽는다).
        if (isEdit && drawerTeamId) {
          const entries = await readTeamKeychain(drawerTeamId);
          setTeamKeychain({ teamId: drawerTeamId, entries });
        }
        if (drives !== null) {
          await settingsViewModel.updateSettings({
            rdpDrivesByHostId: withHostDrives(
              settingsViewModel.settings.rdpDrivesByHostId,
              saved.id,
              drives,
            ),
          });
        }
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
      // 편집 창은 개인 자격 증명만 읽고 고친다 — 팀 자격 증명에서는 편집을 숨긴다.
      onEditExistingSecret={openHostSecretEditor}
      // 폼 안에서 tailnet 을 추가하면 지금은 개인 볼트에 생긴다 — 팀 호스트 서랍에서는 추가를 숨긴다(팀에 만드는
      // 길은 설정에서 볼트를 고르는 화면).
      onTailnetAdded={() => refreshTailnetOptions()}
    />
  ) : null;

  return (
    <section
      className={cn(
        "absolute inset-0 flex min-h-0 flex-col transition-[opacity,transform] duration-180",
        active
          ? "pointer-events-auto opacity-100 scale-100"
          : "pointer-events-none opacity-0 scale-[0.995]",
      )}
    >
      {authState.status === "offline-authenticated" && authState.offline ? (
        <OfflineModeBanner
          expiryLabel={offlineLeaseExpiryLabel}
          isRetrying={loginController.isRetryingOnline}
          onRetry={() => {
            void loginController.retryOnline();
          }}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        {homeViewModel.homeSection === "hosts" ? (
          <HostBrowser
            active={active}
            hostEditor={hostEditor}
            savedWorkspaces={homeViewModel.savedWorkspaces}
            workspaceActivityLogs={settingsViewModel.activityLogs}
            onOpenSavedWorkspace={(workspaceId) =>
              homeViewModel.openSavedWorkspace(
                workspaceId,
                BOOTSTRAP_TERMINAL_SIZE.cols,
                BOOTSTRAP_TERMINAL_SIZE.rows,
              )
            }
            onRenameSavedWorkspace={homeViewModel.renameSavedWorkspace}
            onDuplicateSavedWorkspace={homeViewModel.duplicateSavedWorkspace}
            onSetSavedWorkspaceFavorite={
              homeViewModel.setSavedWorkspaceFavorite
            }
            onRemoveSavedWorkspace={homeViewModel.removeSavedWorkspace}
            tmuxPrefixKey={settingsViewModel.settings.tmuxPrefixKey}
            activePortForwardEntryCount={countActivePortForwardEntries(
              homeViewModel.portForwardRuntimes,
              homeViewModel.dnsOverrides,
            )}
            desktopPlatform={desktopPlatform}
            hosts={homeViewModel.hosts}
            groups={homeViewModel.groups}
            vaults={browserVaults}
            currentVaultId={homeViewModel.currentVaultId}
            keychainEntries={settingsViewModel.keychainEntries}
            currentGroupPath={homeViewModel.currentGroupPath}
            searchQuery={homeViewModel.searchQuery}
            hostViewMode={settingsViewModel.settings.homeHostViewMode ?? "grid"}
            selectedHostId={highlightedHostId}
            errorMessage={hostBrowserError}
            statusMessage={hostBrowserStatus}
            onSearchChange={homeViewModel.setSearchQuery}
            onHostViewModeChange={handleHostViewModeChange}
            onOpenLocalTerminal={() => guardEditorExit(() => {
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
                      : translate("home.error.localTerminalFailed"),
                  );
                });
            })}
            onCreateHost={() => guardEditorExit(() => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              homeViewModel.openCreateHostDrawer();
            })}
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
            onExportAssets={(assets) => {
              resetHostBrowserMessages();
              setExportAssets(assets);
            }}
            onCreateGroup={homeViewModel.createGroup}
            onRemoveGroup={homeViewModel.removeGroup}
            onReorderGroup={async (
              path,
              targetParentPath,
              targetIndex,
              vaultId,
            ) => {
              resetHostBrowserMessages();
              try {
                // 팀 그룹일 때만 볼트가 온다. 개인은 지금처럼 부른다.
                await (vaultId
                  ? homeViewModel.reorderGroup(
                      path,
                      targetParentPath,
                      targetIndex,
                      vaultId,
                    )
                  : homeViewModel.reorderGroup(
                      path,
                      targetParentPath,
                      targetIndex,
                    ));
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate("home.group.moveFailed"),
                );
              }
            }}
            onMoveGroup={async (path, targetParentPath, vaultId) => {
              resetHostBrowserMessages();
              try {
                await (vaultId
                  ? homeViewModel.moveGroup(path, targetParentPath, vaultId)
                  : homeViewModel.moveGroup(path, targetParentPath));
                const nextPath = buildMovedGroupPath(path, targetParentPath);
                setHostBrowserStatus(
                  nextPath
                    ? translate("home.group.movedTo", { path: nextPath })
                    : translate("home.group.moved"),
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate("home.error.groupMoveFailed"),
                );
                throw error;
              }
            }}
            onRenameGroup={async (path, name, vaultId) => {
              resetHostBrowserMessages();
              try {
                await (vaultId
                  ? homeViewModel.renameGroup(path, name, vaultId)
                  : homeViewModel.renameGroup(path, name));
                const nextPath = buildRenamedGroupPath(path, name);
                setHostBrowserStatus(
                  nextPath
                    ? translate("home.group.renamedTo", { path: nextPath })
                    : translate("home.group.renamed"),
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate("home.error.groupRenameFailed"),
                );
                throw error;
              }
            }}
            onNavigateGroup={(path, vaultId) => {
              resetHostBrowserMessages();
              setSelectedHostId(null);
              // 볼트는 볼트가 있을 때만 온다(볼트 맨 위·그 볼트의 그룹). 없으면 All 이거나 팀이 없는 것이다.
              if (vaultId) {
                homeViewModel.navigateGroup(path, vaultId);
              } else {
                homeViewModel.navigateGroup(path);
              }
            }}
            onCreateHostInVault={(vaultId) =>
              guardEditorExit(() => {
                resetHostBrowserMessages();
                setSelectedHostId(null);
                homeViewModel.openCreateHostDrawer({ vaultId, groupPath: null });
              })
            }
            onOpenTeamInvite={setInviteTeamId}
            onRequestVaultCopy={setVaultCopyDraft}
            myCredentials={myCredentialsApi}
            myUsernameByHostId={homeViewModel.vaultIndex?.myUsernameByHostId}
            onManageTeam={homeViewModel.showTeamInPanel}
            // 그룹 이동·All Hosts 복귀도 편집기를 떠나는 동작이다. 막기만 하면 확인을 받은 뒤
            // 이동을 다시 실행할 주체가 없어 편집기만 닫힌다 — 이동 자체를 이어서 실행한다.
            onLeaveGroupScope={(proceed) => {
              guardEditorExit(() => {
                homeViewModel.closeHostDrawer();
                proceed();
              });
            }}
            onClearHostSelection={() => {
              setSelectedHostId(null);
            }}
            onSelectHost={handleSelectHost}
            canSelectHost={canSelectHostWhileEditing}
            onLeaveHostEditor={onLeaveHostEditorForAsset}
            onEditHost={handleEditHost}
            onDuplicateHosts={async (hostIds) => {
              resetHostBrowserMessages();
              try {
                await homeViewModel.duplicateHosts(hostIds);
                setHostBrowserStatus(
                  hostIds.length === 1
                    ? "Copied 1 host."
                    : `Copied ${hostIds.length} hosts.`,
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : "Failed to copy the selected hosts.",
                );
              }
            }}
            onMoveHostToGroup={homeViewModel.moveHostToGroup}
            onMoveSavedWorkspaceToGroup={
              homeViewModel.moveSavedWorkspaceToGroup
            }
            onSetHostFavorite={homeViewModel.setHostFavorite}
            onRemoveHosts={homeViewModel.removeHosts}
            onRemoveSecrets={settingsViewModel.removeKeychainSecrets}
            onConnectHost={async (hostId) => {
              try {
                setHostBrowserError(null);
                setSelectedHostId(hostId);
                await homeViewModel.connectHost(hostId, 120, 32);
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate("home.error.connectFailed"),
                );
              }
            }}
            onOpenHostInNewWindow={homeViewModel.openHostInNewWindow}
            onConnectHostTmux={async (hostId) => {
              try {
                setHostBrowserError(null);
                setSelectedHostId(hostId);
                await homeViewModel.connectHost(
                  hostId,
                  120,
                  32,
                  undefined,
                  true,
                );
              } catch (error) {
                setHostBrowserError(
                  error instanceof Error
                    ? error.message
                    : translate("home.error.tmuxFailed"),
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
                    : translate("home.error.containersFailed"),
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
                    : translate("home.error.quickConnectFailed"),
                );
              }
            }}
            onOpenSftp={(hostId) => {
              resetHostBrowserMessages();
              setSelectedHostId(hostId);
              void homeViewModel
                .connectSftpHost("right", hostId)
                .catch((error) => {
                  setHostBrowserError(
                    error instanceof Error
                      ? error.message
                      : translate("home.error.sftpFailed"),
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
                onClick={() => homeViewModel.openHomeSection("hosts")}
                className="group inline-flex items-center gap-[0.4rem] rounded-[10px] border border-[var(--border)] bg-[var(--surface-elevated)] py-[0.5rem] pl-[0.65rem] pr-[0.9rem] text-[0.82rem] font-semibold text-[var(--text-soft)] transition-[color,border-color,background-color] duration-140 hover:border-[color-mix(in_srgb,var(--accent-strong)_38%,var(--border)_62%)] hover:bg-[var(--selection-tint)] hover:text-[var(--accent-strong)]"
              >
                <ArrowLeft
                  className="h-[0.95rem] w-[0.95rem] transition-transform duration-140 group-hover:-translate-x-[2px]"
                  aria-hidden="true"
                />
                Hosts
              </button>
              <h2 className="text-[1rem] font-bold text-[var(--text)]">
                {sectionTitle}
              </h2>
            </div>
            <main className="min-h-0 flex-1 overflow-auto px-[1.1rem] pb-[1.3rem] pt-[1.1rem]">
              {homeViewModel.homeSection === "portForwarding" ? (
                <PortForwardingPanel
                  hosts={homeViewModel.hosts}
                  containerTabs={containersViewModel.containerTabs}
                  rules={homeViewModel.portForwards}
                  dnsOverrides={homeViewModel.dnsOverrides}
                  runtimes={homeViewModel.portForwardRuntimes}
                  interactiveAuth={
                    modalViewModel.pendingInteractiveAuths.find(
                      (auth) => auth.source === "portForward",
                    ) ?? null
                  }
                  discoveryInteractiveAuth={
                    modalViewModel.pendingInteractiveAuths.find(
                      (auth) => auth.source === "containers",
                    ) ?? null
                  }
                  onSave={homeViewModel.savePortForward}
                  onSaveDnsOverride={homeViewModel.saveDnsOverride}
                  onSetStaticDnsOverrideActive={
                    homeViewModel.setStaticDnsOverrideActive
                  }
                  onRemoveDnsOverride={homeViewModel.removeDnsOverride}
                  onRemove={homeViewModel.removePortForward}
                  onStart={homeViewModel.startPortForward}
                  onStop={homeViewModel.stopPortForward}
                  onRespondInteractiveAuth={
                    modalViewModel.respondInteractiveAuth
                  }
                  onReopenInteractiveAuthUrl={
                    modalViewModel.reopenInteractiveAuthUrl
                  }
                  onClearInteractiveAuth={
                    modalViewModel.clearPendingInteractiveAuth
                  }
                />
              ) : null}

              {homeViewModel.homeSection === "snippets" ? (
                <SnippetsPanel
                  snippets={homeViewModel.snippets}
                  hosts={homeViewModel.hosts}
                  vaultIndex={homeViewModel.vaultIndex}
                  onSave={homeViewModel.saveSnippet}
                  onRemove={homeViewModel.removeSnippet}
                />
              ) : null}

              {homeViewModel.homeSection === "logs" ? (
                <LogsPanel
                  logs={settingsViewModel.activityLogs}
                  onClear={settingsViewModel.clearLogs}
                  onOpenReplay={openSessionReplay}
                  teams={homeViewModel.vaultIndex?.teams}
                />
              ) : null}

              {homeViewModel.homeSection === "settings" ? (
                <SettingsPanel
                  activeSection={settingsViewModel.settingsSection}
                  hosts={settingsViewModel.hosts}
                  settings={settingsViewModel.settings}
                  knownHosts={settingsViewModel.knownHosts}
                  keychainEntries={settingsViewModel.keychainEntries}
                  savedCredentialsSearchQuery={
                    settingsViewModel.savedCredentialsSearchQuery
                  }
                  currentUserEmail={authState.session?.user.email ?? null}
                  currentUserId={authState.session?.user.id ?? null}
                  teamsAvailable={settingsViewModel.teamsAvailable}
                  isLocalOnly={isLocalOnlyAuthState(authState)}
                  onStartLogin={async () => onRequestLogin()}
                  passwordState={
                    authState.status === "authenticated"
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
                  onRevokeRdpCertificate={
                    settingsViewModel.revokeRdpCertificateTrust
                  }
                  onRemoveSecret={handleRemoveSecret}
                  onRemoveUnusedSecrets={handleRemoveUnusedSecrets}
                  onEditSecret={openKeychainSecretEditor}
                  onGenerateSshKey={settingsViewModel.generateSshKey}
                  onCopySshPublicKey={settingsViewModel.copySshPublicKey}
                  onInstallSshPublicKey={settingsViewModel.installSshPublicKey}
                  onLoadSessionReplayStorageUsage={
                    settingsViewModel.loadSessionReplayStorageUsage
                  }
                  onLogout={loginController.logout}
                  onDeleteAccount={loginController.deleteAccount}
                  onChangeAccountPassword={
                    loginController.changeAccountPassword
                  }
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
        currentGroupPath={importGroupPath}
        onClose={() => setIsAwsImportOpen(false)}
        onImport={async (draft, secrets) => {
          // RDP 경로는 자격증명(Administrator + 암호)을 함께 만든다. saveHost 가 시크릿까지 받는다.
          await homeViewModel.saveHost(null, draft, secrets);
        }}
      />

      <HostExportDialog
        open={Boolean(exportAssets)}
        hostIds={exportHostIds}
        workspaceIds={exportWorkspaceIds}
        onClose={() => setExportAssets(null)}
        onExported={(result) => {
          setHostBrowserStatus(
            translate("home.transfer.assetsExported", {
              hosts: result.exportedHostCount,
              workspaces: result.exportedWorkspaceCount,
            }) +
              (result.skippedHostCount + result.skippedWorkspaceCount > 0
                ? translate("home.transfer.assetsSkipped", {
                    hosts: result.skippedHostCount,
                    workspaces: result.skippedWorkspaceCount,
                  })
                : "") +
              // 경고는 실패가 아니다. 예전에는 warnings[0] 을 오류 슬롯에 넣어서, 내보내기가
              // 정상 완료됐는데도 빨간 경고 배너(role="alert")가 함께 떴다.
              (result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : ""),
          );
          setHostBrowserError(null);
        }}
      />

      <DolgateImportDialog
        open={isDolgateImportOpen}
        onClose={() => setIsDolgateImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshSyncedWorkspaceData();
          setHostBrowserStatus(
            `${translate("home.transfer.dolgateAssetsImported", {
              hosts: result.importedHostCount,
              workspaces: result.importedWorkspaceCount,
            })}${
              result.skippedCount > 0
                ? translate("home.transfer.dolgateSkipped", {
                    count: result.skippedCount,
                  })
                : ""
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
            `${translate("home.transfer.termiusImported", {
              hosts: result.createdHostCount,
              groups: result.createdGroupCount,
              secrets: result.createdSecretCount,
            })}${
              result.skippedHostCount > 0
                ? translate("home.transfer.termiusSkipped", {
                    count: result.skippedHostCount,
                  })
                : ""
            }`,
          );
          setHostBrowserError(result.warnings[0]?.message ?? null);
        }}
      />

      <OpenSshImportDialog
        open={isOpenSshImportOpen}
        currentGroupPath={importGroupPath}
        onClose={() => setIsOpenSshImportOpen(false)}
        onImported={async (result) => {
          await homeViewModel.refreshHostCatalog();
          setHostBrowserStatus(
            `${translate("home.transfer.opensshImported", { count: result.createdHostCount })}${
              result.createdSecretCount > 0
                ? translate("home.transfer.opensshSecrets", {
                    count: result.createdSecretCount,
                  })
                : ""
            }${
              result.skippedHostCount > 0
                ? translate("home.transfer.skippedHosts", {
                    count: result.skippedHostCount,
                  })
                : ""
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
            `${translate("home.transfer.xshellImported", {
              hosts: result.createdHostCount,
              groups: result.createdGroupCount,
            })}${
              result.skippedHostCount > 0
                ? translate("home.transfer.skippedHosts", {
                    count: result.skippedHostCount,
                  })
                : ""
            }`,
          );
          setHostBrowserError(result.warnings[0]?.message ?? null);
        }}
      />

      <WarpgateImportDialog
        open={isWarpgateImportOpen}
        currentGroupPath={importGroupPath}
        onClose={() => setIsWarpgateImportOpen(false)}
        onImport={async (draft) => {
          await homeViewModel.saveHost(null, draft);
        }}
      />
      {inviteTeam ? (
        <InviteLinkDialog
          teamName={inviteTeam.name}
          onCreate={(expiresInHours) =>
            homeViewModel.createTeamInvite(inviteTeam.id, expiresInHours)
          }
          onClose={() => setInviteTeamId(null)}
        />
      ) : null}
      {vaultCopyDraft ? (
        <VaultCopyDialog
          vaults={browserVaults}
          draft={vaultCopyDraft}
          hostLabelOf={(hostId) =>
            homeViewModel.hosts.find((host) => host.id === hostId)?.label ?? null
          }
          workspaceLabelOf={(workspaceId) =>
            homeViewModel.savedWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null
          }
          onPreview={homeViewModel.previewVaultCopy}
          onListMembers={homeViewModel.listTeamMembers}
          onCopy={async (request) => {
            const result = await homeViewModel.copyToVault(request);
            showVaultCopies(request, result);
          }}
          onClose={() => setVaultCopyDraft(null)}
        />
      ) : null}

      <LogoutConfirmDialog
        open={loginController.isLogoutConfirmOpen}
        onClose={loginController.cancelLogout}
        onConfirm={loginController.confirmLogout}
      />

      <HostEditSwitchConfirmDialog
        open={pendingEditorExit !== null}
        isSaving={isEditorExitSaving}
        errorMessage={editorExitError}
        onCancel={() => {
          setPendingEditorExit(null);
          setEditorExitError(null);
        }}
        onSave={async () => {
          if (!pendingEditorExit) {
            return;
          }
          setIsEditorExitSaving(true);
          setEditorExitError(null);
          try {
            const saved = await hostDrawerRef.current?.save();
            if (!saved) {
              // 저장이 막혔다(필수 칸 등) — 폼이 그 이유를 자기 자리에서 표시하므로 다이얼로그를
              // 닫고 편집 화면에 머문다. 여기서 문구를 또 만들면 같은 말을 두 번 하게 된다.
              setPendingEditorExit(null);
              return;
            }
            const exit = pendingEditorExit;
            setPendingEditorExit(null);
            exit.run();
          } catch (error) {
            setEditorExitError(error instanceof Error ? error.message : null);
          } finally {
            setIsEditorExitSaving(false);
          }
        }}
      />
    </section>
  );
}
