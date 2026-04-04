import { useMemo } from 'react';
import { startContainerTunnel, stopContainerTunnel } from '../services/desktop/containers';

export function useContainersWorkspaceController() {
  return useMemo(
    () => ({
      startContainerTunnel,
      stopContainerTunnel,
    }),
    [],
  );
}
