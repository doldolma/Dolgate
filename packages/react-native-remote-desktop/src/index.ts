export { RemoteDesktopView } from "./RemoteDesktopView";
export type {
  RemoteDesktopViewProps,
  RemoteDesktopProtocol,
  SurfaceReadyPayload,
  MetricsPayload,
} from "./RemoteDesktopView";

export {
  isNativeSessionAvailable,
  nativeConnect,
  nativeDisconnect,
  nativeSetActive,
  setOrientationUnlocked,
  nativePointerMove,
  nativePointerButton,
  nativeScroll,
  nativeKeyEvent,
  nativeUnicodeEvent,
  nativeTrustCertificate,
  nativeSendClipboard,
  nativeRefresh,
  nativeResize,
  subscribeToSessionEvents,
  _resetEmitterForTests,
} from "./NativeSessionClient";
export type {
  RemoteDesktopSessionEvent,
  RemoteDesktopSessionEventType,
  RemoteDesktopConnectOptions,
  RemoteDesktopDriveShare,
} from "./NativeSessionClient";
