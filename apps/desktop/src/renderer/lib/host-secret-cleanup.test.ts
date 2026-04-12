import { describe, expect, it } from 'vitest';
import type { HostRecord, SecretMetadataRecord } from '@shared';
import { getUnusedSavedCredentialsAfterHostDeletion } from './host-secret-cleanup';

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret:shared',
    label: 'Shared',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 2,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    secretRef: 'secret:single',
    label: 'Single',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    secretRef: 'secret:managed',
    label: 'Managed',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

const hosts: HostRecord[] = [
  {
    id: 'host-1',
    kind: 'ssh',
    label: 'One',
    hostname: 'one.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'secret:shared',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'host-2',
    kind: 'ssh',
    label: 'Two',
    hostname: 'two.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'secret:shared',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'host-3',
    kind: 'ssh',
    label: 'Three',
    hostname: 'three.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'secret:single',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'host-4',
    kind: 'ssh',
    label: 'Four',
    hostname: 'four.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: 'secret:managed',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

describe('getUnusedSavedCredentialsAfterHostDeletion', () => {
  it('returns a saved credential when the removed host was the last remaining usage', () => {
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(hosts, keychainEntries, ['host-3']),
    ).toEqual(['secret:single']);
  });

  it('does not return a shared secret if another host still references it', () => {
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(hosts, keychainEntries, ['host-1']),
    ).toEqual([]);
  });

  it('dedupes and returns a shared secret when all referencing hosts are deleted together', () => {
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(hosts, keychainEntries, ['host-1', 'host-2']),
    ).toEqual(['secret:shared']);
  });

  it('also proposes credentials that used to be server-managed', () => {
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(hosts, keychainEntries, ['host-4']),
    ).toEqual(['secret:managed']);
  });
});
