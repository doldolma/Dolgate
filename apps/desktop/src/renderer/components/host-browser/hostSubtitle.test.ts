import { describe, expect, it } from 'vitest';
import { getHostSubtitle } from '@shared';
import type { HostRecord } from '@shared';

// 이 함수는 호스트 목록·명령 팔레트가 호스트마다 부른다. 여기서 던지면 목록을 그리다 렌더러가
// 죽어서 창이 통째로 빈 화면이 된다 — 설치된 1.8.10 이 동기화로 받은 RDP 호스트에서
// `username.trim()` 을 읽다 그렇게 됐다(RDP 레코드에는 username 이 없다).
//
// 호스트 목록은 버전 사이에서 동기화되므로 옛 빌드가 새 종류를 받는 일은 계속 생긴다. 그래서
// "모르는 종류가 와도 던지지 않는다"를 잠근다.

const labels = {
  devicePathUnset: '장치 경로 미설정',
  remoteAddressUnset: '주소 미설정',
  usernameUnset: '사용자명 미설정',
};

function base(kind: string): Record<string, unknown> {
  return {
    id: `h-${kind}`,
    kind,
    label: `${kind} host`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('getHostSubtitle', () => {
  it('RDP 호스트는 주소를 보여주고 던지지 않는다', () => {
    const host = {
      ...base('rdp'),
      hostname: '10.0.2.181',
      port: 3389,
    } as unknown as HostRecord;

    expect(getHostSubtitle(host, labels)).toBe('RDP • 10.0.2.181:3389');
  });

  it('이 빌드가 모르는 종류가 와도 던지지 않는다', () => {
    // 새 버전이 만든 종류를 옛 빌드가 받은 상황. username 이 없어도 주소는 보여준다.
    const future = {
      ...base('telnet'),
      hostname: 'switch.example.com',
      port: 23,
    } as unknown as HostRecord;

    expect(() => getHostSubtitle(future, labels)).not.toThrow();
    expect(getHostSubtitle(future, labels)).toBe(
      `switch.example.com:23 • ${labels.usernameUnset}`,
    );
  });

  it('주소조차 없으면 라벨로 떨어진다', () => {
    const bare = base('telnet') as unknown as HostRecord;

    expect(getHostSubtitle(bare, labels)).toBe('telnet host');
  });

  it('SSH 는 그대로 사용자@주소다', () => {
    const ssh = {
      ...base('ssh'),
      hostname: 'prod.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'agent',
    } as unknown as HostRecord;

    expect(getHostSubtitle(ssh, labels)).toBe('ubuntu@prod.example.com:22');
  });
});
