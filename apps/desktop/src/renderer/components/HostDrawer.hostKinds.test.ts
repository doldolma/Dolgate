import { describe, expect, it } from 'vitest';
import { resolveCreatableHostKinds } from './HostDrawer';

// 옛 클라이언트가 모르는 종류(RDP·VNC)는 서버가 계정 데이터 수준을 저장할 수 있어야 안전하다.
// 못 하는 서버(자체 호스팅 옛 버전)에서 만들면 같은 계정의 옛 기기가 그 레코드를 받아 조용히
// 망가지고, 서버가 막아 줄 수 없다.

describe('resolveCreatableHostKinds', () => {
  it('서버가 지원하면 네 종류 모두 고를 수 있다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: true });

    expect(kinds.map((tab) => tab.kind)).toEqual(['ssh', 'serial', 'rdp', 'vnc']);
    expect(kinds.every((tab) => !tab.disabled)).toBe(true);
  });

  // **판정이 종류 이름에 매여 있지 않아야 한다.** 예전에는 RDP 만 걸렀는데, 그러면 새 종류를
  // 추가할 때 이 게이트를 기억해야 하고 한 번 잊으면 보호 없이 열린다.
  it('서버가 지원하지 않으면 옛 버전이 모르는 종류만 비활성이다', () => {
    const kinds = resolveCreatableHostKinds({ serverSupportsDataFloor: false });

    expect(
      kinds.map((tab) => [tab.kind, tab.disabled] as const),
    ).toEqual([
      ['ssh', false],
      ['serial', false],
      ['rdp', true],
      ['vnc', true],
    ]);
  });

  // **숨기지 않는다.** 칸이 사라지면 사용자는 그 기능이 없는 줄 알거나, 다른 기기에서는 보이는데
  // 여기서는 안 보이는 이유를 알 수 없다. 자리를 지키고 왜 안 되는지 알려 주는 쪽이다.
  it('지원하지 않는 서버에서도 칸이 사라지지 않는다', () => {
    const supported = resolveCreatableHostKinds({ serverSupportsDataFloor: true });
    const unsupported = resolveCreatableHostKinds({ serverSupportsDataFloor: false });

    expect(unsupported).toHaveLength(supported.length);
    expect(unsupported.map((tab) => tab.kind)).toEqual(
      supported.map((tab) => tab.kind),
    );
  });
});
