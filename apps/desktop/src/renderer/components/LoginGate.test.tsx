import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getServerUrlValidationMessage } from '@shared';
import {
  LoginGate,
  resolveLoginGateActionLabel,
  resolveLoginGateStatusMessage,
  shouldDisableLoginGatePrimaryAction
} from './LoginGate';

describe('LoginGate', () => {
  it('disables the login action while auth or sync bootstrap is in flight', () => {
    expect(
      shouldDisableLoginGatePrimaryAction({
        authStatus: 'authenticating',
        isSyncBootstrapping: false,
        isLoadingServerUrl: false,
        isSubmitting: false,
        serverUrlValidationMessage: null
      })
    ).toBe(true);
  });

  it('prefers the explicit retry action label when provided', () => {
    expect(resolveLoginGateActionLabel('authenticated', '동기화 다시 시도')).toBe('동기화 다시 시도');
    expect(resolveLoginGateActionLabel('authenticating')).toBe('브라우저 로그인 대기 중...');
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
});
