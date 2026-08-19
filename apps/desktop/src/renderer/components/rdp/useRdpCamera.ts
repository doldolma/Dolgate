import { useEffect, useRef, useState } from "react";
import type { RdpSessionEvent } from "@shared";
import { sendRdpCameraFrame, subscribeRdpEvents } from "../../services/desktop/rdp";

/**
 * `MediaStreamTrackProcessor` 는 Chromium 전용이라 TypeScript 의 DOM 타입에 없다.
 *
 * 표준(Insertable Streams)이 아직 아닌데도 쓰는 이유는, 카메라 프레임을 **한 장씩** 꺼내는
 * 다른 방법이 없기 때문이다 — canvas 로 그려 내면 GPU→CPU 복사가 한 번 더 붙고 프레임 타이밍도
 * 잃는다. Electron(Chromium)에서만 도는 코드이므로 여기서 필요한 만큼만 선언한다.
 */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

/** 카메라를 쓸 수 없는 이유. 마이크와 같은 집합이라 문구 규칙도 같다. */
export type CameraProblem = "denied" | "noDevice" | "failed" | "serverRefused";

/** 서버가 정한 캡처 사양. `cameraStart` 이벤트로 온다. */
interface CaptureFormat {
  width: number;
  height: number;
  fps: number;
}

/**
 * 인코더 비트레이트. 720p30 기준으로 잡고 해상도·프레임레이트에 비례해 조정한다.
 *
 * SSM 터널 경로는 실측 상한이 1MB/s 라서 4Mbps 급을 그대로 흘리면 화면(EGFX)까지 같이 굶는다.
 * 화상 통화 화질로는 720p30 2Mbps 가 통상적인 타협점이다.
 */
const BITRATE_PER_PIXEL_PER_FRAME = 2_000_000 / (1280 * 720 * 30);

/**
 * 이 해상도·프레임레이트를 담을 수 있는 H.264 코덱 문자열.
 *
 * **레벨을 크기에 맞춰야 한다.** Constrained Baseline 은 프로필이지 한도가 아니고, 레벨이 낮으면
 * 인코더가 설정 자체를 거부한다 — Level 3.0 은 초당 40,500 매크로블록까지라 720p30(108,000)을
 * 담지 못한다. 프로필을 Baseline 으로 두는 것은 원격 디코더의 폭이 가장 넓기 때문이다.
 *
 * 값의 뒤 두 자리가 level_idc 다: 1F=3.1, 28=4.0, 2A=4.2.
 */
function codecFor(width: number, height: number, fps: number): string {
  // 매크로블록은 16×16 이다. 규격의 한도가 이 단위로 정의돼 있다.
  const macroblocksPerSecond =
    Math.ceil(width / 16) * Math.ceil(height / 16) * Math.max(1, fps);
  if (macroblocksPerSecond <= 108_000) {
    return "avc1.42E01F"; // Level 3.1 — 1280x720@30 까지
  }
  if (macroblocksPerSecond <= 245_760) {
    return "avc1.42E028"; // Level 4.0 — 1920x1080@30 까지
  }
  return "avc1.42E02A"; // Level 4.2
}

/**
 * 로컬 카메라를 잡아 원격으로 보낸다(MS-RDPECAM).
 *
 * **서버가 당겨 간다.** 서버가 프레임 한 장을 허락하면(`cameraCredit`) 그때 한 장을 인코딩해
 * 보낸다. H.264 는 인코딩된 프레임을 버릴 수 없으므로(참조 사슬이 끊긴다) **버리는 것은
 * 인코딩 전에** 한다 — 허락이 없으면 카메라가 준 원본 프레임을 그대로 닫는다. 원본을 버리는
 * 것은 무해하고, 이렇게 하면 지연도 쌓이지 않는다.
 *
 * 캡처·인코딩이 여기 있는 이유: 브라우저가 하드웨어 H.264 인코더(WebCodecs)를 이미 준다.
 * 코어에 인코더를 넣지 않아도 되고, 무압축을 보내면 어떤 경로에서도 대역폭이 감당되지 않는다.
 */
export function useRdpCamera(
  sessionId: string,
  enabled: boolean,
  deviceId?: string | null,
): { active: boolean; problem: CameraProblem | null } {
  const [format, setFormat] = useState<CaptureFormat | null>(null);
  const [active, setActive] = useState(false);
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  /** 서버가 허락한 장 수. 렌더 주기와 무관하게 즉시 읽고 써야 해서 ref 다. */
  const creditRef = useRef(0);
  const teardownRef = useRef<(() => void) | null>(null);

  // 1) 서버의 신호를 기다린다.
  useEffect(() => {
    if (!enabled) {
      setFormat(null);
      creditRef.current = 0;
      return;
    }
    return subscribeRdpEvents((event: RdpSessionEvent) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.type === "cameraStart") {
        const payload = event.payload as {
          width?: number;
          height?: number;
          fps?: number;
        };
        if (
          typeof payload.width !== "number" ||
          typeof payload.height !== "number" ||
          payload.width < 16 ||
          payload.height < 16
        ) {
          return;
        }
        creditRef.current = 0;
        setFormat({
          width: payload.width,
          height: payload.height,
          // 서버가 0 을 주는 경우가 있다(분모가 0). 그때는 통상값으로 잡는다.
          fps: typeof payload.fps === "number" && payload.fps > 0 ? payload.fps : 30,
        });
        return;
      }
      if (event.type === "cameraStop") {
        creditRef.current = 0;
        setFormat(null);
        return;
      }
      if (event.type === "cameraCredit") {
        const payload = event.payload as { credit?: number };
        creditRef.current += typeof payload.credit === "number" ? payload.credit : 1;
      }
    });
  }, [enabled, sessionId]);

  // 2) 사양이 오면 카메라를 열고 허락에 맞춰 인코딩한다.
  useEffect(() => {
    if (!enabled || !format) {
      return;
    }
    let cancelled = false;

    const start = async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            // 서버가 정한 사양을 요청한다. 못 맞추면 브라우저가 가까운 값을 주고, 아래에서
            // 실제 프레임 크기로 인코더를 설정한다.
            width: { ideal: format.width },
            height: { ideal: format.height },
            frameRate: { ideal: format.fps },
          },
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const name = error instanceof DOMException ? error.name : "";
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "noDevice"
              : "failed",
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const track = stream.getVideoTracks()[0];
      if (!track || typeof MediaStreamTrackProcessor === "undefined") {
        stream.getTracks().forEach((item) => item.stop());
        setProblem("failed");
        return;
      }

      const settings = track.getSettings();
      const width = settings.width ?? format.width;
      const height = settings.height ?? format.height;
      const fps = Math.max(1, Math.round(settings.frameRate ?? format.fps));

      let encoder: VideoEncoder;
      try {
        encoder = new VideoEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            // 이 시점의 프레임은 이미 허락을 쓴 것이다(아래 encode 직전에 깎는다).
            sendRdpCameraFrame(sessionId, data.buffer);
          },
          error: () => setProblem("failed"),
        });
        encoder.configure({
          codec: codecFor(width, height, fps),
          width,
          height,
          framerate: fps,
          bitrate: Math.round(width * height * fps * BITRATE_PER_PIXEL_PER_FRAME),
          latencyMode: "realtime",
          // **Annex B 여야 한다.** MS-RDPECAM 은 start code 가 붙은 NAL 스트림을 기대한다.
          avc: { format: "annexb" },
        });
      } catch {
        stream.getTracks().forEach((item) => item.stop());
        setProblem("failed");
        return;
      }

      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      let stopped = false;
      /** 키프레임 간격. 서버가 늦게 붙거나 프레임을 놓쳐도 이 주기로 복구된다. */
      const keyFrameEvery = fps * 2;
      let encoded = 0;

      const pump = async () => {
        while (!stopped) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) {
            break;
          }
          // **허락이 없으면 인코딩하지 않고 버린다.** 원본을 버리는 것은 무해하다.
          if (creditRef.current <= 0) {
            frame.close();
            continue;
          }
          creditRef.current -= 1;
          try {
            encoder.encode(frame, { keyFrame: encoded % keyFrameEvery === 0 });
            encoded += 1;
          } catch {
            // 인코더가 죽었다. 아래 정리로 넘긴다.
            frame.close();
            break;
          }
          frame.close();
        }
      };
      void pump();

      setActive(true);
      setProblem(null);
      teardownRef.current = () => {
        stopped = true;
        void reader.cancel().catch(() => undefined);
        if (encoder.state !== "closed") {
          encoder.close();
        }
        stream.getTracks().forEach((item) => item.stop());
      };
    };

    void start();

    return () => {
      cancelled = true;
      teardownRef.current?.();
      teardownRef.current = null;
      setActive(false);
    };
  }, [enabled, format, sessionId, deviceId]);

  return { active, problem };
}
