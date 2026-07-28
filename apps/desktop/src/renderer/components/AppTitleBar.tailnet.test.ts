import { describe, expect, it } from 'vitest';
import type { TailnetPeer } from '@shared';
import { findTailnetPeer } from './AppTitleBar';

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
