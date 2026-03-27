import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from "@shared";
import type {
  AppSettings,
  FileEntry,
  GroupRecord,
  HostRecord,
} from "@shared";
import type {
  PendingSftpInteractiveAuth,
  SftpPaneState,
  SftpState,
} from "../store/createAppStore";
import { SftpWorkspace } from "./SftpWorkspace";

const baseSettings: AppSettings = {
  theme: "system",
  globalTerminalThemeId: "dolssh-dark",
  terminalFontFamily: "sf-mono",
  terminalFontSize: 13,
  terminalScrollbackLines: 5000,
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalMinimumContrastRatio: 1,
  terminalAltIsMeta: false,
  terminalWebglEnabled: true,
  sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
  serverUrl: "https://ssh.doldolma.com",
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: "2026-03-26T00:00:00.000Z",
};

function createEntry(name: string, pathPrefix: string): FileEntry {
  return {
    name,
    path: `${pathPrefix}/${name}`,
    isDirectory: false,
    size: 128,
    mtime: "2026-03-26T10:00:00.000Z",
    kind: "file",
    permissions: "rw-r--r--",
  };
}

const hostGroups: GroupRecord[] = [
  {
    id: "group-1",
    name: "Production",
    path: "Production",
    parentPath: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  },
];

const connectableHosts: HostRecord[] = [
  {
    id: "ssh-1",
    kind: "ssh",
    label: "Prod SSH",
    hostname: "prod.example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName: "Production",
    tags: ["prod"],
    terminalThemeId: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  },
  {
    id: "ssh-2",
    kind: "ssh",
    label: "Batch SSH",
    hostname: "batch.example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    groupName: "Production",
    tags: ["prod"],
    terminalThemeId: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  },
  {
    id: "warpgate-1",
    kind: "warpgate-ssh",
    label: "Warpgate Prod",
    warpgateBaseUrl: "https://warpgate.example.com",
    warpgateSshHost: "warpgate.example.com",
    warpgateSshPort: 2222,
    warpgateTargetId: "target-1",
    warpgateTargetName: "prod-db",
    warpgateUsername: "example.user",
    groupName: "Production",
    tags: ["prod"],
    terminalThemeId: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
  },
];

function createPane(id: "left" | "right", entry: FileEntry): SftpPaneState {
  const currentPath = id === "left" ? "/left" : "/right";
  return {
    id,
    sourceKind: "local",
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    hostGroupPath: null,
    currentPath,
    lastLocalPath: currentPath,
    history: [currentPath],
    historyIndex: 0,
    entries: [entry],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: "",
    selectedHostId: null,
    hostSearchQuery: "",
    isLoading: false,
    warningMessages: [],
  };
}

function createHostPickerPane(
  overrides: Partial<SftpPaneState> = {},
): SftpPaneState {
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
  };
}

function createSftpState(): SftpState {
  return {
    localHomePath: "/Users/tester",
    leftPane: createPane("left", createEntry("left-alpha.txt", "/left")),
    rightPane: createPane("right", createEntry("right-beta.txt", "/right")),
    transfers: [],
    pendingConflictDialog: null,
  };
}

function renderWorkspace(
  overrides: Partial<Parameters<typeof SftpWorkspace>[0]> = {},
) {
  const onUpdateSettings = vi.fn().mockResolvedValue(undefined);
  const onDisconnectPane = vi.fn().mockResolvedValue(undefined);
  const onSelectEntry = vi.fn();
  const onDeleteSelection = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <SftpWorkspace
      hosts={[]}
      groups={[]}
      sftp={createSftpState()}
      settings={baseSettings}
      interactiveAuth={null}
      onActivatePaneSource={vi.fn().mockResolvedValue(undefined)}
      onDisconnectPane={onDisconnectPane}
      onPaneFilterChange={vi.fn()}
      onHostSearchChange={vi.fn()}
      onNavigateHostGroup={vi.fn()}
      onSelectHost={vi.fn()}
      onConnectHost={vi.fn().mockResolvedValue(undefined)}
      onOpenEntry={vi.fn().mockResolvedValue(undefined)}
      onRefreshPane={vi.fn().mockResolvedValue(undefined)}
      onNavigateBack={vi.fn().mockResolvedValue(undefined)}
      onNavigateForward={vi.fn().mockResolvedValue(undefined)}
      onNavigateParent={vi.fn().mockResolvedValue(undefined)}
      onNavigateBreadcrumb={vi.fn().mockResolvedValue(undefined)}
      onSelectEntry={onSelectEntry}
      onCreateDirectory={vi.fn().mockResolvedValue(undefined)}
      onRenameSelection={vi.fn().mockResolvedValue(undefined)}
      onChangeSelectionPermissions={vi.fn().mockResolvedValue(undefined)}
      onDeleteSelection={onDeleteSelection}
      onDownloadSelection={vi.fn().mockResolvedValue(undefined)}
      onPrepareTransfer={vi.fn().mockResolvedValue(undefined)}
      onPrepareExternalTransfer={vi.fn().mockResolvedValue(undefined)}
      onTransferSelectionToPane={vi.fn().mockResolvedValue(undefined)}
      onResolveConflict={vi.fn().mockResolvedValue(undefined)}
      onDismissConflict={vi.fn()}
      onCancelTransfer={vi.fn().mockResolvedValue(undefined)}
      onRetryTransfer={vi.fn().mockResolvedValue(undefined)}
      onDismissTransfer={vi.fn()}
      onRespondInteractiveAuth={vi.fn().mockResolvedValue(undefined)}
      onReopenInteractiveAuthUrl={vi.fn().mockResolvedValue(undefined)}
      onClearInteractiveAuth={vi.fn()}
      onUpdateSettings={onUpdateSettings}
      {...overrides}
    />,
  );

  return {
    ...result,
    onDisconnectPane,
    onUpdateSettings,
    onSelectEntry,
    onDeleteSelection,
  };
}

function openEntryContextMenu(entryName: string) {
  fireEvent.contextMenu(screen.getByText(entryName), {
    clientX: 120,
    clientY: 160,
  });
  return screen.getByRole("menu");
}

function queryColumnWidths(
  container: HTMLElement,
  columnKey: string,
): string[] {
  return Array.from(
    container.querySelectorAll(`col[data-column-key="${columnKey}"]`),
  ).map((element) => (element as HTMLTableColElement).style.width);
}

describe("SftpWorkspace column resizing", () => {
  it("applies the default shared column widths to both panes", () => {
    const { container } = renderWorkspace();

    expect(queryColumnWidths(container, "name")).toEqual(["360px", "360px"]);
    expect(queryColumnWidths(container, "dateModified")).toEqual([
      "168px",
      "168px",
    ]);
    expect(queryColumnWidths(container, "size")).toEqual(["96px", "96px"]);
    expect(queryColumnWidths(container, "kind")).toEqual(["96px", "96px"]);
  });

  it("updates the shared width live and persists once on mouseup", async () => {
    const { container, onUpdateSettings } = renderWorkspace();
    const [nameHandle] = screen.getAllByRole("separator", {
      name: "Resize Name column",
    });

    fireEvent.mouseDown(nameHandle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 220 });

    expect(queryColumnWidths(container, "name")).toEqual(["480px", "480px"]);
    expect(onUpdateSettings).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);

    await waitFor(() =>
      expect(onUpdateSettings).toHaveBeenCalledWith({
        sftpBrowserColumnWidths: {
          ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
          name: 480,
        },
      }),
    );
  });

  it("clamps resized widths to the per-column minimums", async () => {
    const { container, onUpdateSettings } = renderWorkspace();
    const [sizeHandle] = screen.getAllByRole("separator", {
      name: "Resize Size column",
    });

    fireEvent.mouseDown(sizeHandle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: -1000 });

    expect(queryColumnWidths(container, "size")).toEqual(["72px", "72px"]);

    fireEvent.mouseUp(window);

    await waitFor(() =>
      expect(onUpdateSettings).toHaveBeenCalledWith({
        sftpBrowserColumnWidths: {
          ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS,
          size: 72,
        },
      }),
    );
  });

  it("keeps row selection working after adding resize handles", () => {
    const { onSelectEntry } = renderWorkspace();

    fireEvent.click(screen.getByText("left-alpha.txt"));

    expect(onSelectEntry).toHaveBeenCalledWith("left", {
      entryPath: "/left/left-alpha.txt",
      visibleEntryPaths: ["/left/left-alpha.txt"],
      toggle: false,
      range: false,
    });
  });

  it("renders host picker results in a dedicated scroll container", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();

    renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
    });

    const results = screen.getByLabelText("Available hosts for right pane");

    expect(results).toBeTruthy();
    expect(results.querySelector(".group-grid")).toBeTruthy();
    expect(results.querySelector(".host-grid")).toBeTruthy();
    expect(results.contains(screen.getByLabelText("Search hosts"))).toBe(false);
  });

  it("keeps rename, permissions, and delete actions out of the top toolbar", () => {
    renderWorkspace();

    expect(screen.queryByRole("button", { name: "이름 변경" })).toBeNull();
    expect(screen.queryByRole("button", { name: "권한" })).toBeNull();
    expect(screen.queryByLabelText("Delete selected items")).toBeNull();
    expect(screen.getAllByRole("button", { name: "새 폴더" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "새로고침" })).toHaveLength(2);
  });

  it("shows Warpgate hosts in the SFTP host picker", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();

    renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
    });

    expect(screen.getByText("Warpgate Prod")).toBeTruthy();
    expect(screen.getByText(/example\.user/)).toBeTruthy();
  });

  it("shows a disconnect button for connected host panes and returns control through the callback", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      sourceKind: "host",
      endpoint: {
        id: "endpoint-1",
        kind: "remote",
        hostId: "ssh-1",
        title: "synology",
        path: "/home/ubuntu",
        connectedAt: "2026-03-26T10:00:00.000Z",
      },
      currentPath: "/home/ubuntu",
      history: ["/home/ubuntu"],
      historyIndex: 0,
      entries: [createEntry("notes.txt", "/home/ubuntu")],
      selectedHostId: "ssh-1",
    });

    const { onDisconnectPane } = renderWorkspace({ sftp });

    expect(screen.getByText("synology")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("연결 종료"));

    await waitFor(() => expect(onDisconnectPane).toHaveBeenCalledWith("right"));
  });

  it("shows a connecting overlay and disables host picker controls while connecting", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      connectingHostId: "ssh-1",
      connectingEndpointId: "endpoint-1",
      selectedHostId: "ssh-1",
      isLoading: true,
    });

    const { container } = renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
    });

    expect(
      screen.getByLabelText("SFTP host connection in progress"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Available hosts for right pane"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Search hosts")).toBeDisabled();
    expect(screen.getByLabelText("Connecting selected host")).toBeTruthy();
    expect(screen.getByText("Prod SSH 연결 중...")).toBeTruthy();
    expect(
      container.querySelector(".host-browser-card.connecting"),
    ).toBeTruthy();
  });

  it("renders endpoint-scoped Warpgate approval UI for SFTP panes", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      connectingHostId: "warpgate-1",
      connectingEndpointId: "endpoint-warp",
      selectedHostId: "warpgate-1",
      isLoading: true,
    });
    const onReopenInteractiveAuthUrl = vi.fn().mockResolvedValue(undefined);
    const onClearInteractiveAuth = vi.fn();

    renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
      interactiveAuth: {
        source: "sftp",
        paneId: "right",
        endpointId: "endpoint-warp",
        hostId: "warpgate-1",
        challengeId: "challenge-1",
        name: "warpgate",
        instruction:
          "Open https://warpgate.example.com/authorize and approve this request.",
        prompts: [],
        provider: "warpgate",
        approvalUrl: "https://warpgate.example.com/authorize",
        authCode: "ABCD-1234",
        autoSubmitted: true,
      } satisfies PendingSftpInteractiveAuth,
      onReopenInteractiveAuthUrl,
      onClearInteractiveAuth,
    });

    expect(
      screen.getByLabelText("SFTP interactive authentication required"),
    ).toBeTruthy();
    expect(screen.getByText("Warpgate 승인을 기다리는 중입니다.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "브라우저 다시 열기" }));
    await waitFor(() =>
      expect(onReopenInteractiveAuthUrl).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClearInteractiveAuth).toHaveBeenCalledTimes(1);
  });

  it("shows host picker errors when connection setup fails before browsing", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      errorMessage: "Timed out waiting for SSH core response: probeHostKey",
    });

    renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
    });

    expect(
      screen.getByText("Timed out waiting for SSH core response: probeHostKey"),
    ).toBeTruthy();
  });

  it("opens a styled delete dialog and waits for confirmation before deleting", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const sftp = createSftpState();
    sftp.leftPane.selectedPaths = ["/left/left-alpha.txt"];
    sftp.rightPane = createHostPickerPane();
    const onDeleteSelection = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      sftp,
      onDeleteSelection,
    });

    const contextMenu = openEntryContextMenu("left-alpha.txt");
    fireEvent.click(within(contextMenu).getByRole("button", { name: "삭제" }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText("SFTP delete confirmation")).toBeTruthy();
    expect(screen.getByText('"left-alpha.txt"을 삭제할까요?')).toBeTruthy();
    expect(onDeleteSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(onDeleteSelection).toHaveBeenCalledWith("left"));
    confirmSpy.mockRestore();
  });

  it("treats delete dialog backdrop clicks as cancel", () => {
    const sftp = createSftpState();
    sftp.leftPane.selectedPaths = ["/left/left-alpha.txt"];
    sftp.rightPane = createHostPickerPane();
    const onDeleteSelection = vi.fn().mockResolvedValue(undefined);

    const { container } = renderWorkspace({
      sftp,
      onDeleteSelection,
    });

    const contextMenu = openEntryContextMenu("left-alpha.txt");
    fireEvent.click(within(contextMenu).getByRole("button", { name: "삭제" }));
    fireEvent.click(
      container.querySelector(".sftp-modal-backdrop") as HTMLElement,
    );

    expect(onDeleteSelection).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("SFTP delete confirmation")).toBeNull();
  });

  it("shows folder warnings and keeps the delete dialog open on failure", async () => {
    const onDeleteSelection = vi
      .fn()
      .mockRejectedValue(new Error("Delete failed"));
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();
    sftp.leftPane.entries = [
      {
        name: "logs",
        path: "/left/logs",
        isDirectory: true,
        size: 0,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "folder",
        permissions: "drwxr-xr-x",
      },
    ];
    sftp.leftPane.selectedPaths = ["/left/logs"];

    renderWorkspace({
      sftp,
      onDeleteSelection,
    });

    const contextMenu = openEntryContextMenu("logs");
    fireEvent.click(within(contextMenu).getByRole("button", { name: "삭제" }));

    expect(
      screen.getByText("폴더를 삭제하면 하위 항목도 함께 삭제됩니다."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await screen.findByText("Delete failed");
    expect(screen.getByLabelText("SFTP delete confirmation")).toBeTruthy();
  });

  it("does not dismiss the conflict dialog on backdrop clicks", () => {
    const sftp = createSftpState();
    sftp.pendingConflictDialog = {
      input: {} as never,
      names: ["dup.txt"],
    };
    const onDismissConflict = vi.fn();
    const { container } = renderWorkspace({
      sftp,
      onDismissConflict,
    });

    fireEvent.click(
      container.querySelector(".sftp-modal-backdrop") as HTMLElement,
    );

    expect(onDismissConflict).not.toHaveBeenCalled();
    expect(screen.getByText("dup.txt")).toBeTruthy();
  });
});
