import { describe, expect, it } from 'vitest';
import {
  describeRdpDrives,
  detachHostDrives,
  resolveHostDrives,
  withHostDrives,
  withLocalHostDrives,
} from '@shared';

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

describe('공유 폴더는 기기 로컬이다', () => {
  const local = { 'rdp-1': [{ path: '/Users/me/here', readOnly: true }] };
  const legacy = [{ path: 'C:\\Users\\other\\Downloads', readOnly: false }];

  it('이 기기에 항목이 있으면 레코드는 보지 않는다', () => {
    expect(resolveHostDrives('rdp-1', local, legacy)).toEqual([
      { path: '/Users/me/here', readOnly: true },
    ]);
  });

  it('빈 목록도 이 기기의 결정이다 — 레코드로 되살아나지 않는다', () => {
    expect(resolveHostDrives('rdp-1', { 'rdp-1': [] }, legacy)).toEqual([]);
  });

  it('항목이 없으면 레코드로 물러선다 — 옛 빌드에서 설정한 호스트를 잃지 않게', () => {
    expect(resolveHostDrives('rdp-1', {}, legacy)).toEqual(legacy);
    expect(resolveHostDrives('rdp-1', undefined, legacy)).toEqual(legacy);
  });

  it('돌려주는 배열은 원본과 분리되어 있다', () => {
    const resolved = resolveHostDrives('rdp-1', local, legacy);
    resolved.push({ path: '/tmp', readOnly: false });
    expect(local['rdp-1']).toHaveLength(1);
  });
});

describe('저장할 때 레코드에서 떼어 낸다', () => {
  const draft = {
    kind: 'rdp' as const,
    label: 'PC',
    hostname: '10.0.0.5',
    port: 3389,
    drives: [{ path: '/Users/me/here', readOnly: true }],
  };

  it('RDP 초안의 공유 폴더는 레코드로 나가지 않는다', () => {
    const { draft: outgoing, drives } = detachHostDrives(draft);
    // 레코드는 동기화된다 — 경로가 실려 나가면 다른 기기에서 열 수 없는 값이 된다.
    expect(outgoing).toMatchObject({ drives: null });
    expect(drives).toEqual([{ path: '/Users/me/here', readOnly: true }]);
  });

  it('폴더를 하나도 안 고른 것도 결정이다 — null 이 아니라 빈 목록으로 온다', () => {
    // null 로 오면 부르는 쪽이 "안 건드림" 으로 읽어, 이 기기에서 끈 것이 저장되지 않는다.
    expect(detachHostDrives({ ...draft, drives: null }).drives).toEqual([]);
  });

  it('RDP 가 아니면 그대로 둔다', () => {
    const ssh = { kind: 'ssh' as const, label: 'box', hostname: 'h', port: 22 };
    const result = detachHostDrives(ssh as never);
    expect(result.draft).toBe(ssh);
    expect(result.drives).toBeNull();
  });

  it('맵에 넣을 때 다른 호스트는 건드리지 않는다', () => {
    const before = { 'rdp-2': [{ path: '/other', readOnly: false }] };
    const after = withHostDrives(before, 'rdp-1', [{ path: '/here', readOnly: true }]);
    expect(after).toEqual({
      'rdp-2': [{ path: '/other', readOnly: false }],
      'rdp-1': [{ path: '/here', readOnly: true }],
    });
    expect(before).not.toHaveProperty('rdp-1');
  });
});

describe('보여주는 자리도 같은 값을 읽는다', () => {
  // 호스트 상세의 "공유 폴더" 줄과 탭 말풍선이 이것을 지난다. 여기가 레코드를 읽으면 화면이
  // 말하는 폴더와 실제로 원격에 열리는 폴더가 갈린다 — 파일이 노출되는 문제라 조용히 틀리면
  // 안 된다.
  const rdp = {
    id: 'rdp-1',
    kind: 'rdp' as const,
    label: 'PC',
    hostname: '10.0.0.5',
    port: 3389,
    drives: [{ path: 'C:\\Users\\other\\Downloads', readOnly: false }],
    createdAt: 'x',
    updatedAt: 'x',
  };
  const ssh = { id: 'ssh-1', kind: 'ssh' as const, label: 'box' };

  it('RDP 만 이 기기의 값으로 바뀐다', () => {
    const [swapped, untouched] = withLocalHostDrives(
      [rdp, ssh] as never,
      { 'rdp-1': [{ path: '/Users/me/here', readOnly: true }] },
    ) as never as [{ drives: unknown }, unknown];
    expect(swapped.drives).toEqual([{ path: '/Users/me/here', readOnly: true }]);
    expect(untouched).toBe(ssh);
  });

  it('이 기기에서 끈 호스트는 빈 목록으로 보인다', () => {
    const [swapped] = withLocalHostDrives([rdp] as never, { 'rdp-1': [] }) as never as [
      { drives: unknown },
    ];
    expect(swapped.drives).toEqual([]);
  });
});
