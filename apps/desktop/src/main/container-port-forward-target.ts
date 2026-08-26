import type { HostContainerDetails } from "@shared";
import { t } from './i18n';

export interface ResolvedContainerTunnelTarget {
  host: string;
  port: number;
  source: "container-network";
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

  // 네트워크를 고르지 않았으면(세션 패널의 도커 섹션이 그렇다) **우리가 고른다** — IP 가 있는
  // 첫 네트워크다. 대부분의 컨테이너는 네트워크가 하나뿐이고, 여럿이어도 어느 쪽으로든 컨테이너
  // 포트에 닿는다. 사용자에게 네트워크 이름을 묻는 것은 여기서 할 일이 아니다.
  const network = networkName
    ? details.networks.find((entry) => entry.name === networkName)
    : details.networks.find((entry) => (entry.ipAddress ?? "").trim().length > 0);
  const targetHost = network?.ipAddress?.trim() ?? "";
  if (!targetHost) {
    throw new Error(
      t('containerTarget.networkIpNotFound', {
        name: details.name,
        network: networkName || details.networks.map((entry) => entry.name).join(', '),
      }),
    );
  }

  return {
    host: targetHost,
    port: targetPort,
    source: "container-network",
  };
}
