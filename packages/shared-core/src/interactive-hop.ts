// 대화형 인증·호스트 키 물음을 낸 서버를 사람이 읽는 형태로 만든다.
//
// 데스크톱과 모바일이 같은 것을 보여줘야 하므로 여기 둔다 — 문구가 아니라 주소 조립이라 이 패키지의
// 규칙(코드만 돌려주고 문구는 앱이 붙인다)에 걸리지 않는다.

import { isSshHostRecord, normalizeJumpHostIds } from "./models";
import type { HostRecord, KeyboardInteractiveHop } from "./models";

/**
 * 주소로 저장된 호스트를 찾는다.
 *
 * 포트까지 맞는 것을 먼저 보고, 없으면 주소만 맞는 것을 쓴다. 같은 장비에 포트를 달리 저장해 둔
 * 경우가 있어서, 포트가 다르다고 이름을 못 붙이면 사용자는 자기가 아는 이름을 못 본다.
 *
 * HostRecord 는 합집합이고 kind 마다 필드가 다르므로("hostname" in record) 로 좁힌다 — AWS EC2
 * 항목에는 hostname·port 가 없다.
 */
export function findHostByAddress(
  hosts: readonly HostRecord[] | undefined,
  address: string | null | undefined,
  port?: number | null,
): HostRecord | undefined {
  if (!hosts?.length || !address) {
    return undefined;
  }
  const addressed = (record: HostRecord): boolean =>
    "hostname" in record && record.hostname === address;
  return (
    hosts.find(
      (record) => addressed(record) && "port" in record && record.port === port,
    ) ?? hosts.find(addressed)
  );
}

/**
 * 누가 물었는지를 사람이 읽는 형태로.
 *
 * **이름을 앞에 둔다.** 사용자는 보통 주소가 아니라 자기가 붙인 이름을 기억하고 있어서, 주소만
 * 보여 주면 점프 체인에서 어느 쪽 코드를 넣어야 하는지 바로 알기 어렵다. 주소는 뒤에 남겨 둔다 —
 * 이름이 겹치거나 기억과 다를 때 판단할 근거가 그것뿐이다.
 */
export function formatInteractiveHop(
  hop: KeyboardInteractiveHop | null | undefined,
  hosts?: readonly HostRecord[],
): string {
  if (!hop?.host) {
    return "";
  }
  const user = hop.username ? `${hop.username}@` : "";
  const port = hop.port ? `:${hop.port}` : "";
  const address = `${user}${hop.host}${port}`;
  const label = findHostByAddress(hosts, hop.host, hop.port)?.label?.trim();
  return label ? `${label} (${address})` : address;
}

/**
 * 이 SSH 호스트에 붙기 전에 올라와 있어야 하는 tailnet.
 *
 * **첫 홉의 설정이 우선이다.** 점프 체인에서 실제로 소켓을 여는 것은 첫 홉뿐이고(그 뒤는 SSH 채널을
 * 탄다), 올라와 있어야 하는 노드도 그 홉의 것이다.
 *
 * 대상에서 읽으면 "tailnet 안의 베스천을 거쳐 사내 LAN 호스트로" 가 안 된다 — 대상은 tailnet 에
 * 있지도 않으니 설정이 비어 있고, 그러면 베스천을 일반 네트워크로 찾다 실패한다. 실기기에서
 * `jump host: context deadline exceeded` 로 끝났다.
 *
 * 첫 홉에 설정이 없으면 대상의 것을 물려받는다. 예전에는 대상에만 설정해 두는 것이 유일한 방법이라
 * 그렇게 저장된 호스트가 이미 있다 — 그것들을 깨지 않는다.
 *
 * 첫 홉이 목록에 없으면(다른 기기에서 지운 점프 호스트 등) 판정하지 않고 대상의 것을 쓴다. 없는 것을
 * 근거로 대상의 설정까지 버리면 멀쩡하던 연결이 끊긴다.
 */
export function resolveSshHostTailnetId(
  host: HostRecord,
  hosts: readonly HostRecord[],
): string | undefined {
  const own =
    "tailnetId" in host ? host.tailnetId?.trim() || undefined : undefined;
  return resolveSshEntryHopTailnetId(host, hosts) ?? own;
}

/** 점프 체인 첫 홉에 설정된 tailnet. 체인이 없거나 그 홉에 설정이 없으면 undefined. */
export function resolveSshEntryHopTailnetId(
  host: HostRecord,
  hosts: readonly HostRecord[],
): string | undefined {
  if (!isSshHostRecord(host)) {
    return undefined;
  }
  const entryJumpId = normalizeJumpHostIds(host.jumpHostIds, host.jumpHostId)[0];
  if (!entryJumpId) {
    return undefined;
  }
  const entryJump = hosts.find((candidate) => candidate.id === entryJumpId);
  return entryJump && isSshHostRecord(entryJump)
    ? entryJump.tailnetId?.trim() || undefined
    : undefined;
}
