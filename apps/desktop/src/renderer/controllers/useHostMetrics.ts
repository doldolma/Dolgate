// 원격 호스트 부하를 주기적으로 읽어 상태바에 넘긴다.
//
// 이 훅은 사용자가 접속한 *프로덕션 서버*에 주기적으로 명령을 쏜다. 그래서 조심해야 할 게
// 기능 자체보다 많다 — 기본 꺼짐, 보이는 탭만, 짧은 타임아웃, 연속 실패 시 자동 정지.
//
// 수집은 자동완성 generator 가 쓰는 보조 exec 채널을 그대로 쓴다. 그 채널이 없는 연결
// (AWS SSM raw shell·mosh 등)에서는 첫 시도가 실패하고, 그때 조용히 비활성화한다 — 빈 바를
// 계속 띄우면 고장으로 보이기 때문이다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { queryTerminalCompletion } from '../services/desktop/terminal';
import {
  buildHostMetricsCommand,
  computeHostMetrics,
  hasAnyHostMetric,
  parseHostMetricsSample,
  type HostMetrics,
  type HostMetricsSample,
} from '../lib/host-metrics';

/** 연결 직후 두 번째 샘플까지의 간격. CPU·네트워크는 차분이라 첫 샘플만으로는 값이 없다. */
const PRIMING_DELAY_MS = 2_000;
/**
 * 폴링 주기. 설정으로 열지 않는다 — 조절할 만한 값이 아니고 설정 항목만 늘어난다.
 * 보고 있는 탭 하나당 분당 6회이고, 읽는 것은 /proc 몇 줄이라 부담이 크지 않다.
 */
const POLL_INTERVAL_MS = 10_000;

/** 이만큼 연속으로 실패하면 폴링을 멈춘다(부하가 걸린 서버를 계속 찌르지 않도록). */
const MAX_CONSECUTIVE_FAILURES = 3;

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
  sessionId: string;
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
  /** 재시도 버튼이 누른 횟수. 값이 바뀌면 아래 effect 가 처음부터 다시 돈다. */
  const [retryToken, setRetryToken] = useState(0);

  // 차분 계산에 쓰는 직전 샘플. 세션이 바뀌면 버린다(호스트가 다르면 누적값도 무의미).
  const previousSampleRef = useRef<HostMetricsSample | null>(null);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setStatus('off');
      setMetrics(null);
      setUpdatedAtMs(null);
      previousSampleRef.current = null;
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
    if (previous && Date.now() - previous.atMs > POLL_INTERVAL_MS * 2) {
      previous = null;
      previousSampleRef.current = null;
    }
    let primed = previous !== null;

    setStatus(previous ? 'ready' : 'loading');

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
        stdout = await queryTerminalCompletion(sessionId, buildHostMetricsCommand());
      } catch {
        if (cancelled) {
          return;
        }
        // 첫 시도부터 실패하면 이 연결에는 보조 채널이 없다고 본다(SSM raw shell 등).
        // 그 경우 재시도해도 달라지지 않으므로 조용히 접는다.
        if (previous === null) {
          setStatus('unsupported');
          return;
        }
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          setStatus('paused');
          return;
        }
        schedule(POLL_INTERVAL_MS);
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
        return;
      }

      failures = 0;
      setMetrics(computeHostMetrics(sample, previous));
      setUpdatedAtMs(sample.atMs);
      setStatus('ready');
      previous = sample;
      previousSampleRef.current = sample;

      if (!primed) {
        // 두 번째 샘플을 곧바로 찍어 CPU·네트워크 칸을 채운다. 30초를 빈칸으로 두면
        // 고장으로 보인다.
        primed = true;
        schedule(PRIMING_DELAY_MS);
        return;
      }
      schedule(POLL_INTERVAL_MS);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // visible 이 바뀌면 effect 가 재시작되며 타이머가 정리된다 = 안 보이는 탭은 폴링하지 않는다.
  }, [enabled, retryToken, sessionId, visible]);

  // 세션이 바뀌면 누적 카운터 기준이 달라지므로 직전 샘플을 버린다.
  useEffect(() => {
    previousSampleRef.current = null;
  }, [sessionId]);

  return { status, metrics, updatedAtMs, retry };
}
