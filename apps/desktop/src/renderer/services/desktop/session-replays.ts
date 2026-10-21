import { desktopApi } from '../desktopApi';

/** teamId 를 주면 그 팀의 녹화(서버)다. 없으면 이 기기의 녹화다. */
export function loadSessionReplay(recordingId: string, teamId?: string | null) {
  return desktopApi.sessionReplays.load(recordingId, teamId);
}

export function readSessionReplaySegment(recordingId: string, segmentIndex: number, teamId?: string | null) {
  return desktopApi.sessionReplays.readSegment(recordingId, segmentIndex, teamId);
}

/** 팀 녹화의 스냅샷 하나 — 멀리 건너뛸 때 받는다. */
export function readSessionReplaySnapshot(recordingId: string, segmentIndex: number, teamId: string) {
  return desktopApi.sessionReplays.readSnapshot(recordingId, segmentIndex, teamId);
}

export function openSessionReplay(recordingId: string, teamId?: string | null) {
  return desktopApi.sessionReplays.open(recordingId, teamId);
}
