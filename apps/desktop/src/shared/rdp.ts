// RDP 세션 타입. rdp-core(services/rdp-core)의 protocol.rs와 짝을 이룬다.

export interface RdpMonitorRequest {
  width: number;
  height: number;
  left?: number;
  top?: number;
  primary?: boolean;
}

export interface RdpConnectOptions {
  share?: RdpDriveShare | null;
  host: string;
  port?: number;
  username: string;
  password: string;
  domain?: string | null;
  // 지금은 항목 1개만 허용한다. 멀티모니터가 붙으면 그대로 늘어난다.
  monitors: RdpMonitorRequest[];
}

/**
 * 배치도에 그릴 로컬 디스플레이 하나.
 *
 * 좌표는 모든 디스플레이가 공유하는 하나의 DIP 좌표계다 — 화면별 scaleFactor 를 곱하면 안 된다.
 * 주 디스플레이가 원점이라 다른 화면은 음수 좌표를 가질 수 있다.
 */
export interface RdpLocalMonitor {
  id: number;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** OS 가 정한 주 디스플레이. 선택에서 빠지면 고른 것 중 첫 번째가 주가 된다. */
  primary: boolean;
}

// 프레임버퍼 안에서 각 모니터가 차지하는 위치(0 기준).
export interface RdpMonitorPlacement {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RdpConnectedPayload {
  desktopWidth: number;
  desktopHeight: number;
  monitors: RdpMonitorPlacement[];
}

// 갱신된 사각형 하나. pixels는 width * height * 4 바이트 RGBA이고 이미 촘촘히 packed 되어
// 있어서 렌더러가 texSubImage2D/putImageData 로 바로 넘길 수 있다.
export interface RdpFramePayload {
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

// 렌더러 -> rdp-core 입력. 좌표는 이미 원격 데스크톱 픽셀로 환산해서 보낸다 —
// 캔버스 표시 배율은 렌더러 사정이고, 코어는 원격 해상도만 안다.
// 원격 오디오 한 조각. pcm 은 인터리브된 리틀엔디언 정수 샘플이다.
export interface RdpAudioPayload {
  sessionId: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestamp: number;
  pcm: Uint8Array;
}

// 원격에 공유할 로컬 폴더.
export interface RdpDriveShare {
  label: string;
  path: string;
  /** 원격이 이 폴더를 수정하지 못하게 한다. */
  readOnly: boolean;
}

export type RdpInputEvent =
  | { kind: 'mouseMove'; x: number; y: number }
  /**
   * OS 화면 좌표로 표현한 이동. 메인 프로세스가 데스크톱 좌표로 옮겨 mouseMove 로 바꿔 보낸다.
   *
   * 모니터마다 창을 펼쳤을 때 쓴다. 버튼을 누른 채 드래그하면 OS 가 이후 이벤트를 처음 누른
   * 창에만 보내므로, 그 창이 자기 캔버스 기준으로 환산하면 옆 모니터를 표현할 수 없다.
   * 화면 좌표는 어느 창이 받았든 같아서 그 문제가 없다.
   */
  | { kind: 'mouseMoveScreen'; screenX: number; screenY: number }
  | { kind: 'mouseButton'; button: number; pressed: boolean }
  | { kind: 'wheel'; vertical: boolean; delta: number }
  // scancode 는 확장 키를 0xE000 비트로 표현한 u16.
  | { kind: 'key'; scancode: number; pressed: boolean }
  | { kind: 'unicode'; character: string; pressed: boolean };

// 서버가 제시한 인증서. 사용자가 눈으로 대조할 수 있게 지문 외 식별 정보도 함께 준다.
export interface RdpCertificateInfo {
  fingerprint: string;
  subject: string;
  issuer: string;
  notAfter: string;
}

// 저장된 핀과 대조한 결과.
export type RdpCertificateStatus =
  // 처음 보는 서버 — 신뢰하면 지문을 저장한다.
  | 'unknown'
  // 저장된 지문과 다르다. 정상 재설치일 수도, 다른 기계일 수도 있다.
  | 'changed';

export interface RdpCertificatePrompt {
  sessionId: string;
  hostId: string;
  hostLabel: string;
  status: RdpCertificateStatus;
  certificate: RdpCertificateInfo;
  /** status가 'changed'일 때 이전에 신뢰했던 지문. */
  previousFingerprint?: string | null;
}

export type RdpSessionEvent =
  | { type: 'connected'; sessionId: string; payload: RdpConnectedPayload }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'closed'; sessionId: string }
  // 해상도가 실제로 바뀌었다. 캔버스와 누적 버퍼를 새 크기로 다시 만들어야 한다.
  | {
      type: 'resized';
      sessionId: string;
      desktopWidth: number;
      desktopHeight: number;
    }
  | { type: 'certificatePrompt'; sessionId: string; prompt: RdpCertificatePrompt }
  /**
   * 이 창이 맡을 화면 영역이 정해졌다. 모니터별로 창을 펼치거나 접을 때 온다.
   *
   * region 이 null 이면 데스크톱 전체를 그린다(평소 상태).
   */
  | {
      type: 'monitorRegion';
      sessionId: string;
      region: RdpMonitorPlacement | null;
    };
