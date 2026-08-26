import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalSharePopover } from './TerminalSharePopover';

describe('TerminalSharePopover', () => {
  it('renders the inactive state and respects the start-share disabled flag', () => {
    const onStartShare = vi.fn();

    render(
      <TerminalSharePopover
        anchorRef={{ current: null }}
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

  it('renders the error state without a false "ready" header or "generating" note', () => {
    render(
      <TerminalSharePopover
        anchorRef={{ current: null }}
        open
        canStartShare
        shareCopyStatus={null}
        shareState={{
          status: 'error',
          shareUrl: null,
          viewerCount: 0,
          inputEnabled: false,
          errorMessage:
            '세션 공유 링크를 만들지 못했습니다. (서버가 올바른 응답을 반환하지 않았습니다. 상태 코드 404)',
        }}
        onToggle={vi.fn()}
        onStartShare={vi.fn()}
        onCopyShareUrl={vi.fn()}
        onSetInputEnabled={vi.fn()}
        onOpenChatWindow={vi.fn()}
        onStopShare={vi.fn()}
        canOpenChatWindow={false}
      />,
    );

    // 에러 상태에서 "준비됐다"/"생성 중" 오표시가 없어야 하고, 에러 메시지가 보여야 한다.
    expect(screen.getByText('세션 공유에 실패했습니다.')).toBeInTheDocument();
    expect(screen.getByText(/상태 코드 404/)).toBeInTheDocument();
    expect(
      screen.queryByText('공유 링크가 준비되었습니다.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('공유 링크를 생성하는 중입니다.'),
    ).not.toBeInTheDocument();
  });

  it('renders extra session actions next to the share control', () => {
    render(
      <TerminalSharePopover
        anchorRef={{ current: null }}
        open={false}
        actions={<button type="button">Serial actions</button>}
        canStartShare
        shareCopyStatus={null}
        shareState={null}
        onToggle={vi.fn()}
        onStartShare={vi.fn()}
        onCopyShareUrl={vi.fn()}
        onSetInputEnabled={vi.fn()}
        onOpenChatWindow={vi.fn()}
        onStopShare={vi.fn()}
        canOpenChatWindow={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Serial actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  // 공유는 켜 두면 팝오버를 닫아도 계속 돌아간다. 버튼이 평소와 같아 보이면 켜 둔 것을 잊는다.
  describe('공유 중 표시', () => {
    const props = {
      anchorRef: { current: null },
      open: false,
      canStartShare: true,
      shareCopyStatus: null,
      onToggle: vi.fn(),
      onStartShare: vi.fn(),
      onCopyShareUrl: vi.fn(),
      onSetInputEnabled: vi.fn(),
      onOpenChatWindow: vi.fn(),
      onStopShare: vi.fn(),
      canOpenChatWindow: false,
    } as const;

    const shareState = (status: string, viewerCount = 0, inputEnabled = false) => ({
      status,
      shareUrl: status === 'active' ? 'https://share.test/session-1' : null,
      viewerCount,
      inputEnabled,
      errorMessage: null,
    }) as never;

    it('공유 중이면 상단 바 버튼이 색으로 채워지고 보는 사람 수가 함께 선다', () => {
      render(
        <TerminalSharePopover
          {...props}
          variant="chrome"
          shareState={shareState('active', 3)}
        />,
      );

      const button = screen.getByTestId('session-share-live');
      // 남색 상단 바 위에서 읽히도록 이 자리만 고정색이다.
      expect(button.getAttribute('style')).toContain('21, 145, 107');
      expect(screen.getByTestId('session-share-viewers')).toHaveTextContent('3');
      expect(button).toHaveAttribute('title', 'Share · 시청자 3명 · 읽기 전용');
      // 이름은 어느 상태에서도 그대로여야 한다.
      expect(screen.getByRole('button', { name: 'Share' })).toBe(button);
    });

    it('보는 사람이 없어도 0 을 보여 준다', () => {
      render(
        <TerminalSharePopover {...props} variant="chrome" shareState={shareState('active')} />,
      );

      expect(screen.getByTestId('session-share-viewers')).toHaveTextContent('0');
    });

    it('공유하지 않으면 평소 아이콘 버튼 그대로다', () => {
      render(<TerminalSharePopover {...props} variant="chrome" shareState={null} />);

      expect(screen.queryByTestId('session-share-live')).not.toBeInTheDocument();
      expect(screen.queryByTestId('session-share-viewers')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Share' })).toHaveAttribute('title', 'Share');
    });

    // 링크가 아직 없어도 세션 화면은 이미 넘어가고 있다 — 그동안 표시가 없으면 안 된다.
    it('준비 중에도 채워지고, 깜빡여서 아직 진행 중임을 말한다', () => {
      render(
        <TerminalSharePopover {...props} variant="chrome" shareState={shareState('starting')} />,
      );

      const button = screen.getByTestId('session-share-live');
      expect(button.className).toContain('animate-pulse');
      // 아직 사람 수를 말할 단계가 아니다(링크도 나가지 않았다).
      expect(screen.queryByTestId('session-share-viewers')).not.toBeInTheDocument();
    });

    it('실패한 공유는 붉게 채운다', () => {
      render(
        <TerminalSharePopover {...props} variant="chrome" shareState={shareState('error')} />,
      );

      const button = screen.getByTestId('session-share-live');
      expect(button.getAttribute('style')).toContain('226, 80, 74');
      expect(button.className).not.toContain('animate-pulse');
    });

    // 분할 화면의 pane 헤더는 앱 표면 위라 토큰이 제 일을 한다 — 고정색을 쓰지 않는다.
    it('pane 헤더의 Share 도 같이 물든다', () => {
      render(<TerminalSharePopover {...props} shareState={shareState('active', 2)} />);

      const button = screen.getByRole('button', { name: 'Share' });
      expect(button.className).toContain('var(--success-bg)');
      expect(screen.getByTestId('session-share-viewers')).toHaveTextContent('2');
    });

    // 보기만 하는 것과 남이 내 터미널에 명령을 칠 수 있는 것은 위험이 다르다. 잊기 쉬운
    // 쪽은 후자라, 칩만 보고도 갈려야 한다.
    it('입력을 허용한 공유는 색과 아이콘이 모두 다르다', () => {
      render(
        <TerminalSharePopover
          {...props}
          variant="chrome"
          shareState={shareState('active', 2, true)}
        />,
      );

      const button = screen.getByTestId('session-share-live');
      // 읽기 전용의 초록이 아니라 앰버.
      expect(button.getAttribute('style')).toContain('184, 119, 12');
      // 색만으로 갈리면 색약인 사람에게는 같은 칩이다.
      expect(screen.getByTestId('session-share-input-icon')).toBeInTheDocument();
      expect(screen.queryByTestId('session-share-icon')).not.toBeInTheDocument();
      expect(button).toHaveAttribute('title', 'Share · 시청자 2명 · 입력 허용');
    });

    it('읽기 전용 공유는 초록에 Share 아이콘 그대로다', () => {
      render(
        <TerminalSharePopover
          {...props}
          variant="chrome"
          shareState={shareState('active', 2)}
        />,
      );

      expect(screen.getByTestId('session-share-icon')).toBeInTheDocument();
      expect(screen.queryByTestId('session-share-input-icon')).not.toBeInTheDocument();
      expect(screen.getByTestId('session-share-live')).toHaveAttribute(
        'title',
        'Share · 시청자 2명 · 읽기 전용',
      );
    });

    // 실패한 공유에는 입력이랄 것이 없다 — 그 상태는 붉은색 하나로만 말한다.
    it('실패 상태는 입력 허용이 켜져 있어도 붉은색이다', () => {
      render(
        <TerminalSharePopover
          {...props}
          variant="chrome"
          shareState={shareState('error', 0, true)}
        />,
      );

      const button = screen.getByTestId('session-share-live');
      expect(button.getAttribute('style')).toContain('226, 80, 74');
      expect(screen.queryByTestId('session-share-input-icon')).not.toBeInTheDocument();
    });

    it('pane 헤더도 입력 허용이면 경고 톤으로 물들고 키보드가 붙는다', () => {
      render(<TerminalSharePopover {...props} shareState={shareState('active', 1, true)} />);

      const button = screen.getByRole('button', { name: 'Share' });
      expect(button.className).toContain('var(--warning-bg)');
      expect(screen.getByTestId('session-share-input-icon')).toBeInTheDocument();
    });
  });
});
