import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { AuthState, UpdateState } from '@shared';
import {
  addPasskey,
  beginBrowserLogin,
  cancelBrowserLogin,
  changeAccountPassword,
  checkForUpdates,
  closeWindow,
  deleteAccount,
  deletePasskey,
  dismissAvailableUpdate,
  downloadUpdate,
  installUpdateAndRestart,
  listPasskeys,
  logout,
  maximizeWindow,
  minimizeWindow,
  openExternalUrl,
  reopenBrowserLogin,
  restoreWindow,
  pushDirtySync,
  retryOnline,
  startLocalOnly,
  toggleFullScreenWindow,
} from '../services/desktop/auth-window-updater';
import { t } from '../i18n';

interface UseLoginControllerOptions {
  onAuthState: (state: AuthState) => void;
  onHydrateWorkspace: (state: AuthState) => Promise<void>;
  isWorkspaceAccessibleAuthState: (
    authState: Pick<AuthState, 'status' | 'session'>,
  ) => authState is AuthState & { session: NonNullable<AuthState['session']> };
  setUpdateState: Dispatch<SetStateAction<UpdateState>>;
}

function toUpdaterErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t('misc.updateActionFailed');
}

export function useLoginController({
  onAuthState,
  onHydrateWorkspace,
  isWorkspaceAccessibleAuthState,
  setUpdateState,
}: UseLoginControllerOptions) {
  const [isRetryingOnline, setIsRetryingOnline] = useState(false);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);

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

  /**
   * 계정 없이 시작한다.
   *
   * 워크스페이스는 **로컬 부트스트랩만** 돈다 — 올리고 내릴 서버가 없다. 하이드레이션에 그
   * 상태를 그대로 넘기면 신원(local-only)으로 알아서 갈린다.
   */
  const handleStartLocalOnly = useCallback(async () => {
    const nextState = await startLocalOnly();
    onAuthState(nextState);
    await onHydrateWorkspace(nextState);
  }, [onAuthState, onHydrateWorkspace]);

  /**
   * 로그아웃하기 전에 **먼저 밀어 본다.**
   *
   * 로그아웃은 이 기기의 로컬 데이터를 지운다(purgeSyncedCache). 아직 서버에 못 올린 변경이
   * 남아 있으면 그것도 함께 사라지는데, 지금까지는 확인도 없이 그렇게 됐다 — 오프라인에서
   * 고치고 로그아웃하면 조용히 잃었다.
   *
   * 다 올라갔으면 **아무것도 묻지 않는다.** 평소에는 조용해야 한다. 못 올린 것이 남았을 때만
   * 확인을 받는다 — 동기화에 대해 묻는 것이 아니라 되돌릴 수 없는 동작 직전의 확인이다.
   */
  const handleLogout = useCallback(async () => {
    let hasUnpushed = false;
    try {
      const status = await pushDirtySync();
      hasUnpushed = status?.pendingPush === true;
    } catch {
      // 밀지 못했다 = 남아 있다. 여기서 삼키면 잃는 쪽으로 기운다.
      hasUnpushed = true;
    }
    if (hasUnpushed) {
      setIsLogoutConfirmOpen(true);
      return;
    }
    await logout();
  }, []);

  const handleConfirmLogout = useCallback(async () => {
    setIsLogoutConfirmOpen(false);
    await logout();
  }, []);

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
    startLocalOnly: handleStartLocalOnly,
    beginBrowserLogin,
    reopenBrowserLogin,
    cancelBrowserLogin,
    logout: handleLogout,
    isLogoutConfirmOpen,
    confirmLogout: handleConfirmLogout,
    cancelLogout: () => setIsLogoutConfirmOpen(false),
    deleteAccount,
    changeAccountPassword,
    addPasskey,
    listPasskeys,
    deletePasskey,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    toggleFullScreenWindow,
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
