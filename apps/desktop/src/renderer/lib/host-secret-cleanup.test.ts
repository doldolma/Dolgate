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

  // 원격 화면 호스트도 같은 자격증명 저장소를 쓴다. 종류를 하나 빼먹으면 그 호스트를 지워도
  // 쓰는 데 없는 비밀번호가 키체인에 계속 남는다 — VNC 가 실제로 그랬다.
  it('RDP·VNC 호스트의 자격증명도 함께 지울 대상으로 찾는다', () => {
    const remoteScreenHosts = [
      ...hosts,
      { id: 'rdp-1', kind: 'rdp', secretRef: 'secret:rdp' },
      { id: 'vnc-1', kind: 'vnc', secretRef: 'secret:vnc' },
    ] as unknown as HostRecord[];
    const entries = [
      ...keychainEntries,
      { secretRef: 'secret:rdp', label: 'Win', kind: 'rdp' },
      { secretRef: 'secret:vnc', label: 'Console', kind: 'vnc' },
    ] as SecretMetadataRecord[];

    expect(
      getUnusedSavedCredentialsAfterHostDeletion(remoteScreenHosts, entries, ['rdp-1']),
    ).toEqual(['secret:rdp']);
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(remoteScreenHosts, entries, ['vnc-1']),
    ).toEqual(['secret:vnc']);
  });

  // 같은 비밀번호를 여러 VNC 호스트에 쓰는 일은 흔하다(디스플레이만 다른 같은 기계).
  // 하나 지웠다고 지우면 남은 호스트가 조용히 못 붙는다.
  it('다른 VNC 호스트가 아직 쓰는 자격증명은 남긴다', () => {
    const sharedVncHosts = [
      { id: 'vnc-1', kind: 'vnc', secretRef: 'secret:vnc' },
      { id: 'vnc-2', kind: 'vnc', secretRef: 'secret:vnc' },
    ] as unknown as HostRecord[];
    const entries = [
      { secretRef: 'secret:vnc', label: 'Console', kind: 'vnc' },
    ] as SecretMetadataRecord[];

    expect(
      getUnusedSavedCredentialsAfterHostDeletion(sharedVncHosts, entries, ['vnc-1']),
    ).toEqual([]);
    expect(
      getUnusedSavedCredentialsAfterHostDeletion(sharedVncHosts, entries, ['vnc-1', 'vnc-2']),
    ).toEqual(['secret:vnc']);
  });
});
