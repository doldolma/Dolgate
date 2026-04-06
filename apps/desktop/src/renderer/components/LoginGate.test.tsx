import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getServerUrlValidationMessage } from '@shared';
import {
  LoginGate,
  resolveLoginGateActionLabel,
  resolveLoginGateStatusMessage,
  shouldDisableLoginGatePrimaryAction
} from './LoginGate';

describe('LoginGate', () => {
  it('disables the login action while loading or sync bootstrap is in flight', () => {
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'authenticating',
        isSyncBootstrapping: false,
        isLoadingServerUrl: false,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(false);
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'loading',
        isSyncBootstrapping: false,
        isLoadingServerUrl: false,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(true);
  });

  it('does not disable the login action only because login server settings are still loading', () => {
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'unauthenticated',
        isSyncBootstrapping: false,
        isLoadingServerUrl: true,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(false);
  });

  it('prefers the explicit retry action label when provided', () => {
    expect(resolveLoginGateActionLabel('authenticated', '동기화 다시 시도')).toBe('동기화 다시 시도');
    expect(resolveLoginGateActionLabel('authenticating')).toBe('브라우저 다시 열기');
  });

  it('shows a sync status message only while workspace sync bootstrap is running', () => {
    expect(resolveLoginGateStatusMessage(true)).toBe('최신 데이터 동기화 중...');
    expect(resolveLoginGateStatusMessage(false)).toBeNull();
  });

  it('validates the advanced login server URL as an absolute root URL', () => {
    expect(getServerUrlValidationMessage('ssh.doldolma.com/path')).toBe(
      '로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.'
    );
    expect(getServerUrlValidationMessage('https://ssh.custom.example.com')).toBeNull();
  });

  it('renders the inline sync status text during sync bootstrap', () => {
    render(
      <LoginGate
        authState={{ status: 'authenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={true}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('최신 데이터 동기화 중...')).toBeInTheDocument();
  });

  it('keeps the primary login action enabled when hidden server settings are invalid', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl=""
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeEnabled();
  });

  it('keeps the primary login action enabled while login server settings are loading', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={true}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeEnabled();
  });

  it('disables the primary action when advanced server settings are open with an invalid url', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: '로그인 서버 설정 열기' })
    );
    fireEvent.change(screen.getByPlaceholderText('https://ssh.example.com'), {
      target: { value: 'invalid-host/path' }
    });

    expect(
      screen.getByRole('button', { name: '브라우저로 로그인하기' })
    ).toBeDisabled();
    expect(
      screen.getByText(
        '로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.'
      )
    ).toBeInTheDocument();
  });

  it('renders inline svg icons for the settings and browser login actions', () => {
    render(
      <LoginGate
        authState={{ status: 'unauthenticated', session: null, errorMessage: null }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={false}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const settingsButton = screen.getByRole('button', { name: '로그인 서버 설정 열기' });
    const loginButton = screen.getByRole('button', { name: '브라우저로 로그인하기' });

    expect(settingsButton.querySelector('svg')).not.toBeNull();
    expect(loginButton.querySelector('svg')).not.toBeNull();
    expect(settingsButton).not.toHaveTextContent('⚙');
    expect(loginButton).not.toHaveTextContent('↗');
  });

  it('shows reopen and cancel actions while waiting for browser login completion', async () => {
    const onReopenBrowserLogin = vi.fn().mockResolvedValue(undefined);
    const onCancelBrowserLogin = vi.fn().mockResolvedValue(undefined);

    render(
      <LoginGate
        authState={{
          status: 'authenticating',
          session: null,
          errorMessage: null
        }}
        isSyncBootstrapping={false}
        serverUrl="https://ssh.doldolma.com"
        hasServerUrlOverride={true}
        isLoadingServerUrl={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
        onReopenBrowserLogin={onReopenBrowserLogin}
        onCancelBrowserLogin={onCancelBrowserLogin}
        onSaveServerUrl={vi.fn().mockResolvedValue(undefined)}
        onResetServerUrl={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole('button', { name: '브라우저 다시 열기' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '취소' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '로그인 서버 설정 열기' }));
    expect(screen.getByPlaceholderText('https://ssh.example.com')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '브라우저 다시 열기' }));
    await waitFor(() => {
      expect(onReopenBrowserLogin).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => {
      expect(onCancelBrowserLogin).toHaveBeenCalledTimes(1);
    });
  });
});
