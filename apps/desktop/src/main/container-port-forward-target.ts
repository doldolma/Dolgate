import type { HostContainerDetails } from "@shared";
import { t } from './i18n';

export interface ResolvedContainerTunnelTarget {
  host: string;
  port: number;
  source: "container-network" | "host-network";
}

// host 네트워킹 컨테이너는 자기 IP 가 없다 — 호스트의 네트워크 스택을 그대로 쓴다. 그래서 대상은
// 그 호스트의 루프백이다. 포워딩은 이미 그 호스트 안에서 dial 하므로 여기의 127.0.0.1 이 정확히
// 컨테이너가 듣고 있는 곳이다. `host` 는 도커의 예약 네트워크라 같은 이름의 사용자 네트워크는 없다.
const HOST_NETWORK_NAME = "host";
const HOST_NETWORK_TARGET = "127.0.0.1";

export interface ContainerNetworkChoice {
  name: string;
  ipAddress?: string | null;
}

export interface PickedContainerTunnelHost {
  host: string;
  source: ResolvedContainerTunnelTarget['source'];
}

/**
 * 터널이 향할 곳을 고른다. **이 규칙은 여기 한 곳에만 둔다** — 세션 패널이 실어 보낸 네트워크로
 * 열 때와 코어의 검사 결과로 열 때가 같은 답을 내야 한다. 정할 수 없으면 null 이고, 무엇을
 * 봤는지 적어 알리는 일은 호출자가 한다.
 */
export function pickContainerTunnelHost(
  networks: readonly ContainerNetworkChoice[],
  networkName: string,
): PickedContainerTunnelHost | null {
  // 네트워크를 고르지 않았으면(세션 패널의 도커 섹션이 그렇다) **우리가 고른다** — IP 가 있는
  // 첫 네트워크다. 대부분의 컨테이너는 네트워크가 하나뿐이고, 여럿이어도 어느 쪽으로든 컨테이너
  // 포트에 닿는다. 사용자에게 네트워크 이름을 묻는 것은 여기서 할 일이 아니다.
  const network = networkName
    ? networks.find((entry) => entry.name === networkName)
    : networks.find((entry) => (entry.ipAddress ?? '').trim().length > 0);
  const targetHost = network?.ipAddress?.trim() ?? '';
  if (targetHost) {
    return { host: targetHost, source: 'container-network' };
  }
  if (networks.some((entry) => entry.name === HOST_NETWORK_NAME)) {
    return { host: HOST_NETWORK_TARGET, source: 'host-network' };
  }
  return null;
}

export function resolveContainerTunnelTarget(
  details: HostContainerDetails,
  networkName: string,
  targetPort: number,
): ResolvedContainerTunnelTarget {
  const portOption = details.ports.find(
    (entry) => entry.protocol === "tcp" && entry.containerPort === targetPort,
  );
  if (!portOption) {
    throw new Error(
      t('containerTarget.portNotFound', { name: details.name, port: targetPort }),
    );
  }

  const picked = pickContainerTunnelHost(details.networks, networkName);
  if (!picked) {
    throw new Error(
      t('containerTarget.networkIpNotFound', {
        name: details.name,
        network: networkName || details.networks.map((entry) => entry.name).join(', '),
      }),
    );
  }

  return { host: picked.host, port: targetPort, source: picked.source };
}
