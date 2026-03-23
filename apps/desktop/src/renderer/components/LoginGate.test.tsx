import { describe, expect, it } from 'vitest';
import { getServerUrlValidationMessage } from '@shared';
import { resolveLoginGateActionLabel, shouldDisableLoginGatePrimaryAction } from './LoginGate';

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

  it('validates the advanced login server URL as an absolute root URL', () => {
    expect(getServerUrlValidationMessage('ssh.doldolma.com/path')).toBe('로그인 서버 주소는 http:// 또는 https:// 로 시작하는 절대 URL이어야 합니다.');
    expect(getServerUrlValidationMessage('https://ssh.custom.example.com')).toBeNull();
  });
});
