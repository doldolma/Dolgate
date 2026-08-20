import { describe, expect, it } from "vitest";
import {
  AWS_SSH_OVER_SSM_RETRY_AFTER_MS,
  buildAwsEc2SshOverSsmSignature,
  isAwsHostKeySecurityError,
  recordSshOverSsmFallback,
  shouldAttemptSshOverSsm,
  usesAwsServerProxy,
  type AwsEc2HostRecord,
} from "@shared";

// EC2 접속 규칙은 **데스크톱과 모바일이 같은 함수를 쓴다**(shared-core). 그래서 이 규칙이 깨지면
// 두 플랫폼이 같이 깨지고, 반대로 한쪽만 고치는 일도 생기지 않는다. 이 테스트가 그 계약이다.

const host = (overrides: Partial<AwsEc2HostRecord> = {}): AwsEc2HostRecord =>
  ({
    id: "h-ec2",
    kind: "aws-ec2",
    label: "web-1",
    awsProfileId: "p-1",
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as AwsEc2HostRecord;

describe("EC2 접속 시도 규칙", () => {
  it("평소에는 SSH over SSM 을 먼저 시도한다", () => {
    // 실제 SSH 셸이라 셸 통합·SFTP·점프가 살아난다 — SSM 셸은 ssm-user 로 들어가서 그것들이 없다.
    expect(
      shouldAttemptSshOverSsm({
        host: host(),
        isWindowsInstance: false,
        memo: null,
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  it("윈도우 인스턴스에는 SSH 를 시도하지 않는다", () => {
    expect(
      shouldAttemptSshOverSsm({
        host: host(),
        isWindowsInstance: true,
        memo: null,
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  // 실패한 SSH 시도는 수 초를 쓴다. 원인이 대개 그대로인데 붙을 때마다 그 지연을 다시 낼 이유가 없다.
  it("최근 같은 설정으로 실패했으면 SSH 를 건너뛴다", () => {
    const subject = host();
    const memo = recordSshOverSsmFallback({ host: subject, nowMs: 1_000 });

    expect(memo.retryAfterMs).toBe(1_000 + AWS_SSH_OVER_SSM_RETRY_AFTER_MS);
    expect(
      shouldAttemptSshOverSsm({
        host: subject,
        isWindowsInstance: false,
        memo,
        nowMs: 2_000,
      }),
    ).toBe(false);

    // 시간이 지나면 다시 시도한다 — 그동안 sshd 가 떴을 수 있다.
    expect(
      shouldAttemptSshOverSsm({
        host: subject,
        isWindowsInstance: false,
        memo,
        nowMs: memo.retryAfterMs,
      }),
    ).toBe(true);
  });

  // 사용자가 고친 것은 즉시 반영돼야 한다. 안 그러면 "포트를 고쳤는데 왜 아직 SSM 셸이지" 가 된다.
  it("설정이 바뀌면 기억을 무시하고 다시 시도한다", () => {
    const before = host();
    const memo = recordSshOverSsmFallback({ host: before, nowMs: 1_000 });

    for (const changed of [
      host({ awsSshUsername: "ubuntu" }),
      host({ awsSshPort: 2222 }),
      host({ awsAvailabilityZone: "ap-northeast-2a" }),
      host({ awsSsmServerProxyEnabled: true }),
      host({ awsProfileId: "p-2" }),
      host({ awsInstanceId: "i-def" }),
    ]) {
      expect(
        shouldAttemptSshOverSsm({
          host: changed,
          isWindowsInstance: false,
          memo,
          nowMs: 2_000,
        }),
        buildAwsEc2SshOverSsmSignature(changed),
      ).toBe(true);
    }
  });

  // 호스트 키 문제로 폴백해 버리면 사용자가 신뢰한 뒤 SSH 로 붙을 기회가 사라진다.
  it("호스트 키 오류는 폴백 대상이 아니다", () => {
    expect(isAwsHostKeySecurityError("Host key is not trusted yet")).toBe(true);
    expect(isAwsHostKeySecurityError("host key mismatch for i-abc")).toBe(true);
    expect(isAwsHostKeySecurityError("connection refused")).toBe(false);
    expect(isAwsHostKeySecurityError("sshd is not running")).toBe(false);
  });

  it("서버 프록시는 호스트 설정이 정한다", () => {
    expect(usesAwsServerProxy(host())).toBe(false);
    expect(usesAwsServerProxy(host({ awsSsmServerProxyEnabled: true }))).toBe(true);
  });
});
