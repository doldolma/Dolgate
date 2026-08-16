import { isRdpHostRecord, isSshHostRecord, isVncHostRecord } from '@shared';
import type { HostRecord } from '@shared';

/**
 * 이 호스트에 붙기 전에 올라와 있어야 하는 tailnet.
 *
 * **종류마다 필드가 따로 있어서 한 곳에 모은다.** 빠뜨린 종류는 노드가 내려간 상태로 붙으려 하고,
 * 실패 이유가 "연결할 수 없음" 으로만 보인다 — VNC 가 실제로 그랬다(호출자는 `ensureTailnetReady`
 * 를 부르고 있었는데 판정 쪽이 VNC 를 몰라서 조용히 통과했다).
 *
 * VNC 는 SSH 터널로도 갈 수 있고, 그때 tailnet 은 **경유 호스트**에 붙어 있다. 터널이 그 호스트의
 * tailnet 설정을 그대로 타므로(`ipc/vnc.ts` 의 `resolveTailnetRoute`) 올려야 하는 노드도 그쪽이다.
 * 그래서 호스트 목록을 함께 받는다.
 */
export function resolveHostTailnetId(
  host: HostRecord | undefined,
  hosts: readonly HostRecord[],
): string | undefined {
  if (!host) {
    return undefined;
  }
  if (isSshHostRecord(host)) {
    // **첫 홉의 설정이 우선이다.** 점프 체인에서 실제로 소켓을 여는 것은 첫 홉뿐이고
    // (그 뒤는 SSH 채널을 탄다), 올라와 있어야 하는 노드도 그 홉의 것이다.
    //
    // 대상에서 읽으면 "tailnet 안의 베스천을 거쳐 사내 LAN 호스트로" 가 안 된다 — 대상은
    // tailnet 에 있지도 않으니 설정이 비어 있고, 그러면 베스천을 일반 네트워크로 찾다 실패한다.
    //
    // 첫 홉에 없으면 대상의 것을 물려받는다. 예전에는 대상에만 설정해 두는 것이 유일한 방법이라
    // 그렇게 저장된 호스트가 이미 있다 — 그것들을 깨지 않는다.
    return (
      resolveEntryHopTailnetId(host, hosts) ?? (host.tailnetId?.trim() || undefined)
    );
  }
  if (isRdpHostRecord(host)) {
    return host.tailnetId?.trim() || undefined;
  }
  if (!isVncHostRecord(host)) {
    return undefined;
  }
  // 직접 지정한 tailnet 이 우선이다. 폼이 둘을 상호배타로 막지만, 예전에 저장한 호스트나 다른
  // 기기에서 동기화된 호스트에는 둘 다 들어 있을 수 있다 — 접속 경로도 tailnet 을 먼저 본다.
  const direct = host.tailnetId?.trim();
  if (direct) {
    return direct;
  }
  const tunnelHostId = host.sshTunnelHostId?.trim();
  if (!tunnelHostId) {
    return undefined;
  }
  const tunnelHost = hosts.find((candidate) => candidate.id === tunnelHostId);
  return tunnelHost && isSshHostRecord(tunnelHost)
    ? tunnelHost.tailnetId?.trim() || undefined
    : undefined;
}

/**
 * 점프 체인의 첫 홉에 설정된 tailnet. 체인이 없거나 그 홉에 설정이 없으면 undefined.
 *
 * 첫 홉이 목록에 없으면(다른 기기에서 지운 점프 호스트 등) 판정하지 않는다 — 없는 것을 근거로
 * 대상의 설정까지 버리면 멀쩡하던 연결이 끊긴다.
 */
function resolveEntryHopTailnetId(
  host: HostRecord,
  hosts: readonly HostRecord[],
): string | undefined {
  if (!isSshHostRecord(host)) {
    return undefined;
  }
  const chain =
    Array.isArray(host.jumpHostIds) && host.jumpHostIds.length > 0
      ? host.jumpHostIds
      : host.jumpHostId
        ? [host.jumpHostId]
        : [];
  const entryJumpId = chain.find(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (!entryJumpId) {
    return undefined;
  }
  const entryJump = hosts.find((candidate) => candidate.id === entryJumpId);
  return entryJump && isSshHostRecord(entryJump)
    ? entryJump.tailnetId?.trim() || undefined
    : undefined;
}

/**
 * tailnet 넷맵에서 찾아야 하는 기기의 주소.
 *
 * 터널을 쓰면 VNC 호스트의 주소는 **경유 서버에서 본** 것이라(대개 `127.0.0.1`) 넷맵에 있을 수
 * 없다. 그것을 그대로 넘기면 "대상 기기가 넷맵에 없습니다" 가 거짓으로 뜬다 — 찾아야 하는 기기는
 * 경유 호스트다.
 */
export function resolveTailnetTargetAddress(
  host: HostRecord | undefined,
  hosts: readonly HostRecord[],
): string | undefined {
  if (!host) {
    return undefined;
  }
  if (isVncHostRecord(host) && !host.tailnetId?.trim()) {
    const tunnelHostId = host.sshTunnelHostId?.trim();
    const tunnelHost = tunnelHostId
      ? hosts.find((candidate) => candidate.id === tunnelHostId)
      : undefined;
    if (tunnelHost && isSshHostRecord(tunnelHost)) {
      return tunnelHost.hostname;
    }
  }
  if (isSshHostRecord(host)) {
    // 점프 호스트가 있으면 tailnet 이 닿아야 하는 기기는 **첫 홉**이다.
    //
    // 최종 대상은 그 홉의 망에서 보이는 주소라(사내 LAN 등) 넷맵에 있을 이유가 없다. 그대로
    // 넘기면 "이 Tailscale 네트워크에서 그 기기를 찾을 수 없습니다" 가 거짓으로 뜬다 — 터널을
    // 쓰는 VNC 에서 이미 같은 거짓 진단을 겪어 위쪽에서 처리한 것과 같은 문제다.
    const chain =
      Array.isArray(host.jumpHostIds) && host.jumpHostIds.length > 0
        ? host.jumpHostIds
        : host.jumpHostId
          ? [host.jumpHostId]
          : [];
    // 체인의 첫 항목이 클라이언트가 직접 붙는 홉이다(뒤로 갈수록 대상에 가깝다).
    const entryJumpId = chain.find(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const entryJump = entryJumpId
      ? hosts.find((candidate) => candidate.id === entryJumpId)
      : undefined;
    if (entryJump && isSshHostRecord(entryJump)) {
      return entryJump.hostname;
    }
    return host.hostname;
  }
  if (isRdpHostRecord(host) || isVncHostRecord(host)) {
    return host.hostname;
  }
  return undefined;
}
