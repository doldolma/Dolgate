import { describe, expect, it, vi } from 'vitest';
import { getEmptyReleaseMessage } from './AppTitleBar';
import { getWindowControlDescriptors } from './DesktopWindowControls';

describe('getWindowControlDescriptors', () => {
  const actions = () => ({
    onMinimizeWindow: vi.fn().mockResolvedValue(undefined),
    onToggleFullScreenWindow: vi.fn().mockResolvedValue(undefined),
    onCloseWindow: vi.fn().mockResolvedValue(undefined)
  });

  it.each(['darwin', 'unknown'] as const)('returns no custom window controls on %s', (platform) => {
    const controls = getWindowControlDescriptors(
      platform,
      { isMaximized: false, isFullScreen: false },
      actions()
    );

    expect(controls).toEqual([]);
  });

  // 가운데 버튼은 최대화가 아니라 전체화면이다. 최대화는 드래그 영역 더블클릭으로 OS 가 해 주는데,
  // 전체화면은 F11 밖에 없어서 단축키를 모르는 사용자에게는 경로가 아예 없었다.
  it('shows custom window controls on Linux', () => {
    const controls = getWindowControlDescriptors(
      'linux',
      { isMaximized: false, isFullScreen: false },
      actions()
    );

    expect(controls.map((control) => control.ariaLabel)).toEqual([
      '최소화',
      '전체화면 (F11)',
      '닫기'
    ]);
  });

  // 최대화 상태는 이 버튼과 무관하다. isMaximized 로 판정하던 때는 전체화면인데도 아이콘이
  // "전체화면" 에 머물러, 눌러도 같은 상태를 다시 요청하는 것처럼 보였다.
  it('keeps the full-screen control unchanged while merely maximized', () => {
    const controls = getWindowControlDescriptors(
      'win32',
      { isMaximized: true, isFullScreen: false },
      actions()
    );

    expect(controls[1]?.ariaLabel).toBe('전체화면 (F11)');
    expect(controls[1]?.icon).toBe('enter-full-screen');
  });

  it('switches the control to exit when already full screen', () => {
    const controls = getWindowControlDescriptors(
      'win32',
      { isMaximized: true, isFullScreen: true },
      actions()
    );

    expect(controls[1]?.ariaLabel).toBe('전체화면 종료 (F11)');
    expect(controls[1]?.icon).toBe('exit-full-screen');
  });

  it('routes descriptors to the expected window action handlers', async () => {
    const handlers = actions();
    const controls = getWindowControlDescriptors(
      'win32',
      { isMaximized: false, isFullScreen: false },
      handlers
    );

    await controls[0]?.onClick();
    await controls[1]?.onClick();
    await controls[2]?.onClick();

    expect(handlers.onMinimizeWindow).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleFullScreenWindow).toHaveBeenCalledTimes(1);
    expect(handlers.onCloseWindow).toHaveBeenCalledTimes(1);
  });

  // 방향은 메인이 정한다. 렌더러가 isFullScreen 을 보고 방향을 실어 보내면, F11 로 방금 바뀐 뒤의
  // 낡은 값으로 같은 상태를 다시 세팅해 버튼이 안 먹는 것처럼 보인다.
  it('uses one toggle action in both directions', async () => {
    const handlers = actions();
    const entering = getWindowControlDescriptors(
      'win32',
      { isMaximized: false, isFullScreen: false },
      handlers
    );
    const exiting = getWindowControlDescriptors(
      'win32',
      { isMaximized: false, isFullScreen: true },
      handlers
    );

    await entering[1]?.onClick();
    await exiting[1]?.onClick();

    expect(handlers.onToggleFullScreenWindow).toHaveBeenCalledTimes(2);
  });

  it('does not show an empty release placeholder when release metadata is absent', () => {
    expect(
      getEmptyReleaseMessage({
        enabled: true,
        status: 'idle',
        currentVersion: '1.0.0',
        release: null,
        progress: null,
        checkedAt: null,
        dismissedVersion: null,
        errorMessage: null
      })
    ).toBeNull();
  });
});
