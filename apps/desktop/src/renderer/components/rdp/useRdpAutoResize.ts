import { useEffect, useRef } from "react";
import { requestRdpResize } from "../../services/desktop/rdp";

/**
 * 창 크기가 멈춘 뒤 요청을 보내기까지 기다리는 시간(ms).
 *
 * 서버가 해상도 변경을 받아들일 때마다 deactivation-reactivation 왕복이 일어나고, 그동안
 * 화면이 잠깐 멎는다. 드래그 중간값마다 보내면 드래그가 끝난 뒤로도 한참 재협상만 한다.
 */
const RESIZE_SETTLE_MS = 400;

/** [MS-RDPEDISP] 2.2.2.2.1 의 허용 범위. 벗어나면 서버가 요청 전체를 버린다. */
const MIN_SIDE = 200;
const MAX_SIDE = 8192;

function clampSide(value: number, even: boolean): number {
  const rounded = Math.round(value);
  const clamped = Math.min(MAX_SIDE, Math.max(MIN_SIDE, rounded));
  // 폭은 홀수를 허용하지 않는다.
  return even && clamped % 2 !== 0 ? clamped - 1 : clamped;
}

/**
 * pane 크기에 맞춰 원격 해상도를 따라가게 한다.
 *
 * 이게 없으면 원격 해상도가 접속 시점 값으로 고정되어, 창을 키우면 화면이 확대되기만 하고
 * 작업 공간은 그대로다.
 */
export function useRdpAutoResize(
  sessionId: string,
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const timerRef = useRef<number | null>(null);
  // 마지막으로 보낸 크기. 같은 값을 다시 보내면 서버가 불필요한 재활성화를 한 번 더 한다.
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

      // 캔버스가 화면에서 차지하는 크기 그대로 요청한다.
      //
      // 배율을 곱하면 원격 데스크톱이 보이는 것보다 훨씬 넓어진다 — 배율 2 화면이면 네 배다.
      // 글자가 깨알같이 작아지고, 화면 갱신도 네 배로 늘어 소리까지 그 뒤로 밀린다.
      const width = clampSide(entry.contentRect.width, true);
      const height = clampSide(entry.contentRect.height, false);

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
        requestRdpResize(sessionId, width, height);
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
