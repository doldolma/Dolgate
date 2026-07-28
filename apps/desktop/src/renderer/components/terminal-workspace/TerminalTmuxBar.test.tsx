import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalTmuxStatusBar } from './TerminalTmuxStatusBar';
import { TmuxSessionFooter } from './TmuxSessionFooter';

// tmux 하단 바는 연결 방식에 따라 다른 컴포넌트가 같은 자리에 뜬다 — ssh 접속 후 원격
// tmux 를 감지했을 때(TerminalTmuxStatusBar)와 tmux 에 붙어 있을 때(TmuxSessionFooter).
// 예전에는 둘이 스킨을 따로 들고 있어서 여백(mx 0.35 vs 0.55, mb 0.2 vs 0.55, mt-1)과
// 아이콘(텍스트 글리프 ▤ vs lucide)이 갈렸고, 사용자에게는 "연결 방식마다 UI 가 다르게
// 생겼다"로 보였다. 두 경로가 같은 TerminalTmuxBar 를 쓴다는 것을 여기서 고정한다.
function renderDetected() {
  return render(
    <TerminalTmuxStatusBar
      version="3.5a"
      sessions={[]}
      onOpen={vi.fn()}
      onAttachSession={vi.fn()}
      onCreateSession={vi.fn()}
      onKillSession={vi.fn()}
    />,
  ).container;
}

function renderAttached() {
  return render(
    <TmuxSessionFooter
      sessionName="dolgate"
      sessions={[]}
      onDetach={vi.fn()}
      onCreateSession={vi.fn()}
      onSelectSession={vi.fn()}
      onKillSession={vi.fn()}
    />,
  ).container;
}

describe('tmux 하단 바', () => {
  it('ssh 감지와 tmux 접속이 같은 바 스킨으로 렌더된다', () => {
    const detected = renderDetected().firstElementChild;
    const attached = renderAttached().firstElementChild;

    expect(detected?.className).toBe(attached?.className);
    // 여백은 공통값이어야 한다 — 한쪽만 mt 를 들면 위 자원 바와의 간격이 벌어진다.
    expect(detected?.className).toContain('mx-[0.35rem]');
    expect(detected?.className).toContain('mb-[0.2rem]');
    expect(detected?.className).not.toContain('mt-');
  });

  it('두 경로의 액션 버튼이 같은 스킨을 쓴다', () => {
    const detectedButton = renderDetected().querySelector('button.ml-auto');
    const attachedButton = renderAttached().querySelector('button.ml-auto');

    expect(detectedButton).not.toBeNull();
    expect(attachedButton).not.toBeNull();
    expect(detectedButton?.className).toBe(attachedButton?.className);
  });

  it('아이콘은 양쪽 모두 텍스트 글리프가 아닌 svg 다', () => {
    // ▤ 같은 글리프는 OS·폰트마다 두께와 세로 정렬이 달라 3-OS 빌드에서 제각각으로 보인다.
    for (const container of [renderDetected(), renderAttached()]) {
      expect(container.querySelector('svg')).not.toBeNull();
      expect(container.textContent).not.toContain('▤');
    }
  });

  it('버전은 감지 바에만 나온다', () => {
    // tmux 안에서는 이미 붙어서 들어온 상태라 버전을 반복해 보여주지 않는다.
    expect(renderDetected().textContent).toContain('3.5a');
    expect(renderAttached().textContent).toContain('dolgate');
  });
});
