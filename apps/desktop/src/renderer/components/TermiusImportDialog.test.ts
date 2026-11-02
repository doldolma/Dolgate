import { describe, expect, it } from 'vitest';
import type { TermiusImportGroupPreview, TermiusImportHostPreview } from '@shared';
import {
  countEffectiveSelectedTermiusHosts,
  countTermiusImportSecrets,
  filterTermiusImportGroups,
  filterTermiusImportHosts
} from './TermiusImportDialog';

const groups: TermiusImportGroupPreview[] = [
  {
    path: 'team',
    name: 'team',
    parentPath: null,
    hostCount: 2
  },
  {
    path: 'team/api',
    name: 'api',
    parentPath: 'team',
    hostCount: 1
  }
];

const hosts: TermiusImportHostPreview[] = [
  {
    key: 'host-1',
    name: 'api-1',
    address: 'api.internal',
    groupPath: 'team/api',
    port: 22,
    username: 'ubuntu',
    hasPassword: true,
    hasPrivateKey: false,
    identityName: 'api-user'
  },
  {
    key: 'host-2',
    name: 'web-1',
    address: 'web.internal',
    groupPath: 'team',
    port: 2222,
    username: 'deploy',
    hasPassword: false,
    hasPrivateKey: true,
    identityName: 'deploy-key'
  },
  {
    key: 'host-3',
    name: 'misc',
    address: 'misc.internal',
    groupPath: null,
    port: 22,
    username: 'root',
    hasPassword: false,
    hasPrivateKey: false,
    identityName: null
  }
];

describe('Termius import dialog helpers', () => {
  it('filters groups by name and path', () => {
    expect(filterTermiusImportGroups(groups, 'api')).toEqual([groups[1]]);
    expect(filterTermiusImportGroups(groups, 'TEAM')).toEqual(groups);
  });

  it('filters hosts across address, username and identity metadata', () => {
    expect(filterTermiusImportHosts(hosts, 'deploy')).toEqual([hosts[1]]);
    expect(filterTermiusImportHosts(hosts, 'api.internal')).toEqual([hosts[0]]);
    expect(filterTermiusImportHosts(hosts, 'root')).toEqual([hosts[2]]);
  });

  it('counts effective selected hosts from both explicit host checks and selected group subtrees', () => {
    expect(countEffectiveSelectedTermiusHosts(hosts, ['team'], [])).toBe(2);
    expect(countEffectiveSelectedTermiusHosts(hosts, [], ['host-3'])).toBe(1);
    expect(countEffectiveSelectedTermiusHosts(hosts, ['team/api'], ['host-3'])).toBe(2);
  });

  it('counts the passwords and keys an import makes, once per shared identity', () => {
    const withSecrets: TermiusImportHostPreview[] = [
      { ...hosts[0]!, secretKey: 'identity:shared' },
      { ...hosts[1]!, secretKey: 'identity:shared' },
      { ...hosts[2]!, secretKey: null }
    ];
    // host-1·host-2 는 같은 ID 라 하나, host-3 는 가져올 비밀값이 없다.
    expect(countTermiusImportSecrets(withSecrets, ['team'], ['host-3'])).toBe(1);
    expect(countTermiusImportSecrets(withSecrets, [], ['host-3'])).toBe(0);
    expect(
      countTermiusImportSecrets(
        [withSecrets[0]!, { ...withSecrets[1]!, secretKey: 'host:host-2' }],
        [],
        ['host-1', 'host-2']
      )
    ).toBe(2);
    // 고르지 않은 호스트의 비밀값은 세지 않는다.
    expect(countTermiusImportSecrets(withSecrets, ['team/api'], [])).toBe(1);
    expect(countTermiusImportSecrets(withSecrets, [], [])).toBe(0);
  });
});
