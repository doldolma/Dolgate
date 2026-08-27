import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanelTheme } from './SessionPanelTheme';

// 팔레트는 호스트 레코드(terminalThemeId)에 저장한다. 로컬 셸에는 그 레코드가 없어서 이 자리가
// "호스트가 없습니다" 로 비어 있었다 — 이제 설정에 담는다.

const setHostTerminalTheme = vi.fn((_hostId: string, _themeId: string | null) =>
  Promise.resolve(),
);
const updateSettings = vi.fn((_input: Record<string, unknown>) => Promise.resolve());

const storeState: Record<string, unknown> = {};

vi.mock('../../../store/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector(storeState),
}));

vi.mock('./SessionPanelAppearance', () => ({
  // 글꼴·외관은 전역이라 이 테스트의 관심이 아니다.
  SessionPanelAppearance: () => null,
}));

beforeEach(() => {
  setHostTerminalTheme.mockClear();
  updateSettings.mockClear();
  Object.assign(storeState, {
    hosts: [{ id: 'host-1', terminalThemeId: null }],
    settings: { globalTerminalThemeId: 'system', localTerminalThemeId: null },
    setHostTerminalTheme,
    updateSettings,
  });
});

describe('세션 패널 테마', () => {
  it('로컬 셸은 팔레트를 설정에 담는다', () => {
    render(<SessionPanelTheme hostId={null} source="local" />);
    // 빈 상태가 아니라 고를 수 있는 목록이 나온다.
    const rows = screen.getAllByRole('button');
    expect(rows.length).toBeGreaterThan(1);

    // 앱 설정 따르기(첫 줄)가 아닌 팔레트 하나를 고른다.
    fireEvent.click(rows[1]);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0][0]).toHaveProperty('localTerminalThemeId');
    expect(setHostTerminalTheme).not.toHaveBeenCalled();
  });

  it('로컬에서 앱 설정 따르기를 고르면 null 로 되돌린다', () => {
    Object.assign(storeState, {
      settings: { globalTerminalThemeId: 'system', localTerminalThemeId: 'nord' },
    });
    render(<SessionPanelTheme hostId={null} source="local" />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(updateSettings).toHaveBeenCalledWith({ localTerminalThemeId: null });
  });

  it('호스트가 있으면 그 호스트 레코드에 담는다', () => {
    render(<SessionPanelTheme hostId="host-1" source="host" />);
    fireEvent.click(screen.getAllByRole('button')[1]);
    expect(setHostTerminalTheme).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // 호스트가 지워졌거나 탭을 못 찾은 경우다 — 담을 데가 없으니 빈 상태로 둔다. (컨테이너·ECS
  // 셸은 여기 오지 않는다. 붙어 있는 호스트 레코드를 그대로 들고 있어 위 갈래로 간다.)
  it('호스트도 로컬도 아니면 팔레트를 내주지 않는다', () => {
    render(<SessionPanelTheme hostId="gone" source="host" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    render(<SessionPanelTheme hostId={null} source={null} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
