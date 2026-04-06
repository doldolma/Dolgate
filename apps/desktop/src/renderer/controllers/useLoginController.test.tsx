import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared';
import { useLoginController } from './useLoginController';

const mocks = vi.hoisted(() => ({
  beginBrowserLogin: vi.fn(),
  reopenBrowserLogin: vi.fn(),
  cancelBrowserLogin: vi.fn(),
  checkForUpdates: vi.fn(),
  closeWindow: vi.fn(),
  dismissAvailableUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdateAndRestart: vi.fn(),
  logout: vi.fn(),
  maximizeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  openExternalUrl: vi.fn(),
  restoreWindow: vi.fn(),
  retryOnline: vi.fn(),
}));

vi.mock('../services/desktop/auth-window-updater', () => mocks);

function renderController() {
  let controller: ReturnType<typeof useLoginController> | null = null;

  function Harness() {
    controller = useLoginController({
      onAuthState: vi.fn(),
      onHydrateWorkspace: vi.fn().mockResolvedValue(undefined),
      isWorkspaceAccessibleAuthState: (
        state,
      ): state is AuthState & { session: NonNullable<AuthState['session']> } =>
        state.status === 'authenticated' && Boolean(state.session),
      setUpdateState: vi.fn(),
    });
    return null;
  }

  render(<Harness />);
  return controller!;
}

describe('useLoginController', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((value) => {
      if (typeof value === 'function' && 'mockReset' in value) {
        value.mockReset();
      }
    });
  });

  it('wraps updater actions with the shared updater runner', async () => {
    const controller = renderController();
    mocks.checkForUpdates.mockResolvedValue(undefined);

    await act(async () => {
      await controller.checkForUpdates();
    });

    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('exposes browser login recovery actions from the desktop bridge', async () => {
    const controller = renderController();
    mocks.reopenBrowserLogin.mockResolvedValue(undefined);
    mocks.cancelBrowserLogin.mockResolvedValue(undefined);

    await act(async () => {
      await controller.reopenBrowserLogin();
      await controller.cancelBrowserLogin();
    });

    expect(mocks.reopenBrowserLogin).toHaveBeenCalledTimes(1);
    expect(mocks.cancelBrowserLogin).toHaveBeenCalledTimes(1);
  });

  it('retries online and updates retrying state around the request', async () => {
    mocks.retryOnline.mockResolvedValue({
      status: 'offline-authenticated',
      session: {
        user: { id: 'user-1', email: 'user@example.com' },
        tokens: { accessToken: '', refreshToken: '' },
        vaultBootstrap: null,
        offlineLease: null,
        syncServerTime: null,
      },
      offline: null,
      errorMessage: null,
    });
    const controller = renderController();

    await act(async () => {
      await controller.retryOnline();
    });

    expect(mocks.retryOnline).toHaveBeenCalledTimes(1);
  });
});
