import { useMemo } from 'react';
import {
  getOwnerChatSnapshot,
  onSessionShareChatEvent,
  onSessionShareEvent,
  sendOwnerChatMessage,
} from '../services/desktop/session-shares';
import { closeWindow } from '../services/desktop/auth-window-updater';
import { getDesktopSettings } from '../services/desktop/settings';

export function useSessionShareChatController() {
  return useMemo(
    () => ({
      getDesktopSettings,
      closeWindow,
      getOwnerChatSnapshot,
      onSessionShareChatEvent,
      onSessionShareEvent,
      sendOwnerChatMessage,
    }),
    [],
  );
}
