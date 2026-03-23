import { describe, expect, it } from 'vitest';
import type { GroupRecord, HostRecord } from '@shared';
import { buildGroupOptions } from '@shared';

const groups: GroupRecord[] = [
  {
    id: 'group-1',
    name: 'Servers',
    path: 'Servers',
    parentPath: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const hosts: HostRecord[] = [
  {
    id: 'host-1',
    kind: 'ssh',
    label: 'API',
    hostname: 'api.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: 'Servers/API',
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

describe('buildGroupOptions', () => {
  it('includes ungrouped first and preserves extra legacy values', () => {
    expect(buildGroupOptions(groups, hosts, ['Legacy/Path'])).toEqual([
      { value: null, label: 'Ungrouped' },
      { value: 'Legacy/Path', label: 'Legacy/Path' },
      { value: 'Servers', label: 'Servers' },
      { value: 'Servers/API', label: 'Servers/API' }
    ]);
  });
});
