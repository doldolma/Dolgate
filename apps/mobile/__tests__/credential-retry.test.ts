import type { SshHostRecord } from '@dolssh/shared-core';
import { buildCredentialRetryRequest } from '../src/lib/credential-retry';

// 이 판정이 틀리면 **비밀번호로는 절대 풀리지 않는 실패에 비밀번호 창이 뜬다.** 데스크톱이
// 겪은 오작동이 그대로 목록이 된다 — 호스트키 거절, 사용자 취소, 정지(타임아웃), 서버가
// keyboard-interactive 만 받는 경우.

function host(overrides: Partial<SshHostRecord> = {}): SshHostRecord {
  return {
    id: 'host-1',
    kind: 'ssh',
    label: '가시리 RTU',
    hostname: 'rtu.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    secretRef: 'secret-1',
    groupName: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as SshHostRecord;
}

const target = { kind: 'terminal' as const, recordId: 'session-1' };

describe('buildCredentialRetryRequest', () => {
  it('인증 실패면 호스트의 사용자명을 채운 요청을 만든다', () => {
    const request = buildCredentialRetryRequest(
      host(),
      new Error('ssh: handshake failed: unable to authenticate'),
      target,
      '인증에 실패했습니다.',
    );
    expect(request).toEqual({
      hostId: 'host-1',
      hostLabel: '가시리 RTU',
      target,
      authType: 'password',
      message: '인증에 실패했습니다.',
      // 사용자명을 비워 두면 매번 다시 쳐야 한다 — 고칠 것은 보통 비밀번호 쪽이다.
      initialUsername: 'ubuntu',
    });
  });

  it('사용자명이 없는 호스트도 창을 띄운다', () => {
    // 데스크톱이 OpenSSH config 에서 사용자명 없이 가져온 호스트가 동기화돼 올 수 있다.
    // 그 호스트는 붙을 때마다 실패하는데, 이 창이 유일하게 고칠 자리다.
    const request = buildCredentialRetryRequest(
      host({ username: '' }),
      new Error('unable to authenticate'),
      target,
      '인증에 실패했습니다.',
    );
    expect(request?.initialUsername).toBe('');
  });

  it('호스트키 문제로는 띄우지 않는다', () => {
    for (const message of [
      'host key mismatch',
      'ssh handshake failed: host key was not trusted',
      'no matching host key type',
    ]) {
      expect(
        buildCredentialRetryRequest(host(), new Error(message), target, message),
      ).toBeNull();
    }
  });

  it('사용자가 그만둔 것으로는 띄우지 않는다', () => {
    for (const message of [
      'prompt was cancelled',
      'challenge was cancelled',
      'context canceled',
    ]) {
      expect(
        buildCredentialRetryRequest(host(), new Error(message), target, message),
      ).toBeNull();
    }
  });

  it('정지(타임아웃)로는 띄우지 않는다', () => {
    expect(
      buildCredentialRetryRequest(
        host(),
        new Error('ssh handshake failed: i/o timeout'),
        target,
        'timeout',
      ),
    ).toBeNull();
  });

  it('서버가 keyboard-interactive 만 받으면 띄우지 않는다', () => {
    // 계정·비밀번호를 다시 받아도 그 방식은 시도조차 되지 않는다.
    expect(
      buildCredentialRetryRequest(
        host(),
        new Error(
          'unable to authenticate, attempted methods [none keyboard-interactive], no supported methods remain',
        ),
        target,
        'auth',
      ),
    ).toBeNull();
  });

  it('SSH 가 아닌 호스트에는 띄우지 않는다', () => {
    const rdp = { ...host(), kind: 'rdp' } as unknown as SshHostRecord;
    expect(
      buildCredentialRetryRequest(
        rdp,
        new Error('unable to authenticate'),
        target,
        'auth',
      ),
    ).toBeNull();
  });
});
