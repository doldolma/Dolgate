import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginGate } from './LoginGate';

describe('LoginGate', () => {
  it('disables the login action while auth or sync bootstrap is in flight', () => {
    render(
      <LoginGate
        authState={{
          status: 'authenticating',
          session: null,
          errorMessage: null
        }}
        isSyncBootstrapping={false}
        onBeginLogin={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole('button', { name: '브라우저 로그인 대기 중...' })).toBeDisabled();
  });

  it('renders the error banner and prefers the explicit retry action when provided', async () => {
    const onBeginLogin = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn().mockResolvedValue(undefined);

    render(
      <LoginGate
        authState={{
          status: 'authenticated',
          session: {
            user: {
              id: 'user-1',
              email: 'user@example.com'
            },
            tokens: {
              accessToken: 'access',
              refreshToken: 'refresh',
              expiresInSeconds: 900
            },
            vaultBootstrap: {
              keyBase64: 'ZmFrZS12YXVsdA=='
            },
            syncServerTime: '2025-01-01T00:00:00.000Z'
          },
          errorMessage: '동기화에 실패했습니다.'
        }}
        isSyncBootstrapping={false}
        onBeginLogin={onBeginLogin}
        actionLabel="동기화 다시 시도"
        onAction={onRetry}
      />
    );

    expect(screen.getByText('동기화에 실패했습니다.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '동기화 다시 시도' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBeginLogin).not.toHaveBeenCalled();
  });
});
