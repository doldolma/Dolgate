import { useMemo } from 'react';
import {
  loadEcsServiceActionContext,
  loadEcsServiceLogs,
  startEcsServiceTunnel,
  stopEcsServiceTunnel,
} from '../services/desktop/aws-ecs';
import { onPortForwardRuntimeEvent } from '../services/desktop/port-forward-events';

export function useAwsEcsWorkspaceController() {
  return useMemo(
    () => ({
      onPortForwardRuntimeEvent,
      loadEcsServiceActionContext,
      loadEcsServiceLogs,
      startEcsServiceTunnel,
      stopEcsServiceTunnel,
    }),
    [],
  );
}
