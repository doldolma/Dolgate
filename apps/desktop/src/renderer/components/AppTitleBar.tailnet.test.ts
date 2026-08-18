import { describe, expect, it } from 'vitest';
import type { TailnetPeer } from '@shared';
import type { HostRecord } from '@shared';
import {
  collectTailnetIdsInUse,
  findTailnetPeer,
  findTailnetSubnetRouter,
  shortenRouterName,
} from './AppTitleBar';

const peers: TailnetPeer[] = [
  {
    hostName: 'agt-1',
    dnsName: 'agt-1.example.ts.net',
    ips: ['100.64.0.9'],
    direct: true,
    relay: 'sel',
  },
  {
    hostName: 'db',
    dnsName: 'db.example.ts.net',
    ips: ['100.64.0.12'],
    direct: false,
    relay: 'sel',
  },
  {
    hostName: 'router',
    dnsName: 'router.example.ts.net',
    ips: ['100.64.0.20'],
    direct: true,
    relay: 'sel',
    routes: ['192.168.0.0/24', '10.0.0.0/8'],
  },
  {
    hostName: 'router-narrow',
    dnsName: 'router-narrow.example.ts.net',
    ips: ['100.64.0.21'],
    direct: false,
    relay: 'tok',
    routes: ['10.0.5.0/24'],
  },
];

// 호스트 주소를 어떤 형태로 저장했는지는 사용자 자유다. 하나라도 못 맞추면 그 형태를 쓰는
// 사용자에게는 경로가 늘 "확인 중"으로만 보인다 — 조용히 쓸모없어지는 종류의 실패다.
describe('findTailnetPeer', () => {
  it('matches a MagicDNS short name', () => {
    expect(findTailnetPeer(peers, 'agt-1')?.hostName).toBe('agt-1');
  });

  it('matches a full FQDN', () => {
    expect(findTailnetPeer(peers, 'agt-1.example.ts.net')?.hostName).toBe('agt-1');
  });

  it('matches an FQDN with a trailing dot', () => {
    expect(findTailnetPeer(peers, 'agt-1.example.ts.net.')?.hostName).toBe('agt-1');
  });

  it('matches a tailnet IP', () => {
    expect(findTailnetPeer(peers, '100.64.0.12')?.hostName).toBe('db');
  });

  it('ignores case', () => {
    expect(findTailnetPeer(peers, 'AGT-1')?.hostName).toBe('agt-1');
  });

  it('returns null for a host that is not in this tailnet', () => {
    expect(findTailnetPeer(peers, 'somewhere-else')).toBeNull();
  });

  it('returns null when the node reports no peers yet', () => {
    expect(findTailnetPeer(undefined, 'agt-1')).toBeNull();
  });

  // 짧은 이름을 다른 tailnet 의 동명 기기에 맞추면 안 된다 — 빈 문자열이 아무거나 잡는 것도
  // 같은 종류의 사고다.
  it('does not match an empty hostname', () => {
    expect(findTailnetPeer(peers, '   ')).toBeNull();
  });
});

// tailnet 을 거쳐 가는 호스트가 전부 tailnet 노드인 것은 아니다. tailscale 이 깔려 있지 않은
// 사내망 장비는 서브넷 라우터를 통해 닿는데, 이걸 못 찾으면 그 호스트의 경로는 영영
// "확인 중"에서 멈춘다 — 연결은 멀쩡히 되므로 아무도 버그로 신고하지 않는 종류의 실패다.
describe('findTailnetSubnetRouter', () => {
  it('finds the router that advertises the subnet', () => {
    expect(findTailnetSubnetRouter(peers, '192.168.0.13')?.hostName).toBe('router');
  });

  // 같은 주소를 여러 라우터가 담을 수 있다. 실제 경로는 더 구체적인 대역 쪽이다.
  it('prefers the most specific route', () => {
    expect(findTailnetSubnetRouter(peers, '10.0.5.7')?.hostName).toBe('router-narrow');
    expect(findTailnetSubnetRouter(peers, '10.0.6.7')?.hostName).toBe('router');
  });

  it('returns null for an address no router covers', () => {
    expect(findTailnetSubnetRouter(peers, '172.16.0.1')).toBeNull();
  });

  // 이름은 대역에 속하는지 물어볼 수 없다 — 물으면 아무 라우터나 붙는다.
  it('does not guess a router for a host name', () => {
    expect(findTailnetSubnetRouter(peers, 'agt-1')).toBeNull();
    expect(findTailnetSubnetRouter(peers, 'somewhere-else')).toBeNull();
  });

  it('returns null when the node reports no peers yet', () => {
    expect(findTailnetSubnetRouter(undefined, '192.168.0.13')).toBeNull();
  });

  // tailnet 노드 자신은 peer 매칭이 먼저 잡는다. 라우터 탐색이 그것을 가로채면 안 된다.
  it('ignores peers that advertise no routes', () => {
    expect(findTailnetSubnetRouter(peers, '100.64.0.9')).toBeNull();
  });
});

// 값 칸은 CSS 로 끝부터 잘린다. 이름을 우리가 줄이지 않으면 `…경유 · 직결` 에서 직결/릴레이가
// 먼저 사라져, 이 줄을 넣은 이유가 통째로 없어진다.
describe('shortenRouterName', () => {
  it('leaves short names alone', () => {
    expect(shortenRouterName('router')).toBe('router');
    expect(shortenRouterName('  router  ')).toBe('router');
  });

  it('keeps the distinguishing head of a long name', () => {
    expect(shortenRouterName('seoul-router-01.internal')).toBe('seoul-router-…');
  });

  it('never exceeds the budget', () => {
    expect(shortenRouterName('a'.repeat(80)).length).toBe(14);
    expect(shortenRouterName('a'.repeat(80), 5).length).toBe(5);
  });
});

// tailnet 상태 폴링 대상은 "화면에 떠 있는 것들이 쓰는 tailnet" 이다. 여기서 빠지면
// 호출부가 statuses 를 비워 hover 가 "연결 안 됨" 으로 보인다 — 연결은 멀쩡한데 표시만 깨진다.
describe('collectTailnetIdsInUse', () => {
  const sshHost = (id: string, tailnetId?: string): HostRecord =>
    ({
      id,
      kind: 'ssh',
      label: id,
      hostname: `${id}.example.ts.net`,
      port: 22,
      username: 'ubuntu',
      ...(tailnetId ? { tailnetId } : {}),
    }) as unknown as HostRecord;

  const hosts = [sshHost('host-1', 'tn-1'), sshHost('host-2', 'tn-2'), sshHost('host-3')];

  it('collects the tailnet of an open tab', () => {
    const ids = collectTailnetIdsInUse([{ hostId: 'host-1' }], [], hosts);
    expect([...ids]).toEqual(['tn-1']);
  });

  // control mode 로 붙으면 원래 SSH 탭이 자리를 내주고 tmux 그룹이 된다. 그룹만 남았을 때
  // 목록이 비면 상태가 지워져 "연결 안 됨" 이 된다 — 이 케이스가 실제 증상이었다.
  it('collects the tailnet of a tmux group even when no tab remains', () => {
    const ids = collectTailnetIdsInUse([], [{ hostId: 'host-1' }], hosts);
    expect([...ids]).toEqual(['tn-1']);
  });

  it('merges tabs and tmux groups without duplicates', () => {
    const ids = collectTailnetIdsInUse(
      [{ hostId: 'host-1' }, { hostId: 'host-2' }],
      [{ hostId: 'host-1' }],
      hosts,
    );
    expect([...ids].sort()).toEqual(['tn-1', 'tn-2']);
  });

  it('ignores hosts that do not use a tailnet', () => {
    const ids = collectTailnetIdsInUse([{ hostId: 'host-3' }], [{ hostId: null }], hosts);
    expect(ids.size).toBe(0);
  });
});
