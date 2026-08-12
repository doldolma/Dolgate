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
  if (isSshHostRecord(host) || isRdpHostRecord(host)) {
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
  if (isSshHostRecord(host) || isRdpHostRecord(host) || isVncHostRecord(host)) {
    return host.hostname;
  }
  return undefined;
}
