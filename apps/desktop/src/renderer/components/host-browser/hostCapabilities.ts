import {
  isAwsEc2HostRecord,
  isAwsEc2WindowsPlatform,
  isAwsEcsHostRecord,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from '@shared';
import type { HostRecord } from '@shared';

// 어떤 호스트에 어떤 동작을 걸 수 있는지 한 곳에서 정한다. "ecs 만 빼기" 같은 제외 목록으로 두면
// 종류가 늘 때마다(serial, rdp …) 쓸 수 없는 버튼이 조용히 따라 붙는다 — 붙일 수 있는 쪽을 나열한다.

/** SFTP·tmux·컨테이너는 모두 SSH 세션(subsystem/exec) 위에 얹혀 있다. */
function hasSshSession(host: HostRecord): boolean {
  // Windows EC2 는 SSM 셸(PowerShell)로만 붙는다. SSH-over-SSM 은 EC2 Instance Connect 로
  // 임시 공개키를 밀어 넣어 인증하는데 EIC 는 Linux 전용이라, OpenSSH 서버를 띄워 놨더라도
  // 그 키를 넣을 방법이 없다 — 즉 sshd 유무와 무관하게 이 경로 자체가 성립하지 않는다.
  if (isAwsEc2HostRecord(host)) {
    return !isAwsEc2WindowsPlatform(host.awsPlatform);
  }
  return isSshHostRecord(host) || isWarpgateSshHostRecord(host);
}

/** 터미널 탭으로 여는 연결. aws-ecs 는 connectHost 가 컨테이너 탭으로 돌린다. */
export function hostSupportsTerminalConnect(host: HostRecord): boolean {
  return !isAwsEcsHostRecord(host);
}

/** SFTP 는 SSH subsystem 이라 serial(터미널만)·rdp(화면만)에는 없다. */
export function hostSupportsSftp(host: HostRecord): boolean {
  return hasSshSession(host);
}

/** connectHost 의 tmux 플래그는 SSH 경로에서만 읽힌다 — 나머지 종류는 조용히 무시하고 그냥 연결된다. */
export function hostSupportsTmux(host: HostRecord): boolean {
  return hasSshSession(host);
}

/** 컨테이너 목록은 원격 셸에서 docker/podman 을 실행해 얻는다. aws-ecs 는 Connect 가 곧 컨테이너 탭이다. */
export function hostSupportsContainers(host: HostRecord): boolean {
  return hasSshSession(host);
}
