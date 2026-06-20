import { ipcMain } from 'electron';
import type { CommandFinishedNotification } from '@shared';
import { ipcChannels } from '../../common/ipc-channels';
import type { NotificationService } from '../notification-service';

export function registerNotificationsIpcHandlers(
  service: NotificationService
): void {
  ipcMain.handle(
    ipcChannels.notifications.commandFinished,
    async (_event, payload: CommandFinishedNotification) => {
      service.notifyCommandFinished(payload);
    }
  );
}
