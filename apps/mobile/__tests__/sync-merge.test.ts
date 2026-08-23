import type { HostRecord } from '@dolssh/shared-core';
import {
  mergeSyncedRecords,
  mergeSyncedState,
} from '../src/lib/sync-merge';

// 원격 스냅샷을 적용할 때 **아직 서버에 못 올린 로컬 변경이 사라지지 않는다** 는 규칙을
// 여기서 지킨다. 예전에는 종류마다 따로 덮어썼고, secrets 를 빠뜨려 비밀번호만 증발했다.
// 조심해서 막는 방식은 종류가 늘 때마다 다시 빠진다 — 규칙 하나로 못 일어나게 한다.

function host(overrides: Partial<HostRecord>): HostRecord {
  return {
    id: 'h1',
    kind: 'ssh',
    label: 'h1',
    hostname: 'h1.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    secretRef: null,
    groupName: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as HostRecord;
}

const idOf = (record: HostRecord) => record.id;
const updatedAtOf = (record: HostRecord) => record.updatedAt;

describe('mergeSyncedRecords', () => {
  it('서버에 없는 로컬 레코드를 남기고 미전송으로 보고한다', () => {
    // 아직 안 올린 것이다. 지우면 큐도 밀 것을 못 찾아 항목째 버려진다.
    // 큐 항목이 어쩌다 사라졌더라도 여기서 다시 올릴 대상으로 잡아 스스로 회복한다.
    const { merged, unpushedIds } = mergeSyncedRecords(
      { local: [host({ id: 'local-only' })], remote: { live: [], tombstones: [] } },
      idOf,
      updatedAtOf,
    );
    expect(merged.map(idOf)).toEqual(['local-only']);
    expect(unpushedIds).toEqual(['local-only']);
  });

  it('로컬이 더 최신이면 서버 값을 덮지 않는다', () => {
    const { merged } = mergeSyncedRecords(
      {
        local: [host({ label: 'local edit', updatedAt: '2026-08-02T00:00:00.000Z' })],
        remote: {
          live: [host({ label: 'server', updatedAt: '2026-08-01T00:00:00.000Z' })],
          tombstones: [],
        },
      },
      idOf,
      updatedAtOf,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.label).toBe('local edit');
  });

  it('서버가 더 최신이면 서버 값을 쓴다', () => {
    const { merged } = mergeSyncedRecords(
      {
        local: [host({ label: 'stale', updatedAt: '2026-08-01T00:00:00.000Z' })],
        remote: {
          live: [host({ label: 'server', updatedAt: '2026-08-03T00:00:00.000Z' })],
          tombstones: [],
        },
      },
      idOf,
      updatedAtOf,
    );
    expect(merged[0]!.label).toBe('server');
  });

  it('다른 기기의 삭제를 따른다', () => {
    // "서버에 없다" 만으로는 삭제인지 미전송인지 알 수 없다 — tombstone 이 그것을 가른다.
    const { merged } = mergeSyncedRecords(
      {
        local: [host({ updatedAt: '2026-08-01T00:00:00.000Z' })],
        remote: {
          live: [],
          tombstones: [{ id: 'h1', deletedAt: '2026-08-02T00:00:00.000Z' }],
        },
      },
      idOf,
      updatedAtOf,
    );
    expect(merged).toEqual([]);
  });

  it('삭제 뒤에 다시 만든 로컬 레코드는 살린다', () => {
    const { merged } = mergeSyncedRecords(
      {
        local: [host({ label: 'recreated', updatedAt: '2026-08-05T00:00:00.000Z' })],
        remote: {
          live: [],
          tombstones: [{ id: 'h1', deletedAt: '2026-08-02T00:00:00.000Z' }],
        },
      },
      idOf,
      updatedAtOf,
    );
    expect(merged[0]!.label).toBe('recreated');
  });
});

describe('mergeSyncedState', () => {
  it('네 종류 모두 같은 규칙으로 지킨다', () => {
    // 종류별로 따로 처리하던 시절에 secrets 만 빠져 비밀번호가 사라졌다.
    const result = mergeSyncedState({
      hosts: {
        local: [host({ id: 'local-host' })],
        remote: { live: [], tombstones: [] },
      },
      groups: {
        local: [
          {
            id: 'local-group',
            path: 'work',
            name: 'work',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        remote: { live: [], tombstones: [] },
      },
      knownHosts: {
        local: [
          {
            id: 'local-known',
            host: 'h1.example.com',
            port: 22,
            algorithm: 'ssh-ed25519',
            publicKeyBase64: 'AAAA',
            fingerprintSha256: 'abc',
            createdAt: '2026-08-01T00:00:00.000Z',
            lastSeenAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        remote: { live: [], tombstones: [] },
      },
      secrets: {
        local: [
          {
            secretRef: 'local-secret',
            label: 'creds',
            password: 'hunter2',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        remote: { live: [], tombstones: [] },
      },
    });

    expect(result.hosts.map(record => record.id)).toEqual(['local-host']);
    expect(result.groups.map(record => record.id)).toEqual(['local-group']);
    expect(result.knownHosts.map(record => record.id)).toEqual(['local-known']);
    expect(result.secrets.map(record => record.secretRef)).toEqual([
      'local-secret',
    ]);
    expect(result.secrets[0]!.password).toBe('hunter2');
    // 네 종류 모두 "아직 안 올라간 것" 으로 잡혀 큐에 다시 들어간다.
    expect(result.unpushed).toEqual([
      { kind: 'hosts', id: 'local-host' },
      { kind: 'groups', id: 'local-group' },
      { kind: 'knownHosts', id: 'local-known' },
      { kind: 'secrets', id: 'local-secret' },
    ]);
  });
});
