import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthState, DesktopWindowState } from '@shared';
import { VaultGateShell } from './VaultGateShell';

const vaultServiceMocks = vi.hoisted(() => ({
  setupVault: vi.fn(),
  unlockVault: vi.fn(),
  resetVault: vi.fn(),
  migrateVault: vi.fn(),
}));

vi.mock('../services/desktop/auth-window-updater', () => ({
  setupVault: vaultServiceMocks.setupVault,
  unlockVault: vaultServiceMocks.unlockVault,
  resetVault: vaultServiceMocks.resetVault,
  migrateVault: vaultServiceMocks.migrateVault,
}));

const windowState: DesktopWindowState = { isMaximized: false, isFullScreen: false };

function createAuthState(): AuthState {
  return {
    status: 'authenticated',
    session: {
      user: { id: 'user-1', email: 'vault@example.com' },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresInSeconds: 900,
      },
      vaultBootstrap: { version: 2 },
      offlineLease: {
        token: 'lease',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: 'pem',
      },
      syncServerTime: new Date().toISOString(),
    },
    offline: null,
    errorMessage: null,
    vault: { status: 'locked' },
  };
}

function renderShell(
  mode: 'setup-required' | 'locked' | 'migrate' | 'error',
  onDefer?: () => void,
) {
  return render(
    <VaultGateShell
      mode={mode}
      onDefer={onDefer}
      authState={createAuthState()}
      desktopPlatform="darwin"
      windowState={windowState}
      onLogout={vi.fn().mockResolvedValue(undefined)}
      onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
      onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
      onCloseWindow={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe('VaultGateShell', () => {
  it('requires a confirmed passphrase before calling setupVault', async () => {
    vaultServiceMocks.setupVault.mockResolvedValue(undefined);
    renderShell('setup-required');

    const submit = screen.getByRole('button', { name: '동기화 시작' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('동기화 암호'), {
      target: { value: 'passphrase-1' },
    });
    fireEvent.change(screen.getByPlaceholderText('동기화 암호 확인'), {
      target: { value: 'passphrase-1' },
    });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() =>
      expect(vaultServiceMocks.setupVault).toHaveBeenCalledWith(
        'passphrase-1',
      ),
    );
  });

  it('requires at least four characters for a new passphrase', () => {
    renderShell('setup-required');
    fireEvent.change(screen.getByPlaceholderText('동기화 암호'), {
      target: { value: 'abc' },
    });
    fireEvent.change(screen.getByPlaceholderText('동기화 암호 확인'), {
      target: { value: 'abc' },
    });

    expect(screen.getByText('동기화 암호는 4자 이상이어야 합니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '동기화 시작' })).toBeDisabled();
  });

  it('shows an error gate without exposing passphrase actions', () => {
    const authState = createAuthState();
    authState.vault = {
      status: 'error',
      errorMessage: '지원하지 않는 볼트 형식입니다.',
    };
    render(
      <VaultGateShell
        mode="error"
        authState={authState}
        desktopPlatform="darwin"
        windowState={windowState}
        onLogout={vi.fn().mockResolvedValue(undefined)}
        onMinimizeWindow={vi.fn().mockResolvedValue(undefined)}
        onToggleFullScreenWindow={vi.fn().mockResolvedValue(undefined)}
        onCloseWindow={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('지원하지 않는 볼트 형식입니다.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('동기화 암호')).not.toBeInTheDocument();
  });

  it('unlocks with the entered passphrase and surfaces errors inline', async () => {
    vaultServiceMocks.unlockVault.mockRejectedValueOnce(
      new Error('동기화 암호가 올바르지 않습니다.'),
    );
    renderShell('locked');

    fireEvent.change(screen.getByPlaceholderText('동기화 암호'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: '잠금 해제' }));

    await waitFor(() =>
      expect(
        screen.getByText('동기화 암호가 올바르지 않습니다.'),
      ).toBeInTheDocument(),
    );
    expect(vaultServiceMocks.unlockVault).toHaveBeenCalledWith('wrong');
  });

  it('resets the vault only after the inline confirmation step', async () => {
    vaultServiceMocks.resetVault.mockResolvedValue(undefined);
    renderShell('locked');

    fireEvent.click(
      screen.getByRole('button', {
        name: '동기화 암호를 잊으셨나요? 데이터 초기화',
      }),
    );
    expect(vaultServiceMocks.resetVault).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: '모두 삭제하고 새로 시작' }),
    );
    await waitFor(() =>
      expect(vaultServiceMocks.resetVault).toHaveBeenCalledTimes(1),
    );
  });

  it('migrates with a confirmed passphrase and defers', async () => {
    vaultServiceMocks.migrateVault.mockResolvedValue(undefined);
    const onDefer = vi.fn();
    renderShell('migrate', onDefer);

    fireEvent.change(screen.getByPlaceholderText('동기화 암호'), {
      target: { value: 'migrate-pass-1' },
    });
    fireEvent.change(screen.getByPlaceholderText('동기화 암호 확인'), {
      target: { value: 'migrate-pass-1' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: '종단간 암호화 켜기' }),
    );
    await waitFor(() =>
      expect(vaultServiceMocks.migrateVault).toHaveBeenCalledWith(
        'migrate-pass-1',
      ),
    );

    // "나중에"는 migrate 가 끝날 때까지 disabled 다 — 호출만 기다리면 클릭이 무시된다.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '나중에' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '나중에' }));
    expect(onDefer).toHaveBeenCalledTimes(1);
  });
});
