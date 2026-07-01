import type { HostRecord } from '@shared';

// 다단 ProxyJump 홉 인덱스(1-based, 가장 깊은 점프=1 … 최종 대상=length)에 대응하는 친숙한
// 호스트 이름 배열을 만든다. Go가 주는 홉 라벨은 user@host:port뿐이라, 사용자가 붙인 호스트
// 라벨을 얹어 "Lime-DB → Lime-GW → lime-dev"처럼 보이게 하기 위한 것. 스토어의 홉 이벤트
// 핸들러가 각 연결의 대상 호스트로 이 배열을 만들어 홉에 name을 채운다.
//
// footgun 회피: shared-core의 신규 value export(normalizeJumpHostIds)를 렌더러에서 직접 import하면
// vite dev의 export* 처리로 심볼이 드롭돼 앱이 블랭크가 될 수 있어, 체인 정규화를 인라인한다.
// 타입 import(HostRecord)는 안전하다.
export function resolveHopHostNames(
  host: HostRecord | undefined | null,
  hosts: readonly HostRecord[],
): string[] {
  if (!host) {
    return [];
  }
  if (host.kind !== 'ssh') {
    // 점프 체인이 없는 단일 홉(warpgate/aws/serial 등) — 대상 하나뿐.
    return [host.label];
  }
  const source =
    Array.isArray(host.jumpHostIds) && host.jumpHostIds.length > 0
      ? host.jumpHostIds
      : host.jumpHostId
        ? [host.jumpHostId]
        : [];
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const id of source) {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      chain.push(id);
    }
  }
  // 순서: 첫 홉(클라이언트에서 직접 연결) … 마지막 점프 … 최종 대상(호스트 자신).
  const jumpNames = chain.map(
    (id) => hosts.find((entry) => entry.id === id)?.label ?? id,
  );
  return [...jumpNames, host.label];
}
