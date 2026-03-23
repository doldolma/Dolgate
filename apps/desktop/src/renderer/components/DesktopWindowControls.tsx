import type { DesktopWindowState } from '@shared';

export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';

interface WindowControlActions {
  onMinimizeWindow: () => Promise<void>;
  onMaximizeWindow: () => Promise<void>;
  onRestoreWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

export interface WindowControlDescriptor {
  key: 'minimize' | 'toggle-maximize' | 'close';
  ariaLabel: string;
  buttonClassName: string;
  iconClassName: string;
  onClick: () => Promise<void>;
}

interface DesktopWindowControlsProps extends WindowControlActions {
  desktopPlatform: DesktopPlatform;
  windowState: DesktopWindowState;
}

export function getWindowControlDescriptors(
  desktopPlatform: DesktopPlatform,
  windowState: DesktopWindowState,
  actions: WindowControlActions
): WindowControlDescriptor[] {
  if (desktopPlatform !== 'win32') {
    return [];
  }

  return [
    {
      key: 'minimize',
      ariaLabel: '최소화',
      buttonClassName: 'window-control',
      iconClassName: 'window-control__icon window-control__icon--minimize',
      onClick: actions.onMinimizeWindow
    },
    {
      key: 'toggle-maximize',
      ariaLabel: windowState.isMaximized ? '복원' : '최대화',
      buttonClassName: 'window-control',
      iconClassName: `window-control__icon ${
        windowState.isMaximized ? 'window-control__icon--restore' : 'window-control__icon--maximize'
      }`,
      onClick: windowState.isMaximized ? actions.onRestoreWindow : actions.onMaximizeWindow
    },
    {
      key: 'close',
      ariaLabel: '닫기',
      buttonClassName: 'window-control window-control--close',
      iconClassName: 'window-control__icon window-control__icon--close',
      onClick: actions.onCloseWindow
    }
  ];
}

export function DesktopWindowControls({
  desktopPlatform,
  windowState,
  onMinimizeWindow,
  onMaximizeWindow,
  onRestoreWindow,
  onCloseWindow
}: DesktopWindowControlsProps) {
  const controls = getWindowControlDescriptors(desktopPlatform, windowState, {
    onMinimizeWindow,
    onMaximizeWindow,
    onRestoreWindow,
    onCloseWindow
  });

  if (controls.length === 0) {
    return null;
  }

  return (
    <div className="desktop-window-controls" aria-label="윈도우 창 제어">
      {controls.map((control) => (
        <button key={control.key} type="button" className={control.buttonClassName} aria-label={control.ariaLabel} onClick={control.onClick}>
          <span className={control.iconClassName} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
