import { useEffect, useRef } from 'react';
import type { VncFramePayload } from '@shared';

import { createFrameSurface, type FrameSurface } from '../rdp/frame-surface';
import { refreshVncScreen, subscribeVncFrames } from '../../services/desktop/vnc';

/**
 * VNC 화면을 캔버스에 그린다.
 *
 * **표면 구현은 RDP 것을 그대로 쓴다**(`rdp/frame-surface`). 그 계약이 "사각형 + 빽빽한 RGBA" 이고
 * RFB 의 FramebufferUpdate 가 정확히 같은 모양이라, 프로토콜을 아는 코드가 한 줄도 필요 없다.
 *
 * RDP 훅과 다른 점은 영역(모니터별 창) 개념이 없는 것뿐이다 — RFB 는 프레임버퍼가 하나이고, 여러
 * 화면으로 펼치는 것은 나중에 이 하나를 잘라 쓰는 방식으로 붙인다.
 */
export function useVncCanvas(
  sessionId: string,
  desktopWidth: number | null,
  desktopHeight: number | null,
  visible: boolean,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<FrameSurface | null>(null);
  // 콜백에서 읽는 값은 ref 로 둔다. 상태로 읽으면 값이 바뀔 때마다 구독을 다시 걸어야 하고, 그
  // 사이에 도착한 프레임을 놓친다.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const surface = createFrameSurface(canvas);
    surfaceRef.current = surface;
    return () => {
      surface?.dispose();
      surfaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!desktopWidth || !desktopHeight) {
      return;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      // 캔버스 픽셀 크기를 원격 해상도에 맞춘다. CSS 크기는 스타일이 정한다(비율 유지).
      canvas.width = desktopWidth;
      canvas.height = desktopHeight;
    }
    // 누적본을 새로 만든다(=비운다). 크기가 바뀌면 이전 화면은 무효다.
    surfaceRef.current?.resize(desktopWidth, desktopHeight);
    if (visibleRef.current) {
      surfaceRef.current?.repaint(0, 0, desktopWidth, desktopHeight);
    }
    // **그림을 잃었으니 다시 달라고 한다.**
    //
    // 이 효과는 `resized` 이벤트가 스토어를 거쳐 리렌더된 뒤에 실행된다. 그 사이에 도착한 프레임은
    // 옛 크기 누적본에 쌓였다가 위 resize 에서 통째로 버려진다 — 화면은 위쪽부터 오므로 **위가
    // 검게** 남았다. 서버는 정적인 영역을 다시 보내지 않아서, 클릭 같은 것으로 그 영역이 더러워질
    // 때까지 검은 채로 있었다.
    if (sessionId) {
      refreshVncScreen(sessionId);
    }
  }, [desktopWidth, desktopHeight, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const draw = (frame: VncFramePayload) => {
      const surface = surfaceRef.current;
      if (!surface) {
        return;
      }
      const expected = frame.width * frame.height * 4;
      if (frame.pixels.length < expected) {
        // 잘린 프레임을 그리면 화면이 깨진 채 남는다. 버리면 다음 갱신이 덮어쓴다.
        return;
      }

      // 숨어 있는 동안에도 누적본은 갱신한다 — 빠뜨리면 탭으로 돌아왔을 때 그 사이 변경분이
      // 비어 보인다.
      surface.store(frame.x, frame.y, frame.width, frame.height, frame.pixels);
      if (!visibleRef.current) {
        return;
      }
      // 영역을 쪼개지 않으므로 읽는 자리와 쓰는 자리가 같다.
      surface.present({
        sourceX: frame.x,
        sourceY: frame.y,
        destX: frame.x,
        destY: frame.y,
        width: frame.width,
        height: frame.height,
      });
    };

    // 세션이 바뀔 때만 다시 건다. 나머지는 ref 로 읽는다(위 주석 참고).
    return subscribeVncFrames(sessionId, draw);
  }, [sessionId]);

  /** 탭으로 돌아왔을 때 누적본에서 화면 전체를 다시 칠한다. */
  useEffect(() => {
    if (!visible || !desktopWidth || !desktopHeight) {
      return;
    }
    surfaceRef.current?.repaint(0, 0, desktopWidth, desktopHeight);
  }, [visible, desktopWidth, desktopHeight]);

  return { canvasRef };
}
