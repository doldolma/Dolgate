import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
import type { GroupRecord, HostRecord } from '@shared';
import {
  HostBrowser,
  getHostBrowserCardClassName,
  getHostBrowserEmptyCalloutMessage,
  getHostBrowserVisibleImportMenuLabels,
  HOST_BROWSER_IMPORT_MENU_LABELS
} from './HostBrowser';

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

interface RenderBrowserOptions {
  desktopPlatform?: 'darwin' | 'win32' | 'linux' | 'unknown';
  groups?: GroupRecord[];
  hosts?: HostRecord[];
  currentGroupPath?: string | null;
  searchQuery?: string;
  onClearHostSelection?: ReturnType<typeof vi.fn>;
  onSelectHost?: ReturnType<typeof vi.fn>;
  onDuplicateHosts?: ReturnType<typeof vi.fn>;
  onRemoveGroup?: ReturnType<typeof vi.fn>;
  onRemoveHost?: ReturnType<typeof vi.fn>;
}

function renderBrowser({
  desktopPlatform = 'win32',
  groups: groupsOverride = groups,
  hosts: hostsOverride = hosts,
  currentGroupPath = null,
  searchQuery = '',
  onClearHostSelection = vi.fn(),
  onSelectHost = vi.fn(),
  onDuplicateHosts = vi.fn().mockResolvedValue(undefined),
  onRemoveGroup = vi.fn().mockResolvedValue(undefined),
  onRemoveHost = vi.fn().mockResolvedValue(undefined)
}: RenderBrowserOptions = {}) {
  return render(
    <HostBrowser
      desktopPlatform={desktopPlatform}
      hosts={hostsOverride}
      groups={groupsOverride}
      currentGroupPath={currentGroupPath}
      searchQuery={searchQuery}
      selectedHostId={null}
      onSearchChange={vi.fn()}
      onOpenLocalTerminal={vi.fn()}
      onCreateHost={vi.fn()}
      onOpenAwsImport={vi.fn()}
      onOpenOpenSshImport={vi.fn()}
      onOpenXshellImport={vi.fn()}
      onOpenTermiusImport={vi.fn()}
      onOpenWarpgateImport={vi.fn()}
      onCreateGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveGroup={onRemoveGroup}
      onNavigateGroup={vi.fn()}
      onClearHostSelection={onClearHostSelection}
      onSelectHost={onSelectHost}
      onEditHost={vi.fn()}
      onDuplicateHosts={onDuplicateHosts}
      onMoveHostToGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveHost={onRemoveHost}
      onConnectHost={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

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
        hostCount: 2
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
    expect(isDirectHostChild(hosts[1].groupName ?? null, 'Servers')).toBe(false);
    expect(isDirectHostChild(hosts[1].groupName ?? null, 'Servers/Nested')).toBe(true);
  });

  it('chooses the right delete dialog variant based on descendant counts', () => {
    expect(getGroupDeleteDialogVariant(0, 0)).toBe('simple');
    expect(getGroupDeleteDialogVariant(1, 0)).toBe('with-descendants');
    expect(getGroupDeleteDialogVariant(0, 2)).toBe('with-descendants');
  });

  it('shows subtree hosts when a parent group is selected', () => {
    expect(filterHostsInGroupTree(hosts, 'Servers').map((host) => host.label)).toEqual(['App', 'DB']);
  });

  it('keeps tags hidden until the toggle is pressed', () => {
    expect(getHostTagsToggleLabel(false, 1)).toBe('Tags (1)');
    expect(getHostTagsToggleLabel(true, 1)).toBe('Hide tags');
  });

  it('uses a fixed collapsed host card class and only adds the expanded class when tags are open', () => {
    expect(getHostBrowserCardClassName(false, false)).toBe('host-browser-card');
    expect(getHostBrowserCardClassName(true, false)).toBe('host-browser-card active');
    expect(getHostBrowserCardClassName(false, true)).toBe('host-browser-card host-browser-card--expanded');
  });

  it('defines import actions for the split-button menu in the expected order', () => {
    expect(HOST_BROWSER_IMPORT_MENU_LABELS).toEqual([
      'Import from AWS',
      'Import OpenSSH',
      'Import from Xshell',
      'Import from Termius',
      'Import from Warpgate'
    ]);
  });

  it('hides the Xshell import action outside Windows', () => {
    expect(getHostBrowserVisibleImportMenuLabels('win32')).toEqual([
      'Import from AWS',
      'Import OpenSSH',
      'Import from Xshell',
      'Import from Termius',
      'Import from Warpgate'
    ]);
    expect(getHostBrowserVisibleImportMenuLabels('darwin')).toEqual([
      'Import from AWS',
      'Import OpenSSH',
      'Import from Termius',
      'Import from Warpgate'
    ]);
  });

  it('updates the empty-state copy to reference the import menu', () => {
    expect(getHostBrowserEmptyCalloutMessage(0, '')).toBe('New Host 또는 Import 메뉴를 눌러 첫 번째 연결 대상을 추가해보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, 'nas')).toBe('검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, '')).toBe('New Host를 눌러 이 위치에 호스트를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.');
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

    fireEvent.click(container.querySelector('.home-modal-backdrop') as HTMLElement);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the group empty state only at the root level', () => {
    const { container } = renderBrowser({ groups: [], hosts: [] });

    expect(screen.getByRole('heading', { name: 'Groups' })).toBeInTheDocument();
    expect(container.querySelector('.group-grid .empty-callout')).toBeInTheDocument();
  });

  it('hides the groups section when a nested group has no child groups', () => {
    const { container } = renderBrowser({
      groups: [],
      hosts: [],
      currentGroupPath: 'Servers'
    });

    expect(screen.queryByRole('heading', { name: 'Groups' })).not.toBeInTheDocument();
    expect(container.querySelector('.group-grid')).toBeNull();
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
    expect(appCard.className).toContain('active');
    expect(dbCard.className).toContain('active');

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
    expect(appCard.className).toContain('active');
    expect(dbCard.className).toContain('active');
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
    const serversCard = screen
      .getAllByText('Servers')
      .find((node) => node.tagName === 'STRONG')
      ?.closest('article') as HTMLElement;

    fireEvent.click(appCard, { ctrlKey: true });
    fireEvent.click(serversCard, { ctrlKey: true });

    expect(appCard.className).toContain('active');
    expect(serversCard.className).toContain('active');

    fireEvent.contextMenu(serversCard);

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
});
