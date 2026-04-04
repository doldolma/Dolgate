import { useMemo } from 'react';
import { getSessionReplay, openSessionReplay } from '../services/desktop/session-replays';
import { getDesktopSettings } from '../services/desktop/settings';

export function useSessionReplayController() {
  return useMemo(
    () => ({
      getDesktopSettings,
      getSessionReplay,
      openSessionReplay,
    }),
    [],
  );
}
