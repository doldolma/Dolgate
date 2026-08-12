import { useEffect, useRef } from "react";
import { requestVncDesktopSize } from "../../services/desktop/vnc";

/**
 * 창 크기가 멈춘 뒤 요청을 보내기까지 기다리는 시간(ms).
 *
 * 서버가 크기를 바꿀 때마다 화면 전체를 다시 보내고(크기가 바뀌면 증분이 무효다) 원격 데스크톱도
 * 배치를 다시 잡는다. 드래그 중간값마다 보내면 드래그가 끝난 뒤로도 한참 그 왕복만 한다.
 */
const RESIZE_SETTLE_MS = 400;

/**
 * RFB 의 화면 크기는 16비트다. 그 위로 올려 보내면 잘려서 엉뚱한 크기가 요청된다.
 *
 * 아래쪽 하한은 규격이 아니라 실용이다 — 창을 아주 좁게 만든 순간에 1~2픽셀짜리 데스크톱을
 * 요청하면 원격 배치가 무너지고 되돌리기 어렵다.
 */
const MIN_SIDE = 64;
const MAX_SIDE = 65535;

function clampSide(value: number): number {
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value)));
}

/**
 * pane 크기에 맞춰 원격 화면 크기를 따라가게 한다.
 *
 * 이게 없으면 원격 해상도가 접속 시점 값으로 고정되어, 창을 키우면 화면이 확대되기만 하고 작업
 * 공간은 그대로다.
 *
 * **서버가 지원하지 않을 수 있다.** VNC 는 구현마다 되고 안 되고가 갈리고(실제 화면을 미러링하는
 * x11vnc 는 물리 해상도를 바꿀 수 없다), 그 판정은 코어가 협상 결과로 들고 있다. 그래서 여기서는
 * 지원 여부를 묻지 않고 그냥 요청하고, 코어가 조용히 버린다 — 렌더러가 그 상태를 또 들고 있으면
 * 두 곳이 어긋난다.
 */
export function useVncAutoResize(
  sessionId: string,
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const timerRef = useRef<number | null>(null);
  // 마지막으로 보낸 크기. 코어도 같은 검사를 하지만, 여기서 걸러 IPC 왕복을 줄인다.
  const lastSentRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      // 화면에서 차지하는 크기 그대로 요청한다. 배율을 곱하면 원격 데스크톱이 보이는 것보다
      // 훨씬 넓어져서(배율 2 면 네 배) 글자가 깨알같이 작아지고 갱신량도 네 배가 된다.
      const width = clampSide(entry.contentRect.width);
      const height = clampSide(entry.contentRect.height);

      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const last = lastSentRef.current;
        if (last && last.width === width && last.height === height) {
          return;
        }
        lastSentRef.current = { width, height };
        requestVncDesktopSize(sessionId, width, height);
      }, RESIZE_SETTLE_MS);
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionId, containerRef, enabled]);
}
