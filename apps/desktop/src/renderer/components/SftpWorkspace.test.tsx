import { describe, expect, it } from 'vitest';
import type { SshHostRecord } from '@shared';
import type { SftpPaneState } from '../store/createAppStore';
import { breadcrumbParts, getSftpPaneTitle, groupHosts, hostPickerBreadcrumbs, visibleEntries, visibleHostPickerHosts } from './SftpWorkspace';

const sshHosts: SshHostRecord[] = [
  {
    id: 'ssh-1',
    kind: 'ssh',
    label: 'Prod SSH',
    hostname: 'prod.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Production',
    tags: ['prod'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'ssh-2',
    kind: 'ssh',
    label: 'Stage SSH',
    hostname: 'stage.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: ['stage'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'ssh-3',
    kind: 'ssh',
    label: 'Prod API',
    hostname: 'api.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Production/API',
    tags: ['prod'],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const pane: SftpPaneState = {
  id: 'left',
  sourceKind: 'local',
  endpoint: null,
  hostGroupPath: null,
  currentPath: '/Users/tester/projects',
  lastLocalPath: '/Users/tester',
  history: ['/Users/tester/projects'],
  historyIndex: 0,
  entries: [
    {
      name: 'README.md',
      path: '/Users/tester/projects/README.md',
      isDirectory: false,
      size: 12,
      mtime: '2025-01-01T00:00:00.000Z',
      kind: 'file',
      permissions: 'rw-r--r--'
    },
    {
      name: 'src',
      path: '/Users/tester/projects/src',
      isDirectory: true,
      size: 0,
      mtime: '2025-01-01T00:00:00.000Z',
      kind: 'folder',
      permissions: 'rwxr-xr-x'
    }
  ],
  selectedPaths: [],
  filterQuery: 'read',
  selectedHostId: null,
  hostSearchQuery: '',
  isLoading: false
};

describe('SftpWorkspace helpers', () => {
  it('groups SSH hosts by group name and falls back to Ungrouped', () => {
    expect(groupHosts(sshHosts)).toEqual([
      ['Production', [sshHosts[0]]],
      ['Production/API', [sshHosts[2]]],
      ['Ungrouped', [sshHosts[1]]]
    ]);
  });

  it('filters visible entries by the pane query', () => {
    expect(visibleEntries(pane)).toEqual([pane.entries[0]]);
    expect(visibleEntries({ ...pane, filterQuery: '' })).toEqual(pane.entries);
  });

  it('builds breadcrumbs from the current directory path', () => {
    expect(breadcrumbParts('/Users/tester/projects')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'tester', path: '/Users/tester' },
      { label: 'projects', path: '/Users/tester/projects' }
    ]);
  });

  it('builds host-picker breadcrumbs from the current group path', () => {
    expect(hostPickerBreadcrumbs('Production/API')).toEqual([
      { label: 'Hosts', path: null },
      { label: 'Production', path: 'Production' },
      { label: 'API', path: 'Production/API' }
    ]);
  });

  it('shows subtree hosts without search and searches within the current subtree', () => {
    expect(visibleHostPickerHosts(sshHosts, 'Production', '')).toEqual([sshHosts[0], sshHosts[2]]);
    expect(visibleHostPickerHosts(sshHosts, 'Production', 'api')).toEqual([sshHosts[2]]);
    expect(visibleHostPickerHosts(sshHosts, null, '')).toEqual(sshHosts);
  });

  it('uses the simplified pane titles for local and host panes', () => {
    expect(getSftpPaneTitle({ sourceKind: 'local', endpoint: null })).toBe('Local');
    expect(
      getSftpPaneTitle({
        sourceKind: 'host',
        endpoint: {
          id: 'endpoint-1',
          kind: 'remote',
          hostId: 'ssh-1',
          title: 'Prod SSH',
          path: '/home/ubuntu',
          connectedAt: '2025-01-01T00:00:00.000Z'
        }
      })
    ).toBe('Prod SSH');
    expect(getSftpPaneTitle({ sourceKind: 'host', endpoint: null })).toBe('Host');
  });
});
