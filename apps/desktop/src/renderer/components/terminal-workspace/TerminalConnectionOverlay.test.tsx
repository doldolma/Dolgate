import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalConnectionOverlay } from './TerminalConnectionOverlay';

describe('TerminalConnectionOverlay', () => {
  it('renders blocking copy without action buttons', () => {
    render(
      <TerminalConnectionOverlay
        error={false}
        title="Connecting"
        message="세션을 연결하는 중입니다..."
      />,
    );

    expect(screen.getByRole('status', { name: 'Connecting' })).toBeInTheDocument();
    expect(screen.getByText('Connecting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('세션을 연결하는 중입니다...').tagName).toBe('P');
  });

  it('renders retry and close actions for errors', () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalConnectionOverlay
        error
        title="Connection Failed"
        message="세션 연결에 실패했습니다."
        onRetry={onRetry}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('alertdialog', { name: 'Connection Failed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders close only when retry is disabled', () => {
    const onClose = vi.fn();

    render(
      <TerminalConnectionOverlay
        error
        title="Connection Failed"
        message="컨테이너 셸을 시작하지 못했습니다."
        showRetry={false}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('alertdialog', { name: 'Connection Failed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders per-hop steps for a multi-hop ProxyJump connection', () => {
    render(
      <TerminalConnectionOverlay
        error={false}
        title="Connecting"
        message="점프 호스트를 거쳐 연결하는 중입니다..."
        steps={[
          { index: 1, count: 3, label: 'me@bastion1:22', stage: 'connected' },
          { index: 2, count: 3, label: 'me@bastion2:22', stage: 'connecting' },
          { index: 3, count: 3, label: 'me@target:22', stage: 'connecting' },
        ]}
      />,
    );

    // 3개 홉이 각각 한 줄로, 완료/진행 상태와 함께 표시된다.
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('연결됨')).toBeInTheDocument();
    expect(screen.getAllByText('연결 중…')).toHaveLength(2);
  });

  it('omits the step list when there are no hops', () => {
    render(
      <TerminalConnectionOverlay error={false} title="Connecting" message="연결 중..." />,
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('shows the friendly host name alongside the address for each hop', () => {
    render(
      <TerminalConnectionOverlay
        error={false}
        title="Connecting"
        message="점프 호스트를 거쳐 연결하는 중입니다..."
        steps={[
          {
            index: 1,
            count: 2,
            label: 'gridwiz@10.0.0.1:22',
            stage: 'connected',
            name: 'Lime-DB',
          },
          {
            index: 2,
            count: 2,
            label: 'gridwiz@192.168.0.13:22',
            stage: 'connecting',
            name: 'lime-dev',
          },
        ]}
      />,
    );

    // 사용자 지정 호스트 이름과 계정 주소가 함께 표시된다.
    expect(screen.getByText('Lime-DB')).toBeInTheDocument();
    expect(screen.getByText('lime-dev')).toBeInTheDocument();
    expect(screen.getByText(/gridwiz@192\.168\.0\.13:22/)).toBeInTheDocument();
  });
});
