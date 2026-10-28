import {
  TEAM_HISTORY_FORMAT_VERSION,
  type ActivityLogRecord,
  type HostRecord,
  type MobileRemoteDesktopSessionRecord,
  type MobileSessionRecord,
  type MobileSftpSessionRecord,
  type MobileSftpTransferRecord,
  type SessionConnectionKind,
  type SessionLifecycleLogMetadata,
  type SftpLifecycleLogMetadata,
  type TeamActivityBody,
} from '@dolssh/shared-core';
import { t } from '../i18n';
import { createRandomUuid } from '../lib/mobile';
import type { TeamEventDraft, TeamEventsOutcome } from './team-sync';
import {
  findHost,
  teamIdOfHost,
  type VaultCatalogSource,
} from './vault-catalog';

/*
 * 팀 기록 — 폰에서 팀 호스트에 붙은 접속(터미널·SFTP·원격 데스크톱·AWS SSM)의 시작과 끝을 팀 기록에 남긴다(작업 8-5).
 * 데스크톱 main/team-history-service.ts 의 폰 쪽이다. 폰은 녹화하지 않으므로 줄에 녹화가 없고, 본문에 client: "mobile"
 * 을 단다.
 *
 * - 스토어의 세션 목록을 지켜본다. 팀 호스트 세션이 붙으면 시작 줄, 닫히거나 끊기면 끝 줄을 만든다. 붙지 못한 시도는
 *   남기지 않는다. 다시 붙으면(앱 전환 뒤 자동 재연결 포함) 새 줄이다 — 실제로 연결이 둘이다.
 * - 줄 모양은 데스크톱 수명 줄(session-lifecycle·sftp-lifecycle)과 같고 데스크톱의 번역 키를 싣는다 — 데스크톱이 자기
 *   언어로 그린다. 같은 연결의 시작과 끝은 record.id 가 같아 데스크톱 기록 화면이 한 줄로 합친다.
 * - 대기열은 앱 저장소에 둔다 — 오프라인이거나 앱을 꺼도 남았다가 올라간다. 평문 본문을 두고 보낼 때 팀 키로 잠근다
 *   (데스크톱도 평문 파일이다). 보내기는 팀 동기화가 그 팀 받기와 줄을 세워 한다(sendTeamEvents).
 * - 시작만 보낸 줄은 '열린 줄'로 따로 남긴다. 앱이 꺼져 끝을 못 적었으면 다음에 켤 때 '앱이 꺼져 끊겼습니다'로 닫는다.
 */

/** 한 번에 올리는 줄 수(서버 상한과 같다). */
const EVENT_BATCH_SIZE = 100;
/**
 * 대기열 상한(모든 팀 합쳐). 넘으면 오래된 것부터 버린다. 한 줄이 1KB 안팎이라 앱 저장소의 한 값이 1MB 를 넘지 않게
 * 둔다 — 안드로이드는 2MB 넘는 값을 읽지 못할 수 있다.
 */
const MAX_QUEUED_EVENTS = 1_000;
/** 본문(잠그기 전 JSON)의 상한. 서버는 잠근 것을 16KB 까지 받는다(데스크톱과 같다). */
const MAX_BODY_BYTES = 11 * 1024;
/** 쓴 직후 모아 보내기까지 기다리는 시간. */
const FLUSH_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
/** SFTP 줄이 기억하는 들른 경로 수 — 들른 곳 수(visitedPathCount)는 여기까지 센다. */
const MAX_VISITED_PATHS = 500;
const OUTBOX_KEY = 'dolgate-mobile-team-history';
const OPEN_LINES_KEY = 'dolgate-mobile-team-history-open';
const FILE_VERSION = 1;

/** 지켜보는 스토어 칸. */
export interface TeamHistorySource extends Pick<
  VaultCatalogSource,
  'hosts' | 'teamVaults' | 'teamSecrets'
> {
  sessions: MobileSessionRecord[];
  sftpSessions: MobileSftpSessionRecord[];
  remoteDesktopSessions: MobileRemoteDesktopSessionRecord[];
  sftpTransfers: MobileSftpTransferRecord[];
}

/** SFTP 줄에 더하는 숫자(데스크톱 SftpLifecycleLogMetadata 의 칸). */
export type SftpCounts = Partial<
  Record<
    | 'uploadedCount'
    | 'downloadedCount'
    | 'remoteCopyCount'
    | 'uploadedBytes'
    | 'downloadedBytes'
    | 'remoteCopyBytes'
    | 'mkdirCount'
    | 'renameCount'
    | 'chmodCount'
    | 'deleteCount'
    | 'errorCount',
    number
  >
>;

/** 앱 저장소(AsyncStorage 의 쓰는 몫). */
export interface TeamHistoryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface TeamHistoryDeps {
  /** 스토어를 지켜본다. 돌려준 함수로 그만 본다. */
  subscribe(
    listener: (state: TeamHistorySource, previous: TeamHistorySource) => void,
  ): () => void;
  /** 그 팀에 줄을 올린다(팀 동기화의 sendTeamEvents). */
  send(teamId: string, events: TeamEventDraft[]): Promise<TeamEventsOutcome>;
  storage: TeamHistoryStorage;
  /** 시험용. */
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
  createId?: () => string;
}

export interface TeamHistory {
  /**
   * 지켜보기 시작한다(앱을 켤 때 한 번). 앞선 실행이 남긴 대기열을 읽고, 끝을 못 적은 줄은 '앱이 꺼져 끊겼습니다'로
   * 닫는다.
   */
  start(): void;
  /** 팀 목록을 다시 읽었다(팀이 열렸을 수 있다) — 기다리던 것을 보내 본다. */
  kick(): void;
  /** 팀 호스트 SFTP 줄의 숫자를 더한다(폴더 만들기·이름 바꾸기·권한·지우기·실패). 그 SFTP 의 줄이 없으면 그냥 둔다. */
  countSftp(sftpSessionId: string, counts: SftpCounts): void;
  /** 그 팀을 이 기기에서 지웠다 — 그 팀의 열린 줄과 대기열을 버린다(그 팀에는 더 올릴 수 없다). */
  forgetTeam(teamId: string): void;
  /** 로그아웃 직전 — 열린 줄을 모두 닫고 timeoutMs 안에 올려 본다. 못 올린 것은 뒤이은 purge 가 버린다. */
  finishBeforeLogout(timeoutMs: number): Promise<void>;
  /** 다 버린다(로그아웃·계정이나 서버가 바뀜·볼트 초기화). 지켜보기는 그대로다 — 다음 계정의 접속을 남긴다. */
  purge(): Promise<void>;
  /** 시험용 — 지켜보기·타이머·담아 둔 것을 내려놓는다(저장한 것은 그대로). */
  resetRuntime(): void;
}

type WatchedSource = 'terminal' | 'remoteDesktop' | 'sftp';

/** 지켜보는 세션 레코드(터미널·원격 데스크톱·SFTP 가 같이 가진 칸). */
interface WatchedRecord {
  id: string;
  hostId: string;
  title: string;
  status: string;
  lastConnectedAt?: string | null;
  errorMessage?: string | null;
}

/** 시작만 보낸 줄. 끝을 보낼 때까지 남는다(앱 저장소에도). */
interface OpenLine {
  teamId: string;
  source: WatchedSource;
  /** 지켜보는 세션 레코드의 id. */
  sourceId: string;
  /** 시작 줄. SFTP 는 숫자가 여기에 쌓인다. */
  record: ActivityLogRecord;
  /** SFTP 가 들른 경로 — 들른 곳 수를 셀 때 겹친 것을 뺀다. */
  visitedPaths?: string[];
}

interface OutboxEntry {
  eventId: string;
  createdAt: string;
  /** 대기열에 넣은 때(ms) — 상한을 넘으면 이것이 이른 줄부터 버린다. 팀마다 넣은 차례대로 놓인다. */
  queuedAt: number;
  body: TeamActivityBody;
}

function lineKey(source: WatchedSource, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** 데스크톱 기록이 쓰는 연결 종류 이름(core-manager getConnectionKindLabel). */
function connectionKindLabel(kind: SessionConnectionKind): string {
  switch (kind) {
    case 'aws-ssm':
      return 'AWS SSM';
    case 'rdp':
      return 'RDP';
    case 'vnc':
      return 'VNC';
    case 'mosh':
      return 'Mosh';
    default:
      return 'SSH';
  }
}

/** 원격 데스크톱 줄의 '어디에 붙었나' — 데스크톱과 같은 모양(주소 · 포트). */
function remoteDesktopDetails(host: HostRecord | undefined): string | null {
  if (!host || !('hostname' in host) || !host.hostname) {
    return null;
  }
  return 'port' in host && host.port
    ? `${host.hostname} · ${host.port}`
    : host.hostname;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 본문이 너무 크면 메타데이터의 큰 값을 줄인다(긴 오류 문구 등) — 데스크톱 boundedBody 와 같다. */
function boundedBody(body: TeamActivityBody): TeamActivityBody {
  if (byteLength(JSON.stringify(body)) <= MAX_BODY_BYTES) {
    return body;
  }
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body.record.metadata ?? {})) {
    if (typeof value === 'string') {
      metadata[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      metadata[key] = value;
    }
  }
  const message =
    body.record.message.length > 500
      ? `${body.record.message.slice(0, 500)}…`
      : body.record.message;
  return {
    ...body,
    record: { ...body.record, message, metadata, messageParams: null },
  };
}

function durationBetween(
  startedAt: string,
  endedAt: string | null,
): number | null {
  if (!endedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : null;
}

function transferCounts(transfer: MobileSftpTransferRecord): SftpCounts {
  const bytes = Math.max(0, transfer.bytesTransferred || 0);
  switch (transfer.direction) {
    case 'download':
      return { downloadedCount: 1, downloadedBytes: bytes };
    case 'upload':
      return { uploadedCount: 1, uploadedBytes: bytes };
    default:
      return { remoteCopyCount: 1, remoteCopyBytes: bytes };
  }
}

function parseOutbox(raw: string | null): Record<string, OutboxEntry[]> {
  try {
    const parsed = raw
      ? (JSON.parse(raw) as { version?: unknown; teams?: unknown })
      : null;
    if (
      parsed?.version !== FILE_VERSION ||
      !parsed.teams ||
      typeof parsed.teams !== 'object'
    ) {
      return {};
    }
    const teams: Record<string, OutboxEntry[]> = {};
    for (const [teamId, entries] of Object.entries(parsed.teams)) {
      if (Array.isArray(entries) && entries.length > 0) {
        teams[teamId] = entries as OutboxEntry[];
      }
    }
    return teams;
  } catch {
    return {};
  }
}

function parseOpenLines(raw: string | null): OpenLine[] {
  try {
    const parsed = raw
      ? (JSON.parse(raw) as { version?: unknown; lines?: unknown })
      : null;
    return parsed?.version === FILE_VERSION && Array.isArray(parsed.lines)
      ? (parsed.lines as OpenLine[])
      : [];
  } catch {
    return [];
  }
}

function defaultTimer(
  callback: () => void,
  delayMs: number,
): { cancel(): void } {
  const handle = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(handle) };
}

export function createTeamHistory(deps: TeamHistoryDeps): TeamHistory {
  const setTimer = deps.setTimer ?? defaultTimer;
  const createId = deps.createId ?? createRandomUuid;
  let unsubscribe: (() => void) | null = null;
  /** 앞선 실행이 남긴 것을 읽는 중 — 보내기는 이것을 기다린다. */
  let loading: Promise<void> = Promise.resolve();
  /** 다 버릴 때마다 오른다 — 늦게 끝난 읽기·보내기가 그 뒤의 것을 건드리지 않게. */
  let epoch = 0;
  let outbox: Record<string, OutboxEntry[]> = {};
  const openLines = new Map<string, OpenLine>();
  let timer: { cancel(): void } | null = null;
  let timerDueAt = 0;
  let flushing: Promise<void> | null = null;
  let flushAgain = false;
  let retryDelayMs = FLUSH_DELAY_MS;
  // 저장은 줄을 세운다 — 늦게 끝난 옛 쓰기가 새 것을 덮지 않게.
  let writes: Promise<void> = Promise.resolve();

  const nowIso = () => new Date().toISOString();

  const hasPending = () =>
    Object.values(outbox).some(entries => entries.length > 0);

  const save = (key: string, value: string | null) => {
    writes = writes
      .then(() =>
        value === null
          ? deps.storage.removeItem(key)
          : deps.storage.setItem(key, value),
      )
      .catch(error => {
        // 저장이 막혀도 접속은 이어간다. 메모리의 대기열은 그대로 보낸다.
        console.warn(
          '[team-history] could not save the team activity queue',
          error,
        );
      });
  };

  const saveOutbox = () =>
    save(
      OUTBOX_KEY,
      hasPending()
        ? JSON.stringify({ version: FILE_VERSION, teams: outbox })
        : null,
    );

  const saveOpenLines = () =>
    save(
      OPEN_LINES_KEY,
      openLines.size > 0
        ? JSON.stringify({
            version: FILE_VERSION,
            lines: [...openLines.values()],
          })
        : null,
    );

  /**
   * 모든 팀 합쳐 상한을 넘으면 먼저 넣은 줄부터 버린다. 팀마다 넣은 차례대로 놓여 있으니 팀들의 맨 앞만 견준다(줄의
   * 시각은 차례가 아니다 — 끝 줄은 끝난 때다).
   */
  const trimOutbox = () => {
    let total = Object.values(outbox).reduce(
      (sum, entries) => sum + entries.length,
      0,
    );
    while (total > MAX_QUEUED_EVENTS) {
      let oldest: string | null = null;
      for (const [teamId, entries] of Object.entries(outbox)) {
        if (
          entries.length > 0 &&
          (oldest === null ||
            (entries[0].queuedAt ?? 0) < (outbox[oldest][0].queuedAt ?? 0))
        ) {
          oldest = teamId;
        }
      }
      if (oldest === null) {
        return;
      }
      outbox[oldest].shift();
      if (outbox[oldest].length === 0) {
        delete outbox[oldest];
      }
      total -= 1;
    }
  };

  const scheduleFlush = (delayMs: number) => {
    const dueAt = Date.now() + delayMs;
    if (timer && timerDueAt <= dueAt) {
      return;
    }
    timer?.cancel();
    timerDueAt = dueAt;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  /** 줄 하나를 대기열에 넣는다. 저장은 부르는 쪽이 모아서 한다(saveOutbox). */
  const queue = (
    teamId: string,
    phase: 'start' | 'end',
    record: ActivityLogRecord,
  ) => {
    (outbox[teamId] ??= []).push({
      eventId: createId(),
      createdAt: record.updatedAt ?? record.createdAt,
      queuedAt: Date.now(),
      body: boundedBody({
        v: TEAM_HISTORY_FORMAT_VERSION,
        phase,
        client: 'mobile',
        record,
      }),
    });
  };

  const queued = () => {
    trimOutbox();
    saveOutbox();
    scheduleFlush(FLUSH_DELAY_MS);
  };

  /** 줄을 닫는 끝 줄. 끝 시각을 모르면(앱이 꺼져 끊김) 비운다 — 모르는 시각을 지어내지 않는다(데스크톱과 같다). */
  const endRecord = (
    line: OpenLine,
    status: 'closed' | 'error',
    reason: string | null,
    endedAt: string | null,
  ): ActivityLogRecord => {
    const metadata = line.record.metadata ?? {};
    const durationMs = durationBetween(line.record.createdAt, endedAt);
    const updatedAt = endedAt ?? nowIso();
    if (line.record.kind === 'sftp-lifecycle') {
      return {
        ...line.record,
        level:
          status === 'error' || Number(metadata.errorCount) > 0
            ? 'error'
            : 'info',
        metadata: {
          ...metadata,
          status,
          endedAt,
          durationMs,
          endReason: reason,
        } satisfies Partial<SftpLifecycleLogMetadata>,
        updatedAt,
      };
    }
    return {
      ...line.record,
      level: status === 'error' ? 'error' : 'info',
      metadata: {
        ...metadata,
        status,
        disconnectedAt: endedAt,
        durationMs,
        disconnectReason: reason,
      } satisfies Partial<SessionLifecycleLogMetadata>,
      updatedAt,
    };
  };

  const endLine = (
    line: OpenLine,
    status: 'closed' | 'error',
    reason: string | null,
    endedAt: string | null,
  ) => {
    openLines.delete(lineKey(line.source, line.sourceId));
    queue(line.teamId, 'end', endRecord(line, status, reason, endedAt));
  };

  const startLine = (
    state: TeamHistorySource,
    teamId: string,
    source: WatchedSource,
    record: WatchedRecord,
  ) => {
    const host = findHost(state, record.hostId);
    const connectedAt = record.lastConnectedAt ?? nowIso();
    const hostLabel = host?.label ?? record.title;
    let line: OpenLine;
    if (source === 'sftp') {
      const path = (record as MobileSftpSessionRecord).currentPath || null;
      const visitedPaths = path ? [path] : [];
      const metadata: SftpLifecycleLogMetadata = {
        endpointId: record.id,
        hostId: record.hostId,
        hostLabel,
        title: record.title,
        startedAt: connectedAt,
        connectedAt,
        endedAt: null,
        durationMs: null,
        status: 'connected',
        endReason: null,
        uploadedCount: 0,
        downloadedCount: 0,
        remoteCopyCount: 0,
        uploadedBytes: 0,
        downloadedBytes: 0,
        remoteCopyBytes: 0,
        mkdirCount: 0,
        renameCount: 0,
        chmodCount: 0,
        chownCount: 0,
        deleteCount: 0,
        errorCount: 0,
        visitedPathCount: visitedPaths.length,
        lastPath: path,
      };
      line = {
        teamId,
        source,
        sourceId: record.id,
        visitedPaths,
        record: {
          id: `sftp:${createId()}`,
          level: 'info',
          category: 'session',
          kind: 'sftp-lifecycle',
          message: t('teamHistory.sftpSession'),
          messageKey: 'core.sftpSession',
          messageParams: null,
          metadata: metadata as unknown as Record<string, unknown>,
          createdAt: connectedAt,
          updatedAt: connectedAt,
        },
      };
    } else {
      const connectionKind: SessionConnectionKind =
        source === 'remoteDesktop'
          ? (record as MobileRemoteDesktopSessionRecord).protocol
          : ((record as MobileSessionRecord).connectionKind ?? 'ssh');
      const kind = connectionKindLabel(connectionKind);
      const metadata: SessionLifecycleLogMetadata = {
        sessionId: record.id,
        hostId: record.hostId,
        hostLabel,
        title: record.title,
        connectionDetails:
          source === 'remoteDesktop'
            ? remoteDesktopDetails(host)
            : ((record as MobileSessionRecord).connectionDetails ?? null),
        connectionKind,
        connectedAt,
        disconnectedAt: null,
        durationMs: null,
        status: 'connected',
        disconnectReason: null,
        recordingId: null,
        hasReplay: false,
      };
      line = {
        teamId,
        source,
        sourceId: record.id,
        record: {
          id: `session:${createId()}`,
          level: 'info',
          category: 'session',
          kind: 'session-lifecycle',
          message: t('teamHistory.sessionLog', { kind }),
          messageKey: 'core.sessionLog',
          messageParams: { kind },
          metadata: metadata as unknown as Record<string, unknown>,
          createdAt: connectedAt,
          updatedAt: connectedAt,
        },
      };
    }
    openLines.set(lineKey(source, record.id), line);
    queue(teamId, 'start', line.record);
  };

  const addCounts = (line: OpenLine, counts: SftpCounts) => {
    const metadata: Record<string, unknown> = { ...line.record.metadata };
    for (const [key, value] of Object.entries(counts)) {
      metadata[key] = (Number(metadata[key]) || 0) + (value ?? 0);
    }
    line.record = { ...line.record, metadata };
  };

  /**
   * 한 종류의 세션 목록을 본다. 붙어 있는 동안(끊는 중 포함) 줄이 열려 있고, 그 밖의 상태가 되거나 목록에서 빠지면
   * 닫는다. 붙은 것이 팀 호스트면 새 줄을 연다. 줄을 열거나 닫았으면 lines, 열린 줄의 내용만 바뀌었으면(SFTP 경로) open.
   */
  const watch = (
    state: TeamHistorySource,
    source: WatchedSource,
    records: readonly WatchedRecord[],
  ): { lines: boolean; open: boolean } => {
    const changed = { lines: false, open: false };
    const present = new Set<string>();
    const now = nowIso();
    for (const record of records) {
      present.add(record.id);
      const line = openLines.get(lineKey(source, record.id));
      if (line) {
        if (
          record.status === 'connected' ||
          record.status === 'disconnecting'
        ) {
          if (source === 'sftp') {
            changed.open =
              visit(line, (record as MobileSftpSessionRecord).currentPath) ||
              changed.open;
          }
          continue;
        }
        endLine(
          line,
          record.status === 'error' ? 'error' : 'closed',
          record.status === 'error' ? (record.errorMessage ?? null) : null,
          now,
        );
        changed.lines = true;
        continue;
      }
      if (record.status !== 'connected') {
        continue;
      }
      const teamId = teamIdOfHost(state, record.hostId);
      if (teamId) {
        startLine(state, teamId, source, record);
        changed.lines = true;
      }
    }
    for (const line of [...openLines.values()]) {
      if (line.source === source && !present.has(line.sourceId)) {
        endLine(line, 'closed', null, now);
        changed.lines = true;
      }
    }
    return changed;
  };

  /** SFTP 가 다른 경로를 열었다 — 들른 곳 수와 마지막 경로를 고친다. */
  const visit = (line: OpenLine, path: string): boolean => {
    if (!path || line.record.metadata?.lastPath === path) {
      return false;
    }
    const visitedPaths = line.visitedPaths ?? [];
    if (
      !visitedPaths.includes(path) &&
      visitedPaths.length < MAX_VISITED_PATHS
    ) {
      visitedPaths.push(path);
    }
    line.visitedPaths = visitedPaths;
    line.record = {
      ...line.record,
      metadata: {
        ...line.record.metadata,
        lastPath: path,
        visitedPathCount: visitedPaths.length,
      },
    };
    return true;
  };

  /** 끝난 전송(받기·올리기·복사)을 그 SFTP 줄에 센다. 실패는 실패 수로. */
  const countTransfers = (
    transfers: readonly MobileSftpTransferRecord[],
    previous: readonly MobileSftpTransferRecord[],
  ): boolean => {
    const before = new Map(
      previous.map(transfer => [transfer.id, transfer.status]),
    );
    let changed = false;
    for (const transfer of transfers) {
      if (
        (transfer.status !== 'completed' && transfer.status !== 'error') ||
        before.get(transfer.id) === transfer.status
      ) {
        continue;
      }
      const line = openLines.get(lineKey('sftp', transfer.sftpSessionId));
      if (line) {
        addCounts(
          line,
          transfer.status === 'error'
            ? { errorCount: 1 }
            : transferCounts(transfer),
        );
        changed = true;
      }
    }
    return changed;
  };

  const observe = (state: TeamHistorySource, previous: TeamHistorySource) => {
    let lines = false;
    let open = false;
    const note = (changed: { lines: boolean; open: boolean }) => {
      lines = lines || changed.lines;
      open = open || changed.open || changed.lines;
    };
    // 전송을 먼저 센다 — 같은 때 SFTP 가 닫혀도 그 숫자가 끝 줄에 들어간다.
    if (state.sftpTransfers !== previous.sftpTransfers) {
      open =
        countTransfers(state.sftpTransfers, previous.sftpTransfers) || open;
    }
    if (state.sessions !== previous.sessions) {
      note(watch(state, 'terminal', state.sessions));
    }
    if (state.remoteDesktopSessions !== previous.remoteDesktopSessions) {
      note(watch(state, 'remoteDesktop', state.remoteDesktopSessions));
    }
    if (state.sftpSessions !== previous.sftpSessions) {
      note(watch(state, 'sftp', state.sftpSessions));
    }
    if (lines) {
      queued();
    }
    if (open) {
      saveOpenLines();
    }
  };

  /** 앞선 실행이 남긴 것을 읽는다. 대기열은 앞에 두고, 끝을 못 적은 줄은 앱이 꺼져 끊긴 것으로 닫는다. */
  const load = async (current: number) => {
    const [storedOutbox, storedOpenLines] = await Promise.all([
      deps.storage.getItem(OUTBOX_KEY),
      deps.storage.getItem(OPEN_LINES_KEY),
    ]);
    if (epoch !== current) {
      return;
    }
    for (const [teamId, entries] of Object.entries(parseOutbox(storedOutbox))) {
      const fresh = outbox[teamId] ?? [];
      const known = new Set(fresh.map(entry => entry.eventId));
      outbox[teamId] = [
        ...entries.filter(entry => !known.has(entry.eventId)),
        ...fresh,
      ];
    }
    // 저장해 둔 열린 줄은 앞선 실행이 끝을 못 적은 것이다(강제 종료·멈춤·전원) — 이번 실행의 쓰기는 이 읽기를
    // 기다리므로(start) 여기 섞이지 않는다.
    const reason = t('teamHistory.interruptedByAppExit');
    for (const line of parseOpenLines(storedOpenLines)) {
      if (line.teamId && line.record) {
        queue(line.teamId, 'end', endRecord(line, 'closed', reason, null));
      }
    }
    trimOutbox();
    saveOutbox();
    saveOpenLines();
    if (hasPending()) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
  };

  /** 그 팀의 대기열을 100줄씩 보낸다. 지금 열 수 없으면 남긴다(팀 목록을 다시 읽으면 kick 이 깨운다). */
  const flushTeam = async (teamId: string, current: number) => {
    for (;;) {
      const entries = outbox[teamId];
      if (!entries || entries.length === 0) {
        return;
      }
      const batch = entries.slice(0, EVENT_BATCH_SIZE);
      const outcome = await deps.send(
        teamId,
        batch.map(entry => ({
          id: entry.eventId,
          createdAt: entry.createdAt,
          body: entry.body,
        })),
      );
      if (epoch !== current || outcome === 'not-open') {
        return;
      }
      if (outcome === 'gone' || outcome === 'unsupported') {
        // 팀에서 빠졌거나 팀 기록을 모르는 서버 — 쌓아 두지 않는다.
        dropTeam(teamId);
        return;
      }
      if (outcome === 'rejected') {
        console.warn(
          '[team-history] the server rejected a batch of team activity',
        );
      }
      const sent = new Set(batch.map(entry => entry.eventId));
      const rest = (outbox[teamId] ?? []).filter(
        entry => !sent.has(entry.eventId),
      );
      if (rest.length > 0) {
        outbox[teamId] = rest;
      } else {
        delete outbox[teamId];
      }
      saveOutbox();
    }
  };

  const runFlush = async () => {
    const current = epoch;
    await loading;
    let failed = false;
    for (const teamId of Object.keys(outbox)) {
      if (epoch !== current) {
        return;
      }
      try {
        await flushTeam(teamId, current);
      } catch (error) {
        failed = true;
        console.warn(
          '[team-history] kept team activity for the next upload',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (epoch !== current) {
      return;
    }
    if (failed) {
      retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
      scheduleFlush(retryDelayMs);
    } else {
      retryDelayMs = FLUSH_DELAY_MS;
    }
  };

  /** 대기열을 팀마다 보낸다. 이미 보내는 중이면 끝난 뒤 한 번 더 돈다. */
  function flush(): Promise<void> {
    if (flushing) {
      flushAgain = true;
      return flushing;
    }
    flushing = runFlush().finally(() => {
      flushing = null;
      if (flushAgain) {
        flushAgain = false;
        void flush();
      }
    });
    return flushing;
  }

  function dropTeam(teamId: string) {
    if (outbox[teamId]) {
      delete outbox[teamId];
      saveOutbox();
    }
  }

  /** 하이드레이트 뒤에 부른다 — 저장해 둔 세션은 그때 이미 '끊김'으로 내려와 있어 시작 줄을 만들지 않는다. */
  function start(): void {
    if (unsubscribe) {
      return;
    }
    unsubscribe = deps.subscribe((state, previous) => {
      try {
        observe(state, previous);
      } catch (error) {
        // 기록이 접속을 막지 않는다 — 지켜보기는 스토어 쓰기 안에서 돈다.
        console.warn('[team-history] could not record team activity', error);
      }
    });
    const current = epoch;
    loading = load(current).catch(error => {
      console.warn(
        '[team-history] could not read the team activity queue',
        error,
      );
    });
    // 앞선 실행이 남긴 것을 읽기 전에는 쓰지 않는다 — 먼저 쓰면 그것을 덮어 잃는다. 그 사이의 쓰기는 읽은 뒤에
    // 차례대로 가고, 마지막은 읽어서 합친 것이다.
    writes = loading;
  }

  function kick(): void {
    if (hasPending()) {
      retryDelayMs = FLUSH_DELAY_MS;
      scheduleFlush(0);
    }
  }

  function countSftp(sftpSessionId: string, counts: SftpCounts): void {
    const line = openLines.get(lineKey('sftp', sftpSessionId));
    if (line) {
      addCounts(line, counts);
      saveOpenLines();
    }
  }

  function forgetTeam(teamId: string): void {
    let closed = false;
    for (const [key, line] of openLines) {
      if (line.teamId === teamId) {
        openLines.delete(key);
        closed = true;
      }
    }
    if (closed) {
      saveOpenLines();
    }
    dropTeam(teamId);
  }

  async function finishBeforeLogout(timeoutMs: number): Promise<void> {
    if (openLines.size > 0) {
      const endedAt = nowIso();
      for (const line of [...openLines.values()]) {
        endLine(line, 'closed', null, endedAt);
      }
      trimOutbox();
      saveOutbox();
      saveOpenLines();
    }
    timer?.cancel();
    timer = null;
    if (!hasPending()) {
      return;
    }
    let timeout: { cancel(): void } | undefined;
    await Promise.race([
      flush(),
      new Promise<void>(resolve => {
        timeout = setTimer(resolve, timeoutMs);
      }),
    ]);
    timeout?.cancel();
  }

  async function purge(): Promise<void> {
    epoch += 1;
    timer?.cancel();
    timer = null;
    outbox = {};
    openLines.clear();
    retryDelayMs = FLUSH_DELAY_MS;
    save(OUTBOX_KEY, null);
    save(OPEN_LINES_KEY, null);
    await writes;
  }

  function resetRuntime(): void {
    unsubscribe?.();
    unsubscribe = null;
    epoch += 1;
    timer?.cancel();
    timer = null;
    outbox = {};
    openLines.clear();
    retryDelayMs = FLUSH_DELAY_MS;
    loading = Promise.resolve();
  }

  return {
    start,
    kick,
    countSftp,
    forgetTeam,
    finishBeforeLogout,
    purge,
    resetRuntime,
  };
}
