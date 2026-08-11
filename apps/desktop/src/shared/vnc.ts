// VNC(RFB) 세션에서 메인 ↔ 렌더러가 주고받는 것들.
//
// RDP 와 같은 자리에 같은 모양으로 둔다(shared/rdp.ts). 다른 점은 RFB 에 없는 것들이 빠진 것뿐이다
// — 오디오·드라이브·모니터 배치 협상이 없다.

export interface VncConnectedPayload {
  desktopWidth: number;
  desktopHeight: number;
  /** 서버가 붙인 세션 이름(ServerInit). 탭 제목 후보다. */
  name: string;
}

/** 갱신된 사각형. `pixels` 는 `width * height * 4` 바이트의 RGBA 이고 빽빽하게 채워져 있다. */
export interface VncFramePayload {
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export type VncSessionEvent =
  | { type: 'connected'; sessionId: string; payload: VncConnectedPayload }
  | {
      type: 'resized';
      sessionId: string;
      desktopWidth: number;
      desktopHeight: number;
    }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'closed'; sessionId: string };

/**
 * 렌더러 → vnc-core 입력.
 *
 * 좌표는 이미 원격 데스크톱 픽셀로 환산해서 보낸다 — 캔버스 표시 배율은 렌더러 사정이다(RDP 와
 * 같은 규칙).
 *
 * **키는 X11 keysym 이다.** RDP 의 스캔코드와 다른 체계이고, 렌더러가
 * `components/vnc/keysym.ts` 로 변환해서 보낸다.
 */
export type VncInputEvent =
  | { kind: 'mouseMove'; x: number; y: number }
  | {
      kind: 'mouseButton';
      /** 0=왼쪽, 1=가운데, 2=오른쪽. */
      button: number;
      pressed: boolean;
      x: number;
      y: number;
    }
  | {
      kind: 'wheel';
      vertical: boolean;
      /** 방향만 쓴다 — RFB 는 휠을 버튼 누름으로 표현하므로 단계 수가 없다. */
      delta: number;
      x: number;
      y: number;
    }
  | { kind: 'key'; keysym: number; pressed: boolean };
