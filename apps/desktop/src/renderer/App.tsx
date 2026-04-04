import { useMemo, useRef, useState } from 'react';
import type {
  AppTheme,
  AuthState,
  DesktopWindowState,
  UpdateState,
} from '@shared';
import { AuthBootstrapBridge } from './bridges/AuthBootstrapBridge';
import { DesktopEventBridge } from './bridges/DesktopEventBridge';
import { DesktopStateBridge } from './bridges/DesktopStateBridge';
import { ThemeBridge } from './bridges/ThemeBridge';
import { useLoginController } from './controllers/useLoginController';
import { LoginShell } from './shells/LoginShell';
import { AppShell } from './shells/AppShell';
import {
  bootstrapSync,
  getAuthState,
} from './services/desktop/auth-window-updater';
import {
  useAppModalViewModel,
  useAppSettingsViewModel,
  useContainersViewModel,
  useHomeViewModel,
  useSessionWorkspaceViewModel,
  useSftpViewModel,
} from './view-models/appViewModels';

function resolveTheme(theme: AppTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') {
    return theme;
  }
  return prefersDark ? 'dark' : 'light';
}

function detectDesktopPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  const userAgent = navigator.userAgent.toLowerCase();
  const userAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = (
    userAgentData.userAgentData?.platform ??
    navigator.platform ??
    ''
  ).toLowerCase();

  if (platform.includes('mac') || userAgent.includes('mac os')) {
    return 'darwin';
  }
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'win32';
  }
  if (platform.includes('linux') || userAgent.includes('linux')) {
    return 'linux';
  }
  return 'unknown';
}

function createDefaultUpdateState(): UpdateState {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: '0.0.0',
    dismissedVersion: null,
    release: null,
    progress: null,
    checkedAt: null,
    errorMessage: null,
  };
}

function createDefaultWindowState(): DesktopWindowState {
  return {
    isMaximized: false,
  };
}

function isWorkspaceAccessibleAuthState(
  authState: Pick<AuthState, 'status' | 'session'>,
): authState is AuthState & { session: NonNullable<AuthState['session']> } {
  return (
    (authState.status === 'authenticated' ||
      authState.status === 'offline-authenticated') &&
    Boolean(authState.session)
  );
}

export function App() {
  const homeViewModel = useHomeViewModel();
  const sessionViewModel = useSessionWorkspaceViewModel();
  const containersViewModel = useContainersViewModel();
  const sftpViewModel = useSftpViewModel();
  const settingsViewModel = useAppSettingsViewModel();
  const modalViewModel = useAppModalViewModel();

  const [authState, setAuthState] = useState<AuthState>({
    status: 'loading',
    session: null,
    offline: null,
    errorMessage: null,
  });
  const [isSyncBootstrapping, setIsSyncBootstrapping] = useState(false);
  const [workspaceBootstrapError, setWorkspaceBootstrapError] = useState<string | null>(
    null,
  );
  const [hydratedSessionUserId, setHydratedSessionUserId] = useState<string | null>(
    null,
  );
  const [updateState, setUpdateState] = useState<UpdateState>(
    createDefaultUpdateState,
  );
  const [windowState, setWindowState] = useState<DesktopWindowState>(
    createDefaultWindowState,
  );
  const [isLoginServerSettingsLoading, setIsLoginServerSettingsLoading] =
    useState(true);
  const [prefersDark, setPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const authBootstrapStartedRef = useRef(false);
  const activeHydrationUserIdRef = useRef<string | null>(null);
  const hydratedOnlineSessionUserIdRef = useRef<string | null>(null);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);
  const resolvedTheme = useMemo(
    () => resolveTheme(settingsViewModel.settings.theme, prefersDark),
    [prefersDark, settingsViewModel.settings.theme],
  );

  async function hydrateSessionWorkspace(nextState: AuthState): Promise<void> {
    if (!isWorkspaceAccessibleAuthState(nextState)) {
      return;
    }

    const userId = nextState.session.user.id;
    const needsLocalBootstrap = hydratedSessionUserId !== userId;
    const needsOnlineSync =
      nextState.status === 'authenticated' &&
      hydratedOnlineSessionUserIdRef.current !== userId;
    if (
      (!needsLocalBootstrap && !needsOnlineSync) ||
      activeHydrationUserIdRef.current === userId
    ) {
      return;
    }

    activeHydrationUserIdRef.current = userId;
    setIsSyncBootstrapping(true);
    setWorkspaceBootstrapError(null);

    try {
      if (needsLocalBootstrap) {
        await homeViewModel.bootstrap();
        setHydratedSessionUserId(userId);
      }

      if (needsOnlineSync) {
        try {
          await bootstrapSync();
          await homeViewModel.refreshSyncedWorkspaceData();
          hydratedOnlineSessionUserIdRef.current = userId;
        } catch {
          const latestAuthState = await getAuthState();
          if (!isWorkspaceAccessibleAuthState(latestAuthState)) {
            setHydratedSessionUserId(null);
            hydratedOnlineSessionUserIdRef.current = null;
            return;
          }
        }
      }
    } catch (error) {
      const latestAuthState = await getAuthState();
      setHydratedSessionUserId(null);
      hydratedOnlineSessionUserIdRef.current = null;
      if (!isWorkspaceAccessibleAuthState(latestAuthState)) {
        setWorkspaceBootstrapError(null);
        return;
      }
      setWorkspaceBootstrapError(
        error instanceof Error
          ? error.message
          : '초기 워크스페이스를 불러오지 못했습니다.',
      );
    } finally {
      activeHydrationUserIdRef.current = null;
      setIsSyncBootstrapping(false);
    }
  }

  function handleAuthEvent(state: AuthState) {
    setAuthState(state);
    if (isWorkspaceAccessibleAuthState(state)) {
      void hydrateSessionWorkspace(state);
      return;
    }
    if (state.status === 'unauthenticated' || state.status === 'error') {
      homeViewModel.clearSyncedWorkspaceData();
      setHydratedSessionUserId(null);
      hydratedOnlineSessionUserIdRef.current = null;
      setWorkspaceBootstrapError(null);
      activeHydrationUserIdRef.current = null;
    }
  }

  const loginController = useLoginController({
    onAuthState: setAuthState,
    onHydrateWorkspace: hydrateSessionWorkspace,
    isWorkspaceAccessibleAuthState,
    setUpdateState,
  });

  const isAuthReady =
    isWorkspaceAccessibleAuthState(authState) &&
    hydratedSessionUserId === authState.session.user.id &&
    !isSyncBootstrapping;
  const needsWorkspaceRetry =
    isWorkspaceAccessibleAuthState(authState) &&
    hydratedSessionUserId !== authState.session.user.id &&
    !isSyncBootstrapping &&
    Boolean(workspaceBootstrapError);
  const offlineLeaseExpiryLabel = useMemo(() => {
    if (!authState.offline?.expiresAt) {
      return null;
    }
    return new Date(authState.offline.expiresAt).toLocaleString('ko-KR');
  }, [authState.offline?.expiresAt]);

  const bridgeLayer = (
    <>
      <AuthBootstrapBridge
        hasStarted={authBootstrapStartedRef.current}
        onStarted={() => {
          authBootstrapStartedRef.current = true;
        }}
        onAuthState={setAuthState}
        onHydrateWorkspace={hydrateSessionWorkspace}
        isWorkspaceAccessibleAuthState={isWorkspaceAccessibleAuthState}
      />
      <DesktopEventBridge
        onCoreEvent={homeViewModel.handleCoreEvent}
        onSftpConnectionProgress={sftpViewModel.handleSftpConnectionProgressEvent}
        onContainerConnectionProgress={
          containersViewModel.handleContainerConnectionProgressEvent
        }
        onTransferEvent={sftpViewModel.handleTransferEvent}
        onPortForwardEvent={homeViewModel.handlePortForwardEvent}
        onSessionShareEvent={sessionViewModel.handleSessionShareEvent}
        onSessionShareChatEvent={sessionViewModel.handleSessionShareChatEvent}
        onAuthEvent={handleAuthEvent}
      />
      <DesktopStateBridge
        loadSettings={settingsViewModel.loadSettings}
        onLoginServerSettingsReady={() => {
          setIsLoginServerSettingsLoading(false);
        }}
        onUpdateState={setUpdateState}
        onWindowState={setWindowState}
      />
      <ThemeBridge
        desktopPlatform={desktopPlatform}
        resolvedTheme={resolvedTheme}
        theme={settingsViewModel.settings.theme}
        onPrefersDarkChange={setPrefersDark}
      />
    </>
  );

  if (!isAuthReady) {
    return (
      <>
        {bridgeLayer}
        <LoginShell
          authState={authState}
          isSyncBootstrapping={isSyncBootstrapping}
          needsWorkspaceRetry={needsWorkspaceRetry}
          workspaceBootstrapError={workspaceBootstrapError}
          isLoginServerSettingsLoading={isLoginServerSettingsLoading}
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          settingsViewModel={settingsViewModel}
          loginController={loginController}
          onRetryWorkspaceBootstrap={async () => {
            if (isWorkspaceAccessibleAuthState(authState)) {
              await hydrateSessionWorkspace(authState);
            }
          }}
        />
      </>
    );
  }

  return (
    <>
      {bridgeLayer}
      <AppShell
        authState={authState}
        offlineLeaseExpiryLabel={offlineLeaseExpiryLabel}
        desktopPlatform={desktopPlatform}
        prefersDark={prefersDark}
        updateState={updateState}
        windowState={windowState}
        homeViewModel={homeViewModel}
        sessionViewModel={sessionViewModel}
        containersViewModel={containersViewModel}
        sftpViewModel={sftpViewModel}
        settingsViewModel={settingsViewModel}
        modalViewModel={modalViewModel}
        loginController={loginController}
      />
    </>
  );
}
