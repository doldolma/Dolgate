import { describe, expect, it } from 'vitest';
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
import { getHostBrowserCardClassName } from './HostBrowser';

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
});
