// 폼에서 새로 만들 수 있는 호스트 종류.
//
// **RDP·VNC 는 서버가 계정 데이터 수준(sync_data_floor)을 판정할 때만 열린다.** 못 하는
// 서버(자체 호스팅 옛 버전)에서는 우리가 보내는 수준 헤더를 아무도 읽지 않아, 옛 클라이언트를
// 막아 주는 장치가 없다 — 그 계정의 옛 기기가 RDP 레코드를 받아 조용히 망가진다.
//
// 숨기지 않고 비활성으로 둔다. 없애면 사용자는 그 기능이 아예 없는 줄 알거나, 다른 기기에서는
// 보이는데 폰에서는 안 보이는 이유를 알 수 없다.
//
// **판정을 종류 이름으로 하지 않는다** — `kind === 'rdp'` 로 적으면 종류를 늘릴 때마다 이
// 함수를 기억해야 하고, 한 번 잊으면 보호 없이 열린다. 데스크톱(resolveCreatableHostKinds)과
// 같은 규칙이다.
import { LEGACY_TOLERATED_HOST_KINDS } from '@dolssh/shared-core';
import type { HostFormKind } from '../components/HostFormFields';

export const HOST_FORM_KINDS: readonly HostFormKind[] = ['ssh', 'rdp', 'vnc'];

export function resolveCreatableHostFormKinds(input: {
  serverSupportsDataFloor: boolean;
}): ReadonlyArray<{ kind: HostFormKind; disabled: boolean }> {
  return HOST_FORM_KINDS.map(kind => ({
    kind,
    disabled:
      !LEGACY_TOLERATED_HOST_KINDS.has(kind) && !input.serverSupportsDataFloor,
  }));
}
