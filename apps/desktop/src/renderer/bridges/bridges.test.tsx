import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared';
import { AuthBootstrapBridge } from './AuthBootstrapBridge';
import { DesktopEventBridge } from './DesktopEventBridge';
import { DesktopStateBridge } from './DesktopStateBridge';

const mocks = vi.hoisted(() => {
  const listeners = {
    core: null as ((event: unknown) => void) | null,
    sftpProgress: null as ((event: unknown) => void) | null,
    containersProgress: null as ((event: unknown) => void) | null,
    transfer: null as ((event: unknown) => void) | null,
    forward: null as ((event: unknown) => void) | null,
    sessionShare: null as ((event: unknown) => void) | null,
    sessionShareChat: null as ((event: unknown) => void) | null,
    auth: null as ((state: unknown) => void) | null,
    updater: null as ((event: { state: unknown }) => void) | null,
    windowState: null as ((state: unknown) => void) | null,
  };

  return {
    desktopApi: {
      ssh: {
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.core = listener;
          return vi.fn();
        }),
      },
      sftp: {
        onConnectionProgress: vi.fn((listener: (event: unknown) => void) => {
          listeners.sftpProgress = listener;
          return vi.fn();
        }),
        onTransferEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.transfer = listener;
          return vi.fn();
        }),
      },
      containers: {
        onConnectionProgress: vi.fn((listener: (event: unknown) => void) => {
          listeners.containersProgress = listener;
          return vi.fn();
        }),
      },
      portForwards: {
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.forward = listener;
          return vi.fn();
        }),
      },
      sessionShares: {
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.sessionShare = listener;
          return vi.fn();
        }),
        onChatEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.sessionShareChat = listener;
          return vi.fn();
        }),
      },
      auth: {
        onEvent: vi.fn((listener: (state: unknown) => void) => {
          listeners.auth = listener;
          return vi.fn();
        }),
        bootstrap: vi.fn().mockResolvedValue({
          status: 'authenticated',
          session: { user: { id: 'user-1' } },
          offline: null,
          errorMessage: null,
        }),
      },
      updater: {
        getState: vi.fn().mockResolvedValue({ status: 'idle' }),
        onEvent: vi.fn((listener: (event: { state: unknown }) => void) => {
          listeners.updater = listener;
          return vi.fn();
        }),
      },
      window: {
        getState: vi.fn().mockResolvedValue({ isMaximized: false }),
        onStateChanged: vi.fn((listener: (state: unknown) => void) => {
          listeners.windowState = listener;
          return vi.fn();
        }),
      },
    },
    listeners,
  };
});

vi.mock('../store/appStore', () => ({
  get desktopApi() {
    return mocks.desktopApi;
  },
}));

describe('renderer bridges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mocks.listeners).forEach((listenerKey) => {
      void listenerKey;
    });
    mocks.listeners.core = null;
    mocks.listeners.sftpProgress = null;
    mocks.listeners.containersProgress = null;
    mocks.listeners.transfer = null;
    mocks.listeners.forward = null;
    mocks.listeners.sessionShare = null;
    mocks.listeners.sessionShareChat = null;
    mocks.listeners.auth = null;
    mocks.listeners.updater = null;
    mocks.listeners.windowState = null;
  });

  it('does not re-subscribe desktop events when props rerender', () => {
    const firstCore = vi.fn();
    const latestCore = vi.fn();
    const firstAuth = vi.fn();
    const latestAuth = vi.fn();
    const stableFn = vi.fn();

    const { rerender } = render(
      <DesktopEventBridge
        onCoreEvent={firstCore}
        onSftpConnectionProgress={stableFn}
        onContainerConnectionProgress={stableFn}
        onTransferEvent={stableFn}
        onPortForwardEvent={stableFn}
        onSessionShareEvent={stableFn}
        onSessionShareChatEvent={stableFn}
        onAuthEvent={firstAuth}
      />,
    );

    rerender(
      <DesktopEventBridge
        onCoreEvent={latestCore}
        onSftpConnectionProgress={stableFn}
        onContainerConnectionProgress={stableFn}
        onTransferEvent={stableFn}
        onPortForwardEvent={stableFn}
        onSessionShareEvent={stableFn}
        onSessionShareChatEvent={stableFn}
        onAuthEvent={latestAuth}
      />,
    );

    expect(mocks.desktopApi.ssh.onEvent).toHaveBeenCalledTimes(1);
    expect(mocks.desktopApi.auth.onEvent).toHaveBeenCalledTimes(1);

    mocks.listeners.core?.({ type: 'connected' });
    mocks.listeners.auth?.({ status: 'authenticated' });

    expect(firstCore).not.toHaveBeenCalled();
    expect(firstAuth).not.toHaveBeenCalled();
    expect(latestCore).toHaveBeenCalledWith({ type: 'connected' });
    expect(latestAuth).toHaveBeenCalledWith({ status: 'authenticated' });
  });

  it('does not reload settings or re-subscribe state bridges on rerender', async () => {
    const loadSettings = vi.fn().mockResolvedValue(undefined);
    const onLoginServerSettingsReady = vi.fn();
    const onUpdateState = vi.fn();
    const latestOnUpdateState = vi.fn();
    const onWindowState = vi.fn();
    const latestOnWindowState = vi.fn();

    const { rerender } = render(
      <DesktopStateBridge
        loadSettings={loadSettings}
        onLoginServerSettingsReady={onLoginServerSettingsReady}
        onUpdateState={onUpdateState}
        onWindowState={onWindowState}
      />,
    );

    await waitFor(() => {
      expect(loadSettings).toHaveBeenCalledTimes(1);
    });

    rerender(
      <DesktopStateBridge
        loadSettings={loadSettings}
        onLoginServerSettingsReady={onLoginServerSettingsReady}
        onUpdateState={latestOnUpdateState}
        onWindowState={latestOnWindowState}
      />,
    );

    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.desktopApi.updater.onEvent).toHaveBeenCalledTimes(1);
    expect(mocks.desktopApi.window.onStateChanged).toHaveBeenCalledTimes(1);

    mocks.listeners.updater?.({ state: { status: 'available' } });
    mocks.listeners.windowState?.({ isMaximized: true });

    expect(onUpdateState).not.toHaveBeenCalledWith({ status: 'available' });
    expect(onWindowState).not.toHaveBeenCalledWith({ isMaximized: true });
    expect(latestOnUpdateState).toHaveBeenCalledWith({ status: 'available' });
    expect(latestOnWindowState).toHaveBeenCalledWith({ isMaximized: true });
  });

  it('bootstraps auth only once across rerenders', async () => {
    const onStarted = vi.fn();
    const onAuthState = vi.fn();
    const onHydrateWorkspace = vi.fn().mockResolvedValue(undefined);
    const isWorkspaceAccessibleAuthState = (
      authState: Pick<AuthState, 'status' | 'session'>,
    ): authState is AuthState & {
      session: NonNullable<AuthState['session']>;
    } =>
      authState.status === 'authenticated' && Boolean(authState.session);

    const { rerender } = render(
      <AuthBootstrapBridge
        hasStarted={false}
        onStarted={onStarted}
        onAuthState={onAuthState}
        onHydrateWorkspace={onHydrateWorkspace}
        isWorkspaceAccessibleAuthState={isWorkspaceAccessibleAuthState}
      />,
    );

    await waitFor(() => {
      expect(mocks.desktopApi.auth.bootstrap).toHaveBeenCalledTimes(1);
    });

    rerender(
      <AuthBootstrapBridge
        hasStarted={true}
        onStarted={vi.fn()}
        onAuthState={vi.fn()}
        onHydrateWorkspace={vi.fn().mockResolvedValue(undefined)}
        isWorkspaceAccessibleAuthState={isWorkspaceAccessibleAuthState}
      />,
    );

    expect(mocks.desktopApi.auth.bootstrap).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});
