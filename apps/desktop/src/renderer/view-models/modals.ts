import { useAppStore } from '../store/appStore';

export function useAppModalViewModel() {
  const pendingHostKeyPrompt = useAppStore((state) => state.pendingHostKeyPrompt);
  const pendingCredentialRetry = useAppStore(
    (state) => state.pendingCredentialRetry,
  );
  const pendingAwsSftpConfigRetry = useAppStore(
    (state) => state.pendingAwsSftpConfigRetry,
  );
  const pendingMissingUsernamePrompt = useAppStore(
    (state) => state.pendingMissingUsernamePrompt,
  );
  const pendingInteractiveAuth = useAppStore(
    (state) => state.pendingInteractiveAuth,
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
  const respondInteractiveAuth = useAppStore((state) => state.respondInteractiveAuth);
  const reopenInteractiveAuthUrl = useAppStore(
    (state) => state.reopenInteractiveAuthUrl,
  );
  const clearPendingInteractiveAuth = useAppStore(
    (state) => state.clearPendingInteractiveAuth,
  );

  return {
    pendingHostKeyPrompt,
    pendingCredentialRetry,
    pendingAwsSftpConfigRetry,
    pendingMissingUsernamePrompt,
    pendingInteractiveAuth,
    acceptPendingHostKeyPrompt,
    dismissPendingHostKeyPrompt,
    dismissPendingCredentialRetry,
    submitCredentialRetry,
    dismissPendingAwsSftpConfigRetry,
    submitAwsSftpConfigRetry,
    dismissPendingMissingUsernamePrompt,
    submitMissingUsernamePrompt,
    respondInteractiveAuth,
    reopenInteractiveAuthUrl,
    clearPendingInteractiveAuth,
  };
}
