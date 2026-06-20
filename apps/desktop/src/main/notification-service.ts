import { BrowserWindow, Notification } from 'electron';
import type { CommandFinishedNotification } from '@shared';

/**
 * OS 네이티브 알림(명령 완료 등)을 표시하는 서비스. 알림 클릭 시 앱 창을 다시
 * 앞으로 가져온다. 표시 여부/내용 판정은 렌더러에서 끝내고, 여기서는 받은
 * payload를 그대로 표시만 한다.
 */
export class NotificationService {
  private readonly windows = new Set<BrowserWindow>();

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  notifyCommandFinished(payload: CommandFinishedNotification): void {
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: payload.silent
    });
    notification.on('click', () => {
      this.focusPrimaryWindow();
    });
    notification.show();
  }

  private focusPrimaryWindow(): void {
    const window =
      this.windows.values().next().value ?? BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  }
}
