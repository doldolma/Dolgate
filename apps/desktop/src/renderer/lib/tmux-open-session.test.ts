import { describe, expect, it } from 'vitest';
import { findOpenTmuxSession } from './tmux-open-session';

const groups = [
  { id: 'g1', sessionName: 'work', hostId: 'host-a' },
  { id: 'g2', sessionName: 'd', hostId: 'host-a' },
  { id: 'g3', sessionName: 'work', hostId: 'host-b' },
];

describe('findOpenTmuxSession', () => {
  it('같은 호스트의 같은 이름 세션을 든 그룹을 찾는다', () => {
    expect(findOpenTmuxSession(groups, 'host-a', 'd')?.id).toBe('g2');
  });

  it('이름이 같아도 호스트가 다르면 아니다', () => {
    expect(findOpenTmuxSession(groups, 'host-b', 'd')).toBeNull();
  });

  it('열려 있지 않은 세션은 null', () => {
    expect(findOpenTmuxSession(groups, 'host-a', 'spare')).toBeNull();
  });

  it('tmux 세션 이름은 대소문자를 구분한다', () => {
    expect(findOpenTmuxSession(groups, 'host-a', 'Work')).toBeNull();
  });

  it('호스트를 모르면 후보를 찾지 않는다', () => {
    expect(findOpenTmuxSession(groups, null, 'd')).toBeNull();
    expect(findOpenTmuxSession(groups, undefined, 'd')).toBeNull();
  });

  // 무엇에 붙었는지 모르는 그룹으로 보내면 엉뚱한 세션을 보여 준다.
  it('세션 이름이 아직 비어 있는 그룹은 후보가 아니다', () => {
    const pending = [{ id: 'g9', sessionName: '', hostId: 'host-a' }];
    expect(findOpenTmuxSession(pending, 'host-a', '')).toBeNull();
    expect(findOpenTmuxSession(pending, 'host-a', 'd')).toBeNull();
  });

  it('그룹이 없으면 null', () => {
    expect(findOpenTmuxSession([], 'host-a', 'd')).toBeNull();
  });
});
