// 프로세스 목록에서 이름 뒤로 감춘 것들(전체 경로·사용자·메모리)이 어떻게 나오는지.
//
// **네이티브 `title` 로 두지 않는다.** OS 가 그리는 것이라 1초 가까이 가만히 있어야 뜨고,
// 마우스가 조금만 움직여도 사라지며, 앱과 생김새가 따로 논다. 앱 Tooltip 은 즉시 뜬다.

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState: Record<string, unknown> = {};
vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

const processes = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('./useSessionHostMetrics', () => ({
  useSessionHostMetrics: () => ({ status: 'ready', processes: processes.current }),
}));

import { SessionPanelProcesses } from './SessionPanelProcesses';

const WINDOWS_PROCESS = {
  pid: 16268,
  user: 'Computer',
  cpuPercent: 18.7,
  memPercent: 2.6,
  rssKb: 3315256,
  command: 'C:\\Users\\Computer\\IdeaProjects\\bin\\idea64.exe',
};

beforeEach(() => {
  storeState.settings = { hostMetricsEnabled: true };
  storeState.updateSettings = vi.fn();
  processes.current = [WINDOWS_PROCESS];
});

describe('프로세스 행', () => {
  /**
   * 이 목록은 실행 파일 이름을 보려고 보는 것이다. Windows 경로는 이름이 **맨 뒤**에 있는데
   * 잘리는 자리도 뒤라, 경로를 그대로 두면 목록이 `C:\Users\Computer\IdeaProj…` 로만 채워져
   * 서로 다른 프로그램이 같아 보였다.
   */
  it('Windows 전체 경로 대신 실행 파일 이름을 보여 준다', () => {
    render(<SessionPanelProcesses sessionId="s1" />);
    expect(screen.getByText('idea64.exe')).toBeInTheDocument();
    expect(screen.queryByText(/IdeaProjects/)).toBeNull();
  });

  it('이름 칸에 마우스를 올리면 전체 경로와 사용자·메모리가 즉시 나온다', () => {
    render(<SessionPanelProcesses sessionId="s1" />);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // 지연도 타이머도 없다 — 올린 순간 뜬다.
    fireEvent.mouseEnter(screen.getByText('idea64.exe').parentElement!.parentElement!);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('C:\\Users\\Computer\\IdeaProjects\\bin\\idea64.exe');
    expect(tooltip).toHaveTextContent('Computer');
    // 끊을 자리가 없는 경로가 화면을 넘지 않게 접힌다.
    expect(tooltip.className).toContain('break-all');
    expect(tooltip.className).not.toContain('whitespace-nowrap');
  });

  // OS 툴팁이 남아 있으면 앱 툴팁과 둘 다 떠서 서로를 가린다.
  it('네이티브 title 은 남기지 않는다', () => {
    render(<SessionPanelProcesses sessionId="s1" />);
    const row = screen.getByText('idea64.exe').closest('tr');
    expect(row?.getAttribute('title')).toBeNull();
  });

  // 메모리를 못 읽는 프로세스가 있다(다른 사용자의 것). 그때 " · " 만 남으면 안 된다.
  it('메모리를 못 읽으면 사용자만 적는다', () => {
    processes.current = [{ ...WINDOWS_PROCESS, rssKb: null }];
    render(<SessionPanelProcesses sessionId="s1" />);
    fireEvent.mouseEnter(screen.getByText('idea64.exe').parentElement!.parentElement!);
    expect(screen.getByRole('tooltip').textContent).not.toContain('·');
  });
});
