import { useEffect, useRef } from "react";
import type { RdpFramePayload } from "@shared";
import { subscribeRdpFrames } from "../../services/desktop/rdp";
import { clipToRegion, visibleSize, type RdpCanvasRegion } from "./canvas-region";
import { createFrameSurface, type FrameSurface } from "./frame-surface";

// dirty rect 를 화면에 그린다.
//
// 픽셀은 store 를 거치지 않는다. 프레임 하나가 수백 KB 라 상태로 올리면 React 렌더가 따라오지
// 못하고, 어차피 화면 말고는 쓸 곳이 없다. preload 구독 -> 표면으로 직결한다.
//
// 누적본을 따로 들고 있는다. RDP 는 변경된 사각형만 보내므로 보이는 화면이 어떤 이유로든
// 비워지면(크기 재설정, 탭 전환) 정적인 영역은 서버가 다시 보내주지 않아 검은 화면으로 남는다.
// 누적본에서 되칠하는 것이 유일한 복구 수단이다.
//
// 누적본을 어디에 두는지는 표면 구현이 정한다 — WebGL2 면 GPU 텍스처 자체이고, 그 경우 픽셀은
// 한 번만 복사된다.
export function useRdpCanvas(
  sessionId: string | null,
  width: number | null,
  height: number | null,
  visible: boolean,
  /**
   * 이 캔버스가 맡을 데스크톱의 일부. null 이면 전체를 그린다.
   *
   * 모니터마다 창을 띄울 때 쓴다. 누적본은 언제나 데스크톱 전체 크기다 — 다른 모니터의
   * 갱신도 계속 들어오고, 창을 옮기거나 배치가 바뀌면 그 내용이 필요해진다.
   */
  region?: RdpCanvasRegion | null,
): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<FrameSurface | null>(null);

  // 그리기에 필요한 값들은 ref 로 들고 간다.
  //
  // 이것들을 구독 effect 의 의존성에 넣으면 크기나 영역이 바뀔 때마다 구독을 해제했다 다시
  // 건다. 재구독마다 메인 프로세스가 이 창을 새로 붙은 창으로 보고 전체 화면을 다시 보내면
  // 그것만으로 파이프가 막힌다.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const regionRef = useRef<RdpCanvasRegion | null>(region ?? null);
  regionRef.current = region ?? null;

  // 영역은 객체라 렌더마다 신원이 바뀔 수 있다. 원시값으로 풀어서 의존성에 넣는다 — 객체로
  // 넣으면 매 렌더마다 effect 가 돌고, 캔버스 크기 대입이 화면을 지운다.
  const regionLeft = region?.left ?? null;
  const regionTop = region?.top ?? null;
  const regionWidth = region?.width ?? null;
  const regionHeight = region?.height ?? null;

  // 표면은 캔버스 하나에 하나. 캔버스가 살아 있는 동안 유지한다.
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

  // 누적본은 해상도가 바뀔 때만 다시 만든다. 다시 만들면 내용이 사라지므로 아껴야 한다.
  useEffect(() => {
    if (!width || !height) {
      return;
    }
    surfaceRef.current?.resize(width, height);
  }, [width, height]);

  // 보이는 캔버스의 크기를 맞추고, 누적본에서 즉시 되칠한다.
  //
  // width/height 대입은 그 자체로 캔버스를 지운다. 값이 같을 때 건너뛰는 것은 최적화가 아니라
  // 정확성 문제다 — 같은 값을 다시 넣어도 화면이 날아간다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) {
      return;
    }

    const view = visibleSize(width, height, region);
    if (canvas.width !== view.width || canvas.height !== view.height) {
      canvas.width = view.width;
      canvas.height = view.height;
    }

    if (visible) {
      surfaceRef.current?.repaint(
        regionLeft ?? 0,
        regionTop ?? 0,
        view.width,
        view.height,
      );
    }
    // region 은 원시값으로 풀어 넣는다(위 주석 참고).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, visible, regionLeft, regionTop, regionWidth, regionHeight]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const draw = (frame: RdpFramePayload) => {
      const surface = surfaceRef.current;
      if (!surface) {
        return;
      }

      const expected = frame.width * frame.height * 4;
      if (frame.pixels.length < expected) {
        // 잘린 프레임을 그리면 화면이 깨진 채 남는다. 버리면 다음 갱신이 덮어쓴다.
        return;
      }

      // 항상 누적본을 먼저 갱신한다. 탭이 숨어 있는 동안에도 화면은 계속 바뀌므로, 여기서
      // 빠뜨리면 돌아왔을 때 그 사이 변경분이 비어 보인다.
      surface.store(frame.x, frame.y, frame.width, frame.height, frame.pixels);

      if (!visibleRef.current) {
        return;
      }

      // 다른 모니터의 갱신은 여기서 걸린다. 누적본에는 이미 반영했으니 화면만 건너뛴다.
      const blit = clipToRegion(frame, regionRef.current);
      if (!blit) {
        return;
      }

      // 조각이 도착하는 대로 화면에 올린다.
      //
      // 프레임 경계(FrameMarker End)까지 모았다가 한 번에 올리는 쪽이 이론적으로는 맞지만,
      // 이 서버는 경계를 아예 보내지 않는다(실측 frames/s = 0). 기다려 봐야 안전장치 타이머가
      // 만료될 때까지 표시만 늦어진다.
      surface.present(blit);
    };

    // 세션이 바뀔 때만 다시 건다. 나머지는 ref 로 읽는다(위 주석 참고).
    return subscribeRdpFrames(sessionId, draw);
  }, [sessionId]);

  return { canvasRef };
}
