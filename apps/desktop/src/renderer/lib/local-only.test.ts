import { describe, expect, it } from 'vitest';
import { isLocalOnlyAuthState } from './local-only';

describe('isLocalOnlyAuthState', () => {
  it('계정 없이 쓰는 상태다', () => {
    expect(
      isLocalOnlyAuthState({ status: 'local-only', session: null }),
    ).toBe(true);
  });

  // 브라우저 왕복이 끝나기 전까지는 아직 계정이 없다. 이 사이에 화면이 계정 쪽으로 넘어가면,
  // 사용자는 브라우저에서 아무것도 하지 않았는데 이메일이 비어 있는 계정 판을 본다 —
  // 설정 화면만 이 조건을 빼먹어서 실제로 그렇게 됐다.
  it('로그인을 시작한 동안에도 아직 계정 없이 쓰는 중이다', () => {
    expect(
      isLocalOnlyAuthState({ status: 'authenticating', session: null }),
    ).toBe(true);
  });

  it('계정이 붙으면 아니다', () => {
    expect(
      isLocalOnlyAuthState({
        status: 'authenticated',
        session: { user: { id: 'u-1' } } as never,
      }),
    ).toBe(false);
    expect(
      isLocalOnlyAuthState({ status: 'unauthenticated', session: null }),
    ).toBe(false);
  });
});
