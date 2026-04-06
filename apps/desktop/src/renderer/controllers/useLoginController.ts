import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { AuthState, UpdateState } from '@shared';
import {
  beginBrowserLogin,
  cancelBrowserLogin,
  checkForUpdates,
  closeWindow,
  dismissAvailableUpdate,
  downloadUpdate,
  installUpdateAndRestart,
  logout,
  maximizeWindow,
  minimizeWindow,
  openExternalUrl,
  reopenBrowserLogin,
  restoreWindow,
  retryOnline,
} from '../services/desktop/auth-window-updater';

interface UseLoginControllerOptions {
  onAuthState: (state: AuthState) => void;
  onHydrateWorkspace: (state: AuthState) => Promise<void>;
  isWorkspaceAccessibleAuthState: (
    authState: Pick<AuthState, 'status' | 'session'>,
  ) => authState is AuthState & { session: NonNullable<AuthState['session']> };
  setUpdateState: Dispatch<SetStateAction<UpdateState>>;
}

function toUpdaterErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '업데이트 작업 중 오류가 발생했습니다.';
}

export function useLoginController({
  onAuthState,
  onHydrateWorkspace,
  isWorkspaceAccessibleAuthState,
  setUpdateState,
}: UseLoginControllerOptions) {
  const [isRetryingOnline, setIsRetryingOnline] = useState(false);

  const runUpdaterAction = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        setUpdateState((current) => ({
          ...current,
          status: 'error',
          errorMessage: toUpdaterErrorMessage(error),
        }));
      }
    },
    [setUpdateState],
  );

  const handleRetryOnline = useCallback(async () => {
    setIsRetryingOnline(true);
    try {
      const nextState = await retryOnline();
      onAuthState(nextState);
      if (isWorkspaceAccessibleAuthState(nextState)) {
        await onHydrateWorkspace(nextState);
      }
    } finally {
      setIsRetryingOnline(false);
    }
  }, [isWorkspaceAccessibleAuthState, onAuthState, onHydrateWorkspace]);

  return {
    isRetryingOnline,
    beginBrowserLogin,
    reopenBrowserLogin,
    cancelBrowserLogin,
    logout,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    closeWindow,
    openExternalUrl,
    checkForUpdates: () => runUpdaterAction(checkForUpdates),
    downloadUpdate: () => runUpdaterAction(downloadUpdate),
    dismissAvailableUpdate: (version: string) =>
      runUpdaterAction(() => dismissAvailableUpdate(version)),
    installUpdateAndRestart: () => runUpdaterAction(installUpdateAndRestart),
    runUpdaterAction,
    retryOnline: handleRetryOnline,
  };
}
