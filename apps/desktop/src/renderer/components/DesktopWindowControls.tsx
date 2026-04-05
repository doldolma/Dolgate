import type { DesktopWindowState } from '@shared';
import { cn } from '../lib/cn';

export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';
export type WindowControlIcon = 'minimize' | 'maximize' | 'restore' | 'close';

interface WindowControlActions {
  onMinimizeWindow: () => Promise<void>;
  onMaximizeWindow: () => Promise<void>;
  onRestoreWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

export interface WindowControlDescriptor {
  key: 'minimize' | 'toggle-maximize' | 'close';
  ariaLabel: string;
  icon: WindowControlIcon;
  danger?: boolean;
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
      icon: 'minimize',
      onClick: actions.onMinimizeWindow
    },
    {
      key: 'toggle-maximize',
      ariaLabel: windowState.isMaximized ? '복원' : '최대화',
      icon: windowState.isMaximized ? 'restore' : 'maximize',
      onClick: windowState.isMaximized ? actions.onRestoreWindow : actions.onMaximizeWindow
    },
    {
      key: 'close',
      ariaLabel: '닫기',
      icon: 'close',
      danger: true,
      onClick: actions.onCloseWindow
    }
  ];
}

function renderWindowControlIcon(icon: WindowControlIcon) {
  switch (icon) {
    case 'minimize':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      );
    case 'maximize':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="6.5" rx="0.25" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      );
    case 'restore':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path d="M3.2 1.6h5.2v5.2" fill="none" stroke="currentColor" strokeWidth="1.05" />
          <path d="M1.6 3.2h5.2v5.2H1.6z" fill="none" stroke="currentColor" strokeWidth="1.05" />
        </svg>
      );
    case 'close':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path d="M2 2l6 6M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
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
    <div className="ml-[0.22rem] flex items-center gap-[0.16rem] [-webkit-app-region:no-drag]" aria-label="윈도우 창 제어">
      {controls.map((control) => (
        <button
          key={control.key}
          type="button"
          aria-label={control.ariaLabel}
          data-desktop-control={control.key}
          className={cn(
            'inline-grid h-10 w-10 place-items-center rounded-[10px] text-[rgba(255,255,255,0.9)] transition-[background-color,color] duration-150 hover:bg-[rgba(255,255,255,0.1)] active:bg-[rgba(255,255,255,0.16)]',
            control.danger && 'hover:bg-[#d95454] hover:text-white active:bg-[#bb4545]',
          )}
          onClick={control.onClick}
        >
          {renderWindowControlIcon(control.icon)}
        </button>
      ))}
    </div>
  );
}
