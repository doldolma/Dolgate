import { findUnownedHostKeyPrompt } from '../store/utils';
import { useAppStore } from '../store/appStore';

export function useAppModalViewModel() {
  const pendingHostKeyPrompt = useAppStore((state) => state.pendingHostKeyPrompt);
  /**
   * 전역 대화상자가 받아야 할 물음.
   *
   * 탭이 있는 연결은 **그 판 안에서** 묻는다(TerminalHostKeyTrustCard). 여기서 전부 그리면 보고
   * 있던 탭 위로 남의 물음이 올라오고, 연결을 여러 개 걸면 그것이 줄줄이 이어진다 — 실기기에서
   * 겪은 그 상태다. 그래서 탭이 받아 주지 않는 것만 남긴다.
   */
  const unownedHostKeyPrompt = useAppStore((state) =>
    findUnownedHostKeyPrompt(state, (sessionId) =>
      state.tabs.some((tab) => tab.sessionId === sessionId),
    ),
  );
  const pendingCredentialRetry = useAppStore(
    (state) => state.pendingCredentialRetry,
  );
  const pendingAwsSftpConfigRetry = useAppStore(
    (state) => state.pendingAwsSftpConfigRetry,
  );
  const pendingMissingUsernamePrompt = useAppStore(
    (state) => state.pendingMissingUsernamePrompt,
  );
  const pendingStartupCommandPrompt = useAppStore(
    (state) => state.pendingStartupCommandPrompt,
  );
  const pendingInteractiveAuths = useAppStore(
    (state) => state.pendingInteractiveAuths,
  );
  const acceptPendingHostKeyPrompt = useAppStore(
    (state) => state.acceptPendingHostKeyPrompt,
  );
  const dismissPendingHostKeyPrompt = useAppStore(
    (state) => state.dismissPendingHostKeyPrompt,
  );
  const dismissPendingCredentialRetry = useAppStore(
    (state) => state.dismissPendingCredentialRetry,
  );
  const submitCredentialRetry = useAppStore((state) => state.submitCredentialRetry);
  const dismissPendingAwsSftpConfigRetry = useAppStore(
    (state) => state.dismissPendingAwsSftpConfigRetry,
  );
  const submitAwsSftpConfigRetry = useAppStore(
    (state) => state.submitAwsSftpConfigRetry,
  );
  const dismissPendingMissingUsernamePrompt = useAppStore(
    (state) => state.dismissPendingMissingUsernamePrompt,
  );
  const submitMissingUsernamePrompt = useAppStore(
    (state) => state.submitMissingUsernamePrompt,
  );
  const confirmStartupCommandPrompt = useAppStore(
    (state) => state.confirmStartupCommandPrompt,
  );
  const cancelStartupCommandPrompt = useAppStore(
    (state) => state.cancelStartupCommandPrompt,
  );
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const reopenInteractiveAuthUrl = useAppStore(
    (state) => state.reopenInteractiveAuthUrl,
  );
  const clearPendingInteractiveAuth = useAppStore(
    (state) => state.clearPendingInteractiveAuth,
  );

  return {
    pendingHostKeyPrompt,
    unownedHostKeyPrompt,
    pendingCredentialRetry,
    pendingAwsSftpConfigRetry,
    pendingMissingUsernamePrompt,
    pendingStartupCommandPrompt,
    pendingInteractiveAuths,
    acceptPendingHostKeyPrompt,
    dismissPendingHostKeyPrompt,
    dismissPendingCredentialRetry,
    submitCredentialRetry,
    dismissPendingAwsSftpConfigRetry,
    submitAwsSftpConfigRetry,
    dismissPendingMissingUsernamePrompt,
    submitMissingUsernamePrompt,
    confirmStartupCommandPrompt,
    cancelStartupCommandPrompt,
    respondInteractiveAuth,
    reopenInteractiveAuthUrl,
    clearPendingInteractiveAuth,
  };
}
