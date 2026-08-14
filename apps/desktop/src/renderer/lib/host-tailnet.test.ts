import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@shared';

import { resolveHostTailnetId, resolveTailnetTargetAddress } from './host-tailnet';

const timestamp = '2026-08-01T00:00:00.000Z';

function sshHost(overrides: Record<string, unknown> = {}): HostRecord {
  return {
    id: 'ssh-1',
    kind: 'ssh',
    label: 'Gate',
    hostname: 'gate.example.ts.net',
    port: 22,
    username: 'ops',
    authType: 'password',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as unknown as HostRecord;
}

function vncHost(overrides: Record<string, unknown> = {}): HostRecord {
  return {
    id: 'vnc-1',
    kind: 'vnc',
    label: 'Lab',
    hostname: '10.0.0.6',
    port: 5900,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as unknown as HostRecord;
}

describe('resolveHostTailnetId', () => {
  it('SSH·RDP 는 자기 필드를 쓴다', () => {
    expect(resolveHostTailnetId(sshHost({ tailnetId: 'net-a' }), [])).toBe('net-a');
    expect(
      resolveHostTailnetId(
        { ...(sshHost() as unknown as Record<string, unknown>), kind: 'rdp', tailnetId: 'net-b' } as unknown as HostRecord,
        [],
      ),
    ).toBe('net-b');
  });

  // 호출자(ensureTailnetReady)는 VNC 도 부르고 있었는데 판정 쪽이 VNC 를 몰라서 조용히 통과했다.
  // 그러면 노드가 내려간 상태로 붙으려 하고 실패 이유가 "연결할 수 없음" 으로만 보인다.
  it('VNC 자신의 tailnet 을 찾는다', () => {
    expect(resolveHostTailnetId(vncHost({ tailnetId: 'net-c' }), [])).toBe('net-c');
  });

  // 터널은 경유 호스트의 tailnet 설정을 그대로 탄다(ipc/vnc.ts 의 resolveTailnetRoute). 올려야
  // 하는 노드는 그쪽이고, 그것을 모르면 이 연결은 tailnet 을 쓰는데 아무 관문도 안 보인다.
  it('SSH 터널을 쓰면 경유 호스트의 tailnet 을 쓴다', () => {
    const gate = sshHost({ id: 'gate-1', tailnetId: 'net-gate' });
    const host = vncHost({ sshTunnelHostId: 'gate-1' });

    expect(resolveHostTailnetId(host, [gate, host])).toBe('net-gate');
  });

  it('경유 호스트가 없거나 tailnet 이 없으면 아무것도 아니다', () => {
    const host = vncHost({ sshTunnelHostId: 'gone' });
    expect(resolveHostTailnetId(host, [host])).toBeUndefined();
    expect(
      resolveHostTailnetId(host, [sshHost({ id: 'gone' }), host]),
    ).toBeUndefined();
  });

  it('직접 지정한 tailnet 이 터널보다 우선이다', () => {
    // 폼은 둘을 상호배타로 막지만 예전 레코드에는 둘 다 있을 수 있다. 접속 경로도 tailnet 을
    // 먼저 보므로 판정이 같아야 한다.
    const gate = sshHost({ id: 'gate-1', tailnetId: 'net-gate' });
    const host = vncHost({ tailnetId: 'net-own', sshTunnelHostId: 'gate-1' });

    expect(resolveHostTailnetId(host, [gate, host])).toBe('net-own');
  });
});

describe('resolveTailnetTargetAddress', () => {
  // 터널을 쓰면 VNC 의 주소는 경유 서버에서 본 것(대개 127.0.0.1)이라 넷맵에 있을 수 없다.
  // 그대로 넘기면 "대상 기기가 넷맵에 없습니다" 가 거짓으로 뜬다.
  it('터널을 쓰면 경유 호스트의 주소를 찾는다', () => {
    const gate = sshHost({ id: 'gate-1', hostname: 'gate.ts.net' });
    const host = vncHost({ hostname: '127.0.0.1', sshTunnelHostId: 'gate-1' });

    expect(resolveTailnetTargetAddress(host, [gate, host])).toBe('gate.ts.net');
  });

  it('직접 붙으면 자기 주소를 쓴다', () => {
    const host = vncHost({ tailnetId: 'net-own', hostname: 'lab.ts.net' });
    expect(resolveTailnetTargetAddress(host, [host])).toBe('lab.ts.net');
    expect(resolveTailnetTargetAddress(vncHost(), [])).toBe('10.0.0.6');
  });
});

// 점프 호스트가 있으면 tailnet 이 닿아야 하는 기기는 첫 홉이다. 최종 대상은 그 홉의 망에서 보이는
// 주소라(사내 랜 등) 넷맵에 있을 이유가 없다 — 그대로 넘기면 거짓 실패가 뜬다.
describe('점프 호스트가 있는 SSH 대상', () => {
  it('첫 홉의 주소를 찾는다', () => {
    const jump = sshHost({ id: 'jump-1', hostname: 'bastion.example.ts.net' });
    const target = sshHost({
      id: 'ssh-2',
      hostname: '192.168.200.4',
      jumpHostId: 'jump-1',
      jumpHostIds: ['jump-1'],
    });

    expect(resolveTailnetTargetAddress(target, [jump, target])).toBe('bastion.example.ts.net');
  });

  it('점프가 없으면 자기 주소를 그대로 쓴다', () => {
    const target = sshHost({ id: 'ssh-3', hostname: 'agt-1' });
    expect(resolveTailnetTargetAddress(target, [target])).toBe('agt-1');
  });
});
