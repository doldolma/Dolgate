import {
  isSshHostRecord,
  resolveCredentialRetryKind,
  type HostRecord,
} from '@dolssh/shared-core';

/** 무엇을 다시 붙일 것인가. 터미널 세션과 SFTP 세션이 각각 자기 레코드로 돌아간다. */
export interface CredentialRetryTarget {
  kind: 'terminal' | 'sftp';
  recordId: string;
}

export interface CredentialRetryRequest {
  hostId: string;
  hostLabel: string;
  target: CredentialRetryTarget;
  authType: 'password' | 'privateKey' | 'certificate';
  message?: string | null;
  initialUsername: string;
}

/**
 * 이 실패로 재시도 창을 띄울 것인지, 띄운다면 무엇을 담을지.
 *
 * 스토어에서 떼어 둔 이유는 검증이다 — 판정이 틀리면 **비밀번호로는 절대 풀리지 않는 실패에
 * 비밀번호 창이 뜬다**(호스트키를 거절했는데 계정을 다시 묻는 식). 데스크톱이 이미 그 버그를
 * 겪어서 규칙(`resolveCredentialRetryKind`)이 shared-core 에 있고, 여기서는 그 규칙을 실제
 * 연결 경로와 **같은 함수로** 지나가게 한다.
 */
export function buildCredentialRetryRequest(
  host: HostRecord,
  error: unknown,
  target: CredentialRetryTarget,
  message: string,
): CredentialRetryRequest | null {
  if (!(error instanceof Error) || !isSshHostRecord(host)) {
    return null;
  }
  if (resolveCredentialRetryKind(host, error.message) !== 'auth') {
    return null;
  }
  // 자격증명 창이 다룰 수 있는 인증 방식만. keyboardInteractive 는 서버가 그때그때 묻는
  // 방식이라 미리 받아 둘 것이 없다(그 경우 규칙이 이미 걸러 내지만, 종류를 좁혀 둔다).
  if (
    host.authType !== 'password' &&
    host.authType !== 'privateKey' &&
    host.authType !== 'certificate'
  ) {
    return null;
  }
  return {
    hostId: host.id,
    hostLabel: host.label,
    target,
    authType: host.authType,
    message,
    initialUsername: host.username,
  };
}
