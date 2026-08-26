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
  buildContainerListCommand,
  buildContainerMetricsCommand,
  buildDockerProbeCommand,
  buildImageListCommand,
  buildNetworkListCommand,
  buildVolumeListCommand,
  composeCommandFor,
  computeIoRate,
  ioTotalsOf,
  parseContainerList,
  parseContainerMetrics,
  parseDockerProbe,
  parseImageList,
  parseNetworkList,
  parseVolumeList,
  type DockerContainer,
  type DockerImage,
  type DockerInspectInfo,
  type DockerIoRate,
  type DockerIoTotals,
  type DockerNetwork,
  type DockerProbe,
  type DockerStat,
  type DockerVolume,
} from '../../../lib/docker';

export type DockerTabId = 'containers' | 'images' | 'volumes' | 'networks';

export type DockerAvailability = 'checking' | 'available' | 'blocked' | 'down' | 'absent';

export interface DockerRuntime {
  availability: DockerAvailability;
  /**
   * 호출 방법("docker", "sudo -n docker", "podman", "sudo docker").
   *
   * **터미널에 넣는 명령**(셸 접속·재시작·삭제)이 쓰는 값이다. 비밀번호를 요구하는 호스트에서는
   * `sudo docker` 가 되는데, 그 자리는 사람이 보고 있는 터미널이라 sudo 가 물어보면 사람이
   * 답하면 된다 — 우리가 비밀번호를 흘려 넣지 않는다.
   */
  prefix: string | null;
  /**
   * 조회 명령을 코어가 `sudo -S` 로 감싸고 접속 비밀번호를 되물려야 하는가.
   *
   * 소켓 권한이 없고 `sudo -n` 도 막힌 호스트에서만 참이다. 조회는 보조 채널이라 물어볼 사람이
   * 없어서 코어가 대신 답한다. 비밀번호는 코어 안에만 있고 여기로 오지 않는다 — 렌더러는
   * "감싸 달라" 는 표시만 든다.
   */
  elevate: boolean;
  /**
   * compose 를 부르는 방법 전체("sudo docker compose" · "docker-compose"). 없으면 null.
   *
   * 접두사는 도커를 부르는 방법을 그대로 물려받는다 — sudo 가 필요한 호스트면 compose 도
   * sudo 로 불러야 한다. 둘 다 없으면 스택 단위 compose 동작(로그·down)을 만들지 않는다.
   */
  compose: string | null;
}

/**
 * 보조 채널 조회에 쓸 접두사. 코어가 sudo 를 씌우는 경우에는 명령 자체가 평범한 `docker` 여야
 * 한다 — 안에 또 sudo 를 넣으면 감싼 sudo 안에서 sudo 를 부르게 된다.
 */
export function queryPrefixOf(runtime: DockerRuntime): string | null {
  return runtime.elevate ? 'docker' : runtime.prefix;
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

/**
 * 프로브 왕복 **자체가** 실패했을 때 다시 물어보기까지의 시간과 횟수.
 *
 * 실패는 "도커가 없다" 가 아니다 — 보조 채널을 세션 패널의 다른 폴링과 함께 쓰므로 이번 차례를
 * 놓쳤을 수 있다. 그때 부재로 단정하면 섹션이 통째로 사라지고 재시도 TTL 만큼 돌아오지 않는다.
 * 몇 번 더 물어보고, 그래도 못 물어보면 그때 접는다.
 */
const PROBE_FAILURE_RETRY_MS = 4_000;
const PROBE_MAX_ATTEMPTS = 3;

const CHECKING: DockerRuntime = {
  availability: 'checking',
  prefix: null,
  elevate: false,
  compose: null,
};

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

  /** 왕복 자체가 실패해 다시 물어본 횟수. 이 값이 바뀌면 아래 effect 가 다시 돈다. */
  const [attempt, setProbeAttempt] = useState(0);

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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      let probe: DockerProbe = {
        prefix: null,
        compose: null,
        installed: false,
        answered: false,
        reason: null,
      };
      let failed = false;
      try {
        const stdout = await queryTerminalCompletion(sessionId, buildDockerProbeCommand(), {
          background: true,
        });
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
      // **대답이 없으면 실패로 친다.** 도커가 없는 호스트도 최소한 why= 한 줄은 온다 —
      // 아무 줄도 없다는 것은 명령이 제대로 돌지 않은 것이고(보조 채널이 아직 준비되지 않았거나
      // 이번 차례를 놓쳤다) 그걸 "없음" 으로 굳히면 섹션이 통째로 사라진 채로 남는다.
      if (failed || !probe.answered) {
        // **왕복이 실패한 것은 "도커가 없다" 가 아니다.** 보조 채널을 다른 폴링과 함께 쓰므로
        // 이번 차례를 놓쳤을 수 있는데, 그걸 부재로 단정하면 섹션이 통째로 사라진다(그리고
        // 재시도 TTL 만큼 안 돌아온다). 도커가 정말 없는 연결은 왕복이 **성공하고 빈 출력**으로
        // 오므로 아래 분기가 제대로 판정한다.
        if (cached) {
          // 아는 값을 지키고 시간만 미룬다 — 화면이 깜빡이지 않게.
          publishProbe(key, { ...cached, atMs: Date.now() });
          return;
        }
        // 아직 아는 것이 없다 — 단정하지 않고(= 'checking' 유지) 곧 다시 묻는다.
        if (attempt < PROBE_MAX_ATTEMPTS) {
          retryTimer = setTimeout(() => setProbeAttempt(attempt + 1), PROBE_FAILURE_RETRY_MS);
          return;
        }
        // 계속 못 물어봤다. 이 세션에서는 알아낼 방법이 없다고 본다.
        publishProbe(key, {
          availability: 'absent',
          prefix: null,
          elevate: false,
          compose: null,
          atMs: Date.now(),
        });
        return;
      }

      // 소켓 권한만 막혔다면(데몬은 살아 있고 도커도 깔려 있다) 접속에 쓴 비밀번호로 sudo 를
      // 한 번 되물려 본다. 비밀번호는 코어 안에서만 쓰이고 여기로 오지 않는다 — 우리는 "감싸
      // 달라" 는 표시만 보낸다. **한 번만** 시도한다: 틀린 sudo 시도를 반복하면 pam_faillock
      // 이 계정을 잠근다. 코어도 세션 단위로 같은 빗장을 걸어 둔다.
      if (!probe.prefix && probe.installed && probe.reason === 'permission') {
        let elevated: DockerProbe | null = null;
        try {
          const stdout = await queryTerminalCompletion(sessionId, buildDockerProbeCommand(), {
            background: true,
            elevate: true,
          });
          elevated = parseDockerProbe(stdout);
        } catch {
          // 되물릴 비밀번호가 없거나(키로 붙었다) 이미 거절당한 세션이다 — 아래로 떨어져
          // 평소처럼 "읽을 수 없다" 로 끝낸다.
        }
        if (cancelled) {
          return;
        }
        if (elevated?.prefix) {
          publishProbe(key, {
            availability: 'available',
            // 터미널에 넣는 명령은 사람이 sudo 에 답할 수 있다.
            prefix: 'sudo docker',
            elevate: true,
            // compose 판정은 데몬과 무관하다 — 첫 프로브에서 이미 알아냈다.
            compose: composeCommandFor('sudo docker', probe.compose),
            atMs: Date.now(),
          });
          return;
        }
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
        // 여기까지 왔으면 sudo 되물리기는 통하지 않았거나 시도할 값이 없었다.
        elevate: false,
        compose: composeCommandFor(probe.prefix, probe.compose),
        atMs: Date.now(),
      });
    })();
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [attempt, key, sessionId]);

  return useMemo(() => {
    if (!key) {
      return CHECKING;
    }
    const entry = probeCache.get(key);
    return entry
      ? {
          availability: entry.availability,
          prefix: entry.prefix,
          elevate: entry.elevate,
          compose: entry.compose,
        }
      : CHECKING;
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

/**
 * 직전 누적 I/O. `docker stats` 의 NET·BLOCK 은 컨테이너가 뜬 뒤로 쌓인 총량이라 그대로 보여
 * 주면 "지금 흐르는 양" 으로 잘못 읽힌다. 표본 사이의 차를 시간으로 나눠 초당 값을 만든다.
 */
const ioTotalsByScope = new Map<string, Map<string, DockerIoTotals>>();

function computeIoRates(
  scope: string,
  stats: Map<string, DockerStat>,
  atMs: number,
): Map<string, DockerIoRate> {
  const previous = ioTotalsByScope.get(scope) ?? new Map<string, DockerIoTotals>();
  const rates = new Map<string, DockerIoRate>();
  const next = new Map<string, DockerIoTotals>();
  for (const [id, stat] of stats) {
    const totals = ioTotalsOf(stat, atMs);
    next.set(id, totals);
    const rate = computeIoRate(previous.get(id), totals);
    if (rate) {
      rates.set(id, rate);
    }
  }
  ioTotalsByScope.set(scope, next);
  return rates;
}

/**
 * 표본을 쌓는다. **제자리에서 고치지 않고 새 배열을 만든다.**
 *
 * 화면이 이 배열의 참조로 "달라졌나" 를 판정하기 때문이다. 예전에는 push/shift 로 같은 배열을
 * 고쳐서 React 가 변화를 볼 수 없었고, 그걸 우회하려고 `historyVersion` 을 올려 섹션 전체를
 * 다시 그렸다 — 스파크라인 200개가 매 틱마다 통째로 다시 계산됐다. 새 배열을 주면 값이 바뀐
 * 행만 다시 그린다.
 */
function pushHistory(scope: string, stats: Map<string, DockerStat>, atMs: number): void {
  const byContainer = historyByScope.get(scope) ?? new Map<string, DockerSample[]>();
  const cutoffMs = atMs - HISTORY_WINDOW_MS;
  for (const [id, stat] of stats) {
    const previous = byContainer.get(id) ?? EMPTY_SAMPLES;
    byContainer.set(
      id,
      [...previous, { atMs, cpuPercent: stat.cpuPercent, memBytes: stat.memBytes }]
        .filter((sample) => sample.atMs >= cutoffMs)
        .slice(-HISTORY_MAX_SAMPLES),
    );
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
 * 컨테이너 목록 왕복의 **최소** 주기. `ps -a` 는 데몬 API 한 번이라 대개 100ms 언저리다 —
 * 이 루프는 빨라도 되고, 그래야 새 컨테이너가 금방 보인다.
 */
const CONTAINER_POLL_MS = 5_000;
const CONTAINER_POLL_MAX_MS = 20_000;

/**
 * 지표(stats + inspect) 왕복의 **최소** 주기. 목록보다 훨씬 느긋하다.
 *
 * `stats --no-stream` 은 데몬이 CPU 차분을 내려고 컬렉터 틱을 두 번 기다려서 1~2초가 바닥값이다.
 * 이걸 목록과 같은 주기로 부르면 보조 채널이 늘 물려 있다. CPU·MEM 은 15초마다 와도 충분하다 —
 * 행 스파크라인이 보는 창이 10분이라 그림이 달라지지 않는다. 사용자에게 "지표 끄기" 를 묻는
 * 대신 우리가 물러난다.
 */
const METRICS_POLL_MS = 15_000;
const METRICS_POLL_MAX_MS = 60_000;

/** 걸린 시간의 이 배수를 주기로 삼는다(왕복이 채널을 절반 이상 물지 않게). */
const POLL_DUTY_FACTOR = 3;
const BACKOFF_MS = [5_000, 15_000, 60_000];

/** 재시작 횟수·헬스·OOM 은 자주 바뀌지 않는다 — 지표 왕복 이 횟수마다 한 번씩 얹는다. */
const INSPECT_EVERY_TICKS = 4;

/** 행 스파크라인이 보는 창(ms)과 표본 상한. 이력은 앱에 쌓아 원격 왕복을 늘리지 않는다. */
const HISTORY_WINDOW_MS = 10 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 120;

/** 컨테이너 말고는 스스로 변하지 않는다 — 이만큼 안에 받은 값이면 탭을 다시 열어도 그대로 쓴다. */
const STATIC_TAB_TTL_MS = 15_000;

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

export type { DockerIoRate };

export interface DockerLists {
  containers: DockerContainer[];
  stats: Map<string, DockerStat>;
  /** 컨테이너별 초당 I/O. 누적값의 차라 첫 표본에서는 비어 있다. */
  ioRates: Map<string, DockerIoRate>;
  inspect: Map<string, DockerInspectInfo>;
  summary: DockerSummary;
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  /** 이 탭을 아직 한 번도 못 받았다. */
  loading: boolean;
  /** 마지막으로 받은 시각. 실패해도 남는다. */
  updatedAtMs: number | null;
  /** 지금 받아오기가 실패해 물러나 있는 상태. 목록은 마지막 값이다. */
  failing: boolean;
  truncated: boolean;
}

interface TabState {
  containers: DockerContainer[];
  stats: Map<string, DockerStat>;
  inspect: Map<string, DockerInspectInfo>;
  images: DockerImage[];
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
  volumes: [],
  networks: [],
  updatedAtMs: null,
  failing: false,
  truncated: false,
};

const EMPTY_TABS: Record<DockerTabId, TabState> = {
  containers: EMPTY_TAB,
  images: EMPTY_TAB,
  volumes: EMPTY_TAB,
  networks: EMPTY_TAB,
};

/**
 * 탭별 목록을 **호스트(없으면 세션) 단위로** 기억한다.
 *
 * 컴포넌트 안에만 두면 세션 탭을 옮길 때 직전 호스트의 목록이 그대로 남는다 — 패널은 같은
 * 인스턴스를 재사용하고 `sessionId` 만 갈아끼우기 때문이다. 다른 서버의 컨테이너가 잠깐 내
 * 것처럼 보이고, 그 사이에 누르면 엉뚱한 호스트를 가리킨다.
 *
 * 여기 두면 옮기는 즉시 그 호스트의 것으로 갈아타고(없으면 빈 화면), 돌아왔을 때는 다시
 * 받아오는 동안 아는 값이 보인다. 이력(historyByScope)·접힘(collapsedStacks)과 같은 단위다.
 */
const listCache = new Map<string, Record<DockerTabId, TabState>>();

function buildCommand(tab: DockerTabId, prefix: string): string {
  switch (tab) {
    case 'images':
      return buildImageListCommand(prefix);
    case 'volumes':
      return buildVolumeListCommand(prefix);
    case 'networks':
      return buildNetworkListCommand(prefix);
    default:
      return buildContainerListCommand(prefix);
  }
}

function applyOutput(tab: DockerTabId, previous: TabState, stdout: string): TabState {
  const next: TabState = { ...previous, updatedAtMs: Date.now(), failing: false };
  if (tab === 'containers') {
    // 지표·검사는 이 왕복에 오지 않는다(따로 받는다) — 목록만 갈아 끼우고 나머지는 둔다.
    const parsed = parseContainerList(stdout);
    next.containers = parsed.containers;
    next.truncated = parsed.truncated;
  } else if (tab === 'images') {
    const parsed = parseImageList(stdout);
    next.images = parsed.images;

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
  /** 조회 명령을 코어가 sudo 로 감싸야 하는가(useDockerRuntime 이 정한다). */
  elevate: boolean,
  tab: DockerTabId,
  enabled: boolean,
  /** 이력을 담는 단위(호스트, 없으면 세션). */
  scope: string,
): DockerLists & { refresh: () => void } {
  const [state, setState] = useState<Record<DockerTabId, TabState>>(
    () => listCache.get(scope) ?? EMPTY_TABS,
  );
  // 세션 탭을 옮기면 그 호스트의 것으로 **그 자리에서** 갈아탄다. effect 로 미루면 직전 호스트의
  // 목록이 한 프레임 더 남는다 — React 는 렌더 중의 이 갱신을 커밋 전에 흡수한다.
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    setState(listCache.get(scope) ?? EMPTY_TABS);
  }
  // 받은 것은 그 호스트 자리에 남긴다(순수하게 — 갱신 함수 안에서 쓰지 않는다).
  useEffect(() => {
    listCache.set(scope, state);
  }, [scope, state]);
  const [nonce, setNonce] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  /**
   * 지표를 못 받는 호스트에서는 두 번째 왕복부터 stats 를 붙이지 않는다 — 매번 붙여 헛돌면
   * 왕복만 느려진다. 옛 도커나 stats 형식을 모르는 방언에서 그렇다. 그러면 지표 루프는 검사
   * 차례에만 나가고 나머지 틱은 왕복 없이 넘어간다.
   */
  const statsSupportedRef = useRef(true);
  /** 초당 I/O. 표본마다 새로 계산해 담는다(렌더는 아래 setState 가 낸다). */
  const ioRatesRef = useRef<Map<string, DockerIoRate>>(new Map());
  /** 지표 루프의 틱. 이 횟수마다 검사(inspect)를 얹는다 — 목록 루프와는 무관하다. */
  const tickRef = useRef(0);

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  // 헤더의 새로고침 버튼이 이 세션에 요청을 보낸다.
  useEffect(() => subscribeDockerRefresh(sessionId, refresh), [refresh, sessionId]);

  /**
   * 컨테이너 목록이 한 번이라도 왔는가. 지표 루프의 출발 신호다 — false → true 로 한 번만
   * 뒤집히므로 아래 effect 는 그때 딱 한 번 더 돈다.
   */
  const listReady = state.containers.updatedAtMs !== null;

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
      const startedAtMs = Date.now();
      let stdout: string;
      try {
        stdout = await queryTerminalCompletion(
          sessionId,
          buildCommand(tab, prefix),
          // 스스로 도는 폴링이다 — 두 번째 보조 채널에서 돌려 자동완성을 막지 않는다.
          { background: true, elevate },
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
      setState((current) => ({ ...current, [tab]: applyOutput(tab, current[tab], stdout) }));
      // 컨테이너만 스스로 변한다 — 나머지는 탭을 열 때와 새로고침에서만 받는다.
      if (tab === 'containers') {
        // 걸린 시간에 맞춰 물러난다(5~20초). 목록만 받으므로 대개 최소 주기에 머문다.
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
  }, [elevate, enabled, nonce, prefix, sessionId, tab]);

  /**
   * CPU·MEM(+ 재시작 횟수·헬스)을 **목록과 따로** 받는다.
   *
   * `stats --no-stream` 은 1~2초가 바닥값이라(데몬이 CPU 차분을 잰다) 목록과 한 왕복에 묶으면
   * 이름 몇 줄 그리는 데 그 시간을 통째로 기다리게 된다. 갈라 놓으면 목록은 100ms 대에 뜨고
   * 숫자는 이 왕복이 오는 대로 채워진다.
   *
   * 진행 표시(헤더의 새로고침 아이콘)는 건드리지 않는다 — 사람이 기다리는 것은 목록이다.
   *
   * **목록이 한 번 온 뒤에 시작한다**(`listReady`). 지표는 목록을 채우는 값이라 목록 없이 먼저
   * 그릴 것이 없고, 검사(inspect)는 목록의 id 를 쓴다. 무엇보다 이 왕복이 목록보다 먼저 채널을
   * 물면 첫 그림이 다시 stats 만큼 늦어져 갈라 놓은 의미가 없어진다.
   */
  useEffect(() => {
    if (!enabled || !prefix || !sessionId || tab !== 'containers' || !listReady) {
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
      const listed = stateRef.current.containers;
      const wantsStats = statsSupportedRef.current;
      const wantsInspect = tickRef.current % INSPECT_EVERY_TICKS === 0;
      const inspectIds = wantsInspect ? listed.containers.map((container) => container.id) : [];
      if (!wantsStats && inspectIds.length === 0) {
        // 물어볼 것이 없다(지표를 못 주는 호스트 + 검사 차례가 아님) — 왕복을 쓰지 않는다.
        tickRef.current += 1;
        schedule(METRICS_POLL_MS);
        return;
      }
      tickRef.current += 1;
      const startedAtMs = Date.now();
      let stdout: string;
      try {
        stdout = await queryTerminalCompletion(
          sessionId,
          buildContainerMetricsCommand(prefix, { stats: wantsStats, inspectIds }),
          // 이 기능에서 제일 오래 채널을 무는 왕복이다 — 반드시 백그라운드 레인으로.
          { background: true, elevate },
        );
      } catch {
        if (cancelled) {
          return;
        }
        failures += 1;
        schedule(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
        return;
      }
      if (cancelled) {
        return;
      }
      failures = 0;
      const elapsedMs = Date.now() - startedAtMs;
      const parsed = parseContainerMetrics(stdout);
      if (
        wantsStats &&
        // **아무것도 안 온 것과 지표만 안 온 것은 다르다.** 왕복이 조용히 실패하면(코어의 완성
        // 타임아웃은 오류가 아니라 빈 문자열로 돌아온다) stdout 이 통째로 비는데, 그것을 "이
        // 호스트는 지표를 못 준다" 로 읽으면 한 번 늦은 것 때문에 CPU·MEM 이 영영 사라진다.
        // 명령이 돌기만 했다면 구분자라도 찍혀 있다.
        stdout.trim() !== '' &&
        parsed.stats.size === 0 &&
        listed.containers.some((container) => isRunningState(container))
      ) {
        // 돌고 있는 컨테이너가 있는데 지표가 한 줄도 없다 = 이 호스트에서는 못 쓴다.
        // 다음 왕복부터 stats 를 빼면 이 루프가 검사만 싣고 훨씬 빨라진다.
        statsSupportedRef.current = false;
      }
      if (parsed.stats.size > 0) {
        ioRatesRef.current = computeIoRates(scope, parsed.stats, Date.now());
        // 아래 setState 가 이 틱의 다시 그리기를 낸다 — 이력은 새 배열이라 그 렌더에서 바로
        // 보인다(별도의 version 을 올려 섹션 전체를 흔들 필요가 없다).
        pushHistory(scope, parsed.stats, Date.now());
      }
      // 온 것만 덮어쓴다 — 검사는 매 왕복에 오지 않고, 지표는 실패해도 마지막 값을 지운다.
      setState((current) => ({
        ...current,
        containers: {
          ...current.containers,
          stats: parsed.stats.size > 0 ? parsed.stats : current.containers.stats,
          inspect: parsed.inspect.size > 0 ? parsed.inspect : current.containers.inspect,
        },
      }));
      // 걸린 시간에 맞춰 물러난다(15~60초). 느린 호스트에서 채널을 계속 물지 않게.
      schedule(
        Math.min(METRICS_POLL_MAX_MS, Math.max(METRICS_POLL_MS, elapsedMs * POLL_DUTY_FACTOR)),
      );
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [elevate, enabled, listReady, nonce, prefix, scope, sessionId, tab]);

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
    ioRates: ioRatesRef.current,
    inspect: containerState.inspect,
    summary,
    images: state.images.images,
    volumes: state.volumes.volumes,
    networks: state.networks.networks,
    loading: current.updatedAtMs === null && !current.failing,
    updatedAtMs: current.updatedAtMs,
    failing: current.failing,
    truncated: current.truncated,
    refresh,
  };
}

function isRunningState(container: DockerContainer): boolean {
  return container.state === 'running' || container.state === 'restarting';
}
