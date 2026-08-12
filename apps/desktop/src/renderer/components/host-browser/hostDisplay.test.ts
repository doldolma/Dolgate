import { describe, expect, it } from 'vitest';
import type { HostRecord, RdpHostRecord, VncHostRecord } from '@shared';
import { getHostAddress, getHostShortType, getHostTypeLabel } from './hostDisplay';

// 종류를 모르는 값은 SSH 로 떨어진다(SSH 가 이 앱의 기본이고, 옛 레코드에는 kind 가 없다).
// 그래서 새 종류를 추가할 때 여기를 빼먹으면 화면 곳곳에서 "SSH" 라고 우기게 된다 — 카드·표·
// 상세 패널이 모두 이 세 함수만 본다.

const rdpHost: RdpHostRecord = {
  id: 'h-rdp',
  kind: 'rdp',
  label: 'winbox',
  hostname: '10.0.2.181',
  port: 3389,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('hostDisplay — RDP', () => {
  it('RDP 호스트를 RDP 로 표시한다', () => {
    expect(getHostTypeLabel(rdpHost)).toBe('RDP');
    expect(getHostShortType(rdpHost)).toBe('RDP');
  });

  it('주소는 호스트이름:포트다', () => {
    expect(getHostAddress(rdpHost)).toBe('10.0.2.181:3389');
  });

  it('종류를 모르는 레코드는 여전히 SSH 로 본다', () => {
    const legacy = { ...rdpHost, kind: 'ssh' } as unknown as HostRecord;
    expect(getHostTypeLabel(legacy)).toBe('SSH');
  });
});

// VNC 도 같은 함수를 본다. 분기를 빼먹으면 default 로 떨어져 카드·표에 **주소가 아예 안 나온다**.
describe('hostDisplay — VNC', () => {
  const vncHost: VncHostRecord = {
    id: 'h-vnc',
    kind: 'vnc',
    label: 'lab',
    hostname: '10.0.2.90',
    port: 5900,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('주소는 호스트이름:포트다', () => {
    expect(getHostAddress(vncHost)).toBe('10.0.2.90:5900');
  });

  it('VNC 로 표시한다', () => {
    expect(getHostTypeLabel(vncHost)).toBe('VNC');
    expect(getHostShortType(vncHost)).toBe('VNC');
  });
});
