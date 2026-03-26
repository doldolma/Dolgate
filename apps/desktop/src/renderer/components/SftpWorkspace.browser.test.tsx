import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS } from "@shared";
import type {
  AppSettings,
  FileEntry,
  GroupRecord,
  SshHostRecord,
} from "@shared";
import type { SftpPaneState, SftpState } from "../store/createAppStore";
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

const sshHosts: SshHostRecord[] = [
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
];

function createPane(id: "left" | "right", entry: FileEntry): SftpPaneState {
  const currentPath = id === "left" ? "/left" : "/right";
  return {
    id,
    sourceKind: "local",
    endpoint: null,
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
  const onSelectEntry = vi.fn();
  const onDeleteSelection = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <SftpWorkspace
      hosts={[]}
      groups={[]}
      sftp={createSftpState()}
      settings={baseSettings}
      onActivatePaneSource={vi.fn().mockResolvedValue(undefined)}
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
      onUpdateSettings={onUpdateSettings}
      {...overrides}
    />,
  );

  return {
    ...result,
    onUpdateSettings,
    onSelectEntry,
    onDeleteSelection,
  };
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
      hosts: sshHosts,
      groups: hostGroups,
      sftp,
    });

    const results = screen.getByLabelText("Available hosts for right pane");

    expect(results).toBeTruthy();
    expect(results.querySelector(".group-grid")).toBeTruthy();
    expect(results.querySelector(".host-grid")).toBeTruthy();
    expect(results.contains(screen.getByLabelText("Search hosts"))).toBe(false);
  });

  it("shows a connecting overlay and disables host picker controls while connecting", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      endpoint: {
        id: "endpoint-1",
        kind: "remote",
        hostId: "ssh-1",
        title: "Prod SSH",
        path: "/home/ubuntu",
        connectedAt: "2026-03-26T10:00:00.000Z",
      },
      connectingHostId: "ssh-1",
      selectedHostId: "ssh-1",
      isLoading: true,
    });

    const { container } = renderWorkspace({
      hosts: sshHosts,
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

  it("shows host picker errors when connection setup fails before browsing", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      errorMessage: "Timed out waiting for SSH core response: probeHostKey",
    });

    renderWorkspace({
      hosts: sshHosts,
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

    fireEvent.click(screen.getByLabelText("Delete selected items"));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText("SFTP delete confirmation")).toBeTruthy();
    expect(screen.getByText('"left-alpha.txt"을 삭제할까요?')).toBeTruthy();
    expect(onDeleteSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(onDeleteSelection).toHaveBeenCalledWith("left"));
    confirmSpy.mockRestore();
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

    fireEvent.click(screen.getByLabelText("Delete selected items"));

    expect(
      screen.getByText("폴더를 삭제하면 하위 항목도 함께 삭제됩니다."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await screen.findByText("Delete failed");
    expect(screen.getByLabelText("SFTP delete confirmation")).toBeTruthy();
  });
});
