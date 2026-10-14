import { desktopApi } from '../desktopApi';

export function loadSessionReplay(recordingId: string) {
  return desktopApi.sessionReplays.load(recordingId);
}

export function readSessionReplaySegment(recordingId: string, segmentIndex: number) {
  return desktopApi.sessionReplays.readSegment(recordingId, segmentIndex);
}

export function openSessionReplay(recordingId: string) {
  return desktopApi.sessionReplays.open(recordingId);
}
