import { describe, expect, it } from 'vitest';
import type { TermiusImportSelectionInput } from '@shared';
import {
  buildTermiusEntityKey,
  buildTermiusGroupAncestorPaths,
  buildTermiusSharedSecretKey,
  collectSelectedTermiusGroupPaths,
  collectSelectedTermiusHosts,
  deriveElectronExecutableCandidate,
  resolveTermiusCredential,
  type TermiusExportBundle,
  type TermiusExportGroup,
  type TermiusExportHost,
  type TermiusSnapshot
} from './termius-import-service';

const groups: TermiusExportGroup[] = [
  {
    id: 1,
    localId: 1,
    name: 'Team',
    path: 'Team'
  },
  {
    id: 2,
    localId: 2,
    name: 'Prod',
    path: 'Team/Prod'
  }
];

const hosts: TermiusExportHost[] = [
  {
    id: 11,
    localId: 11,
    name: 'App',
    address: 'app.example.com',
    groupPath: 'Team/Prod',
    sshConfig: {
      port: 22
    },
    identity: {
      localId: 100,
      username: 'ubuntu',
      password: 'secret'
    }
  },
  {
    id: 12,
    localId: 12,
    name: 'Worker',
    address: 'worker.example.com',
    groupPath: 'Team',
    sshConfig: {
      port: 2200
    },
    identity: {
      localId: 101,
      username: 'deploy',
      sshKey: {
        localId: 555,
        name: 'worker-key',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        passphrase: 'passphrase'
      }
    }
  }
];

function createSnapshot(): TermiusSnapshot {
  const bundle: TermiusExportBundle = {
    groups,
    hosts
  };

  return {
    bundle,
    hostsByKey: new Map(
      hosts.map((host) => [buildTermiusEntityKey(host.id, host.localId, `${host.name ?? ''}|${host.address ?? ''}|${host.groupPath ?? ''}`), host])
    )
  };
}

describe('Termius import helpers', () => {
  it('builds ancestor group paths in depth order', () => {
    expect(buildTermiusGroupAncestorPaths(' Team/Prod /Api ')).toEqual(['Team', 'Team/Prod', 'Team/Prod/Api']);
    expect(buildTermiusGroupAncestorPaths(null)).toEqual([]);
  });

  it('collects selected hosts from explicit host checks and selected group subtree', () => {
    const snapshot = createSnapshot();
    const input: TermiusImportSelectionInput = {
      snapshotId: 'snapshot-1',
      selectedGroupPaths: ['Team'],
      selectedHostKeys: []
    };

    expect(collectSelectedTermiusHosts(snapshot, input).map((host) => host.name)).toEqual(['App', 'Worker']);
  });

  it('includes ancestor groups for selected hosts when building import group paths', () => {
    const snapshot = createSnapshot();
    const input: TermiusImportSelectionInput = {
      snapshotId: 'snapshot-1',
      selectedGroupPaths: [],
      selectedHostKeys: [buildTermiusEntityKey(11, 11, 'App|app.example.com|Team/Prod')]
    };

    expect(collectSelectedTermiusGroupPaths(snapshot, input)).toEqual(['Team', 'Team/Prod']);
  });

  it('reuses identity ids for shared secret keys and falls back to descriptive labels', () => {
    expect(buildTermiusSharedSecretKey(hosts[0])).toBe('identity:local:100');
    expect(buildTermiusSharedSecretKey({
      name: 'Legacy',
      address: 'legacy.example.com',
      identity: {
        name: 'Ops',
        username: 'root',
        sshKey: {
          name: 'legacy-key'
        }
      }
    })).toBe('identity-fallback:Ops|root|legacy-key|Legacy|legacy.example.com');
  });

  it('prefers private keys over passwords and keeps passphrases only for key auth', () => {
    expect(resolveTermiusCredential(hosts[0])).toMatchObject({
      authType: 'password',
      hasCredential: true,
      secrets: {
        password: 'secret'
      }
    });

    expect(resolveTermiusCredential(hosts[1])).toMatchObject({
      authType: 'privateKey',
      hasCredential: true,
      secrets: {
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        passphrase: 'passphrase'
      }
    });
  });

  it('derives real Electron executables from npm wrapper paths for packaged builds', () => {
    expect(deriveElectronExecutableCandidate('/tmp/termius-exporter/node_modules/.bin/electron', 'darwin')).toBe(
      '/tmp/termius-exporter/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    );
    expect(deriveElectronExecutableCandidate('/tmp/termius-exporter/node_modules/electron/cli.js', 'win32')).toBe(
      '/tmp/termius-exporter/node_modules/electron/dist/electron.exe'
    );
  });
});
