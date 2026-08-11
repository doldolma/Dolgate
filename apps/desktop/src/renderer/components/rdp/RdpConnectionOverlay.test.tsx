import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HostRecord, TerminalTab } from '@shared';
import { appStore } from '../../store/appStore';
import { RdpConnectionOverlay } from './RdpConnectionOverlay';

vi.mock('../../services/desktop/tailnet-watch', () => ({
  acquireTailnetWatch: vi.fn(() => () => undefined),
}));

const RDP_HOST = {
  id: 'rdp1',
  kind: 'rdp',
  label: 'Win Box',
  hostname: 'winbox.example.ts.net',
  port: 3389,
  tailnetId: 'net-a',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as HostRecord;

function seedTab(overrides: Partial<TerminalTab>) {
  const tab = {
    sessionId: 'rdp-s1',
    stableId: 'rdp-stable-1',
    title: 'Win Box',
    status: 'connecting',
    source: 'host',
    hostId: 'rdp1',
    paneKind: 'rdp',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as TerminalTab;
  appStore.setState({ hosts: [RDP_HOST], tabs: [tab] });
}

describe('RdpConnectionOverlay', () => {
  beforeEach(() => {
    appStore.setState({
      hosts: [],
      tabs: [],
      tailnetStatuses: {},
      pendingRdpCertificatePrompt: null,
    });
  });

  it('does not cover the canvas once connected', () => {
    // 붙은 뒤에도 덮으면 원격 화면을 볼 수 없다.
    seedTab({ status: 'connected' });
    const { container } = render(<RdpConnectionOverlay sessionId="rdp-s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the tailnet layer while connecting', () => {
    // 한 줄 진행 문구로는 "연결하는 중" 밖에 말할 수 없다. tailnet 에서 막힌 것인지 알아야 한다.
    seedTab({ status: 'connecting' });
    appStore.setState({
      tailnetStatuses: {
        'net-a': {
          id: 'net-a',
          state: 'needsAuth',
          ready: false,
        } as never,
      },
    });

    render(<RdpConnectionOverlay sessionId="rdp-s1" />);

    // 단계 목록이 그려지면 Tailscale 이 언급된다(문구는 카탈로그에서 온다).
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('offers a retry when the session failed', () => {
    seedTab({ status: 'error', errorMessage: 'connect: TCP connect: refused' });

    render(<RdpConnectionOverlay sessionId="rdp-s1" />);

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('connect: TCP connect: refused')).toBeTruthy();
  });

  // 인증서 확인 화면과 겹쳐 보이던 버그. 둘 다 pane 을 덮는데 이 오버레이가 나중에 렌더되는
  // 형제라 위에 깔리고, 배경이 반투명이라 아래 프롬프트가 비쳐 두 창이 겹쳐 보였다. 재시도 버튼이
  // 있는 상태에서는 프롬프트 클릭까지 막혔다.
  it('인증서 확인 중에는 물러난다', () => {
    seedTab({ status: 'connecting' });
    appStore.setState({
      pendingRdpCertificatePrompt: {
        sessionId: 'rdp-s1',
        hostLabel: 'Win Box',
        status: 'unknown',
        certificate: {
          fingerprint: 'AA:BB',
          subject: 'CN=winbox',
          issuer: 'CN=winbox',
          notAfter: '2027-01-01T00:00:00Z',
        },
      } as never,
    });

    const { container } = render(<RdpConnectionOverlay sessionId="rdp-s1" />);

    expect(container).toBeEmptyDOMElement();
  });

  // 다른 세션의 프롬프트가 떠 있다고 이 세션의 진행 화면을 내리면, 붙는 중인데 검은 화면만 남는다.
  it('다른 세션의 인증서 확인에는 그대로 남는다', () => {
    seedTab({ status: 'connecting' });
    appStore.setState({
      pendingRdpCertificatePrompt: {
        sessionId: 'rdp-other',
        hostLabel: 'Other',
        status: 'unknown',
        certificate: {
          fingerprint: 'CC:DD',
          subject: 'CN=other',
          issuer: 'CN=other',
          notAfter: '2027-01-01T00:00:00Z',
        },
      } as never,
    });

    render(<RdpConnectionOverlay sessionId="rdp-s1" />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
