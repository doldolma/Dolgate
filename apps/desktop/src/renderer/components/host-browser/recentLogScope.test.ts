import { describe, expect, it } from 'vitest';
import {
  collectRecentLogScopeHostIds,
  collectScopedHostIds,
  resolveRecentLogScope,
  resolveRecentLogScopeGroupPaths,
} from './recentLogScope';

const hosts = [
  { id: 'host-app', groupName: 'Servers' },
  { id: 'host-db', groupName: 'Servers/Nested' },
  { id: 'host-lab', groupName: 'Lab' },
  { id: 'host-loose', groupName: null },
];

describe('resolveRecentLogScopeGroupPaths', () => {
  it('has no scope when nothing is selected or navigated', () => {
    expect(resolveRecentLogScopeGroupPaths({})).toEqual([]);
    expect(
      resolveRecentLogScopeGroupPaths({ selectedGroupPaths: [], currentGroupPath: null }),
    ).toEqual([]);
  });

  it('falls back to the group being navigated', () => {
    expect(resolveRecentLogScopeGroupPaths({ currentGroupPath: 'Servers' })).toEqual(['Servers']);
  });

  // 그룹은 Cmd/Ctrl·Shift 클릭으로 여러 개를 고를 수 있다. 그중 하나만 반영하면 나머지 그룹의
  // 로그가 조용히 사라진다.
  it('keeps every selected group', () => {
    expect(
      resolveRecentLogScopeGroupPaths({ selectedGroupPaths: ['Servers/Nested', 'Lab'] }),
    ).toEqual(['Servers/Nested', 'Lab']);
  });

  // 카드를 고른 것이 더 명시적인 의사표시다 — 탐색 경로보다 앞선다.
  it('prefers the selected groups over the navigated one', () => {
    expect(
      resolveRecentLogScopeGroupPaths({
        selectedGroupPaths: ['Lab'],
        currentGroupPath: 'Servers',
      }),
    ).toEqual(['Lab']);
  });

  it('drops blank paths so they cannot widen the scope to everything', () => {
    expect(
      resolveRecentLogScopeGroupPaths({ selectedGroupPaths: ['   ', ''], currentGroupPath: 'Lab' }),
    ).toEqual(['Lab']);
  });
});

describe('collectScopedHostIds', () => {
  // null(전체)과 빈 Set(그룹에 호스트가 없음)은 뜻이 다르다.
  it('returns null when there is no scope', () => {
    expect(collectScopedHostIds(hosts, [])).toBeNull();
  });

  it('includes hosts from nested groups', () => {
    expect(collectScopedHostIds(hosts, ['Servers'])).toEqual(
      new Set(['host-app', 'host-db']),
    );
  });

  it('takes the union of several groups', () => {
    expect(collectScopedHostIds(hosts, ['Servers/Nested', 'Lab'])).toEqual(
      new Set(['host-db', 'host-lab']),
    );
  });

  it('leaves out hosts that belong to no group', () => {
    expect(collectScopedHostIds(hosts, ['Servers'])).not.toContain('host-loose');
  });

  it('is empty — not null — for a group without hosts', () => {
    expect(collectScopedHostIds(hosts, ['Empty'])).toEqual(new Set());
  });
});

const hostsWithFavorites = [
  { id: 'host-app', groupName: 'Servers', favorite: true },
  { id: 'host-db', groupName: 'Servers/Nested' },
  { id: 'host-lab', groupName: 'Lab', favorite: false },
  { id: 'host-loose', groupName: null, favorite: true },
];

describe('resolveRecentLogScope', () => {
  it('has no scope on All Hosts', () => {
    expect(resolveRecentLogScope({})).toEqual({ kind: 'none' });
  });

  it('scopes to favorites when the favorites filter is on', () => {
    expect(resolveRecentLogScope({ favoritesFilterActive: true })).toEqual({ kind: 'favorites' });
  });

  // 즐겨찾기와 그룹은 동시에 켜지지 않지만(useHostBrowser 가 서로를 끈다), 그래도 한쪽으로
  // 정해져야 한다 — 두 범위가 겹치면 화면 제목과 목록이 다른 말을 한다.
  it('prefers favorites over a leftover group path', () => {
    expect(
      resolveRecentLogScope({ favoritesFilterActive: true, currentGroupPath: 'Servers' }),
    ).toEqual({ kind: 'favorites' });
  });

  it('scopes to the groups otherwise', () => {
    expect(resolveRecentLogScope({ selectedGroupPaths: ['Lab'] })).toEqual({
      kind: 'groups',
      groupPaths: ['Lab'],
    });
  });
});

describe('collectRecentLogScopeHostIds', () => {
  it('returns null for the unscoped view', () => {
    expect(collectRecentLogScopeHostIds(hostsWithFavorites, { kind: 'none' })).toBeNull();
  });

  // 즐겨찾기는 그룹과 무관하다 — 그룹 없는 호스트도 들어온다.
  it('collects favorites regardless of group', () => {
    expect(collectRecentLogScopeHostIds(hostsWithFavorites, { kind: 'favorites' })).toEqual(
      new Set(['host-app', 'host-loose']),
    );
  });

  // 즐겨찾기가 하나도 없으면 빈 Set 이어야 한다. null 이면 전체 로그가 쏟아진다.
  it('is empty — not null — when nothing is favorited', () => {
    expect(collectRecentLogScopeHostIds(hosts, { kind: 'favorites' })).toEqual(new Set());
  });

  it('delegates to the group scope', () => {
    expect(
      collectRecentLogScopeHostIds(hostsWithFavorites, { kind: 'groups', groupPaths: ['Servers'] }),
    ).toEqual(new Set(['host-app', 'host-db']));
  });
});
