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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { queryTerminalCompletion } from '../services/desktop/terminal';
import {
  buildHostMetricsCommand,
  computeHostMetrics,
  hasAnyHostMetric,
  parseHostMetricsSample,
  parseHostProcessesFromOutput,
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
}

export function useHostMetrics({
  sessionId,
  enabled,
  visible,
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
  /** 재시도 버튼이 누른 횟수. 값이 바뀌면 아래 effect 가 처음부터 다시 돈다. */
  const [retryToken, setRetryToken] = useState(0);

  // 차분 계산에 쓰는 직전 샘플. 세션이 바뀌면 버린다(호스트가 다르면 누적값도 무의미).
  const previousSampleRef = useRef<HostMetricsSample | null>(null);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  /** 이번 폴링에서 읽은 프로세스 목록. 요청하지 않았으면 null 로 남는다. */
  const processesRef = useRef<HostProcess[] | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStatus('off');
      setMetrics(null);
      setUpdatedAtMs(null);
      previousSampleRef.current = null;
      processesRef.current = null;
      if (sessionId) {
        clearHostMetrics(sessionId);
      }
      return;
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
    if (previous && Date.now() - previous.atMs > intervalMs * 2) {
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

    const poll = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      let stdout: string;
      try {
        stdout = await queryTerminalCompletion(
          sessionId,
          buildHostMetricsCommand({ processLimit }),
        );
      } catch {
        if (cancelled) {
          return;
        }
        // 첫 시도부터 실패하면 이 연결에는 보조 채널이 없다고 본다(SSM raw shell 등).
        // 그 경우 재시도해도 달라지지 않으므로 조용히 접는다.
        if (previous === null) {
          setStatus('unsupported');
          publish({ status: 'unsupported' });
          return;
        }
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          setStatus('paused');
          publish({ status: 'paused', metrics, updatedAtMs });
          return;
        }
        schedule(intervalMs);
        return;
      }
      if (cancelled) {
        return;
      }

      const sample = parseHostMetricsSample(stdout, Date.now());
      if (!hasAnyHostMetric(sample)) {
        // 명령은 돌았는데 읽어낼 게 없다 = 리눅스가 아니거나 /proc 이 없다.
        // 재시도해도 같으므로 이 세션에서는 끝낸다.
        setStatus('unsupported');
        publish({ status: 'unsupported' });
        return;
      }

      failures = 0;
      // 요청하지 않았으면 null 이 되어 UI 가 "요청 안 함" 과 "못 읽음" 을 구분할 수 있다.
      processesRef.current = processLimit > 0 ? parseHostProcessesFromOutput(stdout) : null;
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

    void poll();

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

  // 세션이 바뀌면 누적 카운터 기준이 달라지므로 직전 샘플을 버린다.
  useEffect(() => {
    previousSampleRef.current = null;
    processesRef.current = null;
  }, [sessionId]);

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
