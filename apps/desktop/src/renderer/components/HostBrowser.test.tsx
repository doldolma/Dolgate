import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVisibleGroups,
  collectGroupPaths,
  filterHostsInGroupTree,
  getGroupDeleteDialogVariant,
  getHostTagsToggleLabel,
  isDirectHostChild,
  isGroupWithinPath,
  normalizeGroupPath
} from '@shared';
import type { GroupRecord, HostRecord, SecretMetadataRecord } from '@shared';
import {
  HostBrowser,
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS
} from './HostBrowser';
import { resolveResponsiveCardGridLayout } from '../lib/responsive-card-grid';

const resizeObserverInstances: MockResizeObserver[] = [];

function getObservedWidth(element: Element): number {
  const width = Number((element as HTMLElement).dataset.testWidth ?? '0');
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
    }
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
      this as unknown as ResizeObserver
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
      this as unknown as ResizeObserver
    );
  }
}

function setObservedWidth(element: HTMLElement, width: number) {
  element.dataset.testWidth = String(width);
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => createObservedRect(element)
  });
}

function triggerResize(element: HTMLElement) {
  resizeObserverInstances.forEach((instance) => {
    if (instance.observedElements.has(element)) {
      instance.notify(element);
    }
  });
}

const groups: GroupRecord[] = [
  {
    id: 'group-1',
    name: 'Servers',
    path: 'Servers',
    parentPath: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'group-2',
    name: 'Nested',
    path: 'Servers/Nested',
    parentPath: 'Servers',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const hosts: HostRecord[] = [
  {
    id: 'host-1',
    kind: 'ssh',
    label: 'App',
    hostname: 'app.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Servers',
    tags: ['app'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-1',
    kind: 'aws-ec2',
    label: 'AWS App',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-aws',
    awsAvailabilityZone: 'ap-northeast-2a',
    awsInstanceName: 'aws-app',
    awsPlatform: 'Linux/UNIX',
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    awsSshUsername: null,
    awsSshPort: null,
    awsSshMetadataStatus: 'loading',
    awsSshMetadataError: null,
    groupName: 'Servers',
    tags: ['app'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'host-2',
    kind: 'ssh',
    label: 'DB',
    hostname: 'db.example.com',
    port: 22,
    username: 'postgres',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Servers/Nested',
    tags: ['database'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret:host-1',
    label: 'App Secret',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    source: 'local_keychain',
    linkedHostCount: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    secretRef: 'secret:shared',
    label: 'Shared Secret',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    source: 'local_keychain',
    linkedHostCount: 2,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

interface RenderBrowserOptions {
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  groups?: GroupRecord[];
  hosts?: HostRecord[];
  keychainEntries?: SecretMetadataRecord[];
  currentGroupPath?: string | null;
  searchQuery?: string;
  selectedHostId?: string | null;
  onClearHostSelection?: ReturnType<typeof vi.fn>;
  onSelectHost?: ReturnType<typeof vi.fn>;
  onDuplicateHosts?: ReturnType<typeof vi.fn>;
  onRemoveGroup?: ReturnType<typeof vi.fn>;
  onMoveGroup?: ReturnType<typeof vi.fn>;
  onRenameGroup?: ReturnType<typeof vi.fn>;
  onRemoveHost?: ReturnType<typeof vi.fn>;
  onRemoveSecret?: ReturnType<typeof vi.fn>;
  onOpenHostContainers?: ReturnType<typeof vi.fn>;
  onNavigateGroup?: ReturnType<typeof vi.fn>;
  onOpenLocalTerminal?: ReturnType<typeof vi.fn>;
  onCreateHost?: ReturnType<typeof vi.fn>;
  onOpenAwsImport?: ReturnType<typeof vi.fn>;
  onOpenOpenSshImport?: ReturnType<typeof vi.fn>;
  onOpenXshellImport?: ReturnType<typeof vi.fn>;
  onOpenTermiusImport?: ReturnType<typeof vi.fn>;
  onOpenWarpgateImport?: ReturnType<typeof vi.fn>;
}

function renderBrowser({
  desktopPlatform = 'win32',
  groups: groupsOverride = groups,
  hosts: hostsOverride = hosts,
  keychainEntries: keychainEntriesOverride = keychainEntries,
  currentGroupPath = null,
  searchQuery = '',
  selectedHostId = null,
  onClearHostSelection = vi.fn(),
  onSelectHost = vi.fn(),
  onDuplicateHosts = vi.fn().mockResolvedValue(undefined),
  onRemoveGroup = vi.fn().mockResolvedValue(undefined),
  onMoveGroup = vi.fn().mockResolvedValue(undefined),
  onRenameGroup = vi.fn().mockResolvedValue(undefined),
  onRemoveHost = vi.fn().mockResolvedValue(undefined),
  onRemoveSecret = vi.fn().mockResolvedValue(undefined),
  onOpenHostContainers = vi.fn().mockResolvedValue(undefined),
  onNavigateGroup = vi.fn(),
  onOpenLocalTerminal = vi.fn(),
  onCreateHost = vi.fn(),
  onOpenAwsImport = vi.fn(),
  onOpenOpenSshImport = vi.fn(),
  onOpenXshellImport = vi.fn(),
  onOpenTermiusImport = vi.fn(),
  onOpenWarpgateImport = vi.fn(),
}: RenderBrowserOptions = {}) {
  return render(
    <HostBrowser
      desktopPlatform={desktopPlatform}
      hosts={hostsOverride}
      groups={groupsOverride}
      keychainEntries={keychainEntriesOverride}
      currentGroupPath={currentGroupPath}
      searchQuery={searchQuery}
      selectedHostId={selectedHostId}
      onSearchChange={vi.fn()}
      onOpenLocalTerminal={onOpenLocalTerminal}
      onCreateHost={onCreateHost}
      onOpenAwsImport={onOpenAwsImport}
      onOpenOpenSshImport={onOpenOpenSshImport}
      onOpenXshellImport={onOpenXshellImport}
      onOpenTermiusImport={onOpenTermiusImport}
      onOpenWarpgateImport={onOpenWarpgateImport}
      onCreateGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveGroup={onRemoveGroup}
      onMoveGroup={onMoveGroup}
      onRenameGroup={onRenameGroup}
      onNavigateGroup={onNavigateGroup}
      onClearHostSelection={onClearHostSelection}
      onSelectHost={onSelectHost}
      onEditHost={vi.fn()}
      onDuplicateHosts={onDuplicateHosts}
      onMoveHostToGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveHost={onRemoveHost}
      onRemoveSecret={onRemoveSecret}
      onConnectHost={vi.fn().mockResolvedValue(undefined)}
      onOpenHostContainers={onOpenHostContainers}
    />
  );
}

function createDataTransfer(): DataTransfer {
  const entries = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) {
        entries.delete(format);
      } else {
        entries.clear();
      }
    },
    getData: (format: string) => entries.get(format) ?? '',
    setData: (format: string, data: string) => {
      entries.set(format, data);
    },
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

beforeEach(() => {
  resizeObserverInstances.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  resizeObserverInstances.length = 0;
  vi.unstubAllGlobals();
});

describe('HostBrowser helpers', () => {
  it('normalizes group paths and checks membership within the current tree', () => {
    expect(normalizeGroupPath('  Servers // Nested  ')).toBe('Servers/Nested');
    expect(isGroupWithinPath('Servers/Nested', 'Servers')).toBe(true);
    expect(isGroupWithinPath('Other', 'Servers')).toBe(false);
  });

  it('collects ancestor group paths and builds only direct child group cards', () => {
    expect(collectGroupPaths(groups, hosts)).toEqual(['Servers', 'Servers/Nested']);

    expect(buildVisibleGroups(groups, hosts, null)).toEqual([
      {
        path: 'Servers',
        name: 'Servers',
        hostCount: 3
      }
    ]);

    expect(buildVisibleGroups(groups, hosts, 'Servers')).toEqual([
      {
        path: 'Servers/Nested',
        name: 'Nested',
        hostCount: 1
      }
    ]);
  });

  it('identifies only direct host children for the current group', () => {
    expect(isDirectHostChild(hosts[0].groupName ?? null, 'Servers')).toBe(true);
    expect(isDirectHostChild(hosts[2].groupName ?? null, 'Servers')).toBe(false);
    expect(isDirectHostChild(hosts[2].groupName ?? null, 'Servers/Nested')).toBe(true);
  });

  it('chooses the right delete dialog variant based on descendant counts', () => {
    expect(getGroupDeleteDialogVariant(0, 0)).toBe('simple');
    expect(getGroupDeleteDialogVariant(1, 0)).toBe('with-descendants');
    expect(getGroupDeleteDialogVariant(0, 2)).toBe('with-descendants');
  });

  it('shows subtree hosts when a parent group is selected', () => {
    expect(filterHostsInGroupTree(hosts, 'Servers').map((host) => host.label)).toEqual(['App', 'AWS App', 'DB']);
  });

  it('keeps tags hidden until the toggle is pressed', () => {
    expect(getHostTagsToggleLabel(false, 1)).toBe('Tags (1)');
    expect(getHostTagsToggleLabel(true, 1)).toBe('Hide tags');
  });

  it('describes host card state via data attributes instead of legacy class names', () => {
    const { container } = renderBrowser();

    const appCard = screen.getByText('App').closest('[data-host-card="true"]') as HTMLElement;
    expect(appCard.dataset.hostCardState).toBe('idle');

    fireEvent.click(appCard);
    expect(appCard.dataset.hostCardState).toBe('selected');

    fireEvent.click(within(appCard).getByRole('button', { name: /Tags \(1\)/ }));
    expect(appCard.className).toContain('h-auto');
  });

  it('defines import actions for the split-button menu in the expected order', () => {
    expect(HOST_BROWSER_IMPORT_MENU_LABELS).toEqual([
      'Import OpenSSH',
      'Import from Termius',
      'Import from Xshell',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
  });

  it('hides the Xshell import action outside Windows', () => {
    expect(getHostBrowserVisibleImportMenuLabels('win32')).toEqual([
      'Import OpenSSH',
      'Import from Termius',
      'Import from Xshell',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
    expect(getHostBrowserVisibleImportMenuLabels('darwin')).toEqual([
      'Import OpenSSH',
      'Import from Termius',
      'Import from Warpgate',
      'Import via AWS SSM'
    ]);
  });

  it('updates the empty-state copy to reference the import menu', () => {
    expect(getHostBrowserEmptyCalloutMessage(0, '')).toBe('New Host로 첫 번째 SSH host를 추가해보세요. 기존 설정이 있으면 OpenSSH import를 먼저 사용할 수 있습니다.');
    expect(getHostBrowserEmptyCalloutMessage(2, 'nas')).toBe('검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, '')).toBe('New Host를 눌러 이 위치에 SSH host를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.');
  });

  it('prioritizes New Host while routing the Import primary action to OpenSSH import', () => {
    const onCreateHost = vi.fn();
    const onOpenOpenSshImport = vi.fn();
    renderBrowser({ onCreateHost, onOpenOpenSshImport });

    const newHostButton = screen.getByRole('button', { name: 'New Host' });
    const importButton = screen.getByRole('button', { name: 'Import' });

    expect(newHostButton.className).toContain('bg-[var(--accent-strong)]');
    expect(importButton.className).toContain('bg-[var(--surface-elevated)]');

    fireEvent.click(importButton);

    expect(onCreateHost).not.toHaveBeenCalled();
    expect(onOpenOpenSshImport).toHaveBeenCalledTimes(1);
  });

  it('shows AWS SSH metadata status on AWS host cards', () => {
    renderBrowser();

    expect(screen.getByText('SSH 설정 확인 중')).toBeInTheDocument();
  });

  it('shows the containers action in the host context menu and opens the host-scoped page', async () => {
    const onOpenHostContainers = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onOpenHostContainers });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '컨테이너' }));

    await waitFor(() => {
      expect(onOpenHostContainers).toHaveBeenCalledWith('host-1');
    });
  });

  it('fills the host row width while staying within the configured maximum', async () => {
    const { container } = renderBrowser({
      currentGroupPath: 'Servers'
    });

    const hostGrid = container.querySelector('[data-host-grid="true"]') as HTMLElement;
    expect(hostGrid).toBeTruthy();

    setObservedWidth(hostGrid, 1200);
    triggerResize(hostGrid);

    const expectedLayout = resolveResponsiveCardGridLayout({
      containerWidth: 1200,
      itemCount: 3,
      minWidth: 280,
      maxWidth: 460,
      gap: 13.6
    });

    await waitFor(() => {
      expect(hostGrid.style.gridTemplateColumns).toBe(expectedLayout.gridTemplateColumns);
      expect(hostGrid.style.justifyContent).toBe('');
    });
  });
});

describe('HostBrowser dialogs', () => {
  it('shows the Xshell import menu item only on Windows', () => {
    const firstRender = renderBrowser({ desktopPlatform: 'darwin' });

    fireEvent.click(screen.getByRole('button', { name: 'Open import menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Import from Xshell' })).not.toBeInTheDocument();

    firstRender.unmount();

    renderBrowser({ desktopPlatform: 'win32' });

    fireEvent.click(screen.getByRole('button', { name: 'Open import menu' }));
    expect(screen.getByRole('menuitem', { name: 'Import from Xshell' })).toBeInTheDocument();
  });

  it('closes the create-group dialog when the backdrop is clicked', () => {
    const { container } = renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const backdrop = screen.getByTestId('host-browser-modal-backdrop');
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the group tree and navigates immediately when a group is clicked', () => {
    const onNavigateGroup = vi.fn();
    renderBrowser({ onNavigateGroup });

    const groupTree = screen.getByLabelText('Group tree');
    const treeQueries = within(groupTree);
    expect(groupTree).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /All Groups/ })).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /Servers/ })).toBeInTheDocument();
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.click(treeQueries.getByRole('button', { name: /Nested/ }));

    expect(onNavigateGroup).toHaveBeenCalledWith('Servers/Nested');
  });

  it('keeps the root group selection tint-based without drag shadows', () => {
    renderBrowser();

    const rootButton = screen.getByRole('button', { name: /All Groups/ });
    expect(rootButton.className).toContain('bg-[var(--selection-tint)]');
    expect(rootButton.className).toContain('border-[var(--selection-border)]');
    expect(rootButton.className).not.toContain('shadow-[0_0_0_2px');
  });

  it('moves a dragged group under another group row', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(clientsRow, { dataTransfer });
    fireEvent.dragOver(serversRow, { dataTransfer });
    fireEvent.drop(serversRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers');
    });
  });

  it('moves a dragged group to the root when dropped on All Groups', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onMoveGroup });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const rootRow = groupTree.getByRole('button', { name: /All Groups/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(nestedRow, { dataTransfer });
    fireEvent.dragOver(rootRow, { dataTransfer });
    fireEvent.drop(rootRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Servers/Nested', null);
    });
  });

  it('keeps group drop targets active even when dragover cannot read custom dataTransfer payloads', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const startDataTransfer = createDataTransfer();
    const emptyDataTransfer = createDataTransfer();

    fireEvent.dragStart(clientsRow, { dataTransfer: startDataTransfer });
    fireEvent.dragOver(serversRow, { dataTransfer: emptyDataTransfer });
    fireEvent.drop(serversRow, { dataTransfer: emptyDataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers');
    });
  });

  it('does not move a group into one of its descendants', () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onMoveGroup });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(serversRow, { dataTransfer });
    fireEvent.dragOver(nestedRow, { dataTransfer });
    fireEvent.drop(nestedRow, { dataTransfer });

    expect(onMoveGroup).not.toHaveBeenCalled();
  });

  it('lets the user toggle subgroup rows with the disclosure and group double click', () => {
    renderBrowser();

    const groupTree = screen.getByLabelText('Group tree');
    const treeQueries = within(groupTree);
    const disclosure = treeQueries.getByRole('button', { name: 'Collapse subgroup' });
    const serversRow = treeQueries.getByRole('button', { name: /Servers/ });

    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(treeQueries.queryByRole('button', { name: /Nested/ })).not.toBeInTheDocument();

    fireEvent.dblClick(serversRow);
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();

    fireEvent.dblClick(serversRow);
    expect(treeQueries.queryByRole('button', { name: /Nested/ })).not.toBeInTheDocument();

    fireEvent.click(treeQueries.getByRole('button', { name: 'Expand subgroup' }));
    expect(treeQueries.getByRole('button', { name: /Nested/ })).toBeInTheDocument();
  });

  it('keeps the groups area out of the main pane and shows the tree toggle instead', () => {
    const { container } = renderBrowser();

    expect(screen.getByLabelText('Group tree')).toBeInTheDocument();
    expect(container.querySelector('[data-group-grid="true"]')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Groups' })).not.toBeInTheDocument();
  });

  it('does not render a duplicate current group breadcrumb above the cards', () => {
    const { container } = renderBrowser({ currentGroupPath: 'Servers/Nested' });
    const content = screen.getByTestId('host-browser-content');

    expect(within(content).queryByText('All Groups')).not.toBeInTheDocument();
    expect(within(content).queryByText('Servers')).not.toBeInTheDocument();
    expect(within(content).queryByText('Nested')).not.toBeInTheDocument();
  });

  it('keeps ungrouped hosts only in the root view and does not add an Ungrouped tree node', () => {
    renderBrowser({
      hosts: [
        ...hosts,
        {
          id: 'host-3',
          kind: 'ssh',
          label: 'Ungrouped Host',
          hostname: 'ungrouped.example.com',
          port: 22,
          username: 'ubuntu',
          authType: 'password',
          privateKeyPath: null,
          secretRef: null,
          groupName: null,
          tags: [],
          terminalThemeId: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    });

    expect(screen.getByText('Ungrouped Host')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Group tree')).queryByRole('button', { name: /^Ungrouped(?:\s|$)/ })).not.toBeInTheDocument();
  });

  it('keeps the group tree visible even when there are no groups', () => {
    renderBrowser({ groups: [], hosts: [] });

    expect(screen.getByLabelText('Group tree')).toBeInTheDocument();
    expect(screen.getByText('아직 만든 그룹이 없습니다.')).toBeInTheDocument();
  });

  it('prefills the rename dialog from the group context menu and saves the new name', async () => {
    const onRenameGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onRenameGroup });

    const nestedRow = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Nested/ });

    fireEvent.contextMenu(nestedRow);
    fireEvent.click(screen.getByRole('button', { name: '이름 변경' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Group name') as HTMLInputElement;
    expect(input.value).toBe('Nested');

    fireEvent.change(input, { target: { value: 'API' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }));

    await waitFor(() => {
      expect(onRenameGroup).toHaveBeenCalledWith('Servers/Nested', 'API');
    });
  });

  it('uses only the dragged group when multiple groups are selected', async () => {
    const onMoveGroup = vi.fn().mockResolvedValue(undefined);
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ],
      onMoveGroup
    });

    const groupTree = within(screen.getByLabelText('Group tree'));
    const clientsRow = groupTree.getByRole('button', { name: /Clients/ });
    const serversRow = groupTree.getByRole('button', { name: /Servers/ });
    const nestedRow = groupTree.getByRole('button', { name: /Nested/ });
    const dataTransfer = createDataTransfer();

    fireEvent.click(serversRow, { ctrlKey: true });
    fireEvent.click(clientsRow, { ctrlKey: true });
    fireEvent.dragStart(clientsRow, { dataTransfer });
    fireEvent.dragOver(nestedRow, { dataTransfer });
    fireEvent.drop(nestedRow, { dataTransfer });

    await waitFor(() => {
      expect(onMoveGroup).toHaveBeenCalledWith('Clients', 'Servers/Nested');
    });
  });

  it('supports additive host selection and copies all selected hosts from the context menu', async () => {
    const onSelectHost = vi.fn();
    const onDuplicateHosts = vi.fn().mockResolvedValue(undefined);
    renderBrowser({ onSelectHost, onDuplicateHosts });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });

    expect(onSelectHost).toHaveBeenCalledTimes(1);
    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(dbCard.dataset.hostCardState).toBe('selected');

    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: '복사 (2개)' }));

    expect(onDuplicateHosts).toHaveBeenCalledWith(['host-1', 'host-2']);
  });

  it('supports shift range selection for hosts without changing the active drawer selection', () => {
    const onSelectHost = vi.fn();
    renderBrowser({ onSelectHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { shiftKey: true });

    expect(onSelectHost).toHaveBeenCalledTimes(1);
    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(dbCard.dataset.hostCardState).toBe('selected');
  });

  it('keeps mixed host and group selections but scopes the context menu to the clicked type', () => {
    renderBrowser({
      groups: [
        ...groups,
        {
          id: 'group-3',
          name: 'Clients',
          path: 'Clients',
          parentPath: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z'
        }
      ]
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const serversTreeItem = within(screen.getByLabelText('Group tree')).getByRole('button', { name: /Servers/ });

    fireEvent.click(appCard, { ctrlKey: true });
    fireEvent.click(serversTreeItem, { ctrlKey: true });

    expect(appCard.dataset.hostCardState).toBe('selected');
    expect(serversTreeItem.getAttribute('data-group-tree-state')).toBe('selected');

    fireEvent.contextMenu(serversTreeItem);

    expect(screen.queryByRole('button', { name: /복사/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /삭제/ })).toBeInTheDocument();
  });

  it('shows an in-app delete dialog for selected hosts instead of calling window.confirm', async () => {
    const onRemoveHost = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderBrowser({ onRemoveHost });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    const dbCard = screen.getByText('DB').closest('article') as HTMLElement;

    fireEvent.click(appCard);
    fireEvent.click(dbCard, { ctrlKey: true });
    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(onRemoveHost).toHaveBeenCalledTimes(2);
    });
  });

  it('offers to remove an unused local secret and keeps the checkbox enabled by default', async () => {
    const onRemoveHost = vi.fn().mockResolvedValue(undefined);
    const onRemoveSecret = vi.fn().mockResolvedValue(undefined);
    const hostsWithSecret: HostRecord[] = [
      {
        ...(hosts[0] as Extract<HostRecord, { kind: 'ssh' }>),
        secretRef: 'secret:host-1',
      },
      ...hosts.slice(1),
    ];

    renderBrowser({
      hosts: hostsWithSecret,
      onRemoveHost,
      onRemoveSecret,
    });

    const appCard = screen.getByText('App').closest('article') as HTMLElement;
    fireEvent.click(appCard);
    fireEvent.contextMenu(appCard);
    fireEvent.click(screen.getByRole('button', { name: /삭제/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: '더 이상 사용되지 않는 저장된 인증 정보 1개도 함께 삭제',
    });
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(onRemoveHost).toHaveBeenCalledWith('host-1'));
    await waitFor(() => expect(onRemoveSecret).toHaveBeenCalledWith('secret:host-1'));
  });
});
