import { describe, expect, it } from 'vitest';
import type { AwsEc2HostRecord, HostRecord } from '@shared';
import {
  hostSupportsContainers,
  hostSupportsSftp,
  hostSupportsTerminalConnect,
  hostSupportsTmux,
} from './hostCapabilities';

const timestamps = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function sshHost(): HostRecord {
  return {
    id: 'h-ssh',
    kind: 'ssh',
    label: 'linuxbox',
    hostname: '10.0.0.1',
    port: 22,
    username: 'ubuntu',
    authType: 'agent',
    ...timestamps,
  };
}

function ec2Host(awsPlatform: string | null): AwsEc2HostRecord {
  return {
    id: 'h-ec2',
    kind: 'aws-ec2',
    label: 'ec2box',
    awsProfileId: 'p-1',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-1',
    awsPlatform,
    ...timestamps,
  };
}

function rdpHost(): HostRecord {
  return {
    id: 'h-rdp',
    kind: 'rdp',
    label: 'winbox',
    hostname: '10.0.0.2',
    port: 3389,
    ...timestamps,
  };
}

function serialHost(): HostRecord {
  return {
    id: 'h-serial',
    kind: 'serial',
    label: 'console',
    transport: 'local',
    devicePath: '/dev/tty.usbserial',
    ...timestamps,
  } as HostRecord;
}

const SSH_FEATURES = [
  ['SFTP', hostSupportsSftp],
  ['tmux', hostSupportsTmux],
  ['containers', hostSupportsContainers],
] as const;

describe('hostCapabilities', () => {
  describe.each(SSH_FEATURES)('%s', (_label, supports) => {
    it('is available on hosts that give a real SSH session', () => {
      expect(supports(sshHost())).toBe(true);
      expect(supports(ec2Host('Linux/UNIX'))).toBe(true);
      expect(supports(ec2Host(null))).toBe(true);
    });

    it('is unavailable on hosts without one', () => {
      expect(supports(rdpHost())).toBe(false);
      expect(supports(serialHost())).toBe(false);
    });

    // Windows EC2 는 SSM 셸(PowerShell)로만 붙는다. SSH-over-SSM 은 EC2 Instance Connect 임시키
    // push 로 인증하는데 EIC 가 Linux 전용이라, OpenSSH 서버를 띄워 놨어도 그 경로가 성립하지 않는다.
    it('is unavailable on Windows EC2 regardless of platform casing', () => {
      expect(supports(ec2Host('Windows'))).toBe(false);
      expect(supports(ec2Host('windows'))).toBe(false);
    });
  });

  // 터미널 연결은 Windows EC2 에서도 된다 — 막히는 건 SSH 위에 얹힌 기능들뿐이다.
  it('keeps terminal connect available for Windows EC2', () => {
    expect(hostSupportsTerminalConnect(ec2Host('Windows'))).toBe(true);
    expect(hostSupportsTerminalConnect(rdpHost())).toBe(true);
  });
});
