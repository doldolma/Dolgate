import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalSharePopover } from './TerminalSharePopover';

describe('TerminalSharePopover', () => {
  it('renders the inactive state and respects the start-share disabled flag', () => {
    const onStartShare = vi.fn();

    render(
      <TerminalSharePopover
        anchorRef={{ current: null }}
        showHeader={false}
        open
        canStartShare={false}
        shareCopyStatus={null}
        shareState={null}
        onToggle={vi.fn()}
        onStartShare={onStartShare}
        onCopyShareUrl={vi.fn()}
        onSetInputEnabled={vi.fn()}
        onOpenChatWindow={vi.fn()}
        onStopShare={vi.fn()}
        canOpenChatWindow={false}
      />,
    );

    const startButton = screen.getByRole('button', { name: '공유 시작' });
    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(onStartShare).not.toHaveBeenCalled();
  });

  it('renders the active share state and forwards share actions', () => {
    const onCopyShareUrl = vi.fn();
    const onStopShare = vi.fn();
    const onSetInputEnabled = vi.fn();

    render(
      <TerminalSharePopover
        anchorRef={{ current: null }}
        showHeader
        open
        canStartShare
        shareCopyStatus="링크를 복사했습니다."
        shareState={{
          status: 'active',
          shareUrl: 'https://share.test/session-1',
          viewerCount: 3,
          inputEnabled: false,
          errorMessage: null,
        }}
        onToggle={vi.fn()}
        onStartShare={vi.fn()}
        onCopyShareUrl={onCopyShareUrl}
        onSetInputEnabled={onSetInputEnabled}
        onOpenChatWindow={vi.fn()}
        onStopShare={onStopShare}
        canOpenChatWindow
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '공유 링크 복사' }));
    fireEvent.click(screen.getByRole('button', { name: '입력 허용' }));
    fireEvent.click(screen.getByRole('button', { name: '공유 종료' }));

    expect(onCopyShareUrl).toHaveBeenCalledTimes(1);
    expect(onSetInputEnabled).toHaveBeenCalledWith(true);
    expect(onStopShare).toHaveBeenCalledTimes(1);
  });
});
