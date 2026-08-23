/**
 * Native-only remote desktop framebuffer with phone-oriented input controls.
 * Pixel bytes never cross the React Native bridge: JS handles only gestures,
 * remote coordinates, local transforms, toolbar state, and key events.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import {
  TRACKPAD_CURSOR_HEIGHT,
  TRACKPAD_CURSOR_HOTSPOT_X,
  TRACKPAD_CURSOR_HOTSPOT_Y,
  TRACKPAD_CURSOR_PNG,
  TRACKPAD_CURSOR_WIDTH,
} from '../lib/remote-desktop-cursor';
import type {
  MobileRemoteDesktopSessionStatus,
  RemoteDesktopInputMode,
  RemoteDesktopProtocol,
  RemoteDesktopScaleMode,
} from '@dolssh/shared-core';
import {
  RemoteDesktopView,
  nativeKeyEvent,
  nativePointerButton,
  nativePointerMove,
  nativeRefresh,
  nativeScroll,
  nativeSendClipboard,
  nativeSetActive,
  nativeUnicodeEvent,
} from '@dolssh/react-native-remote-desktop';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { keyToKeysym, MODIFIER_KEYSYMS } from '../lib/vnc-keysym';
import { keyToRdpScancode, RDP_MODIFIER_SCANCODES } from '../lib/rdp-keyboard';
import {
  applyPinchZoom,
  applyTrackpadMove,
  calculateFitScale,
  isRepeatTap,
  panToRevealCursor,
  clampPan,
  directTouchToRemote,
  remoteToViewport,
  toWheelDelta,
  LONG_PRESS_MS,
  TAP_TIMEOUT_MS,
  type Point,
  type ZoomState,
} from '../lib/remote-desktop-gestures';
import {
  isScreenOrientationLockSupported,
  lockLandscape,
  unlockOrientation,
} from '../lib/screen-orientation';
import { RemoteDesktopKeyboardInput } from './RemoteDesktopKeyboardInput';
import { RemoteDesktopToolbar } from './RemoteDesktopToolbar';
import { ConnectionStagesPanel } from './ConnectionStagesPanel';
import type { ConnectionStage } from '../lib/connection-stages';

const SCROLL_STEP_PX = 12;
const MAX_LOCAL_ZOOM = 5;
/** 클립보드 안내가 떠 있는 시간. 읽을 만큼만 남기고 사라진다. */
const CLIPBOARD_NOTICE_MS = 3200;

/**
 * 클립보드를 알린 뒤 Ctrl+V 를 누르기까지 기다리는 시간.
 *
 * 순서가 중요하다 — 원격은 **붙여넣는 순간에** 우리에게 내용을 요청한다. 알림(Format List)이
 * 아직 가는 중인데 Ctrl+V 가 먼저 도착하면 원격은 예전 클립보드를 붙여넣는다. 왕복 시간만큼만
 * 둔다.
 */
const CLIPBOARD_PASTE_DELAY_MS = 350;

function clampNativeCoordinate(value: number, size: number): number {
  return Math.max(
    0,
    Math.min(65_535, Math.min(Math.max(0, size - 1), Math.round(value))),
  );
}

export interface RemoteDesktopSurfaceProps {
  sessionId: string;
  protocol: RemoteDesktopProtocol;
  status: MobileRemoteDesktopSessionStatus;
  /** When true, the native surface shows its built-in test pattern. */
  testPattern?: boolean;
  /** Whether this tab is the active (visible) tab. */
  isActiveTab?: boolean;
  errorMessage?: string | null;
  title?: string;
  hostAddress?: string;
  connectionStatusMessage?: string | null;
  connectionStages?: readonly ConnectionStage[];
  inputMode?: RemoteDesktopInputMode;
  scaleMode?: RemoteDesktopScaleMode;
  desktopWidth?: number | null;
  desktopHeight?: number | null;
  viewOnly?: boolean;
  onInputModeChange?: (mode: RemoteDesktopInputMode) => void;
  onScaleModeChange?: (mode: RemoteDesktopScaleMode) => void;
  /** 전체화면(세션 탭 줄·하단 탭 바 숨김) 여부. 상태는 스토어가 갖는다. */
  immersive?: boolean;
  onToggleImmersive?: () => void;
  onDisconnect?: () => void;
}

export function RemoteDesktopSurface({
  sessionId,
  protocol,
  status,
  testPattern = false,
  isActiveTab = true,
  errorMessage,
  title,
  hostAddress,
  connectionStatusMessage,
  connectionStages = [],
  inputMode = 'trackpad',
  scaleMode = 'fit',
  desktopWidth,
  desktopHeight,
  viewOnly = false,
  onInputModeChange,
  onScaleModeChange,
  immersive,
  onToggleImmersive,
  onDisconnect,
}: RemoteDesktopSurfaceProps) {
  const { t } = useTranslation();
  // 전체화면에서는 아래 탭바가 없어 키보드 바가 홈 인디케이터 위에 그대로 앉는다. 가로에서는
  // 노치가 좌우 한쪽을 먹는다.
  //
  // `useSafeAreaInsets()` 대신 컨텍스트를 직접 읽는다 — 그 훅은 provider 밖에서 **던진다**.
  // 이 화면은 세션 탭 안에 얹히는 조각이라, 인셋을 못 얻는 것 때문에 세션 전체가 죽는 것보다
  // 0 으로 두는 편이 낫다.
  const contextInsets = useContext(SafeAreaInsetsContext);
  const safeAreaInsets = useMemo(
    () => ({
      bottom: contextInsets?.bottom ?? 0,
      left: contextInsets?.left ?? 0,
      right: contextInsets?.right ?? 0,
    }),
    [contextInsets?.bottom, contextInsets?.left, contextInsets?.right],
  );
  const prevActiveRef = useRef(isActiveTab);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // 가로 고정. 지원하는 플랫폼(안드로이드)에서만 버튼이 뜬다.
  const [landscapeLocked, setLandscapeLocked] = useState(false);
  const orientationLockSupported = isScreenOrientationLockSupported();

  // **화면을 벗어나면 반드시 푼다.** 안 풀면 홈 화면까지 가로로 남는다. 세션이 끊겨
  // 언마운트되는 경우까지 여기서 덮는다.
  useEffect(
    () => () => {
      unlockOrientation();
    },
    [],
  );
  const [zoom, setZoom] = useState<ZoomState>({
    scale: 1,
    mode: 'fit',
    panX: 0,
    panY: 0,
  });
  const zoomRef = useRef(zoom);
  const remoteWidth = Math.max(1, desktopWidth ?? viewport.width ?? 1);
  const remoteHeight = Math.max(1, desktopHeight ?? viewport.height ?? 1);
  /**
   * 트랙패드 커서 위치(화면 좌표).
   *
   * **state 가 아니라 Animated 값이다.** 손가락 이동마다 리렌더하면 프레임 경로까지 같이
   * 느려진다. `useNativeDriver` 로 transform 을 걸어 두면 `setValue` 가 네이티브 노드로 바로
   * 가고 React 는 관여하지 않는다.
   */
  const cursorLeft = useRef(new Animated.Value(0)).current;
  const cursorTop = useRef(new Animated.Value(0)).current;

  /**
   * 툴바를 접었는지. 접으면 작은 손잡이만 남는다.
   *
   * 세션이 아니라 이 화면의 보기 상태다 — 탭을 옮겼다 돌아오면 다시 펴진 상태로 시작하는 편이
   * 안전하다(접힌 걸 잊고 "버튼이 사라졌다" 가 되지 않게).
   */
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  /**
   * 클립보드 버튼을 눌렀을 때 잠깐 뜨는 안내.
   *
   * 이 버튼은 **원격의 클립보드에 넣기만** 한다 — 붙여넣기는 원격에서 Ctrl+V 를 눌러야 한다.
   * 그래서 아무 표시가 없으면 "눌러도 아무 일도 없다" 로 보인다. 무엇이 일어났는지 알린다.
   */
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const clipboardNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const showClipboardNotice = useCallback((message: string) => {
    setClipboardNotice(message);
    if (clipboardNoticeTimer.current) {
      clearTimeout(clipboardNoticeTimer.current);
    }
    clipboardNoticeTimer.current = setTimeout(
      () => setClipboardNotice(null),
      CLIPBOARD_NOTICE_MS,
    );
  }, []);
  useEffect(
    () => () => {
      if (clipboardNoticeTimer.current) {
        clearTimeout(clipboardNoticeTimer.current);
      }
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
    },
    [],
  );

  /**
   * 원격에서 Ctrl+V 를 누른다.
   *
   * 클립보드에 넣는 것만으로는 아무 일도 일어나지 않는다 — 붙여넣기는 원격에서 키를 눌러야
   * 한다. 데스크톱은 사용자가 실제 키보드로 누르지만 **모바일에는 그 방법이 없다**(바에는 글자
   * 키가 없다). 그래서 버튼이 두 단계를 다 한다.
   */
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRemotePaste = useCallback(() => {
    const modifier =
      protocol === 'rdp' ? RDP_MODIFIER_SCANCODES.ctrl : MODIFIER_KEYSYMS.ctrl;
    const key =
      protocol === 'rdp' ? keyToRdpScancode('v') : keyToKeysym('v');
    if (key === null) return;

    if (protocol === 'rdp') {
      nativeKeyEvent(sessionId, 0, true, modifier);
      nativeKeyEvent(sessionId, 0, true, key);
      nativeKeyEvent(sessionId, 0, false, key);
      nativeKeyEvent(sessionId, 0, false, modifier);
      return;
    }
    nativeKeyEvent(sessionId, modifier, true, 0);
    nativeKeyEvent(sessionId, key, true, 0);
    nativeKeyEvent(sessionId, key, false, 0);
    nativeKeyEvent(sessionId, modifier, false, 0);
  }, [protocol, sessionId]);
  /**
   * 마지막 좌클릭의 화면 좌표·시각과 그때 보낸 원격 좌표.
   *
   * 직접 터치 모드에서 더블클릭을 살리기 위한 것이다 — 두 번째 탭을 앞 클릭과 **같은 원격
   * 좌표**로 보내야 원격이 더블클릭으로 센다. 손가락은 반드시 몇 pt 어긋나기 때문이다.
   */
  const lastTapRef = useRef<{
    x: number;
    y: number;
    at: number;
    remote: Point;
  } | null>(null);

  const cursorRef = useRef<Point>({
    x: remoteWidth / 2,
    y: remoteHeight / 2,
  });
  const effectiveInputMode: RemoteDesktopInputMode = viewOnly
    ? 'none'
    : inputMode;
  const gestureEnabled = status === 'connected' || testPattern;

  // 트랙패드에서만 커서를 그린다. Direct 모드는 손가락이 곧 포인터라 점을 하나 더 띄우면
  // 방해만 되고, view-only 세션은 애초에 포인터를 옮기지 않는다.
  const showCursor =
    gestureEnabled && effectiveInputMode === 'trackpad' && !viewOnly;

  // 뷰포트·해상도가 바뀌면(회전, 크기 협상) 커서를 현재 원격 좌표 자리로 다시 놓는다.
  // 그러지 않으면 회전 직후 커서만 옛 위치에 남는다.
  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const onScreen = remoteToViewport(
      cursorRef.current.x,
      cursorRef.current.y,
      zoomRef.current,
      viewport.width,
      viewport.height,
      remoteWidth,
      remoteHeight,
    );
    cursorLeft.setValue(onScreen.x);
    cursorTop.setValue(onScreen.y);
  }, [
    cursorLeft,
    cursorTop,
    remoteHeight,
    remoteWidth,
    viewport.height,
    viewport.width,
    zoom.panX,
    zoom.panY,
    zoom.scale,
  ]);

  const updateZoom = useCallback((next: ZoomState) => {
    zoomRef.current = next;
    setZoom(next);
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    cursorRef.current = {
      x: Math.max(0, Math.min(remoteWidth - 1, cursorRef.current.x)),
      y: Math.max(0, Math.min(remoteHeight - 1, cursorRef.current.y)),
    };
  }, [remoteHeight, remoteWidth]);

  const zoomForScaleMode = useCallback(
    (mode: RemoteDesktopScaleMode): ZoomState => {
      if (
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        remoteWidth <= 0 ||
        remoteHeight <= 0
      ) {
        return { scale: 1, mode: 'fit', panX: 0, panY: 0 };
      }
      if (mode === 'fit') {
        return { scale: 1, mode: 'fit', panX: 0, panY: 0 };
      }

      const fitScale = calculateFitScale(
        viewport.width,
        viewport.height,
        remoteWidth,
        remoteHeight,
      );
      if (mode === 'native') {
        return {
          scale: Math.max(1, Math.min(MAX_LOCAL_ZOOM, 1 / fitScale)),
          mode: 'actual',
          panX: 0,
          panY: 0,
        };
      }

      const fillScale = Math.max(
        viewport.width / remoteWidth,
        viewport.height / remoteHeight,
      );
      return {
        scale: Math.max(1, Math.min(MAX_LOCAL_ZOOM, fillScale / fitScale)),
        mode: 'custom',
        panX: 0,
        panY: 0,
      };
    },
    [remoteHeight, remoteWidth, viewport.height, viewport.width],
  );

  useEffect(() => {
    // `fill` is also the persisted marker for a user-controlled pinch zoom.
    // Preserve that custom transform instead of replacing it with cover mode.
    if (scaleMode === 'fill' && zoomRef.current.mode === 'custom') return;
    updateZoom(zoomForScaleMode(scaleMode));
  }, [scaleMode, updateZoom, zoomForScaleMode]);

  useEffect(() => {
    if (!gestureEnabled || viewOnly) setKeyboardVisible(false);
  }, [gestureEnabled, viewOnly]);

  // 입력 모드가 바뀌거나 입력을 못 보내는 상태가 되면 마지막 클릭 자리를 잊는다 — 옛 좌표로
  // 클릭을 보내면 사용자가 누른 곳이 아닌 데가 눌린다.
  useEffect(() => {
    lastTapRef.current = null;
  }, [effectiveInputMode, gestureEnabled, viewOnly]);

  // Notify native layer of active/inactive transitions.
  //
  // **다시 활성화될 때 화면을 통째로 다시 받는다.** 프레임버퍼는 damage rect 로만 갱신되므로,
  // 탭을 옮겨 둔 사이에 갱신 하나를 놓치면 그 영역은 그 픽셀이 다시 바뀔 때까지 옛 그림으로
  // 남는다. setActive 는 표시 정책만 되돌리고 화면을 요청하지 않아서, 여기서 같이 부른다.
  // (첫 활성화는 제외한다 — 접속 직후에는 서버가 이미 전체 화면을 보낸다. prevActiveRef 가
  // isActiveTab 으로 시작하므로 그 경우 이 분기에 들어오지 않는다.)
  useEffect(() => {
    if (testPattern) return;
    if (prevActiveRef.current !== isActiveTab) {
      prevActiveRef.current = isActiveTab;
      if (status === 'connected') {
        void nativeSetActive(sessionId, isActiveTab).catch(() => undefined);
        if (isActiveTab) {
          void nativeRefresh(sessionId).catch(() => undefined);
        }
      }
    }
  }, [isActiveTab, sessionId, status, testPattern]);

  // On mount (connected), mark active; on unmount, pause presentation only.
  useEffect(() => {
    if (testPattern) return;
    if (status === 'connected' && isActiveTab) {
      void nativeSetActive(sessionId, true).catch(() => undefined);
    }
    return () => {
      if (!testPattern) {
        void nativeSetActive(sessionId, false).catch(() => undefined);
      }
    };
  }, [isActiveTab, sessionId, status, testPattern]);

  const nativePoint = useCallback(
    (point: Point = cursorRef.current) => {
      const mapped = {
        x: clampNativeCoordinate(point.x, remoteWidth),
        y: clampNativeCoordinate(point.y, remoteHeight),
      };
      // 커서는 **원격으로 보낸 좌표**를 되돌려 그린다. 손가락 위치를 그대로 쓰면 레터박스나
      // 클램프가 걸린 순간 커서와 실제 포인터가 갈라진다.
      const onScreen = remoteToViewport(
        mapped.x,
        mapped.y,
        zoomRef.current,
        viewport.width,
        viewport.height,
        remoteWidth,
        remoteHeight,
      );
      cursorLeft.setValue(onScreen.x);
      cursorTop.setValue(onScreen.y);
      return mapped;
    },
    [
      cursorLeft,
      cursorTop,
      remoteHeight,
      remoteWidth,
      viewport.height,
      viewport.width,
    ],
  );

  const moveDirectPointer = useCallback(
    (point: Point): Point => {
      const next = directTouchToRemote(
        point.x,
        point.y,
        zoomRef.current,
        Math.max(1, viewport.width),
        Math.max(1, viewport.height),
        remoteWidth,
        remoteHeight,
      );
      cursorRef.current = next;
      const native = nativePoint(next);
      nativePointerMove(sessionId, native.x, native.y);
      return next;
    },
    [
      nativePoint,
      remoteHeight,
      remoteWidth,
      sessionId,
      viewport.height,
      viewport.width,
    ],
  );

  const sendButton = useCallback(
    (button: number, pressed: boolean, point = cursorRef.current) => {
      const native = nativePoint(point);
      nativePointerButton(sessionId, button, pressed, native.x, native.y);
    },
    [nativePoint, sessionId],
  );


  // 제스처 중재는 **라이브러리에 맡긴다.**
  //
  // 예전에는 PanResponder 하나로 스크롤·핀치·드래그·탭을 직접 갈랐다 — 임계값, 유예 타이머,
  // "간격 변화 vs 중심 이동" 우세 판정을 손으로 짰고, 그 판정이 실제 손짓(두 손가락의 이동량이
  // 크게 다르다)과 어긋나 스크롤이 핀치로, 스크롤이 클릭으로 새어 나갔다. 손가락 개수로
  // 갈라야 하는 일을 크기·시간으로 흉내 내고 있었던 셈이다.
  //
  // react-native-gesture-handler 는 그 중재가 본업이다. 손가락 수를 선언하면 두 번째 손가락이
  // 닿는 순간 한 손가락 제스처가 **자동으로 취소**된다 — 우리가 버튼을 눌렀다 떼며 수습하던
  // 그 일이 애초에 일어나지 않는다.
  const pressedButtonRef = useRef<number | null>(null);
  const scrollRemainderRef = useRef({ x: 0, y: 0 });
  const pinchStartRef = useRef(zoomRef.current);

  const releasePressedButton = useCallback(() => {
    const button = pressedButtonRef.current;
    if (button === null) {
      return;
    }
    pressedButtonRef.current = null;
    sendButton(button, false);
  }, [sendButton]);

  const clickAt = useCallback(
    (button: number, point: Point) => {
      if (viewOnly || effectiveInputMode === 'none') {
        return;
      }
      if (effectiveInputMode === 'touch') {
        const now = Date.now();
        const previous = lastTapRef.current;
        if (button === 0 && previous && isRepeatTap(previous, point.x, point.y, now)) {
          // 앞 클릭과 **정확히 같은** 원격 좌표로 보낸다 — 그래야 원격이 더블클릭으로 센다.
          cursorRef.current = previous.remote;
          lastTapRef.current = { ...previous, at: now };
        } else {
          const remote = moveDirectPointer(point);
          lastTapRef.current =
            button === 0 ? { x: point.x, y: point.y, at: now, remote } : null;
        }
      } else if (button !== 0) {
        lastTapRef.current = null;
      }
      sendButton(button, true);
      sendButton(button, false);
    },
    [effectiveInputMode, moveDirectPointer, sendButton, viewOnly],
  );

  /** 두 손가락 끌기 → 원격 스크롤. 한 손가락으로는 아예 시작되지 않는다. */
  const twoFingerScroll = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('rd-two-finger-scroll')
        .minPointers(2)
        .maxPointers(2)
        .averageTouches(true)
        .onStart(() => {
          scrollRemainderRef.current = { x: 0, y: 0 };
        })
        // changeX/Y(직전 이벤트 대비 변화량)는 onChange 가 준다.
        .onChange(event => {
          if (viewOnly || effectiveInputMode === 'none') {
            return;
          }
          const remainder = scrollRemainderRef.current;
          remainder.x += event.changeX;
          remainder.y += event.changeY;
          const native = nativePoint();
          // **손가락을 따라 종이가 밀린다**(폰 관습) — 위로 밀면 문서의 아래쪽이 보인다.
          // MS·Chrome 원격 데스크톱 모바일도 같다. 만지는 기기가 폰이므로 폰의 관습을
          // 따른다. 두 축의 부호가 서로 다른 것은 휠 규약이 축마다 반대이기 때문이다.
          if (Math.abs(remainder.y) >= SCROLL_STEP_PX) {
            const steps = Math.trunc(remainder.y / SCROLL_STEP_PX);
            nativeScroll(
              sessionId,
              true,
              toWheelDelta(protocol, steps),
              native.x,
              native.y,
            );
            remainder.y -= steps * SCROLL_STEP_PX;
          }
          if (Math.abs(remainder.x) >= SCROLL_STEP_PX) {
            const steps = Math.trunc(remainder.x / SCROLL_STEP_PX);
            nativeScroll(
              sessionId,
              false,
              toWheelDelta(protocol, -steps),
              native.x,
              native.y,
            );
            remainder.x -= steps * SCROLL_STEP_PX;
          }
        }),
    [effectiveInputMode, nativePoint, protocol, sessionId, viewOnly],
  );

  /** 두 손가락 확대. 원격에는 아무것도 보내지 않는다 — 화면만 키운다. */
  const pinchZoom = useMemo(
    () =>
      Gesture.Pinch()
        .withTestId('rd-pinch')
        .onStart(() => {
          pinchStartRef.current = zoomRef.current;
        })
        .onUpdate(event => {
          const next = clampPan(
            applyPinchZoom(
              pinchStartRef.current,
              event.focalX,
              event.focalY,
              event.scale,
              1,
              MAX_LOCAL_ZOOM,
            ),
            viewport.width,
            viewport.height,
          );
          updateZoom(next);
          onScaleModeChange?.(next.scale === 1 ? 'fit' : 'fill');
        }),
    [onScaleModeChange, updateZoom, viewport.height, viewport.width],
  );

  /**
   * 한 손가락 끌기.
   *
   * `maxPointers(1)` 이라 **둘째 손가락이 닿는 순간 이 제스처가 취소된다.** 예전에 스크롤이
   * 클릭으로 새던 원인(두 번째 손가락이 오기 전에 좌버튼을 눌러 버림)이 여기서 사라진다.
   */
  const oneFingerDrag = useMemo(
    () =>
      Gesture.Pan()
        .withTestId('rd-one-finger-drag')
        .minPointers(1)
        .maxPointers(1)
        .onStart(event => {
          if (viewOnly || effectiveInputMode === 'none') {
            return;
          }
          if (effectiveInputMode === 'touch') {
            moveDirectPointer({ x: event.x, y: event.y });
            sendButton(0, true);
            pressedButtonRef.current = 0;
          }
        })
        .onChange(event => {
          if (viewOnly || effectiveInputMode === 'none') {
            return;
          }
          if (effectiveInputMode === 'touch') {
            moveDirectPointer({ x: event.x, y: event.y });
            return;
          }
          const moved = applyTrackpadMove(
            {
              cursorX: cursorRef.current.x,
              cursorY: cursorRef.current.y,
              zoomScale: zoomRef.current.scale,
              panX: zoomRef.current.panX,
              panY: zoomRef.current.panY,
              remoteWidth,
              remoteHeight,
              viewportWidth: Math.max(1, viewport.width),
              viewportHeight: Math.max(1, viewport.height),
            },
            event.changeX,
            event.changeY,
          );
          cursorRef.current = { x: moved.cursorX, y: moved.cursorY };
          const native = nativePoint(cursorRef.current);
          nativePointerMove(sessionId, native.x, native.y);

          // **화면은 커서를 따라간다.** 트랙패드 모드에서 손가락은 화면 아무 데나 있어도
          // 되므로, 확대 상태에서 커서만 원격 끝까지 가고 화면이 안 따라가면 안 된다.
          const cursorOnScreen = remoteToViewport(
            native.x,
            native.y,
            zoomRef.current,
            viewport.width,
            viewport.height,
            remoteWidth,
            remoteHeight,
          );
          const followed = panToRevealCursor(
            zoomRef.current,
            cursorOnScreen.x,
            cursorOnScreen.y,
            viewport.width,
            viewport.height,
          );
          if (
            followed.panX !== zoomRef.current.panX ||
            followed.panY !== zoomRef.current.panY
          ) {
            updateZoom(followed);
          }
        })
        .onFinalize(() => {
          releasePressedButton();
        }),
    [
      effectiveInputMode,
      moveDirectPointer,
      nativePoint,
      releasePressedButton,
      remoteHeight,
      remoteWidth,
      sendButton,
      sessionId,
      updateZoom,
      viewOnly,
      viewport.height,
      viewport.width,
    ],
  );

  const singleTap = useMemo(
    () =>
      Gesture.Tap()
        .withTestId('rd-tap')
        .maxDuration(TAP_TIMEOUT_MS)
        .onEnd((event, success) => {
          if (success) {
            clickAt(0, { x: event.x, y: event.y });
          }
        }),
    [clickAt],
  );

  /** 제자리에서 길게 누르면 우클릭. 폰에서 컨텍스트 메뉴가 그 손짓이다. */
  const longPressRightClick = useMemo(
    () =>
      Gesture.LongPress()
        .withTestId('rd-long-press')
        .minDuration(LONG_PRESS_MS)
        .onStart(event => {
          clickAt(2, { x: event.x, y: event.y });
        }),
    [clickAt],
  );

  /** 두 손가락 탭도 우클릭(트랙패드 관습). 스크롤로 번지지 않게 손가락 수로 갈린다. */
  const twoFingerTap = useMemo(
    () =>
      Gesture.Tap()
        .withTestId('rd-two-finger-tap')
        .minPointers(2)
        .maxDuration(TAP_TIMEOUT_MS)
        .onEnd((event, success) => {
          if (success) {
            clickAt(2, { x: event.x, y: event.y });
          }
        }),
    [clickAt],
  );

  const composedGesture = useMemo(
    () =>
      Gesture.Race(
        twoFingerScroll,
        pinchZoom,
        twoFingerTap,
        longPressRightClick,
        oneFingerDrag,
        singleTap,
      ),
    [
      longPressRightClick,
      oneFingerDrag,
      pinchZoom,
      singleTap,
      twoFingerScroll,
      twoFingerTap,
    ],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout;
    setViewport(current =>
      current.width === next.width && current.height === next.height
        ? current
        : { width: next.width, height: next.height },
    );
  }, []);

  const toggleScaleMode = useCallback(() => {
    const next: RemoteDesktopScaleMode = scaleMode === 'fit' ? 'native' : 'fit';
    updateZoom(zoomForScaleMode(next));
    onScaleModeChange?.(next);
  }, [onScaleModeChange, scaleMode, updateZoom, zoomForScaleMode]);

  const statusLabel = (() => {
    switch (status) {
      case 'connecting':
        return t('session.remoteDesktopConnecting', {
          defaultValue: '연결 준비 중…',
        });
      case 'connected':
        return t('session.remoteDesktopConnected', { defaultValue: '연결됨' });
      case 'disconnecting':
        return t('session.remoteDesktopDisconnecting', {
          defaultValue: '연결 해제 중…',
        });
      case 'error':
        return (
          errorMessage ??
          t('session.remoteDesktopError', {
            defaultValue: '연결 오류',
          })
        );
      case 'closed':
        return t('session.remoteDesktopClosed', {
          defaultValue: '연결 종료됨',
        });
      default:
        return t('session.remoteDesktopPreparing', {
          defaultValue: '지원 준비 중',
        });
    }
  })();

  const loadingStatusLabel = connectionStatusMessage ?? statusLabel;
  const showNativeSurface = status === 'connected' || testPattern;
  const paused = (status !== 'connected' && !testPattern) || !isActiveTab;

  return (
    <View
      testID={`remote-desktop-surface-${sessionId}`}
      style={styles.container}
      accessibilityRole="none"
      accessibilityLabel={t('session.remoteDesktopSurfaceLabel', {
        protocol: protocol.toUpperCase(),
        status: statusLabel,
        defaultValue: `${protocol.toUpperCase()} 원격 데스크톱 — ${statusLabel}`,
      })}
    >
      <View style={styles.viewport} onLayout={handleLayout}>
        {showNativeSurface ? (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                /**
                 * **좌상단을 기준으로 확대한다.**
                 *
                 * RN 의 기본 transform 원점은 뷰의 **중심**이다(CSS 와 같다). 그런데 좌표 계산은
                 * 전부 좌상단 기준으로 되어 있다 — `directTouchToRemote` 는
                 * `(touch - pan) / scale`, `remoteToViewport` 는 그 역이고, 핀치·팬·엣지팬도
                 * 같은 가정을 쓴다. 배율이 1 이면 두 기준이 일치해서 차이가 안 보이지만, 확대하는
                 * 순간 `center*(1-scale)` 만큼 전부 어긋난다 — 클릭이 밀리고 커서가 안 따라오고
                 * 화면 이동이 이상해지는 것이 모두 이 한 줄이다.
                 *
                 * 원점을 옮기는 쪽이 맞다. 계산식마다 중심 보정을 더하면 네 곳이 같은 규칙을
                 * 각자 들고 있어야 하고, 하나만 빠지면 지금과 똑같은 증상이 돌아온다.
                 */
                transformOrigin: 'top left',
                transform: [
                  { translateX: zoom.panX },
                  { translateY: zoom.panY },
                  { scale: zoom.scale },
                ],
              },
            ]}
          >
            <RemoteDesktopView
              sessionId={sessionId}
              protocol={protocol}
              paused={paused}
              testPattern={testPattern}
              style={StyleSheet.absoluteFill}
            />
          </View>
        ) : null}

        {showCursor ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.cursor,
              {
                transform: [
                  { translateX: cursorLeft },
                  { translateY: cursorTop },
                ],
              },
            ]}
          >
            <Image
              source={{ uri: TRACKPAD_CURSOR_PNG }}
              style={styles.cursorImage}
              resizeMode="contain"
            />
          </Animated.View>
        ) : null}

        {clipboardNotice ? (
          <View pointerEvents="none" style={styles.clipboardNotice}>
            <Text style={styles.clipboardNoticeText}>{clipboardNotice}</Text>
          </View>
        ) : null}

        {gestureEnabled ? (
          <GestureDetector gesture={composedGesture}>
            <View
              testID={`remote-desktop-gesture-layer-${sessionId}`}
              style={styles.gestureLayer}
              accessible
              accessibilityRole="imagebutton"
              accessibilityLabel={t('session.remoteDesktopGestureArea', {
                defaultValue: 'Remote desktop input area',
              })}
            />
          </GestureDetector>
        ) : null}

        {status !== 'connected' ? (
          // **box-none 이어야 스크롤이 된다.** `none` 이면 손가락이 통과해서, 안을
          // ScrollView 로 만들어도 움직이지 않는다. 연결 전에는 아래 제스처 레이어가 어차피
          // 비활성이라 가려서 잃는 것이 없다.
          <View pointerEvents="box-none" style={styles.overlay}>
            <ScrollView
              style={styles.overlayScroll}
              contentContainerStyle={styles.overlayContent}
              // 세로 공간이 모자랄 때만 스크롤한다. 남을 때는 가운데에 그대로 둔다.
              centerContent
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.protocolBadge}>{protocol.toUpperCase()}</Text>
              {title ? <Text style={styles.hostTitle}>{title}</Text> : null}
              {hostAddress ? (
                <Text style={styles.hostAddress}>{hostAddress}</Text>
              ) : null}
              {status === 'connecting' || status === 'disconnecting' ? (
                <ActivityIndicator color="#8b8ba7" size="small" />
              ) : null}
              <Text
                style={styles.statusText}
                accessibilityRole="text"
                accessibilityLiveRegion="polite"
              >
                {loadingStatusLabel}
              </Text>
              {connectionStages.length > 0 ? (
                <View style={styles.connectionStages}>
                  <ConnectionStagesPanel
                    title={title ?? protocol.toUpperCase()}
                    stages={connectionStages}
                    busy={status === 'connecting'}
                    showHeader={false}
                  />
                </View>
              ) : null}
            </ScrollView>
          </View>
        ) : null}
      </View>

      <View style={styles.toolbarOverlay} pointerEvents="box-none">
        {toolbarCollapsed ? (
          <Pressable
            onPress={() => setToolbarCollapsed(false)}
            hitSlop={10}
            style={styles.toolbarHandle}
            accessibilityRole="button"
            accessibilityLabel={t('session.rdToolbarExpand', {
              defaultValue: '툴바 펼치기',
            })}
          >
            <Ionicons name="chevron-down" size={16} color="#c0c0d8" />
          </Pressable>
        ) : (
        <RemoteDesktopToolbar
          inputMode={effectiveInputMode}
          scaleMode={scaleMode}
          viewOnly={viewOnly}
          onToggleInputMode={() =>
            onInputModeChange?.(inputMode === 'trackpad' ? 'touch' : 'trackpad')
          }
          onToggleKeyboard={() => setKeyboardVisible(value => !value)}
          landscapeLocked={landscapeLocked}
          onToggleLandscape={
            orientationLockSupported
              ? () => {
                  setLandscapeLocked(value => {
                    const next = !value;
                    if (next) {
                      lockLandscape();
                    } else {
                      unlockOrientation();
                    }
                    return next;
                  });
                }
              : undefined
          }
          onToggleScale={toggleScaleMode}
          immersive={immersive === true}
          onToggleImmersive={() => onToggleImmersive?.()}
          onSendClipboard={() => {
            // 동기 throw 까지 잡는다 — 네이티브 모듈이 없으면 `getString()` 이 프로미스를
            // 만들기 전에 던지고, 그러면 핸들러가 통째로 중단돼 아무 안내도 남지 않는다.
            try {
              void Clipboard.getString()
                .then(async text => {
                  if (text.length === 0) {
                    showClipboardNotice(
                      t('session.rdClipboardEmpty', {
                        defaultValue: 'Nothing in this device clipboard',
                      }),
                    );
                    return;
                  }
                  await nativeSendClipboard(sessionId, text);
                  if (pasteTimer.current) clearTimeout(pasteTimer.current);
                  pasteTimer.current = setTimeout(
                    sendRemotePaste,
                    CLIPBOARD_PASTE_DELAY_MS,
                  );
                  showClipboardNotice(
                    t('session.rdClipboardSent', {
                      defaultValue: 'Pasted on the remote',
                    }),
                  );
                })
                .catch(error => {
                  showClipboardNotice(
                    t('session.rdClipboardFailed', {
                      defaultValue: 'Could not send the clipboard',
                      message:
                        error instanceof Error ? error.message : String(error),
                    }),
                  );
                });
            } catch (error) {
              showClipboardNotice(
                t('session.rdClipboardFailed', {
                  defaultValue: 'Could not send the clipboard',
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }}
          onCollapse={() => setToolbarCollapsed(true)}
          onDisconnect={() => onDisconnect?.()}
        />
        )}
      </View>

      <RemoteDesktopKeyboardInput
        protocol={protocol}
        visible={keyboardVisible && !viewOnly && gestureEnabled}
        insets={safeAreaInsets}
        onDismiss={() => setKeyboardVisible(false)}
        onKeyEvent={(keysym, pressed, keycode = 0) =>
          nativeKeyEvent(sessionId, keysym, pressed, keycode)
        }
        onUnicodeEvent={(codepoint, pressed) =>
          nativeUnicodeEvent(sessionId, codepoint, pressed)
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    overflow: 'hidden',
  },
  viewport: {
    flex: 1,
    overflow: 'hidden',
  },
  /**
   * 트랙패드 커서 — 고전 윈도우 화살표.
   *
   * 위치는 transform 으로만 준다(네이티브 드라이버가 움직일 수 있는 것이 transform 이다).
   * `left`/`top` 은 **화살표 팁을 좌표에 맞추는 보정**이다 — 이미지에는 테두리용 여백이 있어서
   * 좌상단이 곧 팁이 아니다. 이걸 빼먹으면 커서가 실제 클릭 지점보다 살짝 오른쪽 아래에 뜬다.
   */
  cursor: {
    position: 'absolute',
    left: -TRACKPAD_CURSOR_HOTSPOT_X,
    top: -TRACKPAD_CURSOR_HOTSPOT_Y,
    width: TRACKPAD_CURSOR_WIDTH,
    height: TRACKPAD_CURSOR_HEIGHT,
    zIndex: 4,
  },
  cursorImage: {
    width: TRACKPAD_CURSOR_WIDTH,
    height: TRACKPAD_CURSOR_HEIGHT,
  },
  clipboardNotice: {
    position: 'absolute',
    left: 12,
    right: 12,
    // 툴바 바로 아래. 화면 맨 아래는 키보드 바가 쓴다.
    top: 60,
    zIndex: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
  },
  clipboardNoticeText: {
    color: '#e5e7eb',
    fontSize: 12,
    textAlign: 'center',
  },
  gestureLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
  },
  /**
   * 접힌 툴바 손잡이. 작고 반투명해서 원격 화면을 거의 가리지 않는다.
   *
   * 제스처로 펼치게 하지 않는 이유는 이 화면의 탭·길게누르기가 모두 마우스 버튼이라서다 —
   * 언제나 보이는 손잡이 하나가 가장 충돌이 없고 찾기도 쉽다.
   */
  toolbarHandle: {
    paddingHorizontal: 14,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(20, 20, 40, 0.55)',
  },
  toolbarOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    zIndex: 5,
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 3,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(26, 26, 46, 0.92)',
  },
  overlayScroll: {
    width: '100%',
  },
  overlayContent: {
    // ScrollView 의 내용 컨테이너다. 남는 공간에서는 가운데(justifyContent), 모자라면 스크롤.
    flexGrow: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    // 툴바가 이 위에 떠 있다(zIndex 5). 그만큼 비워 두지 않으면 상태 문구를 덮는다 —
    // 가로에서는 그 한 줄이 "왜 못 붙었는지" 인 경우가 많다.
    paddingTop: 56,
    paddingBottom: 20,
  },
  protocolBadge: {
    fontSize: 14,
    fontWeight: '700',
    color: '#8b8ba7',
    letterSpacing: 2,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2a2a4a',
    borderRadius: 6,
    overflow: 'hidden',
  },
  hostTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f0f0fa',
    textAlign: 'center',
  },
  hostAddress: {
    fontSize: 12,
    color: '#777795',
    textAlign: 'center',
  },
  statusText: {
    fontSize: 15,
    color: '#a0a0b8',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  connectionStages: {
    width: '100%',
    marginTop: 4,
  },
});
