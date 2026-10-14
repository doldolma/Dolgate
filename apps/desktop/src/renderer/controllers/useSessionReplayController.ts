import { useMemo } from 'react';
import {
  loadSessionReplay,
  openSessionReplay,
  readSessionReplaySegment,
} from '../services/desktop/session-replays';
import { getDesktopSettings } from '../services/desktop/settings';

export function useSessionReplayController() {
  return useMemo(
    () => ({
      getDesktopSettings,
      loadSessionReplay,
      readSessionReplaySegment,
      openSessionReplay,
    }),
    [],
  );
}
