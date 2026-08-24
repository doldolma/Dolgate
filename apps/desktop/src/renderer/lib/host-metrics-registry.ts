// 호스트 지표를 **한 번만 수집해 여러 곳에서 보게** 하는 레지스트리.
//
// 왜 필요한가: 지표 폴링은 pane 안(`useHostMetrics`)에서 자기 타이머로 돈다. 세션 패널이 같은
// 훅을 또 부르면 같은 프로덕션 서버에 폴링이 두 배로 나간다. 그래서 수집은 그대로 pane 이
// 맡고(발행자 하나), 패널은 여기서 읽는다(구독자 여럿).
//
// 반대 방향도 있다 — 패널은 상태바보다 자주, 그리고 프로세스 목록까지 필요하다. 그것을
// "관찰 요청" 으로 남기면 발행자가 주기와 명령을 그에 맞춰 바꾼다. 요청이 없으면 예전과 똑같이
// 10초마다 /proc 몇 줄만 읽는다.
//
// 스토어에 두지 않는 이유는 terminal-command-blocks 와 같다 — 폴링마다 전역 리렌더를 만들 이유가
// 없고, 보는 쪽은 구독으로 충분하다.

import type { HostMetrics, HostProcess, HostSystemInfo } from './host-metrics';

/** 패널이 보고 있을 때의 폴링 주기. 상태바용 10초로는 프로세스 목록이 굼떠 보인다. */
export const HOST_METRICS_BOOST_INTERVAL_MS = 3_000;
/** 한 번에 가져올 프로세스 수. 출력이 커지므로 상위 N개만. */
export const HOST_PROCESS_LIMIT = 40;

export type HostMetricsStatus =
  | 'off'
  | 'unsupported'
  | 'loading'
  | 'ready'
  | 'paused';

export interface HostMetricsSnapshot {
  status: HostMetricsStatus;
  metrics: HostMetrics | null;
  /** 프로세스를 요청하지 않았거나 못 읽었으면 null(빈 배열과 구분한다). */
  processes: HostProcess[] | null;
  /**
   * 세션 동안 바뀌지 않는 값들(호스트명·커널·아키텍처·CPU 종류).
   *
   * 자원 섹션이 열릴 때 한 번 받아 여기 남긴다 — 이후 왕복에는 실어 보내지 않는다.
   */
  system: HostSystemInfo | null;
  updatedAtMs: number | null;
}

const EMPTY: HostMetricsSnapshot = {
  status: 'off',
  metrics: null,
  processes: null,
  system: null,
  updatedAtMs: null,
};

interface Entry {
  snapshot: HostMetricsSnapshot;
  version: number;
  listeners: Set<() => void>;
  /** 관찰 요청 토큰들. 살아 있는 동안 주기를 좁히고, 프로세스를 원하면 그것도 함께 켠다. */
  watchers: Set<{ processes: boolean; system: boolean }>;
  watchVersion: number;
  watchListeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(sessionId: string): Entry {
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = {
      snapshot: EMPTY,
      version: 0,
      listeners: new Set(),
      watchers: new Set(),
      watchVersion: 0,
      watchListeners: new Set(),
    };
    entries.set(sessionId, entry);
  }
  return entry;
}

function notify(listeners: Set<() => void>): void {
  for (const listener of [...listeners]) {
    // 구독자 하나가 던져도 나머지와 폴링 루프를 멈추지 않는다.
    try {
      listener();
    } catch (error) {
      console.error('[host-metrics] listener threw', error);
    }
  }
}

/** 폴링 결과를 발행한다. 발행자는 세션당 하나(pane 의 useHostMetrics)다. */
export function publishHostMetrics(
  sessionId: string,
  snapshot: HostMetricsSnapshot,
): void {
  if (!sessionId) {
    return;
  }
  const entry = entryFor(sessionId);
  entry.snapshot = snapshot;
  entry.version += 1;
  notify(entry.listeners);
}

/** 세션이 끝나면 버린다 — 남겨 두면 다음 세션이 옛 값을 잠깐 보여 준다. */
export function clearHostMetrics(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) {
    return;
  }
  entry.snapshot = EMPTY;
  entry.version += 1;
  notify(entry.listeners);
  if (entry.listeners.size === 0 && entry.watchers.size === 0) {
    entries.delete(sessionId);
  }
}

export function getHostMetricsSnapshot(sessionId: string): HostMetricsSnapshot {
  return entries.get(sessionId)?.snapshot ?? EMPTY;
}

/** 구독자의 스냅샷 값. 발행마다 오른다. */
export function getHostMetricsVersion(sessionId: string): number {
  return entries.get(sessionId)?.version ?? 0;
}

export function subscribeHostMetrics(
  sessionId: string,
  listener: () => void,
): () => void {
  const entry = entryFor(sessionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export interface HostMetricsWatch {
  /** 주기를 좁힐지. 관찰자가 하나라도 있으면 true. */
  boosted: boolean;
  /** 프로세스 목록까지 수집할지. */
  processes: boolean;
  /** 정적 시스템 정보를 이번 왕복에 태울지(아직 캐시가 없을 때만 true). */
  system: boolean;
}

/**
 * "지금 보고 있다" 를 알린다. 반환값을 호출하면 요청이 사라지고 주기가 원래대로 돌아간다.
 *
 * 요청은 겹칠 수 있다(자원 섹션 + 프로세스 섹션). 하나라도 프로세스를 원하면 켠다.
 */
export function watchHostMetrics(
  sessionId: string,
  options: { processes?: boolean; system?: boolean } = {},
): () => void {
  if (!sessionId) {
    return () => undefined;
  }
  const entry = entryFor(sessionId);
  const token = {
    processes: options.processes === true,
    system: options.system === true,
  };
  entry.watchers.add(token);
  entry.watchVersion += 1;
  notify(entry.watchListeners);
  return () => {
    if (!entry.watchers.delete(token)) {
      return;
    }
    entry.watchVersion += 1;
    notify(entry.watchListeners);
  };
}

export function getHostMetricsWatch(sessionId: string): HostMetricsWatch {
  const entry = entries.get(sessionId);
  if (!entry || entry.watchers.size === 0) {
    return { boosted: false, processes: false, system: false };
  }
  let processes = false;
  let system = false;
  for (const watcher of entry.watchers) {
    processes = processes || watcher.processes;
    system = system || watcher.system;
    if (processes && system) {
      break;
    }
  }
  // 이미 받아 둔 값이 있으면 다시 묻지 않는다 — 세션 동안 바뀌지 않는 값이다.
  return { boosted: true, processes, system: system && entry.snapshot.system === null };
}

/** 관찰 요청이 바뀐 횟수. 발행자가 주기·명령을 다시 정하는 신호로 쓴다. */
export function getHostMetricsWatchVersion(sessionId: string): number {
  return entries.get(sessionId)?.watchVersion ?? 0;
}

export function subscribeHostMetricsWatch(
  sessionId: string,
  listener: () => void,
): () => void {
  const entry = entryFor(sessionId);
  entry.watchListeners.add(listener);
  return () => {
    entry.watchListeners.delete(listener);
  };
}
