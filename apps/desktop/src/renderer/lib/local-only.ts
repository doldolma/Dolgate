// 계정 없이 이 기기에서만 쓰는 중인가.
//
// **한 곳에 둔다.** 이 판정이 여러 화면에 흩어지면 서로 어긋난다 — 실제로 설정 화면만 로그인
// 진행 중을 빼먹어서, 로그인을 시작하는 순간 계정이 있는 것처럼 이메일이 비어 있는 계정 판이
// 떴다.

import type { AuthState } from '@shared';

export function isLocalOnlyAuthState(
  authState: Pick<AuthState, 'status' | 'session'>,
): boolean {
  if (authState.status === 'local-only') {
    return true;
  }
  // 로그인을 시작해도(브라우저 왕복) 계정이 붙기 전까지는 여전히 계정 없이 쓰는 중이다.
  // 그 사이에 화면이 계정 쪽으로 넘어가면, 사용자는 브라우저에서 아무것도 하지 않았는데
  // 로그인된 것처럼 보이는 화면을 본다.
  return authState.status === 'authenticating' && !authState.session;
}
