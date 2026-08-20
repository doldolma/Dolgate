import type { AwsEc2HostRecord } from './models';
import { getAwsEc2HostSshPort } from './models';

/**
 * AWS EC2 호스트에 어떻게 붙을지 정하는 규칙.
 *
 * **데스크톱과 모바일이 이 한 벌을 같이 쓴다.** 데스크톱은 SSH over SSM 을 먼저 시도하고 실패하면
 * SSM 셸로 폴백하는데(실제 SSH 셸이라 셸 통합·SFTP·점프가 살아난다), 그 규칙을 플랫폼마다
 * 다시 쓰면 한쪽에서만 나는 실패를 재현할 수 없다. 그래서 판단은 여기 두고, 실제 호출만 각
 * 플랫폼이 한다.
 */

/**
 * SSH-over-SSM 실패로 폴백한 뒤 이 시간 안에는 SSH 재시도를 건너뛴다.
 *
 * 실패한 SSH 시도는 preflight·EIC·핸드셰이크까지 수 초를 쓴다. 붙을 때마다 그 지연을 다시 낼
 * 이유가 없다 — 원인이 대개 그대로이기 때문이다(sshd 미기동, EIC 미지원).
 */
export const AWS_SSH_OVER_SSM_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * SSH-over-SSM 가능성에 영향을 주는 설정의 지문.
 *
 * 이 값이 바뀌면(포트·계정·AZ·인스턴스·프로필·프록시 모드 수정) 폴백 기억을 버리고 SSH 부터
 * 다시 시도한다 — 사용자가 고친 것이 바로 반영되어야 한다.
 */
export function buildAwsEc2SshOverSsmSignature(host: AwsEc2HostRecord): string {
  return JSON.stringify([
    host.awsRegion,
    host.awsInstanceId,
    getAwsEc2HostSshPort(host),
    host.awsSshUsername?.trim() || null,
    host.awsAvailabilityZone ?? null,
    host.awsSsmServerProxyEnabled === true,
    host.awsProfileId ?? null,
  ]);
}

/** 폴백 기억 한 건. 플랫폼이 자기 자리에 보관한다(데스크톱은 메모리 맵, 모바일은 스토어). */
export interface AwsSshOverSsmFallbackMemo {
  signature: string;
  retryAfterMs: number;
}

/**
 * 호스트 키 관련 실패는 **폴백하지 않는다.**
 *
 * 신뢰를 묻는 자리는 두 곳이다 — 연결 안에서 코어가 묻거나, 연결 전에 신뢰된 키를 요구하거나.
 * 어느 쪽이든 폴백해 버리면 사용자가 신뢰한 뒤 SSH 로 붙을 기회가 사라진다.
 */
export function isAwsHostKeySecurityError(message: string): boolean {
  return [
    /Host key is not trusted yet/i,
    /host key mismatch/i,
    /Host key changed/i,
    /trusted host key/i,
    /host key trust/i,
    /호스트 키/,
  ].some(pattern => pattern.test(message));
}

/**
 * 이번 접속에서 SSH over SSM 을 시도할지.
 *
 * 건너뛰는 경우가 둘이다:
 *   - 윈도우 인스턴스 — SSH 로 들어갈 자리가 아니다(SSM 셸이 정답이다)
 *   - 최근 같은 설정으로 실패했고 아직 재시도 시각이 안 됐다
 */
export function shouldAttemptSshOverSsm(input: {
  host: AwsEc2HostRecord;
  isWindowsInstance: boolean;
  memo?: AwsSshOverSsmFallbackMemo | null;
  nowMs: number;
}): boolean {
  if (input.isWindowsInstance) {
    return false;
  }
  const memo = input.memo;
  if (!memo) {
    return true;
  }
  if (memo.signature !== buildAwsEc2SshOverSsmSignature(input.host)) {
    // 설정이 바뀌었다. 기억은 더 이상 이 호스트의 이야기가 아니다.
    return true;
  }
  return memo.retryAfterMs <= input.nowMs;
}

/** 폴백한 사실을 기억에 남긴다. 다음 접속에서 SSH 시도를 건너뛰는 근거다. */
export function recordSshOverSsmFallback(input: {
  host: AwsEc2HostRecord;
  nowMs: number;
}): AwsSshOverSsmFallbackMemo {
  return {
    signature: buildAwsEc2SshOverSsmSignature(input.host),
    retryAfterMs: input.nowMs + AWS_SSH_OVER_SSM_RETRY_AFTER_MS,
  };
}

/**
 * 이 호스트가 서버 프록시로 붙어야 하는지.
 *
 * 켜져 있으면 SSH 전송을 sync-api WebSocket 으로 우회한다. 직접 붙을 수 없는 망(IP 제한 VPC)을
 * 위한 것이고, iOS 처럼 앱이 백그라운드로 가면 세션이 끊기는 환경에서 서버가 세션을 붙잡아 주는
 * 이점도 있다.
 */
export function usesAwsServerProxy(host: AwsEc2HostRecord): boolean {
  return host.awsSsmServerProxyEnabled === true;
}
