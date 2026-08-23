// 툴바가 글자에서 아이콘으로 바뀌었으니 이름은 툴팁이 말한다. 복사가 두 개라(출력·명령)
// 아이콘만으로는 가릴 수 없어서, 즉시 뜨는 툴팁이 이 화면의 유일한 이름표다.
//
// 쿼리에 hidden 을 주는 이유: 오버레이 루트는 aria-hidden 이다(터미널 위에 얹히는 장식이라
// 스크린리더가 훑을 대상이 아니다). 그래서 접근성 트리에는 안 보이지만 화면에는 있다.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalBlockOverlay } from './TerminalBlockOverlay';

function overlayState(overrides: Record<string, unknown> = {}) {
  return {
    top: 0,
    height: 60,
    state: 'ok' as const,
    exitCode: 0,
    durationMs: 41,
    command: 'ls -la',
    commandUnreliable: false,
    ...overrides,
  } as never;
}

function renderOverlay(props: Record<string, unknown> = {}) {
  const handlers = {
    onCopyOutput: vi.fn(),
    onCopyCommand: vi.fn(),
    onRerun: vi.fn(),
    onAskAi: vi.fn(),
  };
  render(
    <TerminalBlockOverlay
      overlay={overlayState()}
      rerunEnabled
      aiEnabled
      toolbarTopOffset={0}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('TerminalBlockOverlay', () => {
  it('아이콘마다 이름이 남아 있다 — 복사 두 개가 갈린다', () => {
    renderOverlay();
    expect(screen.getByRole('button', { hidden: true, name: '출력 복사' })).toBeTruthy();
    expect(screen.getByRole('button', { hidden: true, name: '명령 복사' })).toBeTruthy();
    expect(screen.getByRole('button', { hidden: true, name: '재실행' })).toBeTruthy();
    expect(screen.getByRole('button', { hidden: true, name: 'AI 에게 묻기' })).toBeTruthy();
  });

  it('마우스를 올리면 툴팁이 즉시 뜬다', () => {
    renderOverlay();
    const button = screen.getByRole('button', { hidden: true, name: '출력 복사' });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('출력 복사');
  });

  it('잠긴 버튼에서도 이유를 보여 준다', () => {
    // 화면에서 읽은 명령은 재실행을 막는다 — 왜인지 알 방법이 툴팁뿐이다.
    renderOverlay({ overlay: overlayState({ commandUnreliable: true }) });
    const rerun = screen.getByRole('button', { hidden: true, name: '재실행' }) as HTMLButtonElement;
    expect(rerun.disabled).toBe(true);
    fireEvent.mouseEnter(rerun.parentElement as HTMLElement);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain('화면에서 읽은');
  });

  it('복사하면 잠깐 이름이 바뀐다', async () => {
    const handlers = renderOverlay();
    fireEvent.click(screen.getByRole('button', { hidden: true, name: '명령 복사' }));
    expect(handlers.onCopyCommand).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { hidden: true, name: '복사했습니다' })).toBeTruthy();
  });

  it('소요시간과 종료 코드는 글자로 남긴다 — 누르는 것이 아니다', () => {
    renderOverlay({ overlay: overlayState({ state: 'failed', exitCode: 1 }) });
    expect(screen.getByText('exit 1 · 41ms')).toBeTruthy();
  });
});
