import React, { useCallback, useRef } from 'react';
import { processColor } from 'react-native';
import type { ViewStyle, StyleProp } from 'react-native';
import NativeRemoteDesktopSurface from './RemoteDesktopSurfaceNativeComponent';
import type {
  SurfaceReadyEvent,
  SurfaceDestroyedEvent,
  MetricsEvent,
} from './RemoteDesktopSurfaceNativeComponent';

export type RemoteDesktopProtocol = 'vnc' | 'rdp';

export interface SurfaceReadyPayload {
  width: number;
  height: number;
}

export interface MetricsPayload {
  fps: number;
  dirtyRects: number;
  frameTimeMs: number;
}

export interface RemoteDesktopViewProps {
  /** Unique session identifier. */
  sessionId: string;
  /** Protocol to use for the remote connection. */
  protocol: RemoteDesktopProtocol;
  /** Pause rendering (e.g. when backgrounded or tab switched). */
  paused?: boolean;
  /** Display a native test pattern instead of real framebuffer data. */
  testPattern?: boolean;
  /** Background color of the surface before content arrives. */
  backgroundColor?: string;
  /** Style for the container view. */
  style?: StyleProp<ViewStyle>;

  // --- Events (only lifecycle/metrics cross the bridge; pixels never do) ---
  onSurfaceReady?: (payload: SurfaceReadyPayload) => void;
  onSurfaceDestroyed?: () => void;
  onMetrics?: (payload: MetricsPayload) => void;
}

/**
 * RemoteDesktopView — native surface for VNC/RDP pixel rendering.
 *
 * Pixels are rendered entirely in native (Metal on iOS, OpenGL ES on Android).
 * No pixel data crosses the JS bridge. The dirty-rect update boundary is exposed
 * natively for future Rust FFI callbacks.
 */
/**
 * 색 문자열을 **처리된 정수**로 바꾼다.
 *
 * 안드로이드의 색 prop 은 숫자(또는 PlatformColor 객체)만 받는다. 문자열을 그대로 넘기면
 * `ViewManagersPropertyCache` 가 뷰를 만드는 순간 던지고("ColorValue: the value must be a number
 * or Object") 연결하자마자 redbox 가 떴다. iOS 의 `RCTConvert+UIColor` 는 16진 문자열도 받아
 * 주기 때문에 그쪽만 조용히 동작했다 — 그래서 안드로이드에서만 터졌다.
 *
 * 숫자는 두 플랫폼 모두 받는다(iOS 는 NSNumber 를 ARGB 로 읽는다). 값을 해석할 수 없으면
 * `undefined` 를 주어 네이티브가 자기 기본값(검정)을 쓰게 한다.
 */
export function resolveSurfaceBackgroundColor(
  color: string,
): number | undefined {
  const processed = processColor(color);
  return typeof processed === 'number' ? processed : undefined;
}

export function RemoteDesktopView({
  sessionId,
  protocol,
  paused = false,
  testPattern = true,
  backgroundColor = '#000000',
  style,
  onSurfaceReady,
  onSurfaceDestroyed,
  onMetrics,
}: RemoteDesktopViewProps) {
  const handleSurfaceReady = useCallback(
    (event: { nativeEvent: SurfaceReadyEvent }) => {
      onSurfaceReady?.({
        width: event.nativeEvent.width,
        height: event.nativeEvent.height,
      });
    },
    [onSurfaceReady],
  );

  const handleSurfaceDestroyed = useCallback(
    (_event: { nativeEvent: SurfaceDestroyedEvent }) => {
      onSurfaceDestroyed?.();
    },
    [onSurfaceDestroyed],
  );

  const handleMetrics = useCallback(
    (event: { nativeEvent: MetricsEvent }) => {
      onMetrics?.({
        fps: event.nativeEvent.fps,
        dirtyRects: event.nativeEvent.dirtyRects,
        frameTimeMs: event.nativeEvent.frameTimeMs,
      });
    },
    [onMetrics],
  );

  return (
    <NativeRemoteDesktopSurface
      sessionId={sessionId}
      protocol={protocol}
      paused={paused}
      testPattern={testPattern}
      backgroundColor={resolveSurfaceBackgroundColor(backgroundColor)}
      style={style}
      onSurfaceReady={handleSurfaceReady}
      onSurfaceDestroyed={handleSurfaceDestroyed}
      onMetrics={handleMetrics}
    />
  );
}
