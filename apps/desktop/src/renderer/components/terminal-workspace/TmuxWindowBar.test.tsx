import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '../../store/types';
import { TmuxWindowBar } from './TmuxWindowBar';

function windowTab(index: number, name: string): WorkspaceTab {
  return {
    id: `ws-${index}`,
    title: `${index}:${name}`,
    layout: { kind: 'leaf', id: `leaf-${index}`, sessionId: `tmux:ctl:${index}` },
    activeSessionId: `tmux:ctl:${index}`,
    broadcastEnabled: false,
    tmux: { controlSessionId: 'ctl', windowId: `@${index}`, index, name },
  };
}

function renderBar(overrides: Partial<Parameters<typeof TmuxWindowBar>[0]> = {}) {
  const props = {
    windows: [windowTab(0, 'vi'), windowTab(1, 'fish')],
    activeWorkspaceId: 'ws-0',
    onSelect: vi.fn(),
    onNewWindow: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onSplitHorizontal: vi.fn(),
    onSplitVertical: vi.fn(),
    ...overrides,
  };
  render(<TmuxWindowBar {...props} />);
  return props;
}

const CLOSE_LABEL = '윈도우 닫기 (kill-window)';

describe('TmuxWindowBar', () => {
  // 닫기(×)가 호버에서만 나타나던 때는 있는 줄 모르고 창 탭을 누르다 오른쪽 끝을 짚어 창이 꺼지는
  // 일이 있었다. kill-window 는 그 창의 프로세스를 다 죽이고 되돌릴 수 없으므로, 눌릴 수 있는
  // 버튼은 눌리기 전에 보여야 한다.
  //
  // jsdom 은 Tailwind CSS 를 적용하지 않아 실제 투명도를 읽을 수 없다. 보임 여부가 전적으로 클래스로
  // 정해지므로(opacity-0 + group-hover:opacity-100) 그 클래스가 없다는 것으로 확인한다.
  it('닫기 버튼은 호버 없이도 보인다', () => {
    renderBar();

    const closeButtons = screen.getAllByRole('button', { name: CLOSE_LABEL });
    expect(closeButtons).toHaveLength(2);
    for (const button of closeButtons) {
      expect(button.className, '호버로만 나타나면 있는 줄 모르고 눌러 창이 꺼진다').not.toContain(
        'opacity-0',
      );
      expect(button.className).not.toContain('group-hover:opacity-100');
    }
  });

  // × 는 탭 안에 들어 있다. 전파를 막지 않으면 닫으면서 그 창으로 전환까지 하게 된다.
  it('닫기를 눌러도 그 창으로 전환하지 않는다', () => {
    const props = renderBar();

    fireEvent.click(screen.getAllByRole('button', { name: CLOSE_LABEL })[1]);

    expect(props.onClose).toHaveBeenCalledWith('ws-1');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('탭을 누르면 그 창으로 전환한다', () => {
    const props = renderBar();

    fireEvent.click(screen.getByText('1:fish'));

    expect(props.onSelect).toHaveBeenCalledWith('ws-1');
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
