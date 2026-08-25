import { useEffect, useEffectEvent } from 'react';
import type { AuthState } from '@shared';
import { desktopApi } from '../store/appStore';

interface AuthBootstrapBridgeProps {
  hasStarted: boolean;
  onStarted: () => void;
  onAuthState: (state: AuthState) => void;
  onHydrateWorkspace: (state: AuthState) => Promise<void>;
  /** 워크스페이스를 열 수 있는 상태인가 — 계정으로 들어왔거나, 계정 없이 쓰기로 골랐거나. */
  isWorkspaceOpenableAuthState: (
    authState: Pick<AuthState, 'status' | 'session'>
  ) => boolean;
}

export function AuthBootstrapBridge({
  hasStarted,
  onStarted,
  onAuthState,
  onHydrateWorkspace,
  isWorkspaceOpenableAuthState,
}: AuthBootstrapBridgeProps) {
  const markStarted = useEffectEvent(onStarted);
  const handleAuthState = useEffectEvent(onAuthState);
  const hydrateWorkspace = useEffectEvent(onHydrateWorkspace);
  const isOpenableWorkspaceState = useEffectEvent(isWorkspaceOpenableAuthState);

  useEffect(() => {
    if (hasStarted) {
      return;
    }
    markStarted();

    void desktopApi.auth.bootstrap().then((state) => {
      handleAuthState(state);
      if (isOpenableWorkspaceState(state)) {
        void hydrateWorkspace(state);
      }
    });
  }, [hasStarted]);

  return null;
}
