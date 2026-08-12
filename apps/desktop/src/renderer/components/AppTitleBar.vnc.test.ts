import { beforeEach, describe, expect, it } from 'vitest';
import type { HostRecord, TerminalTab, VncCapabilities } from '@shared';

import {
  clearVncCapabilities,
  setVncCapabilities,
} from '../lib/vnc-capability-registry';
import { buildTabHoverInfo, tailnetIdOf, vncCapabilityRows } from './AppTitleBar';

function capabilities(overrides: Partial<VncCapabilities> = {}): VncCapabilities {
  return {
    extendedClipboard: false,
    desktopResize: true,
    cursor: true,
    continuousUpdates: true,
    qemuKeys: false,
    tls: false,
    encoding: 'zrle',
    ...overrides,
  };
}

const asMap = (sessionId: string) =>
  Object.fromEntries(vncCapabilityRows(sessionId).map((row) => [row.label, row.value]));

beforeEach(() => {
  clearVncCapabilities('vnc-1');
});

describe('vncCapabilityRows', () => {
  it('켜진 확장만 나열한다', () => {
    setVncCapabilities('vnc-1', capabilities());

    expect(asMap('vnc-1')['확장 기능']).toBe('커서 · 자동 크기 · 연속 갱신');
  });

  it('서버가 UTF-8 클립보드를 안 하면 그 이유를 적는다', () => {
    // 이 행이 "왜 한글 복붙이 안 되지" 에 답하는 유일한 자리다. 서버 한계라 우리가 고칠 수 없다.
    setVncCapabilities('vnc-1', capabilities({ extendedClipboard: false }));
    expect(asMap('vnc-1')['클립보드']).toBe('ASCII 전용(서버가 UTF-8 미지원)');

    setVncCapabilities('vnc-1', capabilities({ extendedClipboard: true }));
    expect(asMap('vnc-1')['클립보드']).toBe('UTF-8');
  });

  it('하나도 안 켜지면 없다고 적는다', () => {
    // 빈 목록을 그리면 라벨만 남아 "무엇이 빠졌나" 를 알 수 없다.
    setVncCapabilities(
      'vnc-1',
      capabilities({ cursor: false, desktopResize: false, continuousUpdates: false }),
    );

    expect(asMap('vnc-1')['확장 기능']).toBe('없음');
  });

  it('픽셀을 아직 못 받았으면 인코딩 행을 빼놓는다', () => {
    setVncCapabilities('vnc-1', capabilities({ encoding: '' }));

    expect(asMap('vnc-1')['인코딩']).toBeUndefined();
  });

  it('협상 결과가 없으면 행을 만들지 않는다', () => {
    // VNC 가 아닌 세션이나 아직 붙지 않은 세션이다.
    expect(vncCapabilityRows('vnc-1')).toEqual([]);
  });
});

// tailnet 경로 표시는 조회가 두 단계다(구독할 목록 + 개별 조회). SSH 만 보면 RDP·VNC 세션의
// tailnet 상태를 아예 조회하지 않아 hover 에 경로가 안 뜬다 — "릴레이 경유인지 직결인지" 를 그
// 줄에서만 알 수 있다.
describe('tailnetIdOf', () => {
  const base = {
    id: 'h',
    label: 'x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('tailnet 을 쓰는 세 종류를 모두 본다', () => {
    expect(
      tailnetIdOf({ ...base, kind: 'ssh', hostname: 'h', port: 22, username: 'u', authType: 'password', tailnetId: 'net-1' } as HostRecord),
    ).toBe('net-1');
    expect(
      tailnetIdOf({ ...base, kind: 'rdp', hostname: 'h', port: 3389, tailnetId: 'net-1' } as HostRecord),
    ).toBe('net-1');
    expect(
      tailnetIdOf({ ...base, kind: 'vnc', hostname: 'h', port: 5900, tailnetId: 'net-1' } as HostRecord),
    ).toBe('net-1');
  });

  it('tailnet 을 안 쓰거나 없는 종류는 빈 값이다', () => {
    expect(
      tailnetIdOf({ ...base, kind: 'vnc', hostname: 'h', port: 5900 } as HostRecord),
    ).toBe('');
    expect(
      tailnetIdOf({ ...base, kind: 'aws-ec2', awsInstanceId: 'i-1', awsRegion: 'ap-northeast-2' } as unknown as HostRecord),
    ).toBe('');
    expect(tailnetIdOf(null)).toBe('');
  });
});

// VNC 탭 hover 는 RDP 와 같은 순서로 읽혀야 한다 — 무엇이 보이는가(해상도) → 내가 바꾼 설정 →
// 협상 결과. **해상도는 데이터가 있는데도 RDP 분기 안에 갇혀 안 나오고 있었다.**
describe('VNC 탭 hover', () => {
  const vncHost = (overrides: Record<string, unknown> = {}): HostRecord =>
    ({
      id: 'h-vnc',
      kind: 'vnc',
      label: 'Lab',
      hostname: '10.0.0.6',
      port: 5900,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }) as HostRecord;

  const vncTab = (overrides: Record<string, unknown> = {}): TerminalTab =>
    ({
      sessionId: 'vnc-1',
      stableId: 's-vnc-1',
      title: 'Lab',
      status: 'connected',
      source: 'host',
      hostId: 'h-vnc',
      paneKind: 'vnc',
      rdpDesktopSize: { width: 1440, height: 900 },
      lastEventAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }) as unknown as TerminalTab;

  const build = (host: HostRecord, tab: TerminalTab = vncTab()) =>
    Object.fromEntries(
      buildTabHoverInfo(
        { kind: 'session', sessionId: 'vnc-1', active: true } as never,
        [tab],
        [host],
        [],
        [],
        () => null,
      ).rows.map((row) => [row.label, row.value]),
    );

  it('해상도를 보여준다', () => {
    expect(build(vncHost())['해상도']).toBe('1440×900');
  });

  it('기본값과 다른 설정만 보여준다', () => {
    // 아무것도 안 바꾼 세션에서 행이 늘면 정작 다른 값이 묻힌다.
    const plain = build(vncHost());
    expect(plain['화질']).toBeUndefined();
    expect(plain['보기 전용']).toBeUndefined();
    expect(plain['화면 공유']).toBeUndefined();

    const tuned = build(
      vncHost({ imageQuality: 'balanced', viewOnly: true, shared: false }),
    );
    expect(tuned['화질']).toBe('균형 (JPEG)');
    expect(tuned['보기 전용']).toBe('켜짐');
    expect(tuned['화면 공유']).toBe('꺼짐');
  });

  it('SSH 터널을 경유하면 그 호스트를 이름으로 보여준다', () => {
    // 주소만 보면 왜 localhost 로 붙는지 알 수 없다.
    const bastion = {
      id: 'h-ssh',
      kind: 'ssh',
      label: 'bastion',
      hostname: '10.0.0.1',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as HostRecord;
    const rows = Object.fromEntries(
      buildTabHoverInfo(
        { kind: 'session', sessionId: 'vnc-1', active: true } as never,
        [vncTab()],
        [vncHost({ sshTunnelHostId: 'h-ssh' }), bastion],
        [],
        [],
        () => null,
      ).rows.map((row) => [row.label, row.value]),
    );
    expect(rows['점프']).toBe('bastion');
  });

  it('협상 결과도 같은 카드에 넣는다', () => {
    setVncCapabilities('vnc-1', capabilities());
    expect(build(vncHost())['확장 기능']).toBe('커서 · 자동 크기 · 연속 갱신');
  });
});
