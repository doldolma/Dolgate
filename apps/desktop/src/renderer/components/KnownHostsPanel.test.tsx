import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, KnownHostRecord } from '@shared';
import { KnownHostsPanel } from './KnownHostsPanel';

// 설정 › Security 는 "이 앱이 무엇을 신뢰하고 있나" 에 답하는 화면이다. SSH 호스트 키는 known_hosts
// 저장소에 있고 RDP 서버 인증서는 호스트 레코드(certificateFingerprint)에 있어서, 예전에는 RDP 를
// 신뢰한 사실이 어디에도 보이지 않았다 — 잘못 신뢰했을 때 호스트를 지우고 다시 만드는 것 말고는
// 되돌릴 방법이 없었다.

const KNOWN_HOST: KnownHostRecord = {
  id: 'known-1',
  host: 'gate.example.com',
  port: 22,
  algorithm: 'ssh-ed25519',
  publicKeyBase64: 'AAAAGATE',
  fingerprintSha256: 'SHA256:gate',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
} as KnownHostRecord;

const TRUSTED_RDP_HOST = {
  id: 'rdp-1',
  kind: 'rdp',
  label: 'work-pc',
  hostname: '10.0.0.5',
  port: 3389,
  certificateFingerprint: 'SHA256:cert-work-pc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as HostRecord;

const UNTRUSTED_RDP_HOST = {
  id: 'rdp-2',
  kind: 'rdp',
  label: 'never-connected',
  hostname: '10.0.0.6',
  port: 3389,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as HostRecord;

const SSH_HOST = {
  id: 'ssh-1',
  kind: 'ssh',
  label: 'gate',
  hostname: 'gate.example.com',
  port: 22,
  username: 'ops',
  authType: 'agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as HostRecord;

function renderPanel(hosts: HostRecord[], records: KnownHostRecord[] = [KNOWN_HOST]) {
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onRevokeRdpCertificate = vi.fn().mockResolvedValue(undefined);
  render(
    <KnownHostsPanel
      records={records}
      onRemove={onRemove}
      hosts={hosts}
      onRevokeRdpCertificate={onRevokeRdpCertificate}
    />,
  );
  return { onRemove, onRevokeRdpCertificate };
}

describe('KnownHostsPanel', () => {
  it('신뢰한 RDP 인증서를 지문과 함께 보여준다', () => {
    renderPanel([SSH_HOST, TRUSTED_RDP_HOST, UNTRUSTED_RDP_HOST]);

    expect(screen.getByText('work-pc')).toBeInTheDocument();
    // 인증서 확인 화면과 같은 형식이라 나란히 대조할 수 있어야 한다.
    expect(screen.getByText('SHA256:cert-work-pc')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5:3389')).toBeInTheDocument();
    // SSH 호스트 키 목록은 그대로 남는다 — 절이 서로를 대체하지 않는다.
    expect(screen.getByText('gate.example.com:22')).toBeInTheDocument();
  });

  it('신뢰하지 않은 RDP 호스트는 목록에 넣지 않는다', () => {
    renderPanel([TRUSTED_RDP_HOST, UNTRUSTED_RDP_HOST]);

    // 접속한 적 없는 호스트까지 나오면 "무엇을 신뢰했나" 라는 질문에 답하지 못한다.
    expect(screen.queryByText('never-connected')).not.toBeInTheDocument();
  });

  it('신뢰 해제는 그 호스트만 지목한다', () => {
    const { onRevokeRdpCertificate } = renderPanel([TRUSTED_RDP_HOST]);

    fireEvent.click(screen.getByRole('button', { name: '신뢰 해제' }));

    expect(onRevokeRdpCertificate).toHaveBeenCalledWith('rdp-1');
  });

  it('신뢰한 인증서가 없으면 어떻게 추가되는지 알려준다', () => {
    renderPanel([SSH_HOST]);

    expect(screen.getByText('신뢰한 RDP 서버 인증서가 없습니다.')).toBeInTheDocument();
    // SSH 목록의 빈 상태와 뒤섞이면 안 된다.
    expect(screen.queryByText('아직 저장된 known host가 없습니다.')).not.toBeInTheDocument();
  });
});
