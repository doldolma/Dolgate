import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
  type AppSettings,
  type GroupRecord,
  type HostRecord,
  type TeamRole,
  type VaultIndex,
} from "@shared";
import type { SftpPaneState, SftpState } from "../store/types";
import { createEmptyVaultIndex } from "../store/utils";
import { buildBrowserVaults } from "./host-browser/browserVaults";
import { SftpWorkspace } from "./SftpWorkspace";

// 팀이 있으면 SFTP 호스트 고르기의 맨 위는 볼트 고르기다(홈 사이드바와 같은 층). 지금은 같은 경로 Prod 가 개인과 팀에
// 다 있으면 한 폴더로 합쳐져 두 볼트가 섞였다.

const TEAM = "team-1";

function host(id: string, groupName: string | null): HostRecord {
  return {
    id,
    kind: "ssh",
    label: id,
    hostname: `${id}.example.com`,
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName,
    tags: [],
    terminalThemeId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as HostRecord;
}

const group = (id: string, path: string) =>
  ({ id, name: path.split("/").at(-1), path, parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null }) as GroupRecord;

const hosts = [host("my-web", "Prod"), host("my-db", "Prod/db"), host("team-web", "Prod"), host("team-api", "Bastion")];
const personalGroups = [group("pg-prod", "Prod"), group("pg-db", "Prod/db"), group("pg-home", "Home")];

function vaultIndex(teamRole: TeamRole = "owner"): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      { id: TEAM, name: "Acme Infra", role: teamRole, syncState: "ready", syncError: null, groups: [group("tg-prod", "Prod"), group("tg-bastion", "Bastion")] },
    ],
    teamIdByHostId: { "team-web": TEAM, "team-api": TEAM },
  };
}

const settings = {
  theme: "system",
  rdpMonitorsByHostId: {},
  rdpDrivesByHostId: {},
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  updatedAt: "2026-03-26T00:00:00.000Z",
} as unknown as AppSettings;

function pickerPane(overrides: Partial<SftpPaneState> = {}): SftpPaneState {
  return {
    id: "right",
    sourceKind: "host",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    hostGroupPath: null,
    currentPath: "",
    lastLocalPath: "",
    history: [],
    historyIndex: -1,
    entries: [],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId: null,
    hostSearchQuery: "",
    isLoading: false,
    warningMessages: [],
    ...overrides,
  } as SftpPaneState;
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPicker(
  pane: Partial<SftpPaneState> = {},
  options: {
    teams?: boolean;
    myUsernameByHostId?: Record<string, string>;
    /** 이 팀(Acme Infra)에서 내 역할. */
    teamRole?: TeamRole;
    hosts?: HostRecord[];
    onOpenHostSettings?: (hostId: string) => void;
  } = {},
) {
  const onNavigateHostGroup = vi.fn();
  const paneHosts = options.hosts ?? hosts;
  const vaults = buildBrowserVaults({
    hosts: paneHosts,
    groups: personalGroups,
    savedWorkspaces: [],
    vaultIndex: options.teams === false ? createEmptyVaultIndex() : vaultIndex(options.teamRole),
    personalName: "Personal",
  });
  const sftp = {
    localHomePath: "/Users/tester",
    leftPane: pickerPane({ id: "left", sourceKind: "local", currentPath: "/left" }),
    rightPane: pickerPane(pane),
    transfers: [],
    pendingConflictDialog: null,
    terminalUploadEndpoints: {},
  } as unknown as SftpState;
  const noop = vi.fn().mockResolvedValue(undefined);
  render(
    <SftpWorkspace
      desktopPlatform="darwin"
      hosts={paneHosts}
      groups={personalGroups}
      vaults={vaults}
      myUsernameByHostId={options.myUsernameByHostId}
      sftp={sftp}
      transfers={[]}
      settings={settings}
      interactiveAuths={[]}
      onActivatePaneSource={noop}
      onDisconnectPane={noop}
      onPaneFilterChange={vi.fn()}
      onHostSearchChange={vi.fn()}
      onNavigateHostGroup={onNavigateHostGroup}
      onSelectHost={vi.fn()}
      onConnectHost={noop}
      onOpenHostSettings={options.onOpenHostSettings}
      onOpenEntry={noop}
      onRefreshPane={noop}
      onNavigateBack={noop}
      onNavigateForward={noop}
      onNavigateParent={noop}
      onNavigateBreadcrumb={noop}
      onListLocalRoots={vi.fn().mockResolvedValue([{ label: "/", path: "/" }])}
      onGetPathForDroppedFile={vi.fn()}
      onSelectEntry={vi.fn()}
      onCreateDirectory={noop}
      onRenameSelection={noop}
      onChangeSelectionPermissions={noop}
      onChangeSelectionOwner={noop}
      onDeleteSelection={noop}
      onDownloadSelection={noop}
      onPrepareTransfer={noop}
      onPrepareExternalTransfer={noop}
      onTransferSelectionToPane={noop}
      onResolveConflict={noop}
      onDismissConflict={vi.fn()}
      onCancelTransfer={noop}
      onPauseTransfer={noop}
      onResumeTransfer={noop}
      onRetryTransfer={noop}
      onDismissTransfer={vi.fn()}
      onRespondInteractiveAuth={noop}
      onReopenInteractiveAuthUrl={noop}
      onClearInteractiveAuth={vi.fn()}
      onUpdateSettings={noop}
    />,
  );
  const picker = within(screen.getByLabelText("Available hosts for right pane"));
  const hostCard = (label: string) =>
    picker.getAllByText(label).map((el) => el.closest("article")!).find((card) => !card.hasAttribute("data-group-card"))!;
  return { onNavigateHostGroup, picker, hostCard };
}

describe("SFTP host picker with team vaults", () => {
  it("starts at vault folders instead of merging the same path across vaults", () => {
    const { picker, hostCard } = renderPicker();

    expect(document.querySelector('[data-vault-card="personal"]')!.textContent).toContain("Personal");
    expect(document.querySelector('[data-vault-card="personal"]')!.textContent).toContain("2 hosts");
    expect(document.querySelector(`[data-vault-card="${TEAM}"]`)!.textContent).toContain("Acme Infra");
    expect(document.querySelector(`[data-vault-card="${TEAM}"]`)!.textContent).toContain("2 hosts");
    // 합쳐진 "Prod" 폴더는 없다.
    expect(picker.queryAllByText("Prod").filter((el) => el.closest("[data-group-card]"))).toHaveLength(0);
    // 맨 위의 호스트 목록은 볼트가 섞인 곳이라 팀 것에 "[팀 표시] 팀 이름 / 그룹".
    expect(hostCard("team-web").textContent).toContain("Acme Infra / Prod");
    expect(hostCard("my-web").textContent).not.toContain("Acme Infra");
  });

  it("goes into a vault and back", () => {
    const { onNavigateHostGroup } = renderPicker();

    fireEvent.doubleClick(document.querySelector(`[data-vault-card="${TEAM}"]`)!);
    expect(onNavigateHostGroup).toHaveBeenLastCalledWith("right", null, TEAM);
    fireEvent.keyDown(document.querySelector('[data-vault-card="personal"]')!, { key: "Enter" });
    expect(onNavigateHostGroup).toHaveBeenLastCalledWith("right", null, "personal");
  });

  it("shows only that vault's groups and hosts inside a vault", () => {
    const { picker, onNavigateHostGroup } = renderPicker({ hostVaultId: TEAM });

    const groupCards = [...document.querySelectorAll<HTMLElement>("[data-group-card]")].map((card) => card.querySelector("strong")!.textContent);
    // 개인 그룹(Home 등)은 섞이지 않는다.
    expect(groupCards.sort()).toEqual(["Bastion", "Prod"]);
    expect(picker.queryByText("my-web")).toBeNull();
    expect(picker.getByText("team-web")).toBeInTheDocument();
    // 볼트 안은 다 같은 볼트라 표시를 안 붙인다.
    expect(picker.getByText("team-web").closest("article")!.textContent).not.toContain("Acme Infra");

    const crumbs = within(screen.getByLabelText("Host group path for right pane"));
    expect(crumbs.getByText("Acme Infra")).toBeInTheDocument();
    fireEvent.doubleClick(document.querySelector<HTMLElement>("[data-group-card]")!.closest("article")!);
    expect(onNavigateHostGroup).toHaveBeenLastCalledWith("right", expect.any(String), TEAM);
    fireEvent.click(crumbs.getByRole("button", { name: "All Groups" }));
    expect(onNavigateHostGroup).toHaveBeenLastCalledWith("right", null, null);
  });

  it("keeps the same path apart — personal Prod shows only personal hosts", () => {
    const { picker } = renderPicker({ hostVaultId: "personal", hostGroupPath: "Prod" });

    expect(picker.getByText("my-web")).toBeInTheDocument();
    expect(picker.queryByText("team-web")).toBeNull();
    const crumbs = within(screen.getByLabelText("Host group path for right pane"));
    expect(crumbs.getByRole("button", { name: "Personal" })).toBeInTheDocument();
  });

  it("says my username on a team host card", () => {
    const { picker } = renderPicker({ hostVaultId: TEAM }, { myUsernameByHostId: { "team-web": "deploy" } });

    expect(picker.getByText("team-web").closest("article")!.textContent).toContain("deploy@team-web.example.com");
    expect(picker.getByText("team-api").closest("article")!.textContent).toContain("ubuntu@team-api.example.com");
  });

  it("stays as before without teams", () => {
    const { picker, onNavigateHostGroup } = renderPicker({}, { teams: false });

    expect(document.querySelector("[data-vault-card]")).toBeNull();
    const prod = picker.getAllByText("Prod").map((el) => el.closest("[data-group-card]")).find(Boolean) as HTMLElement;
    fireEvent.doubleClick(prod);
    // 지금처럼 볼트 없이 부른다.
    expect(onNavigateHostGroup).toHaveBeenLastCalledWith("right", "Prod");
  });
});

// 7-3: 읽기 전용(Viewer) 팀의 AWS 호스트가 SFTP 에서 실패하면 다시 시도·복사만 — 설정 고치기(편집 창)는 내밀지 않는다.
describe("SFTP AWS failure card with a read-only team", () => {
  const teamEc2 = {
    ...host("team-api", "Bastion"),
    kind: "aws-ec2",
    awsProfileName: "acme",
    awsRegion: "us-east-1",
    awsInstanceId: "i-0abc",
  } as unknown as HostRecord;
  const ec2Hosts = hosts.map((entry) => (entry.id === "team-api" ? teamEc2 : entry));
  const failed = {
    selectedHostId: "team-api",
    connectionDiagnostic: {
      endpointId: "ep-1",
      hostId: "team-api",
      stage: "connecting",
      message: "no SSH user",
      reasonCode: "missing-username",
    },
  } as unknown as Partial<SftpPaneState>;

  it("offers editing the SSH settings on a team you edit", () => {
    renderPicker(failed, { hosts: ec2Hosts, onOpenHostSettings: vi.fn() });
    expect(screen.getByRole("button", { name: "SSH 설정 수정" })).toBeInTheDocument();
  });

  it("doesn't offer editing on a team you only view", () => {
    renderPicker(failed, { hosts: ec2Hosts, teamRole: "viewer", onOpenHostSettings: vi.fn() });
    expect(screen.getByRole("alert")).toHaveTextContent("no SSH user");
    expect(screen.queryByRole("button", { name: "SSH 설정 수정" })).toBeNull();
  });
});
