import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppTheme,
  AuthState,
  DesktopWindowState,
  UpdateState,
} from '@shared';
import { AuthBootstrapBridge } from './bridges/AuthBootstrapBridge';
import { DesktopEventBridge } from './bridges/DesktopEventBridge';
import { NetworkBridge } from './bridges/NetworkBridge';
import { DesktopStateBridge } from './bridges/DesktopStateBridge';
import { LanguageBridge } from './bridges/LanguageBridge';
import { ThemeBridge } from './bridges/ThemeBridge';
import { useLoginController } from './controllers/useLoginController';
import { LoginShell } from './shells/LoginShell';
import { VaultGateShell } from './shells/VaultGateShell';
import { AppShell } from './shells/AppShell';
import {
  bootstrapSync,
  consumeWindowLaunchIntent,
  getAuthState,
} from './services/desktop/auth-window-updater';
import {
  useAiChatViewModel,
  useAppModalViewModel,
  useAppSettingsViewModel,
  useContainersViewModel,
  useHomeViewModel,
  useSessionWorkspaceViewModel,
  useSftpViewModel,
} from './view-models/appViewModels';
import { getFormatLocale, t } from './i18n';

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
    isFullScreen: false,
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

// E2EE 볼트 게이트 — 동기화 암호 설정/입력 전에는 워크스페이스를 열지 않는다.
function resolveVaultGateMode(
  authState: AuthState,
): 'setup-required' | 'locked' | 'error' | null {
  if (!isWorkspaceAccessibleAuthState(authState)) {
    return null;
  }
  const status = authState.vault?.status;
  return status === 'setup-required' || status === 'locked' || status === 'error'
    ? status
    : null;
}

export function App() {
  const homeViewModel = useHomeViewModel();
  const sessionViewModel = useSessionWorkspaceViewModel();
  const containersViewModel = useContainersViewModel();
  const sftpViewModel = useSftpViewModel();
  const settingsViewModel = useAppSettingsViewModel();
  const modalViewModel = useAppModalViewModel();
  const aiViewModel = useAiChatViewModel();

  useEffect(() => {
    // 알림 권한이 아직 미결정(default)이면 앱 시작 시 한 번 요청해 macOS 권한
    // 프롬프트를 띄운다. 메인 프로세스 Notification과 같은 앱 번들 권한을 공유한다.
    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      typeof window.Notification?.requestPermission === 'function' &&
      window.Notification.permission === 'default'
    ) {
      void window.Notification.requestPermission();
    }
  }, []);

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
  // 기존(v1) 유저의 E2EE 전환 프롬프트 "나중에" — 이번 실행 동안만 숨긴다.
  const [isVaultMigrationDeferred, setIsVaultMigrationDeferred] =
    useState(false);
  const [isLoginServerSettingsLoading, setIsLoginServerSettingsLoading] =
    useState(true);
  const [prefersDark, setPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const authBootstrapStartedRef = useRef(false);
  const launchIntentConsumedRef = useRef(false);
  const activeHydrationUserIdRef = useRef<string | null>(null);
  const hydratedOnlineSessionUserIdRef = useRef<string | null>(null);
  // 마지막으로 워크스페이스를 다시 읽은 시점의 sync 데이터 변경 타임스탬프. 폴링이 이 값이
  // 바뀌었을 때(=서버가 200 으로 실제 변경을 내려줬을 때)만 refresh 해 낭비를 막는다.
  const lastDataChangeRef = useRef<string | null>(null);
  const desktopPlatform = useMemo(() => detectDesktopPlatform(), []);
  const resolvedTheme = useMemo(
    () => resolveTheme(settingsViewModel.settings.theme, prefersDark),
    [prefersDark, settingsViewModel.settings.theme],
  );

  async function hydrateSessionWorkspace(nextState: AuthState): Promise<void> {
    if (!isWorkspaceAccessibleAuthState(nextState)) {
      return;
    }
    // 볼트 게이트 중에는 하이드레이션을 미룬다 — 잠금해제 브로드캐스트에서 이어진다.
    if (resolveVaultGateMode(nextState)) {
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
          const status = await bootstrapSync();
          await homeViewModel.refreshSyncedWorkspaceData();
          lastDataChangeRef.current = status?.lastDataChangeAt ?? null;
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
          : t('misc.workspaceLoadFailed'),
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
      // E2EE 전환 "나중에" 유예는 계정 단위 결정 — 로그아웃하면 초기화해서
      // 다음 계정(또는 재로그인)에는 프롬프트가 다시 뜨게 한다.
      setIsVaultMigrationDeferred(false);
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
    return new Date(authState.offline.expiresAt).toLocaleString(getFormatLocale());
  }, [authState.offline?.expiresAt]);

  // 다른 기기의 변경을 받아오는 폴링. 서버가 조건부 GET(ETag)을 지원하므로 변경이 없으면
  // 304 로 초경량이다. 창 포커스 복귀 시 즉시 1회 + 30초 주기로 당긴다. 온라인 인증 +
  // 볼트 게이트 아님 + 초기 동기화 완료일 때만 돌고, 진행 중이면 겹치지 않게 건너뛴다.
  const refreshSyncedWorkspaceData = homeViewModel.refreshSyncedWorkspaceData;
  const pollableUserId =
    authState.status === 'authenticated' &&
    isWorkspaceAccessibleAuthState(authState) &&
    // 동기화 가능한 볼트 상태(unlocked/legacy)에서만 폴링한다. 'none'(descriptor 해석
    // 실패 등)은 게이트도 안 뜨지만 pull 도 못 하므로 30초마다 오류만 반복하게 된다 —
    // 모바일 shouldPollSync 와 같은 기준.
    (authState.vault?.status === 'unlocked' ||
      authState.vault?.status === 'legacy')
      ? authState.session.user.id
      : null;
  useEffect(() => {
    if (!pollableUserId) {
      return;
    }
    let inFlight = false;
    const pull = async () => {
      // 겹침 방지 + 하이드레이션 진행 중이면 그쪽이 첫 pull 을 담당한다.
      if (inFlight || activeHydrationUserIdRef.current === pollableUserId) {
        return;
      }
      inFlight = true;
      try {
        // 조건부 GET(ETag). 변경이 없으면 서버가 304 라 lastDataChangeAt 이 그대로이고,
        // 그때는 워크스페이스 재조회(IPC)를 건너뛴다 — 304 최적화를 UI 까지 이어간다.
        const status = await bootstrapSync();
        const changeAt = status?.lastDataChangeAt ?? null;
        if (hydratedOnlineSessionUserIdRef.current !== pollableUserId) {
          // 하이드레이션의 온라인 동기화가 일시 오류(네트워크 blip 등)로 건너뛰어진
          // 세션 — 폴링이 자가 치유한다. 방금 동기화가 성공했으니 워크스페이스를 다시
          // 읽고 완료 표식을 남긴다(안 하면 이 세션은 다음 auth 브로드캐스트까지 영영
          // 동기화되지 않는다).
          await refreshSyncedWorkspaceData();
          lastDataChangeRef.current = changeAt;
          hydratedOnlineSessionUserIdRef.current = pollableUserId;
          return;
        }
        if (changeAt !== lastDataChangeRef.current) {
          await refreshSyncedWorkspaceData();
          lastDataChangeRef.current = changeAt;
        }
      } catch {
        // auth/vault 오류는 auth 브로드캐스트로 별도 처리된다.
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(() => {
      void pull();
    }, 30_000);
    const onFocus = () => {
      void pull();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [pollableUserId, refreshSyncedWorkspaceData]);

  useEffect(() => {
    if (!isAuthReady || launchIntentConsumedRef.current) {
      return;
    }
    launchIntentConsumedRef.current = true;
    void consumeWindowLaunchIntent()
      .then((intent) => {
        if (intent?.type === 'connect-host') {
          return homeViewModel.connectHost(intent.hostId, 120, 32);
        }
      })
      .catch(() => undefined);
  }, [homeViewModel.connectHost, isAuthReady]);

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
        onRdpEvent={homeViewModel.handleRdpEvent}
        onSftpConnectionProgress={sftpViewModel.handleSftpConnectionProgressEvent}
        onContainerConnectionProgress={
          containersViewModel.handleContainerConnectionProgressEvent
        }
        onActivityLogsChanged={homeViewModel.handleActivityLogsChanged}
        onTransferEvent={sftpViewModel.handleTransferEvent}
        onPortForwardEvent={homeViewModel.handlePortForwardEvent}
        onSessionShareEvent={sessionViewModel.handleSessionShareEvent}
        onSessionShareChatEvent={sessionViewModel.handleSessionShareChatEvent}
        onAuthEvent={handleAuthEvent}
        onWorkspaceChanged={() => {
          if (isAuthReady) {
            void homeViewModel.refreshSyncedWorkspaceData();
          }
        }}
        onAiChatEvent={aiViewModel.handleAiChatEvent}
      />
      <NetworkBridge />
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
      <LanguageBridge language={settingsViewModel.settings.language} />
    </>
  );

  const vaultGateMode = resolveVaultGateMode(authState);
  const isVaultMigrationRequired =
    authState.vault?.status === 'legacy' &&
    authState.vault.migrationRequired === true;
  const shouldPromptVaultMigration =
    !vaultGateMode &&
    authState.status === 'authenticated' &&
    authState.vault?.status === 'legacy' &&
    (isVaultMigrationRequired ||
      // 서버가 E2EE 를 지원한다고 확인된 뒤에만(셀프호스팅 구버전 서버 배려).
      (authState.vault.canMigrate === true && !isVaultMigrationDeferred));
  if (vaultGateMode || shouldPromptVaultMigration) {
    return (
      <>
        {bridgeLayer}
        <VaultGateShell
          mode={vaultGateMode ?? 'migrate'}
          authState={authState}
          onDefer={
            isVaultMigrationRequired
              ? undefined
              : () => setIsVaultMigrationDeferred(true)
          }
          desktopPlatform={desktopPlatform}
          windowState={windowState}
          onLogout={loginController.logout}
          onMinimizeWindow={loginController.minimizeWindow}
          onMaximizeWindow={loginController.maximizeWindow}
          onRestoreWindow={loginController.restoreWindow}
          onCloseWindow={loginController.closeWindow}
        />
      </>
    );
  }

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
