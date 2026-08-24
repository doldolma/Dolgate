// 패널이 호스트 지표를 보는 경로.
//
// 폴링은 pane 안의 useHostMetrics 가 하나만 돌린다 — 여기서 또 돌리면 같은 서버에 두 배로
// 나간다. 그래서 이 훅은 **읽기만** 하고, 대신 "지금 보고 있다" 를 레지스트리에 남겨 주기를
// 좁히고(3초) 필요하면 프로세스 목록을 명령에 얹게 한다. 언마운트되면 요청이 풀려 원래
// 주기(10초)로 돌아간다.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  getHostMetricsSnapshot,
  getHostMetricsVersion,
  subscribeHostMetrics,
  watchHostMetrics,
  type HostMetricsSnapshot,
} from '../../../lib/host-metrics-registry';

export function useSessionHostMetrics(
  sessionId: string,
  options: { processes?: boolean; system?: boolean } = {},
): HostMetricsSnapshot {
  const wantsProcesses = options.processes === true;
  // 정적 정보(호스트명·커널·아키텍처·CPU 종류)는 자원 섹션이 열릴 때 한 번만 받아 캐시한다 —
  // 이미 받아 둔 세션에서는 레지스트리가 요청을 걸러 낸다.
  const wantsSystem = options.system === true;

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    return watchHostMetrics(sessionId, {
      processes: wantsProcesses,
      system: wantsSystem,
    });
  }, [sessionId, wantsProcesses, wantsSystem]);

  const subscribe = useCallback(
    (onChange: () => void) => subscribeHostMetrics(sessionId, onChange),
    [sessionId],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => getHostMetricsVersion(sessionId),
    () => 0,
  );
  return useMemo(
    () => getHostMetricsSnapshot(sessionId),
    // version 이 스냅샷이다.
    [sessionId, version],
  );
}
