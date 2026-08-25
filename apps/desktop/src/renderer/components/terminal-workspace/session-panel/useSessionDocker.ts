// 도커 섹션의 데이터 경로. 보조 채널(queryTerminalCompletion)로 물어보고, 실패하면 물러나며
// 알아서 다시 받는다 — 누를 것을 만들지 않는다.
//
// 두 조각으로 갈라져 있다.
//   ① useDockerRuntime — "이 호스트에서 도커를 부를 수 있나" 를 세션당 한 번 알아본다. 결과가
//      없으면 레일에 아이콘 자체를 띄우지 않는다(없는 기능은 안내문이 아니라 부재로 말한다).
//   ② useDockerLists — 고른 탭의 목록. 컨테이너만 주기적으로 다시 받고 나머지는 탭을 열 때.
//
// 새로고침 버튼은 패널 헤더(섹션 동작 자리)에 있어서 이 훅 밖에 있다 — 그래서 요청·진행 상태를
// 작은 레지스트리로 주고받는다.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { queryTerminalCompletion } from '../../../services/desktop/terminal';
import {
  buildDockerProbeCommand,
  buildImageListCommand,
  buildNetworkListCommand,
  buildVolumeListCommand,
  buildSnapshotCommand,
  buildVolumeSizeCommand,
  parseSnapshot,
  parseDockerProbe,
  parseImageList,
  parseNetworkList,
  parseVolumeList,
  parseVolumeSizes,
  type DockerContainer,
  type DockerDiskSummary,
  type DockerImage,
  type DockerInspectInfo,
  type DockerNetwork,
  type DockerProbe,
  type DockerStat,
  type DockerVolume,
} from '../../../lib/docker';

export type DockerTabId = 'containers' | 'images' | 'volumes' | 'networks';

export type DockerAvailability = 'checking' | 'available' | 'blocked' | 'down' | 'absent';

export interface DockerRuntime {
  availability: DockerAvailability;
  /** 목록·명령에 붙일 호출 방법("docker", "sudo -n docker", "podman"). */
  prefix: string | null;
}

interface ProbeEntry extends DockerRuntime {
  atMs: number;
}

const probeCache = new Map<string, ProbeEntry>();
const probeInflight = new Set<string>();
const probeListeners = new Set<() => void>();
let probeVersion = 0;

/** 프로브를 다시 해 볼 만큼 오래된 결과(ms). 세션이 살아 있는 동안은 보통 다시 묻지 않는다. */
const PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * 안 되는 상태는 더 짧게 다시 본다. 데몬을 켜거나 그룹에 들어간 뒤 사용자가 무엇을 누를 필요가
 * 없어야 한다 — 패널을 열어 두면 알아서 나타난다.
 */
const PROBE_RETRY_TTL_MS = 45 * 1000;

const CHECKING: DockerRuntime = { availability: 'checking', prefix: null };

function probeKey(sessionId: string, hostId: string | null): string {
  // 호스트가 있으면 호스트 단위로 기억한다 — 같은 서버의 새 탭에서 다시 묻지 않게. 로컬
  // 터미널처럼 호스트가 없으면 세션 단위다.
  return hostId ? `host:${hostId}` : `session:${sessionId}`;
}

function publishProbe(key: string, entry: ProbeEntry): void {
  probeCache.set(key, entry);
  probeVersion += 1;
  for (const listener of probeListeners) {
    listener();
  }
}

/**
 * 도커를 부를 수 있는지 알아본다. `sessionId` 가 null 이면(패널이 닫혀 있으면) 아무것도 하지
 * 않는다 — 안 보이는 아이콘을 위해 왕복을 쓰지 않는다.
 */
export function useDockerRuntime(
  sessionId: string | null,
  hostId: string | null,
): DockerRuntime {
  const key = sessionId ? probeKey(sessionId, hostId) : null;

  const subscribe = useCallback((onChange: () => void) => {
    probeListeners.add(onChange);
    return () => {
      probeListeners.delete(onChange);
    };
  }, []);
  const version = useSyncExternalStore(
    subscribe,
    () => probeVersion,
    () => 0,
  );

  useEffect(() => {
    if (!sessionId || !key) {
      return;
    }
    const cached = probeCache.get(key);
    // **한 번 있다고 본 도커는 다시 확인하지 않는다.** 프로브 왕복은 실패할 수 있고(타임아웃,
    // 보조 채널 재시작), 그 실패로 상태를 뒤집으면 레일의 아이콘이 사라졌다 나타난다 —
    // 사용자가 보기에 그냥 고장이다. 안 되는 상태만 짧게 다시 본다(데몬을 켜면 나타나게).
    if (cached?.availability === 'available') {
      return;
    }
    if (cached && Date.now() - cached.atMs < PROBE_RETRY_TTL_MS) {
      return;
    }
    if (probeInflight.has(key)) {
      return;
    }
    probeInflight.add(key);
    let cancelled = false;
    void (async () => {
      let probe: DockerProbe = { prefix: null, installed: false, reason: null };
      let failed = false;
      try {
        const stdout = await queryTerminalCompletion(sessionId, buildDockerProbeCommand());
        probe = parseDockerProbe(stdout);
      } catch {
        // 왕복 자체가 실패했다 = 아무것도 알아내지 못했다. 보조 채널이 없는 세션(AWS SSM·
        // 시리얼)도 여기로 오는데, 그 경우는 어차피 첫 프로브가 캐시에 '없음' 으로 남는다.
        failed = true;
      }
      probeInflight.delete(key);
      if (cancelled) {
        return;
      }
      if (failed && cached) {
        // 알아낸 것이 없으면 아는 값을 지키고 시간만 미룬다 — 화면이 깜빡이지 않게.
        publishProbe(key, { ...cached, atMs: Date.now() });
        return;
      }
      publishProbe(key, {
        availability: probe.prefix
          ? 'available'
          : !probe.installed
            ? 'absent'
            : probe.reason === 'daemon'
              ? 'down'
              : 'blocked',
        prefix: probe.prefix,
        atMs: Date.now(),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, sessionId]);

  return useMemo(() => {
    if (!key) {
      return CHECKING;
    }
    const entry = probeCache.get(key);
    return entry ? { availability: entry.availability, prefix: entry.prefix } : CHECKING;
    // version 이 스냅샷이다.
  }, [key, version]);
}

/* ─── CPU·MEM 이력 ─────────────────────────────────────────────────────── */

export interface DockerSample {
  atMs: number;
  cpuPercent: number;
  memBytes: number;
}

const historyByScope = new Map<string, Map<string, DockerSample[]>>();

function pushHistory(scope: string, stats: Map<string, DockerStat>, atMs: number): void {
  const byContainer = historyByScope.get(scope) ?? new Map<string, DockerSample[]>();
  for (const [id, stat] of stats) {
    const samples = byContainer.get(id) ?? [];
    samples.push({ atMs, cpuPercent: stat.cpuPercent, memBytes: stat.memBytes });
    while (
      samples.length > HISTORY_MAX_SAMPLES ||
      (samples.length > 0 && atMs - samples[0].atMs > HISTORY_WINDOW_MS)
    ) {
      samples.shift();
    }
    byContainer.set(id, samples);
  }
  historyByScope.set(scope, byContainer);
}

const EMPTY_SAMPLES: readonly DockerSample[] = [];

export function getDockerHistory(scope: string, containerId: string): readonly DockerSample[] {
  return historyByScope.get(scope)?.get(containerId) ?? EMPTY_SAMPLES;
}

/* ─── 접어 둔 스택 ─────────────────────────────────────────────────────── */

/**
 * 어떤 스택을 접어 뒀는지. 컴포넌트 안이 아니라 여기 두는 이유: 다른 섹션을 보다 돌아오거나
 * 패널을 닫았다 열면 섹션이 다시 마운트되는데, 그때마다 접어 둔 것이 펴지면 접는 의미가 없다.
 * 앱을 켜 둔 동안만 기억한다(설정에 남기지 않는다 — 화면을 보는 방식이지 설정이 아니다).
 */
const collapsedStacks = new Map<string, Set<string>>();
const collapsedListeners = new Set<() => void>();
let collapsedVersion = 0;

export function toggleStackCollapsed(scope: string, project: string): void {
  const set = collapsedStacks.get(scope) ?? new Set<string>();
  if (set.has(project)) {
    set.delete(project);
  } else {
    set.add(project);
  }
  collapsedStacks.set(scope, set);
  collapsedVersion += 1;
  for (const listener of collapsedListeners) {
    listener();
  }
}

/** 접어 둔 스택 이름들. `scope` 는 호스트(없으면 세션) 단위다. */
export function useCollapsedStacks(scope: string): ReadonlySet<string> {
  const subscribe = useCallback((onChange: () => void) => {
    collapsedListeners.add(onChange);
    return () => {
      collapsedListeners.delete(onChange);
    };
  }, []);
  const version = useSyncExternalStore(
    subscribe,
    () => collapsedVersion,
    () => 0,
  );
  return useMemo(
    () => collapsedStacks.get(scope) ?? EMPTY_COLLAPSED,
    // version 이 스냅샷이다.
    [scope, version],
  );
}

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>();

/* ─── 새로고침 · 진행 상태(헤더 버튼과 주고받는다) ────────────────────── */

const refreshListeners = new Map<string, Set<() => void>>();
const busyBySessionId = new Map<string, boolean>();
const busyListeners = new Set<() => void>();
let busyVersion = 0;

export function requestDockerRefresh(sessionId: string): void {
  for (const listener of refreshListeners.get(sessionId) ?? []) {
    listener();
  }
}

function subscribeDockerRefresh(sessionId: string, listener: () => void): () => void {
  const set = refreshListeners.get(sessionId) ?? new Set();
  set.add(listener);
  refreshListeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      refreshListeners.delete(sessionId);
    }
  };
}

function publishDockerBusy(sessionId: string, busy: boolean): void {
  if ((busyBySessionId.get(sessionId) ?? false) === busy) {
    return;
  }
  busyBySessionId.set(sessionId, busy);
  busyVersion += 1;
  for (const listener of busyListeners) {
    listener();
  }
}

/** 헤더의 새로고침 아이콘이 도는지. */
export function useDockerBusy(sessionId: string | null): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    busyListeners.add(onChange);
    return () => {
      busyListeners.delete(onChange);
    };
  }, []);
  const version = useSyncExternalStore(
    subscribe,
    () => busyVersion,
    () => 0,
  );
  return useMemo(
    () => (sessionId ? (busyBySessionId.get(sessionId) ?? false) : false),
    // version 이 스냅샷이다.
    [sessionId, version],
  );
}

/* ─── 목록 ─────────────────────────────────────────────────────────────── */

/**
 * 컨테이너 왕복의 **최소** 주기. 실제 주기는 걸린 시간에서 정한다 — `stats --no-stream` 은
 * 컨테이너가 많으면 초 단위로 걸리는데, 그걸 5초마다 부르면 채널이 늘 물려 있다. 사용자에게
 * "지표 끄기" 를 물어보는 대신 우리가 물러난다.
 */
const CONTAINER_POLL_MS = 5_000;
const CONTAINER_POLL_MAX_MS = 20_000;
/** 걸린 시간의 이 배수를 주기로 삼는다(왕복이 채널을 절반 이상 물지 않게). */
const POLL_DUTY_FACTOR = 3;
const BACKOFF_MS = [5_000, 15_000, 60_000];

/** 재시작 횟수·헬스·OOM 은 자주 바뀌지 않는다 — 이 횟수마다 한 번씩 얹는다. */
const INSPECT_EVERY_TICKS = 6;

/** 행 스파크라인이 보는 창(ms)과 표본 상한. 이력은 앱에 쌓아 원격 왕복을 늘리지 않는다. */
const HISTORY_WINDOW_MS = 10 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 120;

/** 컨테이너 말고는 스스로 변하지 않는다 — 이만큼 안에 받은 값이면 탭을 다시 열어도 그대로 쓴다. */
const STATIC_TAB_TTL_MS = 15_000;

/** 볼륨 크기(system df -v)는 비싸다 — 이만큼은 다시 재지 않는다. */
const VOLUME_SIZE_TTL_MS = 60_000;

export interface DockerSummary {
  running: number;
  total: number;
  /** 컨테이너들의 CPU 합(코어가 여럿이면 100 을 넘을 수 있다). */
  cpuPercent: number;
  memBytes: number;
  /** 호스트 메모리(stats 가 준 limit). 못 받았으면 0. */
  memLimitBytes: number;
  /** 지표를 못 받는 호스트(옛 도커·podman 방언)면 false. */
  hasStats: boolean;
}

export interface DockerLists {
  containers: DockerContainer[];
  stats: Map<string, DockerStat>;
  inspect: Map<string, DockerInspectInfo>;
  summary: DockerSummary;
  images: DockerImage[];
  imageSummary: DockerDiskSummary[];
  volumes: DockerVolume[];
  volumeSizes: Map<string, string>;
  volumeSizesLoading: boolean;
  networks: DockerNetwork[];
  /** 이 탭을 아직 한 번도 못 받았다. */
  loading: boolean;
  /** 마지막으로 받은 시각. 실패해도 남는다. */
  updatedAtMs: number | null;
  /** 지금 받아오기가 실패해 물러나 있는 상태. 목록은 마지막 값이다. */
  failing: boolean;
  truncated: boolean;
  /** 이력이 갱신될 때마다 올라간다 — 스파크라인이 이 값으로 다시 그린다. */
  historyVersion: number;
}

interface TabState {
  containers: DockerContainer[];
  stats: Map<string, DockerStat>;
  inspect: Map<string, DockerInspectInfo>;
  images: DockerImage[];
  imageSummary: DockerDiskSummary[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  updatedAtMs: number | null;
  failing: boolean;
  truncated: boolean;
}

const EMPTY_STATS = new Map<string, DockerStat>();
const EMPTY_INSPECT = new Map<string, DockerInspectInfo>();

const EMPTY_TAB: TabState = {
  containers: [],
  stats: EMPTY_STATS,
  inspect: EMPTY_INSPECT,
  images: [],
  imageSummary: [],
  volumes: [],
  networks: [],
  updatedAtMs: null,
  failing: false,
  truncated: false,
};

function buildCommand(
  tab: DockerTabId,
  prefix: string,
  options: { stats: boolean; inspect: boolean },
): string {
  switch (tab) {
    case 'images':
      return buildImageListCommand(prefix);
    case 'volumes':
      return buildVolumeListCommand(prefix);
    case 'networks':
      return buildNetworkListCommand(prefix);
    default:
      return buildSnapshotCommand(prefix, options);
  }
}

function applyOutput(tab: DockerTabId, previous: TabState, stdout: string): TabState {
  const next: TabState = { ...previous, updatedAtMs: Date.now(), failing: false };
  if (tab === 'containers') {
    const parsed = parseSnapshot(stdout);
    next.containers = parsed.containers;
    next.truncated = parsed.truncated;
    next.stats = parsed.stats.size > 0 ? parsed.stats : previous.stats;
    // 검사 결과는 매 왕복에 오지 않는다 — 새로 온 것만 덮어쓴다.
    next.inspect = parsed.inspect.size > 0 ? parsed.inspect : previous.inspect;
  } else if (tab === 'images') {
    const parsed = parseImageList(stdout);
    next.images = parsed.images;
    next.imageSummary = parsed.summary;
    next.truncated = parsed.truncated;
  } else if (tab === 'volumes') {
    const parsed = parseVolumeList(stdout);
    next.volumes = parsed.volumes;
    next.truncated = parsed.truncated;
  } else {
    const parsed = parseNetworkList(stdout);
    next.networks = parsed.networks;
    next.truncated = parsed.truncated;
  }
  return next;
}

/**
 * 고른 탭의 목록을 받아 온다.
 *
 * `enabled` 는 "이 섹션이 지금 보이는가" 다 — 패널이 닫혀 있으면(폭 0 으로 살아 있다) 폴링을
 * 멈춘다. 안 보이는 화면 때문에 5초마다 원격에 나가지 않게.
 */
export function useDockerLists(
  sessionId: string,
  prefix: string | null,
  tab: DockerTabId,
  enabled: boolean,
  /** 이력을 담는 단위(호스트, 없으면 세션). */
  scope: string,
): DockerLists & { refresh: () => void } {
  const [state, setState] = useState<Record<DockerTabId, TabState>>({
    containers: EMPTY_TAB,
    images: EMPTY_TAB,
    volumes: EMPTY_TAB,
    networks: EMPTY_TAB,
  });
  const [volumeSizes, setVolumeSizes] = useState<{
    sizes: Map<string, string>;
    atMs: number | null;
    loading: boolean;
  }>({ sizes: new Map(), atMs: null, loading: false });
  // 진행 여부는 ref 로 본다 — 이 값을 effect 의 의존성에 넣으면 "재는 중" 으로 바뀌는 순간
  // effect 가 다시 돌고 그 정리가 방금 띄운 요청을 취소해 버린다(크기가 영원히 안 채워졌다).
  const volumeSizeGuard = useRef<{ atMs: number | null; loading: boolean }>({
    atMs: null,
    loading: false,
  });
  const [nonce, setNonce] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  /**
   * 지표를 못 받는 호스트에서는 두 번째 왕복부터 stats 를 붙이지 않는다 — 매번 붙여 헛돌면
   * 왕복만 느려진다. 옛 도커나 stats 형식을 모르는 방언에서 그렇다.
   */
  const statsSupportedRef = useRef(true);
  const tickRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const refresh = useCallback(() => {
    // 크기도 다시 잰다 — 새로 받기는 "지금 값" 을 뜻한다.
    volumeSizeGuard.current = { atMs: null, loading: false };
    setNonce((current) => current + 1);
  }, []);

  // 헤더의 새로고침 버튼이 이 세션에 요청을 보낸다.
  useEffect(() => subscribeDockerRefresh(sessionId, refresh), [refresh, sessionId]);

  useEffect(() => {
    if (!enabled || !prefix || !sessionId) {
      publishDockerBusy(sessionId, false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, delayMs);
    };

    const poll = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      publishDockerBusy(sessionId, true);
      const wantsStats = tab === 'containers' && statsSupportedRef.current;
      const wantsInspect = tab === 'containers' && tickRef.current % INSPECT_EVERY_TICKS === 0;
      tickRef.current += 1;
      const startedAtMs = Date.now();
      let stdout: string;
      try {
        stdout = await queryTerminalCompletion(
          sessionId,
          buildCommand(tab, prefix, { stats: wantsStats, inspect: wantsInspect }),
        );
      } catch {
        if (cancelled) {
          return;
        }
        publishDockerBusy(sessionId, false);
        failures += 1;
        setState((current) => ({
          ...current,
          [tab]: { ...current[tab], failing: true },
        }));
        schedule(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
        return;
      }
      if (cancelled) {
        return;
      }
      failures = 0;
      publishDockerBusy(sessionId, false);
      const elapsedMs = Date.now() - startedAtMs;
      setState((current) => {
        const next = applyOutput(tab, current[tab], stdout);
        if (tab === 'containers') {
          if (wantsStats && next.stats.size === 0 && next.containers.some(isRunningState)) {
            // 돌고 있는 컨테이너가 있는데 지표가 한 줄도 없다 = 이 호스트에서는 못 쓴다.
            statsSupportedRef.current = false;
          }
          if (next.stats.size > 0) {
            pushHistory(scope, next.stats, Date.now());
            setHistoryVersion((version) => version + 1);
          }
        }
        return { ...current, [tab]: next };
      });
      // 컨테이너만 스스로 변한다 — 나머지는 탭을 열 때와 새로고침에서만 받는다.
      if (tab === 'containers') {
        // 걸린 시간에 맞춰 물러난다(5~20초). stats 가 느린 호스트에서 채널을 계속 물지 않게.
        schedule(
          Math.min(
            CONTAINER_POLL_MAX_MS,
            Math.max(CONTAINER_POLL_MS, elapsedMs * POLL_DUTY_FACTOR),
          ),
        );
      }
    };

    const cached = stateRef.current[tab];
    const fresh =
      tab !== 'containers' &&
      cached.updatedAtMs !== null &&
      Date.now() - cached.updatedAtMs < STATIC_TAB_TTL_MS;
    // 방금 받은 값이 있으면(컨테이너 말고) 탭을 왕복 없이 그대로 보여 준다.
    if (!fresh) {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      publishDockerBusy(sessionId, false);
    };
  }, [enabled, nonce, prefix, sessionId, tab]);

  // 볼륨 탭을 열면 크기를 뒤에서 한 번 잰다. 오래 걸려도 목록은 이미 떠 있다.
  useEffect(() => {
    if (!enabled || !prefix || tab !== 'volumes') {
      return;
    }
    const guard = volumeSizeGuard.current;
    if (guard.loading) {
      return;
    }
    if (guard.atMs !== null && Date.now() - guard.atMs < VOLUME_SIZE_TTL_MS) {
      return;
    }
    let cancelled = false;
    guard.loading = true;
    setVolumeSizes((current) => ({ ...current, loading: true }));
    void (async () => {
      let sizes = new Map<string, string>();
      try {
        const stdout = await queryTerminalCompletion(sessionId, buildVolumeSizeCommand(prefix));
        sizes = parseVolumeSizes(stdout);
      } catch {
        // 못 재면 자리를 비워 둔다 — 다시 시도하게 만들지 않는다.
      }
      volumeSizeGuard.current = { atMs: Date.now(), loading: false };
      if (cancelled) {
        return;
      }
      setVolumeSizes({ sizes, atMs: volumeSizeGuard.current.atMs, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce, prefix, sessionId, tab]);

  const current = state[tab];
  const containerState = state.containers;
  const summary = useMemo<DockerSummary>(() => {
    let cpuPercent = 0;
    let memBytes = 0;
    let memLimitBytes = 0;
    for (const stat of containerState.stats.values()) {
      cpuPercent += stat.cpuPercent;
      memBytes += stat.memBytes;
      memLimitBytes = Math.max(memLimitBytes, stat.memLimitBytes);
    }
    return {
      running: containerState.containers.filter((container) => isRunningState(container)).length,
      total: containerState.containers.length,
      cpuPercent,
      memBytes,
      memLimitBytes,
      hasStats: containerState.stats.size > 0,
    };
  }, [containerState]);
  return {
    containers: containerState.containers,
    stats: containerState.stats,
    inspect: containerState.inspect,
    summary,
    images: state.images.images,
    imageSummary: state.images.imageSummary,
    volumes: state.volumes.volumes,
    volumeSizes: volumeSizes.sizes,
    volumeSizesLoading: volumeSizes.loading,
    networks: state.networks.networks,
    loading: current.updatedAtMs === null && !current.failing,
    updatedAtMs: current.updatedAtMs,
    failing: current.failing,
    truncated: current.truncated,
    historyVersion,
    refresh,
  };
}

function isRunningState(container: DockerContainer): boolean {
  return container.state === 'running' || container.state === 'restarting';
}
