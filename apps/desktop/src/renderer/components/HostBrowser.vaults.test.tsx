import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupRecord, HostRecord, SavedWorkspaceRecord, VaultIndex } from "@shared";
import { HostBrowser } from "./HostBrowser";
import { buildBrowserVaults } from "./host-browser/browserVaults";
import type { MyCredentialsApi } from "./host-browser/useHostBrowser";
import { createEmptyVaultIndex } from "../store/utils";

// 팀이 있으면 사이드바 맨 윗단이 볼트다(개인 + 팀). 같은 경로 `Prod` 가 개인과 팀에 다 있어도 따로 접히고·골라지고·
// 이름이 바뀌고·옮겨진다. 볼트 사이로 놓으면 옮기기가 아니라 복사(공유)를 묻는다 — 묻는 창을 열 콜백이 없으면 아무
// 일도 없다.

const TEAM = "team-1";
const BLOCKED = "team-2";

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
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as HostRecord;
}

function group(id: string, path: string): GroupRecord {
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
  return {
    id,
    name: path.split("/").at(-1)!,
    path,
    parentPath,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

const teamWorkspace = {
  version: 1,
  id: "team-ws",
  name: "Team Layout",
  favorite: false,
  groupName: "Prod",
  root: { id: "team-ws-leaf", kind: "leaf", target: { kind: "local", label: "Local" } },
  lastOpenedAt: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
} as unknown as SavedWorkspaceRecord;

// 같은 경로 Prod 의 개인 워크스페이스 — 팀 Prod 목록에 섞이면 안 된다.
const personalWorkspace = {
  ...teamWorkspace,
  id: "my-ws",
  name: "My Layout",
  root: { id: "my-ws-leaf", kind: "leaf", target: { kind: "local", label: "Local" } },
} as unknown as SavedWorkspaceRecord;

const hosts = [
  host("my-web", "Prod"),
  host("my-db", "Prod/db"),
  host("my-home", null),
  host("team-api", "Prod"),
  host("team-web", "Prod/web"),
  host("team-bastion", "Bastion"),
];
const personalGroups = [group("pg-prod", "Prod"), group("pg-db", "Prod/db")];

function vaultIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      {
        id: TEAM,
        name: "Acme Infra",
        role: "owner",
        syncState: "ready",
        syncError: null,
        groups: [group("tg-prod", "Prod"), group("tg-web", "Prod/web"), group("tg-bastion", "Bastion")],
      },
      { id: BLOCKED, name: "Ops Night", role: "member", syncState: "needs-rejoin", syncError: null, groups: [] },
    ],
    teamIdByHostId: { "team-api": TEAM, "team-web": TEAM, "team-bastion": TEAM },
    teamIdByWorkspaceId: { "team-ws": TEAM },
  };
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

function createDataTransfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: () => entries.clear(),
    getData: (format: string) => entries.get(format) ?? "",
    setData: (format: string, data: string) => entries.set(format, data),
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

function renderVaults(
  options: {
    currentVaultId?: string | null;
    currentGroupPath?: string | null;
    teams?: boolean;
    activityLogs?: never[];
    hostViewMode?: "grid" | "list";
    searchQuery?: string;
    selectedHostId?: string | null;
    /** 볼트 사이 복사(공유)를 묻는 창을 열 수 있다(홈이 넘긴다). */
    copy?: boolean;
    myCredentials?: MyCredentialsApi;
    myUsernameByHostId?: Record<string, string>;
  } = {},
) {
  const callbacks = {
    onNavigateGroup: vi.fn(),
    onCreateGroup: vi.fn().mockResolvedValue(undefined),
    onRemoveGroup: vi.fn().mockResolvedValue(undefined),
    onMoveGroup: vi.fn().mockResolvedValue(undefined),
    onReorderGroup: vi.fn().mockResolvedValue(undefined),
    onRenameGroup: vi.fn().mockResolvedValue(undefined),
    onMoveHostToGroup: vi.fn().mockResolvedValue(undefined),
    onMoveSavedWorkspaceToGroup: vi.fn().mockResolvedValue(undefined),
    onCreateHostInVault: vi.fn(),
    onOpenTeamInvite: vi.fn(),
    onManageTeam: vi.fn(),
    onRequestVaultCopy: options.copy ? vi.fn() : undefined,
    myCredentials: options.myCredentials,
    myUsernameByHostId: options.myUsernameByHostId,
  };
  const savedWorkspaces = [teamWorkspace, personalWorkspace];
  const vaults = buildBrowserVaults({
    hosts,
    groups: personalGroups,
    savedWorkspaces,
    vaultIndex: options.teams === false ? createEmptyVaultIndex() : vaultIndex(),
    personalName: "Personal",
  });
  render(
    <HostBrowser
      desktopPlatform="darwin"
      hosts={hosts}
      groups={personalGroups}
      savedWorkspaces={savedWorkspaces}
      vaults={vaults}
      currentVaultId={options.currentVaultId ?? null}
      keychainEntries={[]}
      currentGroupPath={options.currentGroupPath ?? null}
      selectedHostId={options.selectedHostId ?? null}
      activityLogs={options.activityLogs ?? []}
      hostViewMode={options.hostViewMode ?? "grid"}
      searchQuery={options.searchQuery ?? ""}
      onSearchChange={vi.fn()}
      onOpenLocalTerminal={vi.fn()}
      onCreateHost={vi.fn()}
      onOpenDolgateImport={vi.fn()}
      onOpenAwsImport={vi.fn()}
      onOpenOpenSshImport={vi.fn()}
      onOpenXshellImport={vi.fn()}
      onOpenTermiusImport={vi.fn()}
      onOpenWarpgateImport={vi.fn()}
      onClearHostSelection={vi.fn()}
      onSelectHost={vi.fn()}
      onEditHost={vi.fn()}
      onDuplicateHosts={vi.fn().mockResolvedValue(undefined)}
      onExportAssets={vi.fn()}
      onSetHostFavorite={vi.fn()}
      onRemoveHosts={vi.fn().mockResolvedValue(undefined)}
      onRemoveSecrets={vi.fn().mockResolvedValue(undefined)}
      onConnectHost={vi.fn().mockResolvedValue(undefined)}
      onOpenHostContainers={vi.fn().mockResolvedValue(undefined)}
      {...callbacks}
    />,
  );
  return callbacks;
}

const tree = () => within(screen.getByLabelText("Group tree"));
/** 볼트 줄(누르면 그 볼트 맨 위). 접기·⋯ 단추도 이름이 볼트 이름으로 시작해서 id 로 찾는다. */
const vaultRow = (vaultId: string) =>
  screen.getByLabelText("Group tree").querySelector<HTMLElement>(`[data-vault-id="${vaultId}"]`)!;
/** 같은 이름의 그룹 줄 — 화면 순서대로(개인이 먼저). */
const groupRows = (label: string) => tree().getAllByRole("button", { name: new RegExp(`^${label}(\\s*\\d+)?$`) });

describe("HostBrowser vaults", () => {
  it("puts Personal and each team at the top, each over its own groups", () => {
    renderVaults();

    expect(vaultRow("personal").textContent).toContain("Personal");
    expect(vaultRow(TEAM).textContent).toContain("Acme Infra");
    expect(vaultRow(BLOCKED).textContent).toContain("Ops Night");
    // 개인 Prod 는 개인 것만(my-web·my-db·My Layout), 팀 Prod 는 팀 것만(team-api·team-web·Team Layout) 센다.
    const [personalProd, teamProd] = groupRows("Prod");
    expect(personalProd!.textContent).toBe("Prod3");
    expect(teamProd!.textContent).toBe("Prod3");
    // 볼트 줄은 그 볼트 항목 수 — 개인·팀 다 호스트 3개 + 워크스페이스 1개.
    expect(vaultRow("personal").textContent).toBe("Personal4");
    // 팀 표시(머리글자 네모 "AI")는 aria-hidden 이지만 글자로는 남는다.
    expect(vaultRow(TEAM).textContent).toBe("AIAcme Infra4");
    // 다시 들어와야 하는 팀은 개수 대신 경고(툴팁에 이유).
    expect(screen.getByRole("img", { name: "이 기기에 이 팀의 키가 없습니다. 초대 링크로 다시 들어와 주세요." })).toBeInTheDocument();
  });

  it("draws no vault rows without teams", () => {
    renderVaults({ teams: false });
    // 팀 표시도 없다.
    expect(document.body.textContent).not.toContain("Acme Infra");

    expect(screen.getByLabelText("Group tree").querySelector("[data-vault-id]")).toBeNull();
    expect(groupRows("Prod")).toHaveLength(1);
  });

  it("goes to a vault's top and to a group inside a vault", () => {
    const { onNavigateGroup } = renderVaults();

    fireEvent.click(vaultRow(TEAM));
    expect(onNavigateGroup).toHaveBeenLastCalledWith(null, TEAM);

    const [personalProd, teamProd] = groupRows("Prod");
    fireEvent.click(teamProd!);
    expect(onNavigateGroup).toHaveBeenLastCalledWith("Prod", TEAM);
    fireEvent.click(personalProd!);
    expect(onNavigateGroup).toHaveBeenLastCalledWith("Prod", "personal");
    // All 은 볼트 없이.
    fireEvent.click(tree().getByRole("button", { name: /^All/ }));
    expect(onNavigateGroup).toHaveBeenLastCalledWith(null);
  });

  it("lists only the vault you are in and says where you are", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod" });

    expect(screen.getByText("team-api")).toBeInTheDocument();
    expect(screen.getByText("team-web")).toBeInTheDocument();
    expect(screen.getByText("Team Layout")).toBeInTheDocument();
    // 개인 Prod 의 것은 섞이지 않는다(호스트도 워크스페이스도).
    expect(screen.queryByText("my-web")).toBeNull();
    expect(screen.queryByText("my-db")).toBeNull();
    expect(screen.queryByText("My Layout")).toBeNull();
    expect(document.body.textContent).toContain("Acme Infra / Prod · 항목 3개");
    // 지금 위치 표시는 팀 Prod 에만.
    const [personalProd, teamProd] = groupRows("Prod");
    expect(teamProd!.className).toContain("bg-[var(--selection-tint)]");
    expect(personalProd!.className).not.toContain("bg-[var(--selection-tint)]");
  });

  it("marks the vault row, not All, when you are at a vault's top", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: null });

    expect(vaultRow(TEAM)).toHaveAttribute("aria-current", "location");
    expect(vaultRow("personal")).not.toHaveAttribute("aria-current");
    expect(tree().getByRole("button", { name: /^All/ }).className).not.toContain("bg-[var(--selection-tint)]");
    expect(document.body.textContent).toContain("Acme Infra · 항목 4개");
  });

  it("marks team items in the mixed All list only, saying where they are", () => {
    const log = (hostId: string) =>
      ({ id: `log-${hostId}`, kind: "session-lifecycle", level: "info", message: "session.connected", metadata: { hostId, connectionKind: "ssh" }, createdAt: "2026-01-02T00:00:00.000Z" }) as never;
    renderVaults({ activityLogs: [log("team-web"), log("my-web")] });
    const card = (assetKey: string) => document.querySelector<HTMLElement>(`[data-home-asset-key="${assetKey}"]`)!;

    // 카드 아래 줄: 팀 것은 "[머리글자] 팀 이름 / 그룹", 개인 것은 그룹 그대로.
    expect(card("host:team-web").textContent).toContain("Acme Infra / Prod / web");
    expect(card("host:team-bastion").textContent).toContain("Acme Infra / Bastion");
    expect(card("workspace:team-ws").textContent).toContain("Acme Infra / Prod");
    expect(card("host:my-web").textContent).not.toContain("Acme Infra");
    expect(card("workspace:my-ws").textContent).not.toContain("Acme Infra");
    // 개인 것에는 아무것도 안 붙인다("Personal" 표시도 없다).
    expect(card("host:my-web").textContent).not.toContain("Personal");
    // 오른쪽 최근 로그도 팀 호스트 이름 뒤에만.
    const recent = within(screen.getByTestId("recent-logs"));
    expect(recent.getByText("team-web").parentElement!.textContent).toContain("Acme Infra");
    expect(recent.getByText("my-web").parentElement!.textContent).not.toContain("Acme Infra");
  });

  it("marks nothing inside a vault — everything there is from the same vault", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod" });

    const card = document.querySelector<HTMLElement>('[data-home-asset-key="host:team-web"]')!;
    expect(card.textContent).not.toContain("Acme Infra");
  });

  it("puts only the mark in the table's narrow group column, with the team name for screen readers", () => {
    renderVaults({ hostViewMode: "list" });

    const row = (assetKey: string) => document.querySelector<HTMLElement>(`[data-home-asset-key="${assetKey}"]`)!;
    // 경로는 잘리지 않게 그대로, 팀 이름은 머리글자 네모의 툴팁(읽기 프로그램에는 글로).
    expect(within(row("host:team-web")).getByText("Prod / web")).toBeInTheDocument();
    expect(within(row("host:team-web")).getByText("Acme Infra")).toHaveClass("sr-only");
    expect(row("host:my-web").textContent).not.toContain("Acme Infra");
  });

  it("says the team before the subtitle in the command palette", () => {
    // "web" 은 팀 team-web 과 개인 my-web 에 다 걸린다.
    renderVaults({ searchQuery: "web" });
    fireEvent.focus(screen.getByRole("textbox", { name: /Search hosts and Workspaces/ }));

    const texts = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    const team = texts.filter((text) => text.startsWith("team-web"));
    const mine = texts.filter((text) => text.startsWith("my-web"));
    expect(team.length).toBeGreaterThan(0);
    expect(mine.length).toBeGreaterThan(0);
    expect(team.every((text) => text.includes("Acme Infra · "))).toBe(true);
    expect(mine.some((text) => text.includes("Acme Infra"))).toBe(false);
  });

  it("says a team item's favorite is only mine, wherever it is listed", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod" });
    const card = (assetKey: string) => document.querySelector<HTMLElement>(`[data-home-asset-key="${assetKey}"]`)!;

    // 볼트 안이라 팀 표시는 없어도, 즐겨찾기가 나에게만 적용된다는 것은 알린다.
    fireEvent.mouseEnter(within(card("host:team-web")).getByRole("button", { pressed: false, name: /즐겨찾기/ }).parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("즐겨찾기는 나에게만 적용됩니다.");
    fireEvent.mouseLeave(within(card("host:team-web")).getByRole("button", { pressed: false, name: /즐겨찾기/ }).parentElement!);
    fireEvent.mouseEnter(within(card("workspace:team-ws")).getByRole("button", { pressed: false, name: /즐겨찾기/ }).parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("즐겨찾기는 나에게만 적용됩니다.");
  });

  it("says it in the table and the detail panels too", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod", hostViewMode: "list", selectedHostId: "team-web" });
    const tooltipFor = (button: HTMLElement) => {
      fireEvent.mouseEnter(button.parentElement!);
      const text = screen.getByRole("tooltip").textContent;
      fireEvent.mouseLeave(button.parentElement!);
      return text;
    };
    const row = document.querySelector<HTMLElement>('[data-home-asset-key="host:team-web"]')!;
    expect(tooltipFor(within(row).getByRole("button", { name: /즐겨찾기/ }))).toBe("즐겨찾기는 나에게만 적용됩니다.");
    // 고른 호스트의 상세 머리 별.
    const detailStar = screen
      .getAllByRole("button", { name: "team-web 즐겨찾기" })
      .find((button) => !button.closest("[data-home-asset-key]"))!;
    expect(tooltipFor(detailStar)).toBe("즐겨찾기는 나에게만 적용됩니다.");
    const wsRow = document.querySelector<HTMLElement>('[data-home-asset-key="workspace:team-ws"]')!;
    expect(tooltipFor(within(wsRow).getByRole("button", { name: /즐겨찾기/ }))).toBe("즐겨찾기는 나에게만 적용됩니다.");
  });

  it("says it in the workspace detail panel", () => {
    renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod" });
    fireEvent.click(document.querySelector<HTMLElement>('[data-home-asset-key="workspace:team-ws"]')!);

    const detailStar = screen
      .getAllByRole("button", { name: "Workspace 즐겨찾기" })
      .find((button) => !button.closest("[data-home-asset-key]"))!;
    fireEvent.mouseEnter(detailStar.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("즐겨찾기는 나에게만 적용됩니다.");
  });

  it("adds no favorite note to personal items", () => {
    renderVaults({ currentVaultId: "personal", currentGroupPath: "Prod" });
    const card = document.querySelector<HTMLElement>('[data-home-asset-key="host:my-web"]')!;

    fireEvent.mouseEnter(within(card).getByRole("button", { pressed: false, name: /즐겨찾기/ }).parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows recent logs of the vault you are in only", () => {
    const log = (hostId: string, createdAt: string) =>
      ({
        id: `log-${hostId}`,
        kind: "session-lifecycle",
        level: "info",
        message: "session.connected",
        metadata: { hostId, connectionKind: "ssh" },
        createdAt,
      }) as never;
    renderVaults({
      currentVaultId: TEAM,
      currentGroupPath: null,
      activityLogs: [log("my-web", "2026-01-03T00:00:00.000Z"), log("team-web", "2026-01-02T00:00:00.000Z")],
    });

    // 팀 맨 위: 경로가 없어도 그 팀의 로그만(개인 my-web 의 로그는 섞이지 않는다). 범위 이름은 그 볼트.
    const recent = within(screen.getByTestId("recent-logs"));
    expect(recent.getByText("최근 로그 · Acme Infra")).toBeInTheDocument();
    expect(recent.getByText("team-web")).toBeInTheDocument();
    expect(recent.queryByText("my-web")).toBeNull();
  });

  it("collapses the same path in each vault on its own", () => {
    renderVaults();

    expect(tree().getByRole("button", { name: /^db/ })).toBeInTheDocument();
    expect(tree().getByRole("button", { name: /^web/ })).toBeInTheDocument();
    const [, teamToggle] = tree().getAllByRole("button", { name: "Collapse subgroup" });
    fireEvent.click(teamToggle!);

    expect(tree().queryByRole("button", { name: /^web/ })).toBeNull();
    expect(tree().getByRole("button", { name: /^db/ })).toBeInTheDocument();

    // 볼트 줄을 접으면 그 볼트의 그룹만 숨는다.
    fireEvent.click(tree().getByRole("button", { name: "Acme Infra 접기" }));
    expect(groupRows("Prod")).toHaveLength(1);
    expect(tree().queryByRole("button", { name: /^Bastion/ })).toBeNull();
  });

  it("keeps picking several groups inside one vault", () => {
    renderVaults();

    const [personalProd, teamProd] = groupRows("Prod");
    fireEvent.click(teamProd!, { metaKey: true });
    fireEvent.click(tree().getByRole("button", { name: /^Bastion/ }), { metaKey: true });
    expect(teamProd!.dataset.groupTreeState).toBe("selected");
    expect(tree().getByRole("button", { name: /^Bastion/ }).dataset.groupTreeState).toBe("selected");

    // 다른 볼트를 더하면 거기서 새로 시작한다.
    fireEvent.click(personalProd!, { metaKey: true });
    expect(personalProd!.dataset.groupTreeState).toBe("selected");
    expect(teamProd!.dataset.groupTreeState).toBe("idle");
    expect(tree().getByRole("button", { name: /^Bastion/ }).dataset.groupTreeState).toBe("idle");
  });

  it("renames a team group in that team and a personal group as before", async () => {
    const { onRenameGroup } = renderVaults();

    const [personalProd, teamProd] = groupRows("Prod");
    fireEvent.contextMenu(teamProd!);
    fireEvent.click(screen.getByRole("button", { name: "이름 변경" }));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "Live" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename group" }));
    await waitFor(() => expect(onRenameGroup).toHaveBeenLastCalledWith("Prod", "Live", TEAM));

    fireEvent.contextMenu(personalProd!);
    fireEvent.click(screen.getByRole("button", { name: "이름 변경" }));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "Home" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename group" }));
    // 개인은 볼트 없이 지금처럼 부른다.
    await waitFor(() => expect(onRenameGroup).toHaveBeenLastCalledWith("Prod", "Home"));
  });

  it("makes a subgroup of a team group in that team", async () => {
    const { onCreateGroup } = renderVaults();

    fireEvent.contextMenu(groupRows("Prod")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "하위 그룹 생성" }));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(onCreateGroup).toHaveBeenCalledWith("api", "Prod", TEAM));
  });

  it("counts and deletes only inside the team when deleting a team group", async () => {
    const { onRemoveGroup } = renderVaults();

    fireEvent.contextMenu(groupRows("Prod")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    // 팀 Prod 아래: 하위 그룹 web 1개, 호스트 team-api·team-web 2개, 워크스페이스 1개(개인 my-web·my-db 는 세지 않는다).
    expect(screen.getByText("하위 그룹 1개, 호스트 2개, Workspace 1개가 함께 영향을 받습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "하위 항목까지 삭제" }));
    await waitFor(() => expect(onRemoveGroup).toHaveBeenCalledWith("Prod", "delete-subtree", TEAM));
  });

  it("moves things only inside one vault — dropping into another vault does nothing", async () => {
    const { onMoveHostToGroup, onMoveGroup } = renderVaults();

    const teamCard = screen.getByText("team-web").closest("article") as HTMLElement;
    const [personalProd, teamProd] = groupRows("Prod");

    // 팀 호스트 → 개인 그룹: 놓을 자리로 받지 않고(dragover 를 취소하지 않는다) 놓아도 아무 일 없다.
    let dataTransfer = createDataTransfer();
    fireEvent.dragStart(teamCard, { dataTransfer });
    expect(fireEvent.dragOver(personalProd!, { dataTransfer })).toBe(true);
    fireEvent.drop(personalProd!, { dataTransfer });
    // 팀 호스트 → 개인 볼트 줄도, 볼트가 섞인 All 도 마찬가지.
    expect(fireEvent.dragOver(vaultRow("personal"), { dataTransfer })).toBe(true);
    fireEvent.drop(vaultRow("personal"), { dataTransfer });
    expect(fireEvent.dragOver(tree().getByRole("button", { name: /^All/ }), { dataTransfer })).toBe(true);
    fireEvent.drop(tree().getByRole("button", { name: /^All/ }), { dataTransfer });
    // 같은 볼트(팀 볼트 줄)는 받는다.
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(false);
    fireEvent.dragEnd(teamCard, { dataTransfer });
    expect(onMoveHostToGroup).not.toHaveBeenCalled();

    // 팀 호스트 → 팀 그룹: 옮겨진다.
    dataTransfer = createDataTransfer();
    fireEvent.dragStart(teamCard, { dataTransfer });
    fireEvent.dragOver(tree().getByRole("button", { name: /^Bastion/ }), { dataTransfer });
    fireEvent.drop(tree().getByRole("button", { name: /^Bastion/ }), { dataTransfer });
    await waitFor(() => expect(onMoveHostToGroup).toHaveBeenCalledWith("team-web", "Bastion"));

    // 팀 그룹 → 개인 그룹·All: 놓이지 않는다. 팀 그룹 → 팀 그룹: 그 팀 안에서 옮긴다.
    dataTransfer = createDataTransfer();
    const bastion = tree().getByRole("button", { name: /^Bastion/ });
    fireEvent.dragStart(bastion, { dataTransfer });
    expect(fireEvent.dragOver(personalProd!, { dataTransfer })).toBe(true);
    fireEvent.drop(personalProd!, { dataTransfer });
    expect(fireEvent.dragOver(tree().getByRole("button", { name: /^All/ }), { dataTransfer })).toBe(true);
    fireEvent.drop(tree().getByRole("button", { name: /^All/ }), { dataTransfer });
    fireEvent.dragEnd(bastion, { dataTransfer });
    // 하위 팀 그룹(Prod/web)도 All 에 떨어뜨리면 아무 일 없다 — 맨 위로 옮기려면 그 볼트 줄에 놓는다.
    const web = tree().getByRole("button", { name: /^web/ });
    const webTransfer = createDataTransfer();
    fireEvent.dragStart(web, { dataTransfer: webTransfer });
    fireEvent.drop(tree().getByRole("button", { name: /^All/ }), { dataTransfer: webTransfer });
    fireEvent.dragEnd(web, { dataTransfer: webTransfer });
    expect(onMoveGroup).not.toHaveBeenCalled();
    fireEvent.dragStart(bastion, { dataTransfer });
    fireEvent.dragOver(teamProd!, { dataTransfer });
    fireEvent.drop(teamProd!, { dataTransfer });
    await waitFor(() => expect(onMoveGroup).toHaveBeenCalledWith("Bastion", "Prod", TEAM));
  });

  it("reorders a team group among that team's groups", async () => {
    // jsdom 에는 DragEvent 가 없어 끌기 이벤트에 마우스 좌표가 실리지 않는다 — 줄의 어느 높이에 놓는지 보려면 필요하다.
    vi.stubGlobal("DragEvent", class extends MouseEvent {});
    const { onReorderGroup, onMoveGroup } = renderVaults();
    const teamProd = groupRows("Prod")[1]!;
    const bastion = tree().getByRole("button", { name: /^Bastion/ });
    // 줄의 위쪽 25% 에 놓으면 "이 자리로"(순서 바꾸기)다.
    Object.defineProperty(bastion, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(teamProd, { dataTransfer });
    fireEvent.dragOver(bastion, { dataTransfer, clientY: 2 });
    fireEvent.drop(bastion, { dataTransfer, clientY: 2 });

    // 팀의 형제(Bastion·Prod) 사이에서 Bastion 앞으로.
    await waitFor(() => expect(onReorderGroup).toHaveBeenCalledWith("Prod", null, 0, TEAM));
    expect(onMoveGroup).not.toHaveBeenCalled();
  });

  it("exports only the team group's own items", () => {
    renderVaults();

    fireEvent.contextMenu(groupRows("Prod")[1]!);
    // 팀 Prod 아래 호스트 2개 + 워크스페이스 1개(개인 Prod 의 것은 세지 않는다).
    expect(screen.getByRole("button", { name: "내보내기... (항목 3개)" })).toBeInTheDocument();
  });

  it("offers invite, new host, new group and team management on a team row", async () => {
    const { onOpenTeamInvite, onCreateHostInVault, onNavigateGroup, onCreateGroup, onManageTeam } = renderVaults();
    const teamRow = vaultRow(TEAM);

    fireEvent.contextMenu(teamRow);
    const menu = within(screen.getByRole("menu"));
    expect(menu.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "초대 링크",
      "새 호스트",
      "새 그룹",
      "팀 관리",
    ]);
    fireEvent.click(menu.getByRole("button", { name: "초대 링크" }));
    expect(onOpenTeamInvite).toHaveBeenCalledWith(TEAM);

    // ⋯ 단추도 같은 메뉴를 연다.
    fireEvent.click(screen.getByRole("button", { name: "Acme Infra 메뉴" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "새 호스트" }));
    // 그 볼트로 옮긴 뒤 만든다(만든 호스트가 목록에 바로 보이게).
    expect(onNavigateGroup).toHaveBeenLastCalledWith(null, TEAM);
    expect(onCreateHostInVault).toHaveBeenCalledWith(TEAM);

    fireEvent.contextMenu(teamRow);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "새 그룹" }));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "Ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    // 볼트 맨 위에 만든다.
    await waitFor(() => expect(onCreateGroup).toHaveBeenCalledWith("Ops", null, TEAM));

    fireEvent.contextMenu(teamRow);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "팀 관리" }));
    expect(onManageTeam).toHaveBeenCalledWith(TEAM);
  });

  it("offers only what works: personal has no team items, a team to rejoin only management", () => {
    renderVaults();

    fireEvent.contextMenu(vaultRow("personal"));
    expect(within(screen.getByRole("menu")).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "새 호스트",
      "새 그룹",
    ]);
    fireEvent.click(document.body);

    fireEvent.contextMenu(vaultRow(BLOCKED));
    expect(within(screen.getByRole("menu")).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "팀 관리",
    ]);
  });

  it("makes a new group from the + button in the vault you are in", async () => {
    const { onCreateGroup } = renderVaults({ currentVaultId: TEAM, currentGroupPath: "Prod" });

    fireEvent.click(screen.getByRole("button", { name: "New Group" }));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    // 부모를 정하지 않으면 스토어가 그 볼트의 지금 경로 아래에 만든다.
    await waitFor(() => expect(onCreateGroup).toHaveBeenCalledWith("api", undefined, TEAM));
  });

  it("goes back to All when the team you were in is gone", () => {
    const { onNavigateGroup } = renderVaults({ currentVaultId: "team-gone", currentGroupPath: "Prod" });

    expect(onNavigateGroup).toHaveBeenCalledWith(null);
  });
});

describe("HostBrowser copy between vaults", () => {
  // 고르면 상세에도 같은 이름이 나와서 목록 카드만 찾는다.
  const cardOf = (label: string) =>
    screen
      .getAllByText(label)
      .map((element) => element.closest<HTMLElement>("article[data-home-asset-key]"))
      .find(Boolean) as HTMLElement;

  it("asks to copy hosts dropped on another vault's row or group, and still moves inside one vault", async () => {
    const { onRequestVaultCopy, onMoveHostToGroup } = renderVaults({ copy: true });

    // 개인 호스트 → 팀 볼트 줄: 복사로 받고("+ Copy"), 놓으면 그 팀 맨 위로 복사할지 묻는다.
    let dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("my-web"), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(within(vaultRow(TEAM)).getByText("Copy")).toBeInTheDocument();
    fireEvent.drop(vaultRow(TEAM), { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "hosts", hostIds: ["my-web"] },
      target: { vaultId: TEAM, groupPath: null },
    });
    expect(within(vaultRow(TEAM)).queryByText("Copy")).toBeNull();

    // 개인 호스트 → 팀 그룹: 그 그룹으로.
    dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("my-web"), { dataTransfer });
    const bastion = tree().getByRole("button", { name: /^Bastion/ });
    expect(fireEvent.dragOver(bastion, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(within(bastion).getByText("Copy")).toBeInTheDocument();
    fireEvent.drop(bastion, { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { vaultId: TEAM, groupPath: "Bastion" } }),
    );

    // 팀 호스트 → 팀 그룹: 지금처럼 옮긴다(복사를 묻지 않는다).
    onRequestVaultCopy!.mockClear();
    dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("team-web"), { dataTransfer });
    expect(fireEvent.dragOver(bastion, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
    expect(within(bastion).queryByText("Copy")).toBeNull();
    fireEvent.drop(bastion, { dataTransfer });
    await waitFor(() => expect(onMoveHostToGroup).toHaveBeenCalledWith("team-web", "Bastion"));
    expect(onRequestVaultCopy).not.toHaveBeenCalled();
  });

  it("asks to copy a whole group dropped into another vault", () => {
    const { onRequestVaultCopy, onMoveGroup } = renderVaults({ copy: true });
    const [personalProd] = groupRows("Prod");

    let dataTransfer = createDataTransfer();
    fireEvent.dragStart(personalProd!, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(false);
    fireEvent.drop(vaultRow(TEAM), { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "group", groupPath: "Prod" },
      target: { vaultId: TEAM, groupPath: null },
    });

    // 팀 그룹 → 개인 그룹: 그 그룹 안으로 복사(팀 → 개인도 복사다).
    dataTransfer = createDataTransfer();
    const bastion = tree().getByRole("button", { name: /^Bastion/ });
    fireEvent.dragStart(bastion, { dataTransfer });
    expect(fireEvent.dragOver(personalProd!, { dataTransfer })).toBe(false);
    fireEvent.drop(personalProd!, { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: TEAM,
      selection: { kind: "group", groupPath: "Bastion" },
      target: { vaultId: "personal", groupPath: "Prod" },
    });
    expect(onMoveGroup).not.toHaveBeenCalled();
  });

  it("won't take mixed vaults, hosts with workspaces, a blocked team or All", () => {
    const { onRequestVaultCopy } = renderVaults({ copy: true });

    // 개인과 팀 호스트를 함께 고르면 어디로도 복사되지 않는다.
    fireEvent.click(cardOf("my-web"));
    fireEvent.click(cardOf("team-web"), { metaKey: true });
    let dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("team-web"), { dataTransfer });
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(true);
    expect(fireEvent.dragOver(vaultRow("personal"), { dataTransfer })).toBe(true);
    fireEvent.dragEnd(cardOf("team-web"), { dataTransfer });

    // 호스트와 워크스페이스를 함께 고르면 복사하지 않는다(요청은 둘 중 하나만 담는다).
    fireEvent.click(cardOf("My Layout"));
    fireEvent.click(cardOf("my-web"), { metaKey: true });
    dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("My Layout"), { dataTransfer });
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(true);
    fireEvent.dragEnd(cardOf("My Layout"), { dataTransfer });

    // 막힌 팀과 볼트가 섞인 All 은 놓을 자리가 아니다.
    fireEvent.click(cardOf("my-web"));
    dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("my-web"), { dataTransfer });
    expect(fireEvent.dragOver(vaultRow(BLOCKED), { dataTransfer })).toBe(true);
    expect(fireEvent.dragOver(tree().getByRole("button", { name: /^All/ }), { dataTransfer })).toBe(true);
    fireEvent.drop(vaultRow(BLOCKED), { dataTransfer });
    expect(onRequestVaultCopy).not.toHaveBeenCalled();
  });

  it("keeps drags move-only without teams", () => {
    renderVaults({ copy: true, teams: false });

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("my-web"), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("asks to copy from the table too", () => {
    const { onRequestVaultCopy } = renderVaults({ copy: true, hostViewMode: "list" });

    const row = document.querySelector<HTMLElement>('[data-home-asset-key="host:my-web"]')!;
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(row, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(false);
    fireEvent.drop(vaultRow(TEAM), { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { kind: "hosts", hostIds: ["my-web"] } }),
    );
  });

  it("offers Share on personal items and Copy to vault on team items", () => {
    const { onRequestVaultCopy } = renderVaults({ copy: true });
    const menuItems = () => within(screen.getByRole("menu")).getAllByRole("button").map((button) => button.textContent);

    fireEvent.contextMenu(cardOf("my-web"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "공유…" }));
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "hosts", hostIds: ["my-web"] },
      target: null,
    });

    fireEvent.contextMenu(cardOf("team-web"));
    expect(menuItems()).toContain("볼트로 복사…");
    expect(menuItems()).not.toContain("공유…");
    fireEvent.click(document.body);

    const [personalProd, teamProd] = groupRows("Prod");
    fireEvent.contextMenu(personalProd!);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "공유…" }));
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "group", groupPath: "Prod" },
      target: null,
    });

    fireEvent.contextMenu(teamProd!);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "볼트로 복사…" }));
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: TEAM,
      selection: { kind: "group", groupPath: "Prod" },
      target: null,
    });
  });

  it("offers no copy for mixed vaults or hosts with workspaces", () => {
    const hasCopyItem = () =>
      within(screen.getByRole("menu"))
        .getAllByRole("button")
        .some((button) => button.textContent === "공유…" || button.textContent === "볼트로 복사…");

    renderVaults({ copy: true });
    fireEvent.click(cardOf("my-web"));
    fireEvent.click(cardOf("team-web"), { metaKey: true });
    fireEvent.contextMenu(cardOf("team-web"));
    expect(hasCopyItem()).toBe(false);
    fireEvent.click(document.body);
    fireEvent.click(cardOf("My Layout"));
    fireEvent.click(cardOf("my-web"), { metaKey: true });
    fireEvent.contextMenu(cardOf("my-web"));
    expect(hasCopyItem()).toBe(false);
  });

  // 4-6: 워크스페이스도 다른 볼트에 놓거나 메뉴로 공유한다 — 창의 호스트까지 메인이 함께 복사한다.
  it("asks to copy a workspace by dropping it on another vault or from its menu", () => {
    const { onRequestVaultCopy } = renderVaults({ copy: true });

    fireEvent.click(cardOf("My Layout"));
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(cardOf("My Layout"), { dataTransfer });
    expect(fireEvent.dragOver(vaultRow(TEAM), { dataTransfer })).toBe(false);
    fireEvent.drop(vaultRow(TEAM), { dataTransfer });
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "workspaces", workspaceIds: ["my-ws"] },
      target: { vaultId: TEAM, groupPath: null },
    });

    fireEvent.contextMenu(cardOf("My Layout"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "공유…" }));
    expect(onRequestVaultCopy).toHaveBeenLastCalledWith({
      sourceVaultId: "personal",
      selection: { kind: "workspaces", workspaceIds: ["my-ws"] },
      target: null,
    });
  });

  it("offers no copy without teams or without a way to ask", () => {
    const hasCopyItem = () =>
      within(screen.getByRole("menu"))
        .getAllByRole("button")
        .some((button) => button.textContent === "공유…" || button.textContent === "볼트로 복사…");

    renderVaults({ copy: true, teams: false });
    fireEvent.contextMenu(cardOf("my-web"));
    expect(hasCopyItem()).toBe(false);
  });

  it("offers no copy when home gives no way to ask", () => {
    renderVaults();
    fireEvent.contextMenu(cardOf("my-web"));
    const items = within(screen.getByRole("menu")).getAllByRole("button").map((button) => button.textContent);
    expect(items).not.toContain("공유…");
  });
});

describe("HostBrowser my credentials on team hosts", () => {
  const summary = {
    username: "deploy",
    authType: "password" as const,
    domain: null,
    hasPassword: true,
    hasPrivateKey: false,
    hasCertificate: false,
    hasPassphrase: false,
  };
  const api = (current: typeof summary | null): MyCredentialsApi => ({
    load: vi.fn().mockResolvedValue(current),
    save: vi.fn().mockImplementation(async (_hostId, input) => ({ ...summary, username: input.username ?? null })),
    clear: vi.fn().mockResolvedValue(undefined),
  });
  const card = () =>
    screen.getAllByText("My credentials").map((element) => element.closest("h3")!.parentElement!.parentElement!)[0]!;

  it("shows what is stored for me on a team host — names, never values", async () => {
    const myCredentials = api(summary);
    renderVaults({ selectedHostId: "team-web", myCredentials });

    await waitFor(() => expect(within(card()).getByText("deploy")).toBeInTheDocument());
    expect(myCredentials.load).toHaveBeenCalledWith("team-web");
    const rows = card().querySelector("[data-my-credentials]")!.textContent;
    expect(rows).toContain("Username");
    expect(rows).toContain("Auth비밀번호");
    expect(rows).toContain("Stored비밀번호");
    expect(within(card()).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("adds my credentials from the empty card, and clears them", async () => {
    const myCredentials = api(null);
    renderVaults({ selectedHostId: "team-web", myCredentials });

    expect(await within(card()).findByText("비어 있으면 팀 것으로 접속합니다.")).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole("button", { name: "Add" }));
    const dialog = within(screen.getByRole("dialog", { name: "team-web · 내 자격 증명" }));
    fireEvent.change(dialog.getByPlaceholderText("ubuntu (팀)"), { target: { value: "deploy" } });
    fireEvent.click(dialog.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(myCredentials.save).toHaveBeenCalledWith("team-web", { username: "deploy" }));
    await waitFor(() => expect(within(card()).getByText("deploy")).toBeInTheDocument());

    fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "team-web · 내 자격 증명" })).getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(myCredentials.clear).toHaveBeenCalledWith("team-web"));
    expect(await within(card()).findByText("비어 있으면 팀 것으로 접속합니다.")).toBeInTheDocument();
  });

  it("has no such card on personal hosts, without teams, or when home gives no way to keep them", async () => {
    const myCredentials = api(summary);
    renderVaults({ selectedHostId: "my-web", myCredentials });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Host" })).toBeInTheDocument());
    expect(screen.queryByText("My credentials")).toBeNull();
    expect(myCredentials.load).not.toHaveBeenCalled();
  });

  it("has no card without teams", async () => {
    renderVaults({ selectedHostId: "team-web", myCredentials: api(summary), teams: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Host" })).toBeInTheDocument());
    expect(screen.queryByText("My credentials")).toBeNull();
  });

  it("has no card when home gives no way to keep them", async () => {
    renderVaults({ selectedHostId: "team-web" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Host" })).toBeInTheDocument());
    expect(screen.queryByText("My credentials")).toBeNull();
  });

  it("says my username in the command palette for a team host", () => {
    renderVaults({ searchQuery: "web", myUsernameByHostId: { "team-web": "deploy" } });
    fireEvent.focus(screen.getByRole("textbox", { name: /Search hosts and Workspaces/ }));

    const texts = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(texts.filter((text) => text.startsWith("team-web")).every((text) => text.includes("deploy@team-web.example.com"))).toBe(true);
    // 내 이름이 없는 호스트는 레코드 이름 그대로.
    expect(texts.filter((text) => text.startsWith("my-web")).every((text) => text.includes("ubuntu@my-web.example.com"))).toBe(true);
  });
});
