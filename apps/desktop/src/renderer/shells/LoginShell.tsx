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
    <div className="app-frame app-frame--login">
      <div className="login-window-chrome">
        <div className="login-window-chrome__spacer" />
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
