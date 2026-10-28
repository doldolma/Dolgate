import {
  normalizeServerUrl,
  SYNC_WATCH_CLIENT_TIMEOUT_MS,
  toTeamSummary,
  type RawTeamSummary,
  type SyncRecord,
  type TeamSummary,
  type TeamSyncPayload,
  type TeamWatchResult,
  VAULT_EPOCH_HEADER,
} from '@dolssh/shared-core';
import {
  buildClientIdentificationHeaders,
  fetchWithOptions,
  toApiError,
} from './mobile';

/*
 * 팀 볼트 API(services/sync-api 의 http/teams.go·team_history.go) 가운데 폰이 쓰는 것 — 목록·레코드·내 개인 칸·감시,
 * 그리고 내 개인 칸 올리기와 팀 기록 덧붙이기. 폰은 팀 레코드는 올리지 않는다. 요청 머리와 오류는 개인 동기화(lib/mobile.ts)와 같다 — 실패는
 * ApiError(상태·code)로 던지고, 401·404·426 을 어떻게 다룰지는 부르는 쪽(store/team-sync.ts)이 정한다.
 */

/** 조건부 GET 결과. notModified 면 지난번에 받은 그대로다. */
export type TeamSnapshotResult =
  | { notModified: true; payload: null; etag: null }
  | { notModified: false; payload: TeamSyncPayload; etag: string | null };

function teamUrl(serverUrl: string, path: string): string {
  return new URL(path, normalizeServerUrl(serverUrl)).toString();
}

function teamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}`;
}

async function authorizedHeaders(
  accessToken: string,
  ifNoneMatch?: string | null,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    ...(await buildClientIdentificationHeaders()),
  };
  if (ifNoneMatch) {
    headers['If-None-Match'] = ifNoneMatch;
  }
  return headers;
}

/** 서버는 레코드가 없는 종류를 키째로 뺀다. 배열이 아닌 것은 버리고 나머지 종류는 그대로 둔다. */
function normalizeTeamPayload(raw: unknown): TeamSyncPayload {
  const payload: TeamSyncPayload = {};
  if (raw && typeof raw === 'object') {
    for (const [kind, records] of Object.entries(raw)) {
      if (Array.isArray(records)) {
        payload[kind] = records as SyncRecord[];
      }
    }
  }
  return payload;
}

/** 내 팀 목록 — 이름·역할·내 개인 DEK 로 감싼 팀 키. */
export async function fetchTeams(
  serverUrl: string,
  accessToken: string,
): Promise<TeamSummary[]> {
  const response = await fetchWithOptions(teamUrl(serverUrl, '/teams'), {
    headers: await authorizedHeaders(accessToken),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as { teams?: RawTeamSummary[] } | null;
  return (body?.teams ?? []).map(toTeamSummary);
}

async function fetchTeamSnapshot(
  serverUrl: string,
  accessToken: string,
  path: string,
  ifNoneMatch: string | null,
): Promise<TeamSnapshotResult> {
  const response = await fetchWithOptions(teamUrl(serverUrl, path), {
    headers: await authorizedHeaders(accessToken, ifNoneMatch),
  });
  if (response.status === 304) {
    return { notModified: true, payload: null, etag: null };
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  return {
    notModified: false,
    payload: normalizeTeamPayload(await response.json()),
    etag: response.headers.get('etag'),
  };
}

/** 팀 레코드 — 팀 키로 잠근 것. */
export function fetchTeamRecords(
  serverUrl: string,
  accessToken: string,
  teamId: string,
  ifNoneMatch: string | null,
): Promise<TeamSnapshotResult> {
  return fetchTeamSnapshot(
    serverUrl,
    accessToken,
    `${teamPath(teamId)}/sync`,
    ifNoneMatch,
  );
}

/** 내 개인 칸 — 내 개인 DEK 로 잠근 것이라 나만 연다. */
export function fetchTeamPrivate(
  serverUrl: string,
  accessToken: string,
  teamId: string,
  ifNoneMatch: string | null,
): Promise<TeamSnapshotResult> {
  return fetchTeamSnapshot(
    serverUrl,
    accessToken,
    `${teamPath(teamId)}/me`,
    ifNoneMatch,
  );
}

/**
 * 내 개인 칸에 레코드를 올린다(바뀐 것만). 내 개인 DEK 로 잠근 것이라 개인 동기화처럼 볼트 세대 헤더를 단다 — 다른
 * 기기에서 볼트를 초기화했으면 서버가 거절한다. 서버는 레코드마다 나중 것만 받는다(updated_at).
 */
export async function putTeamPrivate(
  serverUrl: string,
  accessToken: string,
  teamId: string,
  payload: TeamSyncPayload,
  vaultEpoch: number,
): Promise<void> {
  const headers = await authorizedHeaders(accessToken);
  headers['content-type'] = 'application/json';
  headers[VAULT_EPOCH_HEADER] = String(vaultEpoch);
  const response = await fetchWithOptions(
    teamUrl(serverUrl, `${teamPath(teamId)}/me`),
    { method: 'PUT', headers, body: JSON.stringify(payload) },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
}

/** 팀 기록에 올릴 한 줄 — 본문은 팀 키로 잠근 것이다(sealTeamEventBody). */
export interface TeamEventUpload {
  id: string;
  createdAt: string;
  payload: string;
}

/**
 * 팀 기록에 줄을 덧붙인다(한 번에 100줄까지). 서버는 같은 id 를 한 번만 남기므로, 답을 못 받아 다시 보내도 한 줄이다.
 * 역할과 상관없이 멤버면 받는다.
 */
export async function appendTeamEvents(
  serverUrl: string,
  accessToken: string,
  teamId: string,
  events: TeamEventUpload[],
): Promise<void> {
  const headers = await authorizedHeaders(accessToken);
  headers['content-type'] = 'application/json';
  const response = await fetchWithOptions(
    teamUrl(serverUrl, `${teamPath(teamId)}/events`),
    { method: 'POST', headers, body: JSON.stringify({ events }) },
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
}

/**
 * 그 팀의 변경을 기다린다(롱폴링). 바뀌면 리비전 셋(레코드·팀 정보·내 개인 칸)을 준다 — 무엇을 다시 받을지는
 * 부르는 쪽이 지난 리비전과 견주어 정한다. 개인 감시(watchSyncChanges)와 같이 한참 늦으면 끊고, signal 이
 * abort 되면(앱이 뒤로 가는 등) 바로 끊는다.
 */
export async function watchTeamChanges(
  serverUrl: string,
  accessToken: string,
  teamId: string,
  ifNoneMatch: string | null,
  signal: AbortSignal,
): Promise<TeamWatchResult> {
  const headers = await authorizedHeaders(accessToken, ifNoneMatch);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort);
  }
  const timer = setTimeout(abort, SYNC_WATCH_CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(
      teamUrl(serverUrl, `${teamPath(teamId)}/sync/watch`),
      { headers, signal: controller.signal },
    );
    if (response.status === 304) {
      return { changed: false };
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    const body = ((await response.json()) ?? {}) as {
      revision?: unknown;
      infoRevision?: unknown;
      privateRevision?: unknown;
    };
    return {
      changed: true,
      etag: response.headers.get('etag'),
      revisions: {
        revision: Number(body.revision ?? 0),
        infoRevision: Number(body.infoRevision ?? 0),
        privateRevision: Number(body.privateRevision ?? 0),
      },
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
