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
});
