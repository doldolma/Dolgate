import { useEffect, useEffectEvent } from 'react';
import type { AuthState } from '@shared';
import { desktopApi } from '../store/appStore';

interface AuthBootstrapBridgeProps {
  hasStarted: boolean;
  onStarted: () => void;
  onAuthState: (state: AuthState) => void;
  onHydrateWorkspace: (state: AuthState) => Promise<void>;
  isWorkspaceAccessibleAuthState: (
    authState: Pick<AuthState, 'status' | 'session'>
  ) => authState is AuthState & { session: NonNullable<AuthState['session']> };
}

export function AuthBootstrapBridge({
  hasStarted,
  onStarted,
  onAuthState,
  onHydrateWorkspace,
  isWorkspaceAccessibleAuthState,
}: AuthBootstrapBridgeProps) {
  const markStarted = useEffectEvent(onStarted);
  const handleAuthState = useEffectEvent(onAuthState);
  const hydrateWorkspace = useEffectEvent(onHydrateWorkspace);
  const isAccessibleWorkspaceState = useEffectEvent(isWorkspaceAccessibleAuthState);

  useEffect(() => {
    if (hasStarted) {
      return;
    }
    markStarted();

    void desktopApi.auth.bootstrap().then((state) => {
      handleAuthState(state);
      if (isAccessibleWorkspaceState(state)) {
        void hydrateWorkspace(state);
      }
    });
  }, [hasStarted]);

  return null;
}
