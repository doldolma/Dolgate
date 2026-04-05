import type { AuthState, DesktopWindowState } from '@shared';
import { DesktopWindowControls } from '../components/DesktopWindowControls';
import { LoginGate } from '../components/LoginGate';
import type { useLoginController } from '../controllers/useLoginController';
import type { useAppSettingsViewModel } from '../view-models/appViewModels';

interface LoginShellProps {
  authState: AuthState;
  isSyncBootstrapping: boolean;
  needsWorkspaceRetry: boolean;
  workspaceBootstrapError: string | null;
  isLoginServerSettingsLoading: boolean;
  desktopPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  windowState: DesktopWindowState;
  settingsViewModel: ReturnType<typeof useAppSettingsViewModel>;
  loginController: ReturnType<typeof useLoginController>;
  onRetryWorkspaceBootstrap: () => Promise<void>;
}

export function LoginShell({
  authState,
  isSyncBootstrapping,
  needsWorkspaceRetry,
  workspaceBootstrapError,
  isLoginServerSettingsLoading,
  desktopPlatform,
  windowState,
  settingsViewModel,
  loginController,
  onRetryWorkspaceBootstrap,
}: LoginShellProps) {
  async function saveLoginServerUrl(nextServerUrl: string): Promise<void> {
    await settingsViewModel.updateSettings({
      serverUrlOverride: nextServerUrl,
    });
  }

  async function resetLoginServerUrl(): Promise<void> {
    await settingsViewModel.updateSettings({
      serverUrlOverride: null,
    });
  }

  return (
    <div className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--accent-strong)_10%,transparent),transparent_24%),radial-gradient(circle_at_top_right,rgba(255,255,255,0.3),transparent_24%),linear-gradient(180deg,color-mix(in_srgb,var(--app-bg)_97%,white_3%),var(--app-bg))]">
      <div className="flex min-h-16 items-center justify-end px-[1.05rem] pb-0 pt-[0.95rem] [-webkit-app-region:drag]">
        <div className="flex-1" />
        <DesktopWindowControls
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          onMinimizeWindow={loginController.minimizeWindow}
          onMaximizeWindow={loginController.maximizeWindow}
          onRestoreWindow={loginController.restoreWindow}
          onCloseWindow={loginController.closeWindow}
        />
      </div>
      <LoginGate
        authState={
          needsWorkspaceRetry
            ? {
                ...authState,
                errorMessage: workspaceBootstrapError,
              }
            : authState
        }
        isSyncBootstrapping={isSyncBootstrapping}
        serverUrl={settingsViewModel.settings.serverUrl}
        hasServerUrlOverride={Boolean(settingsViewModel.settings.serverUrlOverride)}
        isLoadingServerUrl={isLoginServerSettingsLoading}
        onBeginLogin={loginController.beginBrowserLogin}
        onSaveServerUrl={saveLoginServerUrl}
        onResetServerUrl={resetLoginServerUrl}
        actionLabel={needsWorkspaceRetry ? '다시 시도' : undefined}
        onAction={needsWorkspaceRetry ? onRetryWorkspaceBootstrap : undefined}
      />
    </div>
  );
}
