/**
 * Fabric Native Component spec for RemoteDesktopView.
 *
 * This spec drives codegen for both iOS (C++ TurboModule + ComponentDescriptor)
 * and Android (Java interface). If Fabric codegen is not available at build time,
 * the fallback ViewManager implementation in each platform folder provides the
 * same contract via the New Architecture interop layer.
 */
import type { HostComponent, ViewProps } from 'react-native';
import type {
  DirectEventHandler,
  Double,
  Int32,
} from 'react-native/Libraries/Types/CodegenTypes';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';

export type SurfaceReadyEvent = Readonly<{
  width: Int32;
  height: Int32;
}>;

export type SurfaceDestroyedEvent = Readonly<{}>;

export type MetricsEvent = Readonly<{
  fps: Double;
  dirtyRects: Int32;
  frameTimeMs: Double;
}>;

export interface NativeProps extends ViewProps {
  sessionId: string;
  protocol: string; // 'vnc' | 'rdp'
  paused?: boolean;
  testPattern?: boolean;
  /**
   * **처리된** 색 정수(`processColor` 결과). 문자열을 넘기면 안드로이드가 뷰를 만드는 순간
   * 던진다 — 변환은 RemoteDesktopView 가 한다.
   */
  backgroundColor?: Int32;
  onSurfaceReady?: DirectEventHandler<SurfaceReadyEvent>;
  onSurfaceDestroyed?: DirectEventHandler<SurfaceDestroyedEvent>;
  onMetrics?: DirectEventHandler<MetricsEvent>;
}

export default codegenNativeComponent<NativeProps>(
  'RemoteDesktopSurface',
) as HostComponent<NativeProps>;
