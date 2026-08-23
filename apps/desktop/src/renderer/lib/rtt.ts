// keepalive 왕복 지연(RTT) 표시 규칙.
//
// 코어가 keepalive 로 잰 값이 `latency` 이벤트로 올라와 세션별 `tab.lastRttMs` 에 쌓인다
// (sshsession/tmuxsession manager 의 sendKeepAliveProbe, AWS SSM 은 ssmdatachannel).
// 그 값을 보여주는 곳이 여럿(타이틀바 탭 hover · 하단 상태바 · 그 hover 의 스파크라인)이라
// 임계값을 여기 한 곳에 둔다 — 각자 숫자를 들고 있으면 같은 연결이 화면마다 다른 색이 된다.

/** 빠름 / 보통 / 느림. 스파크라인은 구간마다 이 값으로 색을 고른다. */
export type RttBand = 'fast' | 'medium' | 'slow';

export function rttBand(ms: number): RttBand {
  if (ms < RTT_FAST_MS) {
    return 'fast';
  }
  if (ms < RTT_SLOW_MS) {
    return 'medium';
  }
  return 'slow';
}

/** 빠름 초록 / 보통 주황 / 느림 빨강. */
export function rttBandColor(band: RttBand): string {
  if (band === 'fast') {
    return 'var(--success,#3fae8f)';
  }
  if (band === 'medium') {
    return 'var(--warning-text)';
  }
  return 'var(--danger,#e2504a)';
}

/** 경계는 80ms · 200ms. */
export function rttColor(ms: number): string {
  return rttBandColor(rttBand(ms));
}

/** 둘 중 더 나쁜 쪽. 선의 한 구간은 양 끝점 중 나쁜 쪽 색으로 그린다. */
export function worseRttBand(left: RttBand, right: RttBand): RttBand {
  const order: RttBand[] = ['fast', 'medium', 'slow'];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

export const RTT_FAST_MS = 80;
export const RTT_SLOW_MS = 200;
