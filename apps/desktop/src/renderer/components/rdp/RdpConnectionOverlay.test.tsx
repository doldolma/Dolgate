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
    appStore.setState({ hosts: [], tabs: [], tailnetStatuses: {} });
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
});
