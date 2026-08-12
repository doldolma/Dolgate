import type { DesktopWindowState } from '@shared';
import { cn } from '../lib/cn';
import { useTranslation } from 'react-i18next';
import { t } from '../i18n';

export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';
export type WindowControlIcon =
  | 'minimize'
  | 'enter-full-screen'
  | 'exit-full-screen'
  | 'close';

interface WindowControlActions {
  onMinimizeWindow: () => Promise<void>;
  onToggleFullScreenWindow: () => Promise<void>;
  onCloseWindow: () => Promise<void>;
}

export interface WindowControlDescriptor {
  key: 'minimize' | 'toggle-full-screen' | 'close';
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
  if (desktopPlatform !== 'win32' && desktopPlatform !== 'linux') {
    return [];
  }

  return [
    {
      key: 'minimize',
      ariaLabel: t('windowControls.minimize'),
      icon: 'minimize',
      onClick: actions.onMinimizeWindow
    },
    // 최대화가 아니라 전체화면을 토글한다.
    //
    // 최대화는 여기서 뺄 수 있다. 윈도우·리눅스는 frame:false 라도 -webkit-app-region:drag 영역을
    // **더블클릭**하면 OS 가 최대화/복원을 해 주므로(코드 없이) 그 경로가 남는다. 반면 전체화면은
    // F11 밖에 없어서, 단축키를 모르는 사용자에게는 화면 전체를 쓰는 방법이 아예 없었다.
    //
    // 판정은 isFullScreen 으로 한다. isMaximized 로 두면 전체화면에서 아이콘이 "전체화면"에 머물러
    // 눌러도 같은 상태를 다시 요청하는 것처럼 보인다.
    {
      key: 'toggle-full-screen',
      ariaLabel: t(
        windowState.isFullScreen
          ? 'windowControls.exitFullScreen'
          : 'windowControls.enterFullScreen'
      ),
      icon: windowState.isFullScreen ? 'exit-full-screen' : 'enter-full-screen',
      onClick: actions.onToggleFullScreenWindow
    },
    {
      key: 'close',
      ariaLabel: t('windowControls.close'),
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
    // 네 귀퉁이로 벌어지는 화살표. 사각형(최대화)과 형태를 다르게 둬야 사용자가 이 버튼이
    // 최대화가 아니라는 것을 아이콘만으로 구분할 수 있다.
    case 'enter-full-screen':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path
            d="M1.2 3.6V1.2h2.4M6.4 1.2h2.4v2.4M8.8 6.4v2.4H6.4M3.6 8.8H1.2V6.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
        </svg>
      );
    // 안쪽으로 모이는 화살표.
    case 'exit-full-screen':
      return (
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path
            d="M3.8 1.4v2.4H1.4M6.2 1.4v2.4h2.4M6.2 8.6V6.2h2.4M3.8 8.6V6.2H1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinecap="round"
          />
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
  onToggleFullScreenWindow,
  onCloseWindow
}: DesktopWindowControlsProps) {
  const { t: translate } = useTranslation();
  const controls = getWindowControlDescriptors(desktopPlatform, windowState, {
    onMinimizeWindow,
    onToggleFullScreenWindow,
    onCloseWindow
  });

  if (controls.length === 0) {
    return null;
  }

  return (
    <div className="ml-[0.25rem] flex items-center gap-[0.25rem] [-webkit-app-region:no-drag]" aria-label={translate('windowControls.aria')}>
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
