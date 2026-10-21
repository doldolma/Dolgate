import { describe, expect, it } from 'vitest';
import type { VaultIndex } from '@shared';
import { createEmptyVaultIndex } from '../store/utils';
import { groupByVault, orderByVault, sectionsByVault, teamOfVault } from './vault-groups';

// 볼트별 목록 묶기(4-6). 표에 없는 레코드는 개인 것이다.

function index(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      { id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] },
      { id: 'team-b', name: 'Blocked Co', role: 'member', syncState: 'needs-rejoin', syncError: null, groups: [] },
      { id: 'team-c', name: 'Cloud Ops', role: 'member', syncState: 'ready', syncError: null, groups: [] },
    ],
  };
}

const item = (id: string) => ({ id });

describe('groupByVault', () => {
  it('leaves the list alone without teams', () => {
    expect(groupByVault([item('a')], {}, createEmptyVaultIndex())).toBeNull();
    expect(groupByVault([item('a')], undefined, null)).toBeNull();
  });

  it('puts personal first, then teams in vault order, keeping empty vaults and their order inside', () => {
    const teamIdById = { t2: 'team-a', t1: 'team-a', c1: 'team-c', lost: 'team-gone' };

    const sections = groupByVault([item('t2'), item('p1'), item('t1'), item('c1'), item('lost')], teamIdById, index());

    expect(sections?.map((section) => [section.vaultId, section.team?.name ?? null, section.blocked, section.items.map((entry) => entry.id)])).toEqual([
      // 이 기기에 없는 팀을 가리키면 빼먹지 않고 개인에 둔다(표에 없는 것과 같다).
      ['personal', null, false, ['p1', 'lost']],
      ['team-a', 'Acme Infra', false, ['t2', 't1']],
      // 막힌 팀 — 묶음은 있지만 여기 만들지 않는다.
      ['team-b', 'Blocked Co', true, []],
      ['team-c', 'Cloud Ops', false, ['c1']],
    ]);
  });
});

describe('orderByVault', () => {
  const items = [item('p1'), item('c1'), item('a1'), item('p2'), item('a2')];
  const teamIdById = { a1: 'team-a', a2: 'team-a', c1: 'team-c' };

  it("puts the session vault's items first, then personal, then other teams", () => {
    expect(orderByVault(items, teamIdById, 'team-a').map((entry) => entry.id)).toEqual(['a1', 'a2', 'p1', 'p2', 'c1']);
  });

  it('keeps the list as it is for a personal session or without teams', () => {
    expect(orderByVault(items, teamIdById, 'personal')).toBe(items);
    expect(orderByVault(items, {}, 'team-a')).toBe(items);
    expect(orderByVault(items, undefined, 'team-a')).toBe(items);
  });
});

describe('teamOfVault', () => {
  it('names a team vault and nothing for personal or unknown ones', () => {
    expect(teamOfVault(index(), 'team-c')).toEqual({ id: 'team-c', name: 'Cloud Ops' });
    expect(teamOfVault(index(), 'personal')).toBeNull();
    expect(teamOfVault(index(), 'team-gone')).toBeNull();
    expect(teamOfVault(null, 'team-c')).toBeNull();
  });
});

// 설정의 볼트별 묶음(4-7) — 목록 IPC 가 볼트 하나씩 준 것을 묶는다.
describe('sectionsByVault', () => {
  it('leaves the list alone without teams', () => {
    expect(sectionsByVault([item('p1')], { 'team-a': [item('t1')] }, createEmptyVaultIndex())).toBeNull();
    expect(sectionsByVault([item('p1')], {}, null)).toBeNull();
  });

  it('puts personal first, then each team in vault order, empty for a team not read yet', () => {
    const sections = sectionsByVault([item('p1'), item('p2')], { 'team-c': [item('c1')], 'team-a': [item('a1')] }, index());

    expect(sections?.map((section) => [section.vaultId, section.team?.name ?? null, section.blocked, section.items.map((entry) => entry.id)])).toEqual([
      ['personal', null, false, ['p1', 'p2']],
      ['team-a', 'Acme Infra', false, ['a1']],
      ['team-b', 'Blocked Co', true, []],
      ['team-c', 'Cloud Ops', false, ['c1']],
    ]);
  });
});
