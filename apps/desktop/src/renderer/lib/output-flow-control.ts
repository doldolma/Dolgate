/**
 * 출력 흐름 제어의 렌더러 쪽.
 *
 * 받은 출력 중 화면이 처리를 끝낸 양을 코어에 알린다. 코어는 알리지 않은 양이 1MB 를 넘으면 그
 * 세션의 읽기를 멈춰, 출력하던 프로그램이 화면 속도에 맞춰 기다리게 한다. 그래서 출력이 쏟아져도
 * 렌더러에 쌓이는 양이 그 안에 머물고, Ctrl+C 뒤 프롬프트가 바로 돌아온다.
 *
 * 처리한 양 = 받은 양 − 아직 처리하지 않은 양(런타임 큐, xterm 에 넘긴 것, 런타임이 생기기 전 대기분).
 * ZMODEM 이 삼킨 바이트(`sz` 다운로드)는 대기분에 들어가지 않으므로 받자마자 처리된 것으로 친다 —
 * xterm 쓰기 완료만 세면 다운로드가 멈춘다.
 */

/**
 * 이만큼 처리할 때마다 알린다. 코어의 하한(256KB)보다 작아야 한다 — 알리지 않고 남겨 두는 양이 늘
 * 이보다 작아서, 화면이 다 따라잡으면 코어가 반드시 다시 읽는다.
 */
export const OUTPUT_ACK_STEP_BYTES = 128 * 1024;

/**
 * 처리 중인데 이만큼 알리지 못했으면 0 바이트로라도 알린다. 코어는 멈춘 채 10초 동안 아무 말이 없으면
 * 렌더러가 사라진 것으로 보고 흐름 제어를 꺼 버린다(창이 다시 보일 때 쌓인 출력을 오래 그리는 동안).
 */
export const OUTPUT_HEARTBEAT_MS = 1000;

/**
 * 창이 안 보이는 동안 처리하지 못한 채 쌓여도 되는 양.
 *
 * 숨은 창은 타이머가 느려져 xterm 처리가 초당 1MB 아래로 떨어진다(최소화 실측 0.7MB/s). 그 속도대로
 * 알리면 창을 내려 둔 사이 백그라운드 빌드가 그 속도로 묶이므로, 쌓인 것 중 이만큼은 처리한 것으로 쳐
 * 준다. 그보다 쌓이면 코어가 읽기를 멈춰 메모리가 이 선에서 멈춘다 — 보통의 빌드 출력은 여기에 닿지
 * 않고, 쏟아지는 출력만 걸린다.
 */
export const OUTPUT_HIDDEN_BACKLOG_BYTES = 64 * 1024 * 1024;

export interface OutputFlowControlDeps {
  start: () => void;
  ack: (bytes: number) => void;
  stop: () => void;
  /** 받았지만 아직 처리하지 않은 출력. */
  pendingBytes: () => number;
  /** 창이 보이는가. 안 보이면 쌓인 것 중 OUTPUT_HIDDEN_BACKLOG_BYTES 까지는 처리한 것으로 친다. */
  isVisible: () => boolean;
  /**
   * 창이 숨었다(true)·다시 보인다(false)를 코어에 알린다. 바뀔 때만 부른다.
   *
   * 숨은 창은 타이머가 1분에 한 번으로 줄어 xterm 처리도, 0 바이트 ack 도 그만큼 뜸해진다. 코어는 멈춘
   * 채 10초 동안 답이 없으면 렌더러가 사라진 것으로 보고 푸는데, 숨은 창에서 그게 일어나 쏟아지는
   * 출력이 끝없이 쌓였다(최소화 7분에 2.3GB). 알려 주면 숨은 동안은 풀지 않고 기다린다.
   */
  setHidden: (hidden: boolean) => void;
  now?: () => number;
}

export interface OutputFlowControl {
  /** 세션 출력이 들어왔다(ZMODEM 이 삼킬 것까지 전부). */
  received: (bytes: number) => void;
  /** 처리 상태가 바뀌었을 수 있다 — 받은 직후, xterm 이 묶음을 처리한 뒤, 창이 보이거나 숨을 때. */
  settle: () => void;
  dispose: () => void;
}

export function createOutputFlowControl(deps: OutputFlowControlDeps): OutputFlowControl {
  const now = deps.now ?? (() => Date.now());
  let received = 0;
  let acked = 0;
  let lastAckAt = now();
  let disposed = false;
  // 코어에 마지막으로 알린 숨김 상태. 코어는 구독(start)할 때 보이는 창으로 시작한다.
  let reportedHidden = false;
  const reportVisibility = (visible: boolean) => {
    if (reportedHidden !== !visible) {
      reportedHidden = !visible;
      deps.setHidden(reportedHidden);
    }
  };

  deps.start();
  reportVisibility(deps.isVisible());

  return {
    received(bytes) {
      if (!disposed && bytes > 0) {
        received += bytes;
      }
    },
    settle() {
      if (disposed) {
        return;
      }
      const visible = deps.isVisible();
      reportVisibility(visible);
      const pending = Math.max(0, deps.pendingBytes());
      const unprocessed = visible ? pending : Math.max(0, pending - OUTPUT_HIDDEN_BACKLOG_BYTES);
      const processed = Math.max(acked, received - unprocessed);
      const delta = processed - acked;
      const at = now();
      if (delta >= OUTPUT_ACK_STEP_BYTES || (pending > 0 && at - lastAckAt >= OUTPUT_HEARTBEAT_MS)) {
        acked = processed;
        lastAckAt = at;
        deps.ack(delta);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      deps.stop();
    },
  };
}
