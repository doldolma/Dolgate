import { useMemo } from 'react';
import {
  listEcsTaskTunnelServices,
  loadEcsTaskTunnelService,
} from '../services/desktop/aws-ecs';
import {
  inspectHostContainer,
  listHostContainers,
  onContainersConnectionProgress,
  releaseContainerHost,
} from '../services/desktop/containers';
import { probeKnownHost, replaceKnownHost, trustKnownHost } from '../services/desktop/known-hosts';

export function usePortForwardingPanelController() {
  return useMemo(
    () => ({
      releaseContainerHost,
      listEcsTaskTunnelServices,
      loadEcsTaskTunnelService,
      probeKnownHost,
      listHostContainers,
      inspectHostContainer,
      replaceKnownHost,
      trustKnownHost,
      onContainersConnectionProgress,
    }),
    [],
  );
}
