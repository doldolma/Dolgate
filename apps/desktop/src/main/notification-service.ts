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
    // [임시 진단] 알림 IPC 도달 + 표시 여부 확인
    console.log('[NOTIFY] received:', payload.title, '/', payload.body);
    if (!Notification.isSupported()) {
      console.log('[NOTIFY] Notification.isSupported() = false');
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
    notification.on('show', () => console.log('[NOTIFY] macOS show event fired'));
    notification.on('failed', (_event, error) =>
      console.log('[NOTIFY] failed:', error),
    );
    notification.show();
    console.log('[NOTIFY] show() called');
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
