import type { HostContainerDetails } from "@shared";

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
      `${details.name} 컨테이너에서 TCP ${targetPort} 포트를 찾지 못했습니다.`,
    );
  }

  const network = details.networks.find((entry) => entry.name === networkName);
  const targetHost = network?.ipAddress?.trim() ?? "";
  if (!targetHost) {
    throw new Error(
      `${details.name} 컨테이너의 ${networkName} 네트워크 IP를 확인하지 못했습니다.`,
    );
  }

  return {
    host: targetHost,
    port: targetPort,
    source: "container-network",
  };
}
