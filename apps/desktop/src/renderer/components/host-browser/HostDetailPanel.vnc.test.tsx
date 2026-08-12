import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, SecretMetadataRecord, SshHostRecord, VncHostRecord } from '@shared';
import { HostDetailPanel } from './HostDetailPanel';
import type { HostBrowserModel } from './useHostBrowser';

// VNC 호스트의 Connection 탭이 Type·Address 두 줄만 보여주던 것을 메꾼다(RDP 가 그랬던 것과 같은
// 빈틈이다). **경유 SSH 호스트가 특히 중요하다** — 터널을 쓰면 Address 가 127.0.0.1 로 보여서,
// 어디를 거치는지 적지 않으면 왜 로컬 주소로 붙는지 설명이 안 된다.

vi.mock('../../services/desktop/tailnet', () => ({
  listTailnets: vi.fn(async () => [{ id: 'tn-corp', label: 'corp-tailnet' }]),
}));

const keychainEntries: SecretMetadataRecord[] = [
  {
    secretRef: 'secret-vnc',
    label: '콘솔 비밀번호',
    kind: 'vnc',
    hasPassword: true,
    hasPassphrase: false,
    hasManagedPrivateKey: false,
    hasCertificate: false,
    linkedHostCount: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as SecretMetadataRecord,
];

const gateHost: SshHostRecord = {
  id: 'h-gate',
  kind: 'ssh',
  label: 'gate',
  hostname: 'gate.example.com',
  port: 22,
  username: 'ops',
  authType: 'agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as SshHostRecord;

function makeHost(overrides: Partial<VncHostRecord> = {}): VncHostRecord {
  return {
    id: 'h-vnc',
    kind: 'vnc',
    label: 'lab console',
    hostname: '127.0.0.1',
    port: 5901,
    secretRef: 'secret-vnc',
    sshTunnelHostId: 'h-gate',
    imageQuality: 'balanced',
    shared: false,
    viewOnly: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as VncHostRecord;
}

function renderPanel(
  host: HostRecord,
  hosts: HostRecord[] = [host, gateHost],
  detailTab: 'overview' | 'connection' = 'connection',
) {
  const hb = {
    hosts,
    selectedHostId: host.id,
    favoriteHostIdSet: new Set<string>(),
    keychainEntries,
    detailTab,
    onEditHost: vi.fn(),
    onConnectHost: vi.fn(),
    onOpenHostContainers: vi.fn(),
    onOpenSftp: vi.fn(),
    onConnectHostTmux: vi.fn(),
    toggleFavorite: vi.fn(),
    clearSelections: vi.fn(),
    selectSingleHost: vi.fn(),
  } as unknown as HostBrowserModel;
  return render(<HostDetailPanel hb={hb} />);
}

/** InfoRow 는 라벨과 값을 형제 span 으로 둔다 — 라벨로 줄을 찾아 값만 떼어낸다. */
function rowValue(label: string): string {
  const labelNode = screen.getByText(label);
  const text = labelNode.parentElement?.textContent ?? '';
  return text.slice(label.length).trim();
}

describe('HostDetailPanel — VNC Connection 탭', () => {
  it('설정한 VNC 값들을 줄로 보여준다', () => {
    renderPanel(makeHost());

    expect(rowValue('Type')).toBe('VNC');
    expect(rowValue('Address')).toBe('127.0.0.1:5901');
    expect(rowValue('Port')).toBe('5901');
    expect(rowValue('Credential')).toBe('콘솔 비밀번호');
    // 경유 호스트는 id 가 아니라 사용자가 붙인 이름으로 보여야 한다.
    expect(rowValue('SSH 터널')).toBe('gate');
    expect(rowValue('화질')).toBe('균형');
    // 기본이 켬인 토글은 껐을 때도 보여준다.
    expect(rowValue('화면 공유')).toBe('사용 안 함');
    // 기본이 끔인 것은 켰을 때만 나온다.
    expect(rowValue('보기 전용')).toBe('사용');
  });

  it('설정하지 않은 값은 기본값으로 보여주고 없는 줄은 빼낸다', () => {
    renderPanel(
      makeHost({
        secretRef: null,
        sshTunnelHostId: null,
        imageQuality: null,
        shared: null,
        viewOnly: null,
      }),
    );

    // 레코드 기본값과 같은 규칙이어야 한다 — 없으면 무손실·공유다.
    expect(rowValue('화질')).toBe('무손실');
    expect(rowValue('화면 공유')).toBe('사용');
    expect(screen.queryByText('보기 전용')).toBeNull();
    expect(screen.queryByText('SSH 터널')).toBeNull();
    expect(rowValue('Credential')).toBe('저장 안 함 (연결 시 입력)');
  });

  // 경유 호스트를 지우면 접속이 실패한다. 그 사실을 여기서 알아채는 것이 가장 이르다.
  it('경유 SSH 호스트가 지워졌으면 그 사실을 알린다', () => {
    const host = makeHost({ sshTunnelHostId: 'h-gone' });
    renderPanel(host, [host]);

    expect(rowValue('SSH 터널')).toContain('삭제된 SSH 호스트');
  });

  // 경로는 Overview 에서도 보여야 한다 — 접속이 실패했을 때 무엇을 의심할지가 여기 달려 있다.
  it('Overview 에도 경유 SSH 호스트를 보여준다', () => {
    renderPanel(makeHost(), [makeHost(), gateHost], 'overview');

    // Connection 탭과 같은 행이어야 한다 — 새 라벨을 만들지 않는다.
    expect(rowValue('SSH 터널')).toBe('gate');
  });

  it('경유하는 것이 없으면 Overview 에 그 행을 넣지 않는다', () => {
    const host = makeHost({ sshTunnelHostId: null, tailnetId: null });
    renderPanel(host, [host], 'overview');

    expect(screen.queryByText('SSH 터널')).toBeNull();
    expect(screen.queryByText('Tailnet')).toBeNull();
  });

  it('tailnet 을 쓰면 그 이름을 보여준다', async () => {
    renderPanel(makeHost({ sshTunnelHostId: null, tailnetId: 'tn-corp' }));

    expect(await screen.findByText('corp-tailnet')).toBeTruthy();
  });
});
