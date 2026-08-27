import type { TerminalConnectionStage } from '@shared';

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

/**
 * 서버가 보낸 커서 모양.
 *
 * `width`·`height` 가 0 이면 "커서를 숨겨라" 는 뜻이다(서버가 커서를 감출 때 그렇게 알린다).
 * 픽셀은 RGBA 이고 **투명한 부분은 알파가 0** 이다 — 화면 프레임과 달리 알파가 의미를 갖는다.
 */
export interface VncCursorPayload {
  sessionId: string;
  /** 모양 안에서 실제 포인터가 되는 점. CSS 커서의 핫스팟과 같은 뜻이다. */
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * 이 세션에서 **실제로 켜진** 확장.
 *
 * 우리는 늘 같은 목록을 선언하지만 켜지는 것은 서버마다 다르다. 사용자에게 이걸 보여주는 것이
 * "왜 한글 복붙이 안 되지" 같은 물음에 답하는 유일한 방법이다 — 서버가 UTF-8 클립보드를 지원하지
 * 않으면 우리가 할 수 있는 일이 없고, 그 사실은 협상이 끝나 봐야 안다.
 */
export interface VncCapabilities {
  /** UTF-8 클립보드. 꺼져 있으면 고전 latin-1 이라 한글을 담을 수 없다. */
  extendedClipboard: boolean;
  /** 창 크기에 맞춰 원격 해상도를 바꿀 수 있나. */
  desktopResize: boolean;
  /** 커서 모양을 따로 받아 우리가 그리나. */
  cursor: boolean;
  /** 요청 없이 서버가 계속 보내나. */
  continuousUpdates: boolean;
  /** 스캔코드로 키를 보내나(QEMU 확장 키). 꺼져 있으면 keysym 으로만 보낸다. */
  qemuKeys: boolean;
  /** 통로가 TLS 인가(VeNCrypt). */
  tls: boolean;
  /** 서버가 화면에 실제로 쓰는 인코딩. 아직 픽셀을 못 받았으면 빈 문자열이다. */
  encoding: string;
}

/**
 * 붙는 동안 지나가는 관문.
 *
 * `TerminalConnectionStage` 에서 뽑아 쓴다 — 탭의 `connectionProgress` 로 그대로 들어가고 연결
 * 화면의 단계 목록이 그 이름으로 판정하므로, 여기서 문자열을 따로 만들면 두 곳이 어긋난다.
 * (컴파일러가 소속을 검사하게 두는 것이 목적이다.)
 */
export type VncConnectStage = Extract<
  TerminalConnectionStage,
  'ssh-tunnel-gateway' | 'ssh-tunnel-open' | 'connecting'
>;

export type VncSessionEvent =
  | { type: 'connected'; sessionId: string; payload: VncConnectedPayload }
  | {
      /**
       * 아직 붙는 중이고 지금 이 관문에 있다.
       *
       * 직접 붙을 때는 `connecting` 하나만 온다. 경유(tailnet·SSH 터널)를 거치면 그 앞에 관문이
       * 더 있고, 거기서 막히는 일이 실제로 흔하다 — 어디까지 갔는지 말해 주지 않으면 화면은
       * 그냥 멈춘 것으로 보인다.
       */
      type: 'progress';
      sessionId: string;
      stage: VncConnectStage;
      message: string;
    }
  | { type: 'capabilities'; sessionId: string; payload: VncCapabilities }
  | {
      /**
       * 고전 클립보드로 보내면서 담을 수 없는 글자를 `?` 로 바꿨다.
       *
       * 서버가 UTF-8 확장을 지원하지 않을 때만 온다. 알리지 않으면 한글 복사가 조용히 망가진다 —
       * 사용자는 원격에 `?` 가 붙는 것만 보고 이유를 알 수 없다.
       */
      type: 'clipboardLossy';
      sessionId: string;
      replaced: number;
    }
  | {
      type: 'resized';
      sessionId: string;
      desktopWidth: number;
      desktopHeight: number;
    }
  | {
      type: 'error';
      sessionId: string;
      message: string;
      /**
       * 코어가 판정한 실패 원인 코드(`ErrorPayload.failure`).
       *
       * 문구를 다시 뜯지 않기 위해 함께 싣는다 — 소켓 원인은 errno 로(core_framing::neterr),
       * 인증 실패는 프로토콜에서(vnc-core 의 src/failure.rs) 코어가 이미 판정했다. 원인을
       * 모르면 없다.
       */
      failure?: string | null;
    }
  | { type: 'closed'; sessionId: string };

/**
 * 렌더러 → vnc-core 입력.
 *
 * 좌표는 이미 원격 데스크톱 픽셀로 환산해서 보낸다 — 캔버스 표시 배율은 렌더러 사정이다(RDP 와
 * 같은 규칙).
 *
 * **키는 X11 keysym 이다.** 렌더러가 `components/vnc/keysym.ts` 로 변환해서 보낸다. 서버가 QEMU
 * 확장 키를 쓰면 스캔코드(RDP 와 같은 표)도 함께 실어 보낸다.
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
  | {
      kind: 'key';
      keysym: number;
      pressed: boolean;
      /**
       * PS/2 set 1 스캔코드. 서버가 QEMU 확장 키를 쓸 때만 실제로 나간다(코어가 판단한다).
       *
       * keysym 으로 표현할 수 없는 키가 있어서 함께 보낸다 — 한/영·한자 키, 그리고 같은 keysym 에
       * 여러 물리 키가 걸리는 경우다. 모르는 키는 0(생략)이고 그때는 keysym 만 쓰인다.
       */
      keycode?: number;
    };
