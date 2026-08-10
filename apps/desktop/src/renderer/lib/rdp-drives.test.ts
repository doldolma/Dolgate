import { describe, expect, it } from 'vitest';
import { describeRdpDrives } from '@shared';

/**
 * 드라이브 이름 규칙은 shared-core 한 곳에만 있다. 편집 화면이 보여주는 이름과 코어가 원격에
 * 알리는 이름이 갈리면, 원격의 드라이브가 어느 폴더인지 알 수 없다.
 */
describe('describeRdpDrives', () => {
  it('names a drive after the last path segment', () => {
    expect(describeRdpDrives([{ path: '/Users/me/docs' }])).toEqual([
      { path: '/Users/me/docs', readOnly: false, name: 'docs' },
    ]);
  });

  it('ignores a trailing separator', () => {
    expect(describeRdpDrives([{ path: '/Users/me/docs/' }])[0].name).toBe('docs');
  });

  it('handles Windows-style separators', () => {
    expect(describeRdpDrives([{ path: 'C:\\Users\\me\\docs' }])[0].name).toBe('docs');
  });

  it('falls back when there is nothing to take', () => {
    expect(describeRdpDrives([{ path: '/' }])[0].name).toBe('Dolgate');
  });

  it('keeps duplicate names apart', () => {
    // 원격에서 이름이 겹치면 하나가 아예 안 보인다.
    const described = describeRdpDrives([
      { path: '/a/docs' },
      { path: '/b/docs' },
      { path: '/c/docs' },
    ]);
    expect(described.map((drive) => drive.name)).toEqual(['docs', 'docs 2', 'docs 3']);
  });

  it('carries the read-only flag as a plain boolean', () => {
    // 저장 계층은 null 도 쓴다. 코어로 나가는 값은 boolean 하나여야 한다.
    expect(
      describeRdpDrives([{ path: '/a', readOnly: true }, { path: '/b', readOnly: null }]),
    ).toEqual([
      { path: '/a', readOnly: true, name: 'a' },
      { path: '/b', readOnly: false, name: 'b' },
    ]);
  });

  it('drops entries without a path', () => {
    // 경로가 없으면 원격에 드라이브만 뜨고 모든 접근이 실패한다.
    expect(describeRdpDrives([{ path: '  ' }, { path: '/a' }])).toHaveLength(1);
  });

  it('treats a missing list as no drives', () => {
    expect(describeRdpDrives(null)).toEqual([]);
    expect(describeRdpDrives(undefined)).toEqual([]);
  });
});
