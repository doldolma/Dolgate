import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resolveResponsiveCardGridLayout } from "../lib/responsive-card-grid";
import { SftpWorkspace } from "./SftpWorkspace";

const resizeObserverInstances: MockResizeObserver[] = [];

function getObservedWidth(element: Element): number {
  const width = Number((element as HTMLElement).dataset.testWidth ?? "0");
  return Number.isFinite(width) ? width : 0;
}

function createObservedRect(element: Element): DOMRectReadOnly {
  const width = getObservedWidth(element);
  return {
    width,
    height: 0,
    top: 0,
    right: width,
    bottom: 0,
    left: 0,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRectReadOnly;
}

class MockResizeObserver {
  observedElements = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
  }

  observe = (element: Element) => {
    this.observedElements.add(element);
    this.callback(
      [{ target: element, contentRect: createObservedRect(element) } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  };

  unobserve = (element: Element) => {
    this.observedElements.delete(element);
  };

  disconnect = () => {
    this.observedElements.clear();
  };

  notify(element: Element) {
    this.callback(
      [{ target: element, contentRect: createObservedRect(element) } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function setObservedWidth(element: HTMLElement, width: number) {
  element.dataset.testWidth = String(width);
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => createObservedRect(element),
  });
}

function triggerResize(element: HTMLElement) {
  resizeObserverInstances.forEach((instance) => {
    if (instance.observedElements.has(element)) {
      instance.notify(element);
    }
  });
}

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
  sessionReplayRetentionCount: 100,
  serverUrl: "https://ssh.doldolma.com",
  serverUrlOverride: null,
  dismissedUpdateVersion: null,
  updatedAt: "2026-03-26T00:00:00.000Z",
};

beforeEach(() => {
  resizeObserverInstances.length = 0;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  resizeObserverInstances.length = 0;
  vi.unstubAllGlobals();
});

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

function createAwsHost(
  overrides: Partial<Extract<HostRecord, { kind: "aws-ec2" }>> = {},
): Extract<HostRecord, { kind: "aws-ec2" }> {
  return {
    id: "aws-1",
    kind: "aws-ec2",
    label: "AWS Linux",
    awsProfileName: "default",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-abc",
    awsAvailabilityZone: "ap-northeast-2a",
    awsInstanceName: "web-1",
    awsPlatform: "Linux/UNIX",
    awsPrivateIp: "10.0.0.10",
    awsState: "running",
    awsSshUsername: "ubuntu",
    awsSshPort: 22,
    awsSshMetadataStatus: "ready",
    awsSshMetadataError: null,
    groupName: "Production",
    tags: ["prod"],
    terminalThemeId: null,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

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
  const sftp = overrides.sftp ?? createSftpState();
  const transfers: SftpState["transfers"] =
    overrides.transfers ??
    ("transfers" in sftp ? (sftp as SftpState).transfers : []);
  const onUpdateSettings = vi.fn().mockResolvedValue(undefined);
  const onDisconnectPane = vi.fn().mockResolvedValue(undefined);
  const onSelectEntry = vi.fn();
  const onDeleteSelection = vi.fn().mockResolvedValue(undefined);
  const onNavigateBreadcrumb = vi.fn().mockResolvedValue(undefined);
  const onListLocalRoots = vi
    .fn()
    .mockResolvedValue([{ label: "/", path: "/" }]);
  const onGetPathForDroppedFile = vi
    .fn()
    .mockImplementation((file: File) => `/Users/tester/Drop/${file.name}`);
  const onPrepareExternalTransfer = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <SftpWorkspace
      desktopPlatform="darwin"
      hosts={[]}
      groups={[]}
      sftp={sftp}
      transfers={transfers}
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
      onNavigateBreadcrumb={onNavigateBreadcrumb}
      onListLocalRoots={onListLocalRoots}
      onGetPathForDroppedFile={onGetPathForDroppedFile}
      onSelectEntry={onSelectEntry}
      onCreateDirectory={vi.fn().mockResolvedValue(undefined)}
      onRenameSelection={vi.fn().mockResolvedValue(undefined)}
      onChangeSelectionPermissions={vi.fn().mockResolvedValue(undefined)}
      onDeleteSelection={onDeleteSelection}
      onDownloadSelection={vi.fn().mockResolvedValue(undefined)}
      onPrepareTransfer={vi.fn().mockResolvedValue(undefined)}
      onPrepareExternalTransfer={onPrepareExternalTransfer}
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
    onListLocalRoots,
    onNavigateBreadcrumb,
    onUpdateSettings,
    onSelectEntry,
    onDeleteSelection,
    onGetPathForDroppedFile,
    onPrepareExternalTransfer,
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

  it("does not re-enter a render loop when equivalent column widths arrive in a new settings object", () => {
    const { container, rerender } = renderWorkspace();

    rerender(
      <SftpWorkspace
        desktopPlatform="darwin"
        hosts={[]}
        groups={[]}
        sftp={createSftpState()}
        transfers={[]}
        settings={{
          ...baseSettings,
          sftpBrowserColumnWidths: { ...DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS },
        }}
        interactiveAuth={null}
        onActivatePaneSource={vi.fn().mockResolvedValue(undefined)}
        onDisconnectPane={vi.fn().mockResolvedValue(undefined)}
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
        onListLocalRoots={vi.fn().mockResolvedValue([{ label: "/", path: "/" }])}
        onGetPathForDroppedFile={vi.fn().mockReturnValue(null)}
        onSelectEntry={vi.fn()}
        onCreateDirectory={vi.fn().mockResolvedValue(undefined)}
        onRenameSelection={vi.fn().mockResolvedValue(undefined)}
        onChangeSelectionPermissions={vi.fn().mockResolvedValue(undefined)}
        onDeleteSelection={vi.fn().mockResolvedValue(undefined)}
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
        onUpdateSettings={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(queryColumnWidths(container, "name")).toEqual(["360px", "360px"]);
    expect(queryColumnWidths(container, "dateModified")).toEqual([
      "168px",
      "168px",
    ]);
    expect(queryColumnWidths(container, "size")).toEqual(["96px", "96px"]);
    expect(queryColumnWidths(container, "kind")).toEqual(["96px", "96px"]);
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

  it("uploads Finder-style dropped files to the connected host pane", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      sourceKind: "host",
      endpoint: {
        id: "endpoint-1",
        kind: "remote",
        hostId: "ssh-1",
        title: "Prod SSH",
        path: "/remote",
        connectedAt: "2026-03-26T10:00:00.000Z",
      },
      currentPath: "/remote",
      history: ["/remote"],
      historyIndex: 0,
      entries: [],
      selectedHostId: "ssh-1",
    });
    const uploadFile = new File(["payload"], "upload.txt");
    const { container, onGetPathForDroppedFile, onPrepareExternalTransfer } =
      renderWorkspace({ sftp });
    const rightPane = container.querySelector(
      '[data-pane-id="right"]',
    ) as HTMLElement;
    const dataTransfer = {
      types: ["Files"],
      files: [uploadFile],
      getData: vi.fn().mockReturnValue(""),
      dropEffect: "none",
    };

    fireEvent.dragOver(rightPane, { dataTransfer });
    fireEvent.drop(rightPane, { dataTransfer });

    await waitFor(() => {
      expect(onGetPathForDroppedFile).toHaveBeenCalledWith(uploadFile);
      expect(onPrepareExternalTransfer).toHaveBeenCalledWith("right", "/remote", [
        "/Users/tester/Drop/upload.txt",
      ]);
    });
  });

  it("enables downloads for remote folders and multiple selected entries", () => {
    const sftp = createSftpState();
    sftp.rightPane = {
      ...createPane("right", createEntry("report.txt", "/remote")),
      sourceKind: "host",
      endpoint: {
        id: "endpoint-1",
        kind: "remote",
        hostId: "ssh-1",
        title: "Prod SSH",
        path: "/remote",
        connectedAt: "2026-03-26T10:00:00.000Z",
      },
      currentPath: "/remote",
      history: ["/remote"],
      entries: [
        {
          name: "logs",
          path: "/remote/logs",
          isDirectory: true,
          size: 0,
          mtime: "2026-03-26T10:00:00.000Z",
          kind: "folder",
          permissions: "rwxr-xr-x",
        },
        {
          name: "report.txt",
          path: "/remote/report.txt",
          isDirectory: false,
          size: 128,
          mtime: "2026-03-26T10:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
        },
      ],
      selectedPaths: ["/remote/logs", "/remote/report.txt"],
    };

    renderWorkspace({ sftp });

    fireEvent.contextMenu(screen.getByText("logs"), {
      clientX: 120,
      clientY: 160,
    });

    expect(screen.getByRole("button", { name: "다운로드" })).not.toBeDisabled();
  });

  it("keeps download disabled for local pane selections", () => {
    const sftp = createSftpState();
    sftp.leftPane.entries = [
      {
        name: "local-folder",
        path: "/left/local-folder",
        isDirectory: true,
        size: 0,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "folder",
        permissions: "rwxr-xr-x",
      },
    ];
    sftp.leftPane.selectedPaths = ["/left/local-folder"];

    renderWorkspace({ sftp });

    fireEvent.contextMenu(screen.getByText("local-folder"), {
      clientX: 120,
      clientY: 160,
    });

    expect(screen.getByRole("button", { name: "다운로드" })).toBeDisabled();
  });

  it("replaces D/F badges with file icons and readable kind labels in both panes", () => {
    const sftp = createSftpState();
    sftp.leftPane.entries = [
      {
        name: "photos",
        path: "/left/photos",
        isDirectory: true,
        size: 0,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "folder",
        permissions: "drwxr-xr-x",
      },
      {
        name: "report.PDF",
        path: "/left/report.PDF",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
      {
        name: "cover.png",
        path: "/left/cover.png",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
      {
        name: "backup.tar.gz",
        path: "/left/backup.tar.gz",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
    ];
    sftp.rightPane = {
      ...createPane("right", createEntry("deploy.ts", "/remote")),
      sourceKind: "host",
      endpoint: {
        id: "endpoint-1",
        kind: "remote",
        hostId: "ssh-1",
        title: "Prod SSH",
        path: "/remote",
        connectedAt: "2026-03-26T10:00:00.000Z",
      },
      currentPath: "/remote",
      history: ["/remote"],
      entries: [
        {
          name: "deploy.ts",
          path: "/remote/deploy.ts",
          isDirectory: false,
          size: 128,
          mtime: "2026-03-26T10:00:00.000Z",
          kind: "file",
          permissions: "rw-r--r--",
        },
        {
          name: "latest",
          path: "/remote/latest",
          isDirectory: false,
          size: 0,
          mtime: "2026-03-26T10:00:00.000Z",
          kind: "symlink",
          permissions: "rwxr-xr-x",
        },
      ],
    };

    renderWorkspace({ sftp });

    expect(screen.queryByText(/^D$/)).toBeNull();
    expect(screen.queryByText(/^F$/)).toBeNull();

    const folderRow = screen.getByText("photos").closest("tr") as HTMLElement;
    expect(
      folderRow.querySelector('[data-file-icon="folder"][data-file-kind="folder"]'),
    ).toBeTruthy();
    expect(within(folderRow).getByText("Folder")).toBeTruthy();

    const pdfRow = screen.getByText("report.PDF").closest("tr") as HTMLElement;
    expect(
      pdfRow.querySelector('[data-file-icon="pdf"][data-file-kind="file"]'),
    ).toBeTruthy();
    expect(within(pdfRow).getByText("File")).toBeTruthy();

    const imageRow = screen.getByText("cover.png").closest("tr") as HTMLElement;
    expect(
      imageRow.querySelector('[data-file-icon="image"][data-file-kind="file"]'),
    ).toBeTruthy();

    const archiveRow = screen.getByText("backup.tar.gz").closest("tr") as HTMLElement;
    expect(
      archiveRow.querySelector('[data-file-icon="archive"][data-file-kind="file"]'),
    ).toBeTruthy();

    const codeRow = screen.getByText("deploy.ts").closest("tr") as HTMLElement;
    expect(
      codeRow.querySelector('[data-file-icon="code"][data-file-kind="file"]'),
    ).toBeTruthy();
    expect(within(codeRow).getByText("File")).toBeTruthy();

    const symlinkRow = screen.getByText("latest").closest("tr") as HTMLElement;
    expect(
      symlinkRow.querySelector('[data-file-icon="symlink"][data-file-kind="symlink"]'),
    ).toBeTruthy();
    expect(within(symlinkRow).getByText("Link")).toBeTruthy();
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
    expect(within(results).queryByText("Groups")).toBeNull();
    expect(within(results).getByText("Hosts")).toBeTruthy();
    expect(results.querySelector('[data-group-grid="true"]')).toBeTruthy();
    const groupCard = results.querySelector(
      '[data-group-card="true"][data-host-card="true"]',
    ) as HTMLElement | null;
    expect(groupCard).toBeTruthy();
    expect(
      groupCard?.querySelector('[data-host-card-badge="folder"] svg'),
    ).toBeTruthy();
    expect(within(groupCard as HTMLElement).queryByText("DIR")).toBeNull();
    expect(within(groupCard as HTMLElement).getByText("Group")).toBeTruthy();
    expect(results.querySelector('[data-host-grid="true"]')).toBeTruthy();
    expect(results.contains(screen.getByLabelText("Search hosts"))).toBe(false);
  });

  it("renders the current host group as a compact breadcrumb with a clear root label", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      hostGroupPath: "Production/API",
    });
    const onNavigateHostGroup = vi.fn();

    renderWorkspace({
      hosts: [
        ...connectableHosts,
        {
          ...connectableHosts[0],
          id: "ssh-api",
          label: "API SSH",
          groupName: "Production/API",
        },
      ],
      groups: [
        ...hostGroups,
        {
          id: "group-2",
          name: "API",
          path: "Production/API",
          parentPath: "Production",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
      ],
      sftp,
      onNavigateHostGroup,
    });

    const breadcrumb = screen.getByLabelText("Host group path for right pane");
    expect(
      within(breadcrumb).getByRole("button", { name: "All Groups" }),
    ).toBeTruthy();
    expect(
      within(breadcrumb).getByRole("button", { name: "Production" }),
    ).toBeTruthy();
    expect(within(breadcrumb).getByText("API")).toBeTruthy();

    fireEvent.click(
      within(breadcrumb).getByRole("button", { name: "All Groups" }),
    );
    fireEvent.click(
      within(breadcrumb).getByRole("button", { name: "Production" }),
    );

    expect(onNavigateHostGroup).toHaveBeenNthCalledWith(1, "right", null);
    expect(onNavigateHostGroup).toHaveBeenNthCalledWith(
      2,
      "right",
      "Production",
    );
  });

  it("renders Windows local breadcrumbs without a fake slash root", async () => {
    const sftp = createSftpState();
    sftp.leftPane = createPane("left", createEntry("report.txt", "D:\\work\\repo"));
    sftp.leftPane.currentPath = "D:\\work\\repo";
    sftp.leftPane.lastLocalPath = "D:\\work\\repo";
    sftp.leftPane.history = ["D:\\work\\repo"];
    sftp.leftPane.entries = [
      {
        name: "report.txt",
        path: "D:\\work\\repo\\report.txt",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
    ];
    const onNavigateBreadcrumb = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      desktopPlatform: "win32",
      sftp,
      onNavigateBreadcrumb,
    });

    const breadcrumb = screen.getByLabelText("Local path for left pane");
    expect(within(breadcrumb).queryByRole("button", { name: "/" })).toBeNull();
    expect(within(breadcrumb).getByRole("button", { name: "D:" })).toBeTruthy();
    expect(within(breadcrumb).getByRole("button", { name: "work" })).toBeTruthy();
    expect(within(breadcrumb).getByText("repo")).toBeTruthy();

    fireEvent.click(within(breadcrumb).getByRole("button", { name: "work" }));

    await waitFor(() =>
      expect(onNavigateBreadcrumb).toHaveBeenCalledWith("left", "D:\\work"),
    );
  });

  it("opens a Windows drive picker from the drive breadcrumb and navigates to the selected root", async () => {
    const sftp = createSftpState();
    sftp.leftPane = createPane("left", createEntry("report.txt", "D:\\work\\repo"));
    sftp.leftPane.currentPath = "D:\\work\\repo";
    sftp.leftPane.lastLocalPath = "D:\\work\\repo";
    sftp.leftPane.history = ["D:\\work\\repo"];
    sftp.leftPane.entries = [
      {
        name: "report.txt",
        path: "D:\\work\\repo\\report.txt",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
    ];
    const onListLocalRoots = vi.fn().mockResolvedValue([
      { label: "C:", path: "C:\\" },
      { label: "D:", path: "D:\\" },
    ]);
    const onNavigateBreadcrumb = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      desktopPlatform: "win32",
      sftp,
      onListLocalRoots,
      onNavigateBreadcrumb,
    });

    const breadcrumb = screen.getByLabelText("Local path for left pane");
    fireEvent.click(within(breadcrumb).getByRole("button", { name: "D:" }));

    await waitFor(() => expect(onListLocalRoots).toHaveBeenCalledTimes(1));

    const driveMenu = screen.getByLabelText("Local drive selector for left pane");
    expect(within(driveMenu).getByRole("menuitem", { name: "C:" })).toBeTruthy();
    expect(
      within(driveMenu).getByRole("menuitem", { name: "D:" }),
    ).toBeTruthy();

    fireEvent.click(within(driveMenu).getByRole("menuitem", { name: "C:" }));

    await waitFor(() =>
      expect(onNavigateBreadcrumb).toHaveBeenCalledWith("left", "C:\\"),
    );
  });

  it("allows reselecting the current Windows drive to jump back to the drive root", async () => {
    const sftp = createSftpState();
    sftp.leftPane = createPane("left", createEntry("report.txt", "D:\\work\\repo"));
    sftp.leftPane.currentPath = "D:\\work\\repo";
    sftp.leftPane.lastLocalPath = "D:\\work\\repo";
    sftp.leftPane.history = ["D:\\work\\repo"];
    sftp.leftPane.entries = [
      {
        name: "report.txt",
        path: "D:\\work\\repo\\report.txt",
        isDirectory: false,
        size: 128,
        mtime: "2026-03-26T10:00:00.000Z",
        kind: "file",
        permissions: "rw-r--r--",
      },
    ];
    const onListLocalRoots = vi.fn().mockResolvedValue([
      { label: "C:", path: "C:\\" },
      { label: "D:", path: "D:\\" },
    ]);
    const onNavigateBreadcrumb = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      desktopPlatform: "win32",
      sftp,
      onListLocalRoots,
      onNavigateBreadcrumb,
    });

    const breadcrumb = screen.getByLabelText("Local path for left pane");
    fireEvent.click(within(breadcrumb).getByRole("button", { name: "D:" }));

    const driveMenu = await screen.findByLabelText(
      "Local drive selector for left pane",
    );
    fireEvent.click(within(driveMenu).getByRole("menuitem", { name: "D:" }));

    await waitFor(() =>
      expect(onNavigateBreadcrumb).toHaveBeenCalledWith("left", "D:\\"),
    );
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

  it("shows AWS Linux hosts in the SFTP host picker and allows connecting them", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();
    const onConnectHost = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      hosts: [...connectableHosts, createAwsHost()],
      groups: hostGroups,
      sftp,
      onConnectHost,
    });

    const awsCard = screen.getByText("AWS Linux").closest('[data-host-card="true"]');
    expect(awsCard).toBeTruthy();

    fireEvent.doubleClick(awsCard as HTMLElement);

    await waitFor(() =>
      expect(onConnectHost).toHaveBeenCalledWith("right", "aws-1"),
    );
  });

  it("applies the shared responsive card grid sizing in the host picker", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();

    renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
    });

    const results = screen.getByLabelText("Available hosts for right pane");
    const groupGrid = results.querySelector('[data-group-grid="true"]') as HTMLElement;
    const hostGrid = results.querySelector('[data-host-grid="true"]') as HTMLElement;

    setObservedWidth(groupGrid, 1200);
    triggerResize(groupGrid);
    setObservedWidth(hostGrid, 1200);
    triggerResize(hostGrid);

    const expectedGroupLayout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 1,
      minWidth: 220,
      maxWidth: 460,
      gap: 12,
    });
    const expectedHostLayout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 3,
      minWidth: 220,
      maxWidth: 460,
      gap: 12,
    });

    await waitFor(() => {
      expect(groupGrid.style.gridTemplateColumns).toBe(
        expectedGroupLayout.gridTemplateColumns,
      );
      expect(groupGrid.style.justifyContent).toBe("start");
      expect(hostGrid.style.gridTemplateColumns).toBe(
        expectedHostLayout.gridTemplateColumns,
      );
    });

    expect(screen.getByText("Prod SSH")).toBeTruthy();
    expect(screen.getByText("Warpgate Prod")).toBeTruthy();
  });

  it("navigates SFTP host groups only on double click, matching Home", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();
    const onNavigateHostGroup = vi.fn();

    const { container } = renderWorkspace({
      hosts: connectableHosts,
      groups: hostGroups,
      sftp,
      onNavigateHostGroup,
    });

    const groupCard = container.querySelector('[data-group-grid="true"] [data-group-card="true"]');
    expect(groupCard).toBeTruthy();

    fireEvent.click(groupCard as HTMLElement);
    expect(onNavigateHostGroup).not.toHaveBeenCalled();

    fireEvent.doubleClick(groupCard as HTMLElement);
    expect(onNavigateHostGroup).toHaveBeenCalledWith("right", "Production");
  });

  it("shows a disabled reason for unsupported AWS Windows hosts", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();

    renderWorkspace({
      hosts: [
        ...connectableHosts,
        createAwsHost({
          id: "aws-win",
          label: "AWS Windows",
          awsPlatform: "Windows",
        }),
      ],
      groups: hostGroups,
      sftp,
    });

    const awsCard = screen.getByText("AWS Windows").closest('[data-host-card="true"]');
    expect(awsCard).toBeTruthy();
    expect((awsCard as HTMLElement | null)?.dataset.hostCardState).toBe("disabled");
    expect(
      within(awsCard as HTMLElement).getByText("Windows 인스턴스는 아직 지원하지 않습니다."),
    ).toBeTruthy();
  });

  it("offers a settings shortcut when an AWS host is missing SSH username", async () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane();
    const onOpenHostSettings = vi.fn();

    renderWorkspace({
      hosts: [
        ...connectableHosts,
        createAwsHost({
          id: "aws-missing-user",
          label: "AWS Missing User",
          awsSshUsername: null,
        }),
      ],
      groups: hostGroups,
      sftp,
      onOpenHostSettings,
    });

    fireEvent.click(screen.getByRole("button", { name: "설정 열기" }));

    expect(onOpenHostSettings).toHaveBeenCalledWith("aws-missing-user");
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
    const disconnectButton = screen.getByLabelText("연결 종료");

    expect(disconnectButton.querySelector("svg")).toBeTruthy();
    fireEvent.click(disconnectButton);

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
    expect(container.querySelector('[data-host-card-state="busy"]')).toBeTruthy();
  });

  it("renders AWS SFTP progress details inside the connecting overlay", () => {
    const sftp = createSftpState();
    sftp.rightPane = createHostPickerPane({
      connectingHostId: "aws-1",
      connectingEndpointId: "endpoint-aws",
      selectedHostId: "aws-1",
      isLoading: true,
      connectionProgress: {
        endpointId: "endpoint-aws",
        hostId: "aws-1",
        stage: "sending-public-key",
        message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
      },
    });

    renderWorkspace({
      hosts: [...connectableHosts, createAwsHost()],
      groups: hostGroups,
      sftp,
    });

    expect(screen.getByText("공개 키 전송")).toBeTruthy();
    expect(
      screen.getByText("EC2 Instance Connect로 공개 키를 전송하는 중입니다."),
    ).toBeTruthy();
  });

  it("renders browser warnings, errors, and loading state without legacy table wrappers", () => {
    const sftp = createSftpState();
    sftp.leftPane.warningMessages = ["권한이 제한된 항목은 숨겨집니다."];
    sftp.leftPane.errorMessage = "read failed";
    sftp.leftPane.isLoading = true;

    const { container } = renderWorkspace({ sftp });

    expect(
      screen.getByText("권한이 제한된 항목은 숨겨집니다."),
    ).toBeTruthy();
    expect(screen.getByText("read failed")).toBeTruthy();
    expect(screen.getByText("목록을 새로 읽는 중...")).toBeTruthy();
    expect(container.querySelector(".sftp-table-shell")).toBeNull();
    expect(container.querySelector(".terminal-warning-banner")).toBeNull();
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

  it("renders transfer cards and routes transfer actions without legacy transfer classes", async () => {
    const sftp = createSftpState();
    sftp.transfers = [
      {
        id: "transfer-running",
        sourceLabel: "left-alpha.txt",
        targetLabel: "/remote/left-alpha.txt",
        itemCount: 1,
        bytesCompleted: 64,
        bytesTotal: 128,
        speedBytesPerSecond: 1024,
        etaSeconds: 1,
        status: "running",
        startedAt: "2026-03-26T10:00:00.000Z",
        updatedAt: "2026-03-26T10:00:01.000Z",
      },
      {
        id: "transfer-failed",
        sourceLabel: "/remote/right-beta.txt",
        targetLabel: "/right/right-beta.txt",
        itemCount: 1,
        bytesCompleted: 10,
        bytesTotal: 128,
        speedBytesPerSecond: null,
        etaSeconds: null,
        status: "failed",
        startedAt: "2026-03-26T10:00:00.000Z",
        updatedAt: "2026-03-26T10:00:01.000Z",
      },
      {
        id: "transfer-complete",
        sourceLabel: "/remote/archive.log",
        targetLabel: "/right/archive.log",
        itemCount: 1,
        bytesCompleted: 128,
        bytesTotal: 128,
        speedBytesPerSecond: null,
        etaSeconds: null,
        status: "completed",
        startedAt: "2026-03-26T10:00:00.000Z",
        updatedAt: "2026-03-26T10:00:01.000Z",
      },
    ];
    const onCancelTransfer = vi.fn().mockResolvedValue(undefined);
    const onRetryTransfer = vi.fn().mockResolvedValue(undefined);
    const onDismissTransfer = vi.fn();

    const { container } = renderWorkspace({
      sftp,
      onCancelTransfer,
      onRetryTransfer,
      onDismissTransfer,
    });

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));
    const dismissButtons = screen.getAllByRole("button", { name: "닫기" });
    dismissButtons.forEach((button) => fireEvent.click(button));

    await waitFor(() =>
      expect(onCancelTransfer).toHaveBeenCalledWith("transfer-running"),
    );
    await waitFor(() =>
      expect(onRetryTransfer).toHaveBeenCalledWith("transfer-failed"),
    );
    expect(onDismissTransfer).toHaveBeenCalledWith("transfer-failed");
    expect(onDismissTransfer).toHaveBeenCalledWith("transfer-complete");
    expect(container.querySelector(".transfer-card")).toBeNull();
  });

  it("shows cancelling transfers as disabled until the cancelled event arrives", () => {
    const sftp = createSftpState();
    sftp.transfers = [
      {
        id: "transfer-cancelling",
        sourceLabel: "large.bin",
        targetLabel: "/remote/large.bin",
        itemCount: 1,
        bytesCompleted: 512,
        bytesTotal: 1024,
        speedBytesPerSecond: 2048,
        etaSeconds: 1,
        status: "cancelling",
        startedAt: "2026-03-26T10:00:00.000Z",
        updatedAt: "2026-03-26T10:00:01.000Z",
      },
    ];
    const onCancelTransfer = vi.fn().mockResolvedValue(undefined);
    const onDismissTransfer = vi.fn();

    renderWorkspace({
      sftp,
      onCancelTransfer,
      onDismissTransfer,
    });

    expect(screen.getAllByText("취소 중")).toHaveLength(2);
    expect(screen.getByText("취소 요청을 처리하는 중입니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "취소 중" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
    expect(onCancelTransfer).not.toHaveBeenCalled();
    expect(onDismissTransfer).not.toHaveBeenCalled();
  });

  it("shows the permissions dialog preview and applies the updated mode", async () => {
    const sftp = createSftpState();
    sftp.leftPane.selectedPaths = ["/left/left-alpha.txt"];
    sftp.rightPane = createHostPickerPane();
    const onChangeSelectionPermissions = vi.fn().mockResolvedValue(undefined);

    renderWorkspace({
      sftp,
      onChangeSelectionPermissions,
    });

    const contextMenu = openEntryContextMenu("left-alpha.txt");
    fireEvent.click(
      within(contextMenu).getByRole("button", { name: "권한 수정" }),
    );

    expect(screen.getByText(/0644/)).toBeTruthy();

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[2] as HTMLElement);

    expect(screen.getByText(/0744/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    await waitFor(() =>
      expect(onChangeSelectionPermissions).toHaveBeenCalledWith("left", 0o744),
    );
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
    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

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

    const backdrop = container.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(onDismissConflict).not.toHaveBeenCalled();
    expect(screen.getByText("dup.txt")).toBeTruthy();
  });
});
