import { describe, expect, it } from 'vitest';
import type { GroupRecord, HostRecord } from '@shared';
import { createGroupIn, removeGroupFrom, renameGroupIn } from '@shared';

// 이 규칙들은 데스크톱과 모바일이 같은 함수로 돌려야 한다. 눈에 잘 안 띄는 것들이라
// (합쳐짐 · 이름 재계산 · 그룹 레코드 없는 그룹) 두 벌이 되면 조용히 어긋난다.

const TS = '2026-08-23T00:00:00.000Z';
const OPTIONS = { timestamp: TS };

function group(path: string, name = path.split('/').at(-1)!): GroupRecord {
  return {
    id: `g:${path}`,
    name,
    path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function host(id: string, groupName: string | null): HostRecord {
  return {
    id,
    kind: 'ssh',
    label: id,
    groupName,
    hostname: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  } as HostRecord;
}

describe('createGroupIn', () => {
  it('nests the new group under the given parent', () => {
    const { created } = createGroupIn([], {
      id: 'g1',
      name: 'aws',
      parentPath: 'work',
      timestamp: TS
    });

    expect(created.path).toBe('work/aws');
    expect(created.parentPath).toBe('work');
  });

  it('refuses a path that already exists', () => {
    expect(() =>
      createGroupIn([group('work')], { id: 'g2', name: 'work', timestamp: TS }),
    ).toThrow(/already exists/);
  });
});

describe('renameGroupIn', () => {
  it('rewrites descendants and the hosts under them', () => {
    const result = renameGroupIn(
      [group('work'), group('work/aws')],
      [host('h1', 'work/aws'), host('h2', 'personal')],
      'work',
      'office',
      OPTIONS,
    );

    expect(result.nextPath).toBe('office');
    expect(result.groups.map((record) => record.path).sort()).toEqual([
      'office',
      'office/aws'
    ]);
    expect(result.hosts.find((record) => record.id === 'h1')?.groupName).toBe('office/aws');
    // 밖에 있던 호스트는 손대지 않는다 — updatedAt 도 그대로여야 한다.
    expect(result.hosts.find((record) => record.id === 'h2')?.updatedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  // 그룹은 레코드 없이 호스트의 groupName 만으로도 존재한다. 그것도 이름을 바꿀 수 있어야 한다.
  it('renames a group that exists only through its hosts', () => {
    const result = renameGroupIn([], [host('h1', 'work/aws')], 'work', 'office', OPTIONS);

    expect(result.groups).toEqual([]);
    expect(result.hosts[0]?.groupName).toBe('office/aws');
  });

  it('refuses when nothing is under the path', () => {
    expect(() => renameGroupIn([], [], 'ghost', 'office', OPTIONS)).toThrow(/not found/);
  });
});

describe('removeGroupFrom', () => {
  it('deletes the whole subtree in delete-subtree mode', () => {
    const result = removeGroupFrom(
      [group('work'), group('work/aws')],
      [host('h1', 'work/aws'), host('h2', 'personal')],
      'work',
      'delete-subtree',
      OPTIONS,
    );

    expect(result.groups).toEqual([]);
    expect(result.hosts.map((record) => record.id)).toEqual(['h2']);
    expect(result.removedHostIds).toEqual(['h1']);
  });

  it('lifts descendants one level in reparent mode and keeps every host', () => {
    const result = removeGroupFrom(
      [group('work'), group('work/aws')],
      [host('h1', 'work/aws'), host('h2', 'work')],
      'work',
      'reparent-descendants',
      OPTIONS,
    );

    expect(result.groups.map((record) => record.path)).toEqual(['aws']);
    // 이름은 새 경로에서 다시 계산된다.
    expect(result.groups[0]?.name).toBe('aws');
    expect(result.hosts.find((record) => record.id === 'h1')?.groupName).toBe('aws');
    // 그룹 바로 아래 있던 호스트는 그룹이 사라지므로 뿌리로 올라간다.
    expect(result.hosts.find((record) => record.id === 'h2')?.groupName).toBeNull();
    expect(result.removedHostIds).toEqual([]);
  });

  // 끌어올린 자리에 같은 경로가 이미 있으면 그 레코드는 버려지고 둘이 합쳐진다.
  it('merges into an existing path when reparenting collides', () => {
    const result = removeGroupFrom(
      [group('work'), group('work/aws'), group('aws')],
      [],
      'work',
      'reparent-descendants',
      OPTIONS,
    );

    expect(result.groups.map((record) => record.path)).toEqual(['aws']);
    expect(result.removedGroupIds).toContain('g:work/aws');
  });
});
