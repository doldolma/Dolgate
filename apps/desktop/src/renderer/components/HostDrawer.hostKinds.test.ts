import { describe, expect, it } from 'vitest';
import { resolveCreatableHostKinds } from './HostDrawer';

// RDP 호스트는 서버가 계정 데이터 수준을 저장할 수 있어야 안전하다. 못 하는 서버(자체 호스팅 옛
// 버전)에서 만들면 같은 계정의 옛 기기가 그 레코드를 받아 조용히 망가지고, 서버가 막아 줄 수 없다.

describe('resolveCreatableHostKinds', () => {
  it('서버가 지원하면 RDP 도 만들 수 있다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: true });

    expect(kinds.map((tab) => tab.kind)).toEqual(['ssh', 'serial', 'rdp']);
  });

  it('서버가 지원하지 않으면 RDP 를 열지 않는다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: false });

    expect(kinds.map((tab) => tab.kind)).toEqual(['ssh', 'serial']);
    // SSH·시리얼은 옛 클라이언트도 아는 종류라 영향이 없어야 한다.
    expect(kinds).toHaveLength(2);
  });
});
