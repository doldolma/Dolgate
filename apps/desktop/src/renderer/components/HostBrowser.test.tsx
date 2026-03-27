import { fireEvent, render, screen } from '@testing-library/react';
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
import { HostBrowser, getHostBrowserCardClassName, getHostBrowserEmptyCalloutMessage, HOST_BROWSER_IMPORT_MENU_LABELS } from './HostBrowser';

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

function renderBrowser() {
  return render(
    <HostBrowser
      hosts={hosts}
      groups={groups}
      currentGroupPath={null}
      searchQuery=""
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
      onRemoveGroup={vi.fn().mockResolvedValue(undefined)}
      onNavigateGroup={vi.fn()}
      onSelectHost={vi.fn()}
      onEditHost={vi.fn()}
      onMoveHostToGroup={vi.fn().mockResolvedValue(undefined)}
      onRemoveHost={vi.fn().mockResolvedValue(undefined)}
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

  it('updates the empty-state copy to reference the import menu', () => {
    expect(getHostBrowserEmptyCalloutMessage(0, '')).toBe('New Host 또는 Import 메뉴를 눌러 첫 번째 연결 대상을 추가해보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, 'nas')).toBe('검색어를 지우거나 다른 호스트명으로 다시 찾아보세요.');
    expect(getHostBrowserEmptyCalloutMessage(2, '')).toBe('New Host를 눌러 이 위치에 호스트를 추가하거나, 다른 그룹으로 이동해 장치를 확인해보세요.');
  });
});

describe('HostBrowser dialogs', () => {
  it('closes the create-group dialog when the backdrop is clicked', () => {
    const { container } = renderBrowser();

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(container.querySelector('.home-modal-backdrop') as HTMLElement);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
