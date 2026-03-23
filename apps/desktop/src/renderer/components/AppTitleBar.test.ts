import { describe, expect, it, vi } from 'vitest';
import { getWindowControlDescriptors } from './DesktopWindowControls';

describe('getWindowControlDescriptors', () => {
  it('returns no custom window controls outside Windows', () => {
    const controls = getWindowControlDescriptors(
      'darwin',
      { isMaximized: false },
      {
        onMinimizeWindow: vi.fn().mockResolvedValue(undefined),
        onMaximizeWindow: vi.fn().mockResolvedValue(undefined),
        onRestoreWindow: vi.fn().mockResolvedValue(undefined),
        onCloseWindow: vi.fn().mockResolvedValue(undefined)
      }
    );

    expect(controls).toEqual([]);
  });

  it('switches maximize control descriptor to restore when maximized', () => {
    const controls = getWindowControlDescriptors(
      'win32',
      { isMaximized: true },
      {
        onMinimizeWindow: vi.fn().mockResolvedValue(undefined),
        onMaximizeWindow: vi.fn().mockResolvedValue(undefined),
        onRestoreWindow: vi.fn().mockResolvedValue(undefined),
        onCloseWindow: vi.fn().mockResolvedValue(undefined)
      }
    );

    expect(controls.map((control) => control.ariaLabel)).toEqual(['최소화', '복원', '닫기']);
    expect(controls[1]?.iconClassName).toContain('window-control__icon--restore');
  });

  it('routes descriptors to the expected window action handlers', async () => {
    const onMinimizeWindow = vi.fn().mockResolvedValue(undefined);
    const onMaximizeWindow = vi.fn().mockResolvedValue(undefined);
    const onRestoreWindow = vi.fn().mockResolvedValue(undefined);
    const onCloseWindow = vi.fn().mockResolvedValue(undefined);
    const controls = getWindowControlDescriptors(
      'win32',
      { isMaximized: false },
      {
        onMinimizeWindow,
        onMaximizeWindow,
        onRestoreWindow,
        onCloseWindow
      }
    );

    await controls[0]?.onClick();
    await controls[1]?.onClick();
    await controls[2]?.onClick();

    expect(onMinimizeWindow).toHaveBeenCalledTimes(1);
    expect(onMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(onRestoreWindow).not.toHaveBeenCalled();
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
  });
});
