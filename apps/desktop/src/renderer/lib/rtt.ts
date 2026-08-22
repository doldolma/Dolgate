// keepalive 왕복 지연(RTT) 표시 규칙.
//
// 코어가 keepalive 로 잰 값이 `latency` 이벤트로 올라와 세션별 `tab.lastRttMs` 에 쌓인다
// (sshsession/tmuxsession manager 의 sendKeepAliveProbe, AWS SSM 은 ssmdatachannel).
// 그 값을 보여주는 곳이 둘로 늘어나서(타이틀바 탭 인디케이터 · pane 헤더) 임계값을
// 여기 한 곳에 둔다 — 양쪽이 각자 숫자를 들고 있으면 같은 연결이 화면마다 다른 색이 된다.

/** 빠름 초록 / 보통 주황 / 느림 빨강. 경계는 80ms · 200ms. */
export function rttColor(ms: number): string {
  if (ms < RTT_FAST_MS) {
    return 'var(--success,#3fae8f)';
  }
  if (ms < RTT_SLOW_MS) {
    return 'var(--warning-text)';
  }
  return 'var(--danger,#e2504a)';
}

export const RTT_FAST_MS = 80;
export const RTT_SLOW_MS = 200;
