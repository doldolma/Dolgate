import { describe, expect, it } from 'vitest';
import { collectScopedHostIds, resolveRecentLogScopeGroupPaths } from './recentLogScope';

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
