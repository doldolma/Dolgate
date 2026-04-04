import { desktopApi } from '../desktopApi';

export function getSessionReplay(recordingId: string) {
  return desktopApi.sessionReplays.get(recordingId);
}

export function openSessionReplay(recordingId: string) {
  return desktopApi.sessionReplays.open(recordingId);
}
