// 원격 호스트 부하를 주기적으로 읽어 상태바에 넘긴다.
//
// 이 훅은 사용자가 접속한 *프로덕션 서버*에 주기적으로 명령을 쏜다. 그래서 조심해야 할 게
// 기능 자체보다 많다 — 설정으로 끌 수 있고, 보이는 탭만, 짧은 타임아웃, 연속 실패 시 자동 정지.
//
// 세션 패널도 같은 값을 본다. 패널이 자기 폴링을 돌리면 같은 서버에 두 배로 나가므로, 수집은
// 여기 하나로 두고 결과를 host-metrics-registry 로 발행한다. 패널이 "지금 보고 있다" 를
// 남기면 주기가 좁아지고 프로세스 목록이 명령에 얹힌다.
//
// 수집은 자동완성 generator 가 쓰는 보조 exec 채널을 그대로 쓴다. 그 채널이 없는 연결
// (AWS SSM raw shell·mosh 등)에서는 첫 시도가 실패하고, 그때 조용히 비활성화한다 — 빈 바를
// 계속 띄우면 고장으로 보이기 때문이다.
//
// **로컬 세션만 다른 길로 간다.** 그 "호스트" 는 앱이 도는 바로 그 기계라 셸에 물어볼 것이
// 없고, Windows 에는 애초에 그 POSIX 스크립트를 돌릴 셸이 없어 자원 섹션이 통째로 비어
// 있었다. 코어가 Win32 로 직접 읽어 주고(0.5ms), 그 길이 없는 플랫폼에서는 한 번 물어본 뒤
// 위의 셸 경로로 돌아간다. 도착지는 양쪽 다 HostMetricsSample 이라 아래 계산은 그대로다.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  collectNativeHostMetrics,
  queryTerminalCompletion,
} from '../services/desktop/terminal';
import {
  buildHostMetricsCommand,
  parseHostSystemInfoFromOutput,
  type HostSystemInfo,
  computeHostMetrics,
  hasAnyHostMetric,
  parseHostMetricsSample,
  parseHostProcessesFromOutput,
  readNativeHostMetricsSample,
  readNativeHostProcesses,
  readNativeHostSystemInfo,
  type HostMetrics,
  type HostMetricsSample,
  type HostProcess,
} from '../lib/host-metrics';
import {
  clearHostMetrics,
  getHostMetricsWatch,
  getHostMetricsWatchVersion,
  publishHostMetrics,
  subscribeHostMetricsWatch,
  HOST_METRICS_BOOST_INTERVAL_MS,
  HOST_PROCESS_LIMIT,
} from '../lib/host-metrics-registry';

/** 연결 직후 두 번째 샘플까지의 간격. CPU·네트워크는 차분이라 첫 샘플만으로는 값이 없다. */
const PRIMING_DELAY_MS = 2_000;
/**
 * 폴링 주기. 설정으로 열지 않는다 — 조절할 만한 값이 아니고 설정 항목만 늘어난다.
 * 보고 있는 탭 하나당 분당 6회이고, 읽는 것은 /proc 몇 줄이라 부담이 크지 않다.
 */
const POLL_INTERVAL_MS = 10_000;

/** 이만큼 연속으로 실패하면 폴링을 멈춘다(부하가 걸린 서버를 계속 찌르지 않도록). */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 이 훅이 세션당 하나뿐인 발행자다 — 자세한 이유는 host-metrics-registry 주석에. */
export type HostMetricsStatus =
  /** 설정이 꺼져 있거나 세션이 준비되지 않음 — 아무것도 그리지 않는다. */
  | 'off'
  /** 이 연결에서는 지표를 읽을 수 없다(보조 채널 없음·리눅스 아님) — 아무것도 그리지 않는다. */
  | 'unsupported'
  /** 첫 값을 기다리는 중. */
  | 'loading'
  | 'ready'
  /** 연속 실패로 멈춤. 마지막 값이 있으면 흐리게 보여주고 재시도 버튼을 낸다. */
  | 'paused';

export interface HostMetricsState {
  status: HostMetricsStatus;
  metrics: HostMetrics | null;
  /** 마지막으로 값을 성공적으로 읽은 시각(epoch ms). */
  updatedAtMs: number | null;
  retry: () => void;
}

interface Options {
  /** 없으면 폴링하지 않는다 — 대상 pane 이 정해지기 전에도 훅은 호출되어야 하므로. */
  sessionId: string | null;
  enabled: boolean;
  /** 이 탭이 화면에 보이는지. 보이지 않으면 폴링하지 않는다. */
  visible: boolean;
  /**
   * 이 세션이 로컬 셸인가. 그때는 코어가 이 기계를 직접 읽는다 — 원격처럼 셸에 물어볼
   * 것이 없고, Windows 에는 그 POSIX 스크립트를 돌릴 셸이 아예 없다.
   */
  local?: boolean;
}

export function useHostMetrics({
  sessionId,
  enabled,
  visible,
  local = false,
}: Options): HostMetricsState {
  const [status, setStatus] = useState<HostMetricsStatus>('off');
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [updatedAtMs, setUpdatedAtMs] = useState<number | null>(null);

  // 세션 패널이 보고 있으면 주기를 좁히고 프로세스 목록까지 태운다. 요청이 없으면 예전과
  // 똑같이 10초마다 /proc 몇 줄만 읽는다.
  const watchSubscribe = useCallback(
    (onChange: () => void) => subscribeHostMetricsWatch(sessionId ?? '', onChange),
    [sessionId],
  );
  const watchVersion = useSyncExternalStore(
    watchSubscribe,
    () => getHostMetricsWatchVersion(sessionId ?? ''),
    () => 0,
  );
  const watch = useMemo(
    () => getHostMetricsWatch(sessionId ?? ''),
    // watchVersion 이 스냅샷이다.
    [sessionId, watchVersion],
  );
  const intervalMs = watch.boosted
    ? HOST_METRICS_BOOST_INTERVAL_MS
    : POLL_INTERVAL_MS;
  const processLimit = watch.processes ? HOST_PROCESS_LIMIT : 0;
  // 정적 정보는 아직 캐시가 없을 때만 요청한다(레지스트리가 그 판단을 한다).
  const wantsSystem = watch.system;
  /** 재시도 버튼이 누른 횟수. 값이 바뀌면 아래 effect 가 처음부터 다시 돈다. */
  const [retryToken, setRetryToken] = useState(0);

  // 차분 계산에 쓰는 직전 샘플. 세션이 바뀌면 버린다(호스트가 다르면 누적값도 무의미).
  const previousSampleRef = useRef<HostMetricsSample | null>(null);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  /** 이번 폴링에서 읽은 프로세스 목록. 요청하지 않았으면 null 로 남는다. */
  const processesRef = useRef<HostProcess[] | null>(null);
  /**
   * 한 번 받아 둔 정적 정보. 세션이 사는 동안 다시 묻지 않는다 — 발행할 때마다 이 값을
   * 그대로 실어 보내야 캐시가 유지된다(스냅샷은 매번 새로 만든다).
   */
  const systemRef = useRef<HostSystemInfo | null>(null);
  /**
   * 코어에 네이티브 수집을 물어봤다가 "안 한다" 를 받았는가.
   *
   * 답이 바뀔 일이 없는 판정(플랫폼·세션 유형)이라 한 번 받으면 그 세션에서는 다시 묻지
   * 않는다. effect 지역 변수로 두면 주기가 바뀔 때마다(패널 열기) 되물어 왕복이 는다.
   */
  const nativeUnavailableRef = useRef(false);
  /** 위 ref 들이 **어느 세션의 것인지**. 세션이 바뀌면 여기서 갈라 낸다. */
  const refsSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStatus('off');
      setMetrics(null);
      setUpdatedAtMs(null);
      previousSampleRef.current = null;
      processesRef.current = null;
      systemRef.current = null;
      nativeUnavailableRef.current = false;
      refsSessionRef.current = sessionId ?? null;
      if (sessionId) {
        clearHostMetrics(sessionId);
      }
      return;
    }

    // 세션이 바뀌었으면 **이 세션의 것이 아닌 값을 전부 버린다** — 누적 카운터의 기준(previous),
    // 프로세스 목록, 그리고 정적 정보(hostname·커널·CPU)까지.
    //
    // 따로 둔 effect 로는 늦다. 선언 순서상 그것은 이 아래라, 여기서 이미 이전 세션의 샘플을
    // 지역 변수로 집어 든 뒤에 돈다 — 빠르게 탭을 옮기면 **옛 서버의 카운터로 첫 차분**을 냈고,
    // 정적 정보는 새 값이 올 때까지 옛 서버의 것이 그대로 보였다.
    if (refsSessionRef.current !== sessionId) {
      previousSampleRef.current = null;
      processesRef.current = null;
      systemRef.current = null;
      nativeUnavailableRef.current = false;
      refsSessionRef.current = sessionId;
    }

    // 안 보이는 탭은 폴링하지 않는다. 이미 읽어 둔 값과 상태는 그대로 두어, 다시 보일 때
    // 화면이 깜빡이지 않게 한다.
    if (!visible) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    // 이 effect 안에서만 쓰는 로컬 상태 — ref 를 쓰면 세션 전환 시 남는다.
    let previous: HostMetricsSample | null = previousSampleRef.current;
    // 탭을 한참 가려 뒀다 돌아오면 직전 샘플이 너무 오래됐다. 그대로 차분을 내면 그 사이의
    // *평균*이 현재값인 척 표시된다 — 버리고 다시 두 번 찍는다.
    //
    // 기준은 **상시 주기**의 두 배로 고정한다. 새 주기(부스트 3초)로 재면 10초 주기에 찍힌
    // 직전 샘플이 거의 항상 낡은 것이 되어, 패널을 열어 주기가 좁혀지는 순간 기준 샘플이
    // 버려지고 값이 `-` 로 돌아갔다(자원 섹션을 열 때마다 다시 읽기 시작하던 것).
    if (previous && Date.now() - previous.atMs > POLL_INTERVAL_MS * 2) {
      previous = null;
      previousSampleRef.current = null;
    }
    let primed = previous !== null;

    const publish = (next: {
      status: HostMetricsStatus;
      metrics?: HostMetrics | null;
      updatedAtMs?: number | null;
    }) => {
      publishHostMetrics(sessionId, {
        status: next.status,
        metrics: next.metrics ?? null,
        processes: processesRef.current,
        system: systemRef.current,
        updatedAtMs: next.updatedAtMs ?? null,
      });
    };

    const initialStatus: HostMetricsStatus = previous ? 'ready' : 'loading';
    setStatus(initialStatus);

    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, delayMs);
    };

    /**
     * 이번 왕복에서 읽어 온 것. 셸에서 왔든 코어가 직접 읽었든 도착지는 같다.
     */
    type Reading = {
      sample: HostMetricsSample;
      processes: HostProcess[] | null;
      system: HostSystemInfo | null;
    };

    /**
     * 로컬 세션은 코어가 이 기계를 직접 읽는다.
     *
     * 로컬 터미널의 "호스트" 는 앱이 도는 바로 그 기계라 셸에 물어볼 것이 없고, Windows 에는
     * 애초에 그 POSIX 스크립트를 돌릴 셸이 없어 자원 섹션이 통째로 비어 있었다.
     *
     * 한 번 `supported: false` 를 받으면 **이 세션에서는 다시 묻지 않는다** — 답이 바뀔 일이
     * 없는 판정(플랫폼·세션 유형)이라 폴링마다 되물으면 왕복만 두 배가 된다.
     */
    const readNatively = async (): Promise<Reading | null> => {
      if (!local || nativeUnavailableRef.current) {
        return null;
      }
      const native = await collectNativeHostMetrics(sessionId, {
        processLimit,
        system: wantsSystem,
      });
      const sample = native.supported
        ? readNativeHostMetricsSample(native.sample, Date.now())
        : null;
      if (!sample) {
        // 코어가 못 읽거나(유닉스) 문서 모양이 낯설면 셸 경로로 돌아간다. 반쯤 읽은 값으로
        // 그럴듯한 거짓 그래프를 그리는 것보다 낫다.
        nativeUnavailableRef.current = true;
        return null;
      }
      return {
        sample,
        processes: processLimit > 0 ? readNativeHostProcesses(native.sample) : null,
        system: wantsSystem ? readNativeHostSystemInfo(native.sample) : null,
      };
    };

    const poll = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      let reading: Reading | null = null;
      let stdout: string;
      try {
        reading = await readNatively();
        stdout = reading
          ? ''
          : await queryTerminalCompletion(
              sessionId,
              buildHostMetricsCommand({ processLimit, system: wantsSystem }),
              // 스스로 도는 폴링이다 — 두 번째 보조 채널에서 돌려 자동완성을 막지 않는다.
              { background: true },
            );
      } catch {
        if (cancelled) {
          return;
        }
        failures += 1;
        if (failures < MAX_CONSECUTIVE_FAILURES) {
          schedule(intervalMs);
          return;
        }
        // **한 번 실패했다고 접지 않는다.** 보조 채널은 세션 패널의 다른 폴링(도커 지표)과
        // 함께 쓰는데, `docker stats` 가 몇 초씩 물고 있으면 이번 차례를 놓칠 수 있다. 그걸
        // 곧장 "미지원" 으로 읽으면 자원 섹션이 세션 내내 비어 버린다 — 보조 채널이 아예 없는
        // 연결(SSM raw shell)은 왕복이 **성공하고 빈 출력**으로 오므로 아래 hasAnyHostMetric
        // 에서 걸린다. 여기까지 계속 실패했다면 그때 접는다.
        if (previous === null) {
          setStatus('unsupported');
          publish({ status: 'unsupported' });
          return;
        }
        setStatus('paused');
        publish({ status: 'paused', metrics, updatedAtMs });
        return;
      }
      if (cancelled) {
        return;
      }

      const sample = reading?.sample ?? parseHostMetricsSample(stdout, Date.now());
      if (!hasAnyHostMetric(sample)) {
        // 명령은 돌았는데 읽어낼 게 없다 = 리눅스가 아니거나 /proc 이 없다.
        // 재시도해도 같으므로 이 세션에서는 끝낸다.
        setStatus('unsupported');
        publish({ status: 'unsupported' });
        return;
      }

      failures = 0;
      // 요청하지 않았으면 null 이 되어 UI 가 "요청 안 함" 과 "못 읽음" 을 구분할 수 있다.
      processesRef.current = reading
        ? reading.processes
        : processLimit > 0
          ? parseHostProcessesFromOutput(stdout)
          : null;
      // 정적 정보는 받은 것만 덮어쓴다 — 요청하지 않은 왕복에서 null 로 지우면 캐시가 날아가
      // 매번 다시 묻게 된다.
      const system = reading
        ? reading.system
        : wantsSystem
          ? parseHostSystemInfoFromOutput(stdout)
          : null;
      if (system) {
        systemRef.current = system;
      }
      const computed = computeHostMetrics(sample, previous);
      setMetrics(computed);
      setUpdatedAtMs(sample.atMs);
      setStatus('ready');
      publish({ status: 'ready', metrics: computed, updatedAtMs: sample.atMs });
      previous = sample;
      previousSampleRef.current = sample;

      if (!primed) {
        // 두 번째 샘플을 곧바로 찍어 CPU·네트워크 칸을 채운다. 30초를 빈칸으로 두면
        // 고장으로 보인다.
        primed = true;
        schedule(PRIMING_DELAY_MS);
        return;
      }
      schedule(intervalMs);
    };

    // 주기가 바뀌어 effect 가 다시 도는 것뿐이면(패널·프로세스 섹션 여닫기) **즉시 찍지
    // 않는다.** 직전 폴링 직후에 열면 간격이 0.x초가 되고, 그 왕복의 초당 값이 통째로 부풀어
    // 차트 눈금을 10분 동안 붙잡는다. 남은 시간만큼 기다렸다 찍는다.
    //
    // 직전 샘플이 없거나(첫 폴링) 한참 지났으면(멈춘 뒤 재시도·탭 복귀) 남은 시간이 0이라
    // 예전과 똑같이 즉시 나간다.
    if (previous) {
      schedule(Math.max(0, intervalMs - (Date.now() - previous.atMs)));
    } else {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // visible 이 바뀌면 effect 가 재시작되며 타이머가 정리된다 = 안 보이는 탭은 폴링하지 않는다.
    // intervalMs·processLimit 이 바뀌는 것(패널을 여닫는 것)도 같은 방식으로 반영된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metrics·updatedAtMs 는 발행에만
    // 쓰이며 의존성에 넣으면 폴링이 값마다 재시작한다.
  }, [enabled, intervalMs, processLimit, retryToken, sessionId, visible]);

  // pane 이 사라지면 발행한 값도 치운다 — 남겨 두면 다음 세션이 옛 값을 잠깐 보여 준다.
  useEffect(() => {
    if (!sessionId) {
      return;
    }
    return () => {
      clearHostMetrics(sessionId);
    };
  }, [sessionId]);

  return { status, metrics, updatedAtMs, retry };
}
