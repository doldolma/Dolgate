// 레이아웃이 애니메이션으로 움직이는 동안 터미널 fit 을 붙잡아 두는 아주 작은 신호대.
//
// 왜 필요한가: 세션 패널은 터미널과 flex 형제라, 패널 폭이 프레임마다 바뀌면 터미널의
// ResizeObserver 도 프레임마다 발화한다. 그러면 150ms 사이에 fit 이 열 번 돌고 격자가 바뀔
// 때마다 PTY(그리고 tmux client)에 리사이즈가 쏟아진다 — SIGWINCH 폭풍이다.
//
// 그래서 전환 동안에는 fit 을 미루고, 전환이 끝나면 **한 번만** 돌린다. 그 사이 터미널은 예전
// 격자를 유지하므로 컨테이너가 좁아지는 만큼 잘려 보인다(0.15초). 폭이 확정된 뒤 한 번
// 맞추므로 셸이 보는 크기는 늘 화면과 같다.

/** 지금 붙잡고 있는 전환이 끝나는 시각(performance.now 기준). 없으면 0. */
let heldUntil = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

/**
 * 레이아웃 전환을 시작한다 — `durationMs` 동안 fit 을 미루고, 끝나면 구독자에게 알린다.
 *
 * 겹쳐 부르면 늦게 끝나는 쪽으로 늘어난다(패널을 연달아 여닫는 경우).
 */
export function beginLayoutTransition(durationMs: number): void {
  const end = performance.now() + durationMs;
  if (end <= heldUntil && timer !== null) {
    return;
  }
  heldUntil = end;
  if (timer !== null) {
    window.clearTimeout(timer);
  }
  timer = window.setTimeout(() => {
    timer = null;
    heldUntil = 0;
    for (const listener of [...listeners]) {
      listener();
    }
  }, durationMs);
}

/** 지금 fit 을 미뤄야 하는가. */
export function isLayoutTransitionActive(): boolean {
  return heldUntil > 0 && performance.now() < heldUntil;
}

/** 전환이 끝나면 부른다 — 그때 fit 을 한 번 돌리는 것이 구독자의 몫이다. */
export function subscribeToLayoutTransitionEnd(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 테스트용 초기화. */
export function resetLayoutTransition(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  heldUntil = 0;
  listeners.clear();
}
