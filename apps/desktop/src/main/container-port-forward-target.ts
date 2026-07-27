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

  const network = details.networks.find((entry) => entry.name === networkName);
  const targetHost = network?.ipAddress?.trim() ?? "";
  if (!targetHost) {
    throw new Error(
      t('containerTarget.networkIpNotFound', { name: details.name, network: networkName }),
    );
  }

  return {
    host: targetHost,
    port: targetPort,
    source: "container-network",
  };
}
