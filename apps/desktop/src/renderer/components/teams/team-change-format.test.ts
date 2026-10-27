import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import type { TeamChangeItem } from '@shared';
import {
  formatTeamChangeItemLabel,
  formatTeamChangeSubject,
  formatTeamChangeTitle,
  hasFinalConsonant,
} from './team-change-format';

const ko = i18next.getFixedT('ko') as unknown as (key: string, params?: Record<string, unknown>) => string;
const en = i18next.getFixedT('en') as unknown as (key: string, params?: Record<string, unknown>) => string;

function item(kind: TeamChangeItem['kind'], label: string | null, deleted = true): TeamChangeItem {
  return { kind, recordId: `${kind}:${label}`, label, deleted, currentLabel: null };
}

describe('team change titles', () => {
  it('reads like the activity cards, picking Korean particles by the last sound', () => {
    expect(formatTeamChangeTitle([item('hosts', 'web-1'), item('hosts', 'web-2')], ko, 'ko')).toBe(
      '호스트 2개를 삭제했습니다.',
    );
    expect(
      formatTeamChangeTitle([item('groups', 'Staging'), item('hosts', 'stg-api'), item('hosts', 'stg-worker')], ko, 'ko'),
    ).toBe('Staging 그룹과 호스트 2개를 삭제했습니다.');
    expect(formatTeamChangeTitle([item('hosts', 'legacy-db'), item('secrets', 'legacy-db')], ko, 'ko')).toBe(
      'legacy-db 호스트와 비밀번호를 삭제했습니다.',
    );
    expect(formatTeamChangeTitle([item('hosts', 'bastion', false)], ko, 'ko')).toBe('bastion 호스트를 수정했습니다.');
    expect(formatTeamChangeTitle([item('snippets', 'deploy', false)], ko, 'ko')).toBe('deploy 스니펫을 수정했습니다.');
    expect(formatTeamChangeTitle([item('tailnets', 'corp', false)], ko, 'ko')).toBe('corp tailnet을 수정했습니다.');
    expect(formatTeamChangeTitle([item('workspaces', 'Ops', false)], ko, 'ko')).toBe('Ops Workspace를 수정했습니다.');
  });

  it('says both when one push edited some and deleted others, and counts what it cannot name', () => {
    expect(
      formatTeamChangeTitle([item('hosts', 'a', false), item('hosts', 'b', false), item('groups', 'Old')], ko, 'ko'),
    ).toBe('호스트 2개를 수정하고 Old 그룹을 삭제했습니다.');
    expect(formatTeamChangeTitle([item('hosts', null)], ko, 'ko')).toBe('호스트 1개를 삭제했습니다.');
    expect(
      formatTeamChangeSubject([item('groups', 'A'), item('hosts', 'h'), item('secrets', 's'), item('snippets', 'x')], ko, 'ko'),
    ).toBe('A 그룹, h 호스트, s 비밀번호와 x 스니펫');
  });

  it('writes English with articles and plurals', () => {
    expect(formatTeamChangeTitle([item('hosts', 'db'), item('secrets', 'db')], en, 'en')).toBe(
      'Deleted the db host and password.',
    );
    expect(formatTeamChangeTitle([item('groups', 'Staging'), item('hosts', 'a'), item('hosts', 'b')], en, 'en')).toBe(
      'Deleted the Staging group and 2 hosts.',
    );
    expect(formatTeamChangeTitle([item('hosts', 'a', false), item('portForwards', 'pf')], en, 'en')).toBe(
      'Edited the a host and deleted the pf port forward.',
    );
  });

  it('names a password by its host and marks what it cannot open', () => {
    expect(formatTeamChangeItemLabel({ kind: 'secrets', label: 'legacy-db' }, ko)).toBe('legacy-db 비밀번호');
    expect(formatTeamChangeItemLabel({ kind: 'hosts', label: 'web' }, ko)).toBe('web');
    expect(formatTeamChangeItemLabel({ kind: 'hosts', label: null }, ko)).toBe('(열 수 없음)');
  });

  it('hears final consonants in Hangul, digits and the English nouns the titles use', () => {
    expect(['그룹', '스니펫', '포워딩', 'AWS 프로필', '3', 'tailnet'].map(hasFinalConsonant)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['호스트', '비밀번호', '2개', '2', 'Workspace', 'DNS 덮어쓰기'].map(hasFinalConsonant)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
