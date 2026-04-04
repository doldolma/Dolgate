import { sortLogs } from "../utils";
import type { SliceDeps } from "./context";

export function createRuntimeEventServices({ api, set }: SliceDeps) {
  const openedInteractiveBrowserChallenges = new Set<string>();
  let activityLogsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let activityLogsRefreshInFlight = false;
  let activityLogsRefreshQueued = false;

  const flushActivityLogsRefresh = async () => {
    if (activityLogsRefreshInFlight) {
      activityLogsRefreshQueued = true;
      return;
    }

    activityLogsRefreshInFlight = true;
    try {
      const activityLogs = await api.logs.list();
      set({ activityLogs: sortLogs(activityLogs) });
    } finally {
      activityLogsRefreshInFlight = false;
      if (activityLogsRefreshQueued) {
        activityLogsRefreshQueued = false;
        scheduleActivityLogsRefresh(120);
      }
    }
  };

  const scheduleActivityLogsRefresh = (delayMs = 120) => {
    if (activityLogsRefreshTimer) {
      clearTimeout(activityLogsRefreshTimer);
    }
    activityLogsRefreshTimer = setTimeout(() => {
      activityLogsRefreshTimer = null;
      void flushActivityLogsRefresh();
    }, delayMs);
  };

  return {
    openedInteractiveBrowserChallenges,
    scheduleActivityLogsRefresh,
  };
}
