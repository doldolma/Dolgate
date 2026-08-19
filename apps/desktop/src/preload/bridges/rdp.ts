import type { IpcRenderer } from "electron";
import type {
  HostRecord,
  RdpConnectedPayload,
  RdpAudioPayload,
  RdpFramePayload,
  RdpInputEvent,
  RdpLocalMonitor,
  RdpSessionEvent,
} from "@shared";
import { ipcChannels } from "../../common/ipc-channels";
import { subscribeRdpAudio, subscribeRdpEvent, subscribeRdpFrame } from "../events/state";

export interface RdpBridge {
  connect: (
    sessionId: string,
    hostId: string,
    /** 원격 화면이 들어갈 자리의 크기. 없으면 메인이 창 크기로 대신한다. */
    viewport?: { width: number; height: number },
  ) => Promise<RdpConnectedPayload>;
  disconnect: (sessionId: string) => Promise<void>;
  sendInput: (sessionId: string, events: RdpInputEvent[]) => void;
  /**
   * 캡처한 마이크 PCM 을 코어로 보낸다. 협상된 사양의 리틀엔디언 16-bit PCM 이어야 한다
   * (사양은 `microphoneFormat` 이벤트로 온다).
   */
  sendMicrophoneAudio: (sessionId: string, chunk: ArrayBuffer) => void;
  /**
   * 인코딩된 카메라 프레임 한 장(H.264 Annex B).
   *
   * 입력·마이크와 같은 fire-and-forget 이다. **서버가 허락한 만큼만 보내야 한다** —
   * `cameraCredit` 이벤트가 그 허락이다.
   */
  sendCameraFrame: (sessionId: string, chunk: ArrayBuffer) => void;
  trustCertificate: (sessionId: string, accept: boolean) => Promise<void>;
  /**
   * 신뢰한 서버 인증서를 해제한다. 갱신된 호스트 레코드를 돌려준다(없거나 RDP 가 아니면 null).
   *
   * 설정 › Security 의 목록에서 쓴다. 해제하면 다음 접속에서 인증서를 다시 확인한다.
   */
  revokeCertificateTrust: (hostId: string) => Promise<HostRecord | null>;
  requestResize: (sessionId: string, width: number, height: number) => void;
  sendClipboardText: (sessionId: string, text: string) => void;
  syncClipboard: (sessionId: string) => void;
  /**
   * 원격 화면이 키보드를 잡았는지 알린다(캔버스 포커스 = true).
   *
   * 메인이 자기 단축키를 비켜 주는 데 쓴다. 렌더러가 스스로 못 하는 일이라 알려야 한다 —
   * Win/Linux 의 `before-input-event` 는 렌더러 도달 전이고, macOS 메뉴 accelerator 는 웹 페이지
   * 보다 먼저 매칭된다.
   */
  setKeyboardCapture: (active: boolean) => void;
  pickShareFolder: () => Promise<string | null>;
  /** 배치도 UI 가 그릴 로컬 디스플레이 목록. */
  listMonitors: () => Promise<RdpLocalMonitor[]>;
  /** 이미 붙어 있는 세션의 접속 정보. 모니터별 창이 뒤늦게 붙을 때 쓴다. */
  describeSession: (sessionId: string) => Promise<RdpConnectedPayload | null>;
  /** 지금 화면 전체를 한 번 더 보내게 한다. 도중에 붙는 창이 쓴다. */
  requestRefresh: (sessionId: string) => void;
  /** 원격 모니터를 물리 화면마다 펼친다. 메인 창이 맡을 모니터 번호를 돌려준다. */
  spreadMonitors: (sessionId: string) => Promise<number | null>;
  /** 펼친 창을 접고 메인 창을 데스크톱 전체 보기로 되돌린다. */
  collapseMonitors: (sessionId: string) => Promise<void>;
  onEvent: (listener: (event: RdpSessionEvent) => void) => () => void;
  // 픽셀은 store를 거치지 않고 캔버스로 직결한다. ssh.data 와 같은 이유다.
  onFrame: (sessionId: string, listener: (frame: RdpFramePayload) => void) => () => void;
  onAudio: (sessionId: string, listener: (audio: RdpAudioPayload) => void) => () => void;
}

export function buildRdpBridge(ipcRenderer: IpcRenderer): RdpBridge {
  return {
    connect: (sessionId, hostId, viewport) =>
      ipcRenderer.invoke(ipcChannels.rdp.connect, sessionId, hostId, viewport),
    disconnect: (sessionId) => ipcRenderer.invoke(ipcChannels.rdp.disconnect, sessionId),
    sendInput: (sessionId, events) =>
      ipcRenderer.send(ipcChannels.rdp.input, sessionId, events),
    sendMicrophoneAudio: (sessionId, chunk) =>
      ipcRenderer.send(ipcChannels.rdp.micAudio, sessionId, chunk),
    sendCameraFrame: (sessionId, chunk) =>
      ipcRenderer.send(ipcChannels.rdp.cameraFrame, sessionId, chunk),
    trustCertificate: (sessionId, accept) =>
      ipcRenderer.invoke(ipcChannels.rdp.trustCertificate, sessionId, accept),
    revokeCertificateTrust: (hostId) =>
      ipcRenderer.invoke(ipcChannels.rdp.revokeCertificateTrust, hostId),
    requestResize: (sessionId, width, height) =>
      ipcRenderer.send(ipcChannels.rdp.resize, sessionId, width, height),
    sendClipboardText: (sessionId, text) =>
      ipcRenderer.send(ipcChannels.rdp.clipboard, sessionId, text),
    syncClipboard: (sessionId) =>
      ipcRenderer.send(ipcChannels.rdp.syncClipboard, sessionId),
    setKeyboardCapture: (active) =>
      ipcRenderer.send(ipcChannels.rdp.keyboardCapture, active),
    pickShareFolder: () => ipcRenderer.invoke(ipcChannels.rdp.pickShareFolder),
    listMonitors: () => ipcRenderer.invoke(ipcChannels.rdp.listMonitors),
    describeSession: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.rdp.describeSession, sessionId),
    requestRefresh: (sessionId) =>
      ipcRenderer.send(ipcChannels.rdp.refresh, sessionId),
    spreadMonitors: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.rdp.spreadMonitors, sessionId),
    collapseMonitors: (sessionId) =>
      ipcRenderer.invoke(ipcChannels.rdp.collapseMonitors, sessionId),
    onEvent: (listener) => subscribeRdpEvent(listener),
    onFrame: (sessionId, listener) => subscribeRdpFrame(sessionId, listener),
    onAudio: (sessionId, listener) => subscribeRdpAudio(sessionId, listener),
  };
}
