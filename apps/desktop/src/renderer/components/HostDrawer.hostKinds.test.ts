import { describe, expect, it } from 'vitest';
import { resolveCreatableHostKinds } from './HostDrawer';

// 옛 클라이언트가 모르는 종류(RDP·VNC)는 서버가 계정 데이터 수준을 저장할 수 있어야 안전하다.
// 못 하는 서버(자체 호스팅 옛 버전)에서 만들면 같은 계정의 옛 기기가 그 레코드를 받아 조용히
// 망가지고, 서버가 막아 줄 수 없다.

describe('resolveCreatableHostKinds', () => {
  it('서버가 지원하면 옛 버전이 모르는 종류도 만들 수 있다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: true });

    expect(kinds.map((tab) => tab.kind)).toEqual(['ssh', 'serial', 'rdp', 'vnc']);
  });

  // **판정이 종류 이름에 매여 있지 않아야 한다.** 예전에는 RDP 만 걸렀는데, 그러면 새 종류를
  // 추가할 때 이 게이트를 기억해야 하고 한 번 잊으면 보호 없이 열린다.
  it('서버가 지원하지 않으면 옛 버전이 아는 종류만 남는다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: false });

    expect(kinds.map((tab) => tab.kind)).toEqual(['ssh', 'serial']);
    expect(kinds).toHaveLength(2);
  });
});
