import { describe, expect, it } from 'vitest';
import type { SshHostRecord } from '@shared';
import type { SftpPaneState } from '../store/createAppStore';
import {
  breadcrumbParts,
  buildTransferCardTitle,
  canTransferBetweenSftpPanes,
  encodeInternalTransferPayload,
  formatEta,
  formatTransferSpeed,
  getSftpPaneTitle,
  groupHosts,
  hasInternalTransferData,
  hostPickerBreadcrumbs,
  isSftpTransferArrowDisabled,
  parseInternalTransferPayload,
  permissionMatrixFromString,
  permissionMatrixToMode,
  visibleEntries,
  visibleHostPickerHosts
} from './SftpWorkspace';

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
  connectingHostId: null,
  connectingEndpointId: null,
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
  selectionAnchorPath: null,
  filterQuery: 'read',
  selectedHostId: null,
  hostSearchQuery: '',
  isLoading: false,
  warningMessages: []
};

function createPaneState(overrides: Partial<SftpPaneState> = {}): SftpPaneState {
  return {
    id: 'left',
    sourceKind: 'local',
    endpoint: null,
    connectingHostId: null,
    connectingEndpointId: null,
    hostGroupPath: null,
    currentPath: '/Users/tester/projects',
    lastLocalPath: '/Users/tester/projects',
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
        permissions: 'drwxr-xr-x'
      }
    ],
    selectedPaths: [],
    selectionAnchorPath: null,
    filterQuery: '',
    selectedHostId: null,
    hostSearchQuery: '',
    isLoading: false,
    warningMessages: [],
    ...overrides
  };
}

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

  it('parses permission strings and converts them to octal mode', () => {
    expect(permissionMatrixFromString('drwxr-xr-x')).toEqual({
      owner: { read: true, write: true, execute: true },
      group: { read: true, write: false, execute: true },
      other: { read: true, write: false, execute: true }
    });
    expect(
      permissionMatrixToMode({
        owner: { read: true, write: true, execute: true },
        group: { read: true, write: false, execute: true },
        other: { read: true, write: false, execute: false }
      })
    ).toBe(0o754);
  });

  it('disables center transfer arrows until both panes are browsable', () => {
    const leftPane = createPaneState({
      id: 'left',
      sourceKind: 'local',
      selectedPaths: ['/Users/tester/projects/README.md']
    });
    const rightHostPicker = createPaneState({
      id: 'right',
      sourceKind: 'host',
      endpoint: null,
      entries: [],
      selectedPaths: []
    });

    expect(canTransferBetweenSftpPanes(leftPane, rightHostPicker)).toBe(false);
    expect(isSftpTransferArrowDisabled(leftPane, rightHostPicker)).toBe(true);
  });

  it('formats transfer speed and eta for running transfer cards', () => {
    expect(formatTransferSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
    expect(formatEta(125)).toBe('남은 시간 2분 5초');
    expect(formatTransferSpeed(null)).toBeNull();
    expect(formatEta(0)).toBeNull();
  });

  it('accepts internal drag payloads from the text/plain fallback channel', () => {
    const payload = encodeInternalTransferPayload({
      sourcePaneId: 'left',
      draggedPath: '/Users/tester/projects/README.md'
    });

    expect(
      parseInternalTransferPayload({
        getData: (type: string) => (type === 'text/plain' ? payload : '')
      })
    ).toEqual({
      sourcePaneId: 'left',
      draggedPath: '/Users/tester/projects/README.md'
    });
  });

  it('treats both custom mime and text/plain as internal transfer drags during dragover', () => {
    expect(
      hasInternalTransferData({
        types: ['application/x-dolssh-transfer']
      })
    ).toBe(true);

    expect(
      hasInternalTransferData({
        types: ['text/plain']
      })
    ).toBe(true);

    expect(
      hasInternalTransferData({
        types: ['Files']
      })
    ).toBe(false);
  });

  it('builds a stable summary title for multi-file transfers', () => {
    expect(
      buildTransferCardTitle({
        id: 'job-1',
        sourceLabel: 'Local',
        targetLabel: 'nas',
        itemCount: 3,
        bytesTotal: 300,
        bytesCompleted: 150,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:01.000Z',
        activeItemName: 'second.txt',
        request: {
          source: { kind: 'local', path: '/Users/tester' },
          target: { kind: 'remote', endpointId: 'endpoint-1', path: '/home/tester' },
          items: [
            { name: 'first.txt', path: '/Users/tester/first.txt', isDirectory: false, size: 100 },
            { name: 'second.txt', path: '/Users/tester/second.txt', isDirectory: false, size: 100 },
            { name: 'third.txt', path: '/Users/tester/third.txt', isDirectory: false, size: 100 }
          ],
          conflictResolution: 'overwrite'
        }
      })
    ).toBe('first.txt 외 2개');
  });
});
