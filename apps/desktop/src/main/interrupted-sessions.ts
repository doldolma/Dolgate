import type {
  ActivityLogRecord,
  ContainerLifecycleLogMetadata,
  PortForwardLifecycleLogMetadata,
  SessionLifecycleLogMetadata,
  SftpLifecycleLogMetadata,
} from "@shared";
import type { ActivityLogRepository } from "./database";
import { t } from "./i18n";
import type { SessionReplayService } from "./session-replay-service";

/** 수명 줄마다 끝나지 않은 상태. 앱이 꺼지면 줄이 이대로 남는다. */
const OPEN_STATUSES: Readonly<Record<string, ReadonlySet<string>>> = {
  "session-lifecycle": new Set(["connected"]),
  "port-forward-lifecycle": new Set(["running"]),
  "sftp-lifecycle": new Set(["connecting", "connected"]),
  "container-lifecycle": new Set(["connecting", "connected"]),
};

type Metadata = Record<string, unknown>;

/**
 * 앱이 꺼져(강제 종료·멈춤·전원) 끝을 적지 못한 연결 줄(접속·포워딩·SFTP·컨테이너)을 닫는다. 계정의 기록이 열릴 때
 * 부른다 — 그 계정의 팀 기록도 연 뒤에. 보통 쓰기 길로 쓰므로 팀 호스트의 줄이면 팀 기록에도 끝이 간다.
 *
 * - 이 실행보다 먼저 시작한 줄만 닫는다. 계정 없이 쓰다 로그인하면 지금 살아 있는 세션 줄도 계정 쪽으로 옮겨 온다.
 * - 끝 시각은 녹화가 있으면 녹화의 끝이다(녹화의 메타도 이때 채운다). 없으면 비워 둔다 — 모르는 시각을 지어내지 않는다.
 *
 * 닫은 줄 수와 끝을 찾은 녹화 수를 돌려준다. 줄은 한 번에 쓴다 — 오래 쌓인 줄이 많아도 기록 파일을 한 번만 쓴다.
 */
export function closeInterruptedSessions(options: {
  logs: Pick<ActivityLogRepository, "list" | "upsertMany">;
  recordings: Pick<SessionReplayService, "recoverInterruptedRecording">;
  /** 이 실행이 시작한 시각(ms). */
  startedBeforeMs: number;
}): { closed: number; recoveredRecordings: number } {
  const reason = t("core.interruptedByAppExit");
  const updates: ActivityLogRecord[] = [];
  let recoveredRecordings = 0;
  for (const record of options.logs.list()) {
    const open = record.kind ? OPEN_STATUSES[record.kind] : undefined;
    const metadata = record.metadata;
    if (!open || !metadata || typeof metadata.status !== "string" || !open.has(metadata.status)) {
      continue;
    }
    const startedAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(startedAtMs) || startedAtMs >= options.startedBeforeMs) {
      continue;
    }
    let next: Metadata;
    let endedAt: string | null = null;
    if (record.kind === "session-lifecycle") {
      const session = metadata as unknown as SessionLifecycleLogMetadata;
      const recording =
        typeof session.recordingId === "string" && session.recordingId
          ? options.recordings.recoverInterruptedRecording({
              recordingId: session.recordingId,
              sessionId: session.sessionId,
              hostId: session.hostId,
              hostLabel: session.hostLabel,
              title: session.title,
              connectionDetails: session.connectionDetails ?? null,
              connectionKind: session.connectionKind,
              connectedAt: session.connectedAt,
            })
          : null;
      if (recording) {
        recoveredRecordings += 1;
        endedAt = recording.disconnectedAt;
      }
      next = {
        ...metadata,
        status: "closed",
        disconnectedAt: endedAt,
        durationMs: recording ? durationFrom(session.connectedAt, endedAt) : null,
        disconnectReason: reason,
        ...(recording ? { hasReplay: true } : {}),
      } satisfies Partial<SessionLifecycleLogMetadata>;
    } else if (record.kind === "port-forward-lifecycle") {
      next = {
        ...metadata,
        status: "closed",
        stoppedAt: null,
        durationMs: null,
        endReason: reason,
      } satisfies Partial<PortForwardLifecycleLogMetadata>;
    } else {
      next = {
        ...metadata,
        status: "closed",
        endedAt: null,
        durationMs: null,
        endReason: reason,
      } satisfies Partial<SftpLifecycleLogMetadata | ContainerLifecycleLogMetadata>;
    }
    updates.push({ ...record, metadata: next, updatedAt: endedAt ?? new Date().toISOString() });
  }
  if (updates.length > 0) {
    options.logs.upsertMany(updates);
  }
  return { closed: updates.length, recoveredRecordings };
}

function durationFrom(startedAt: string, endedAt: string | null): number | null {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}
