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
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
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
  classifyTap,
  directTouchToRemote,
  remoteToViewport,
  TAP_SLOP,
  type Point,
  type ZoomState,
} from '../lib/remote-desktop-gestures';
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

interface ActiveGesture {
  startedAt: number;
  maxTouches: number;
  totalMovement: number;
  lastPoint: Point | null;
  lastCenter: Point | null;
  initialDistance: number;
  initialZoom: ZoomState;
  twoFingerMode: 'pending' | 'pinch' | 'scroll';
  scrollX: number;
  scrollY: number;
  directPressed: boolean;
}

function createGesture(zoom: ZoomState): ActiveGesture {
  return {
    startedAt: 0,
    maxTouches: 0,
    totalMovement: 0,
    lastPoint: null,
    lastCenter: null,
    initialDistance: 0,
    initialZoom: zoom,
    twoFingerMode: 'pending',
    scrollX: 0,
    scrollY: 0,
    directPressed: false,
  };
}

function touchPoints(event: GestureResponderEvent): Point[] {
  return event.nativeEvent.touches.map(touch => ({
    x: touch.locationX,
    y: touch.locationY,
  }));
}

function midpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

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
  const gestureRef = useRef<ActiveGesture>(createGesture(zoom));
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

  const finishGesture = useCallback(
    (cancelled: boolean) => {
      const gesture = gestureRef.current;
      if (gesture.directPressed) {
        sendButton(0, false);
        gesture.directPressed = false;
      }
      if (cancelled || viewOnly || effectiveInputMode === 'none') return;

      const tap = classifyTap(
        gesture.maxTouches,
        Date.now() - gesture.startedAt,
        gesture.totalMovement,
      );
      if (tap.type === 'none') {
        // 드래그였다. 포인터가 딸려 갔으므로 다음 탭을 앞 클릭 자리로 볼 근거가 없다.
        lastTapRef.current = null;
        return;
      }
      if (tap.type === 'left-click' && effectiveInputMode === 'touch') {
        const point = gesture.lastPoint;
        if (point) {
          const now = Date.now();
          const previous = lastTapRef.current;
          if (previous && isRepeatTap(previous, point.x, point.y, now)) {
            // 앞 클릭과 **정확히 같은** 원격 좌표로 보낸다. 이동 이벤트가 그 사이 포인터를
            // 몇 px 옮겼어도 클릭 좌표가 같으면 원격은 더블클릭으로 센다.
            //
            // 기준은 첫 탭의 자리로 유지한다 — 세 번 이상 이어질 때도 한 점에 모인다.
            cursorRef.current = previous.remote;
            lastTapRef.current = { ...previous, at: now };
          } else {
            lastTapRef.current = {
              x: point.x,
              y: point.y,
              at: now,
              remote: moveDirectPointer(point),
            };
          }
        }
      } else {
        // 우클릭 뒤에는 컨텍스트 메뉴가 떠 있다. 다음 탭은 메뉴를 고르는 것이므로 앞 클릭
        // 자리로 끌어다 놓으면 안 된다.
        lastTapRef.current = null;
        if (tap.type === 'right-click' && gesture.lastCenter) {
          if (effectiveInputMode === 'touch') {
            moveDirectPointer(gesture.lastCenter);
          }
        }
      }
      const button = tap.type === 'right-click' ? 2 : 0;
      sendButton(button, true);
      sendButton(button, false);
    },
    [effectiveInputMode, moveDirectPointer, sendButton, viewOnly],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => gestureEnabled,
        onMoveShouldSetPanResponder: () => gestureEnabled,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: event => {
          const points = touchPoints(event);
          const first = points[0] ?? {
            x: event.nativeEvent.locationX,
            y: event.nativeEvent.locationY,
          };
          const center =
            points.length >= 2 ? midpoint(points[0], points[1]) : first;
          const next = createGesture(zoomRef.current);
          next.startedAt = Date.now();
          next.maxTouches = Math.max(1, points.length);
          next.lastPoint = first;
          next.lastCenter = center;
          next.initialDistance =
            points.length >= 2 ? pointDistance(points[0], points[1]) : 0;
          next.initialZoom = zoomRef.current;
          gestureRef.current = next;
          if (
            !viewOnly &&
            effectiveInputMode === 'touch' &&
            points.length < 2
          ) {
            moveDirectPointer(first);
          }
        },
        onPanResponderMove: event => {
          const points = touchPoints(event);
          if (points.length === 0) return;
          const gesture = gestureRef.current;
          const previousMaxTouches = gesture.maxTouches;
          gesture.maxTouches = Math.max(gesture.maxTouches, points.length);

          if (points.length >= 2) {
            const center = midpoint(points[0], points[1]);
            const distance = pointDistance(points[0], points[1]);
            // Most gestures begin with one finger and receive the second in a
            // later event. Establish the pinch/scroll baseline at that moment.
            if (previousMaxTouches < 2 || gesture.initialDistance <= 0) {
              gesture.initialDistance = distance;
              gesture.initialZoom = zoomRef.current;
              gesture.lastCenter = center;
              gesture.lastPoint = center;
              gesture.twoFingerMode = 'pending';
              return;
            }
            const centerDeltaX = gesture.lastCenter
              ? center.x - gesture.lastCenter.x
              : 0;
            const centerDeltaY = gesture.lastCenter
              ? center.y - gesture.lastCenter.y
              : 0;
            gesture.totalMovement += Math.hypot(centerDeltaX, centerDeltaY);
            gesture.lastCenter = center;
            gesture.lastPoint = center;

            if (
              gesture.twoFingerMode === 'pending' &&
              Math.abs(distance - gesture.initialDistance) > 5
            ) {
              gesture.twoFingerMode = 'pinch';
              // A stationary pinch changes distance but not its center. Mark it
              // non-tappable so release cannot become a right click.
              gesture.totalMovement = Math.max(
                gesture.totalMovement,
                TAP_SLOP + 1,
              );
            } else if (
              gesture.twoFingerMode === 'pending' &&
              gesture.totalMovement > TAP_SLOP
            ) {
              gesture.twoFingerMode = 'scroll';
            }

            if (
              gesture.twoFingerMode === 'pinch' &&
              gesture.initialDistance > 0
            ) {
              const next = clampPan(
                applyPinchZoom(
                  gesture.initialZoom,
                  center.x,
                  center.y,
                  distance / gesture.initialDistance,
                  1,
                  MAX_LOCAL_ZOOM,
                ),
                viewport.width,
                viewport.height,
              );
              updateZoom(next);
              if (next.scale === 1) {
                onScaleModeChange?.('fit');
              } else {
                onScaleModeChange?.('fill');
              }
              return;
            }

            if (
              gesture.twoFingerMode === 'scroll' &&
              !viewOnly &&
              effectiveInputMode !== 'none'
            ) {
              gesture.scrollX += centerDeltaX;
              gesture.scrollY += centerDeltaY;
              const native = nativePoint();
              if (Math.abs(gesture.scrollY) >= SCROLL_STEP_PX) {
                const steps = Math.trunc(gesture.scrollY / SCROLL_STEP_PX);
                nativeScroll(sessionId, true, -steps, native.x, native.y);
                gesture.scrollY -= steps * SCROLL_STEP_PX;
              }
              if (Math.abs(gesture.scrollX) >= SCROLL_STEP_PX) {
                const steps = Math.trunc(gesture.scrollX / SCROLL_STEP_PX);
                nativeScroll(sessionId, false, steps, native.x, native.y);
                gesture.scrollX -= steps * SCROLL_STEP_PX;
              }
            }
            return;
          }

          const point = points[0];
          // Do not reinterpret the final remaining finger from a two-finger
          // gesture as a one-finger pointer drag.
          if (gesture.maxTouches >= 2) {
            gesture.lastPoint = point;
            return;
          }
          const deltaX = gesture.lastPoint ? point.x - gesture.lastPoint.x : 0;
          const deltaY = gesture.lastPoint ? point.y - gesture.lastPoint.y : 0;
          gesture.totalMovement += Math.hypot(deltaX, deltaY);
          gesture.lastPoint = point;
          gesture.lastCenter = point;
          if (viewOnly || effectiveInputMode === 'none') return;

          if (effectiveInputMode === 'touch') {
            moveDirectPointer(point);
            if (gesture.totalMovement > TAP_SLOP && !gesture.directPressed) {
              sendButton(0, true);
              gesture.directPressed = true;
            }
          } else {
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
              deltaX,
              deltaY,
            );
            cursorRef.current = { x: moved.cursorX, y: moved.cursorY };
            const native = nativePoint(cursorRef.current);
            nativePointerMove(sessionId, native.x, native.y);

            // **화면은 커서를 따라간다.** 예전에는 손가락이 화면 가장자리에 닿아야 움직였는데,
            // 트랙패드 모드에서 손가락은 화면 아무 데나 있어도 되므로 확대 상태에서는 커서만
            // 원격 끝까지 가고 화면은 끝내 안 움직였다.
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
          }
        },
        onPanResponderRelease: () => finishGesture(false),
        onPanResponderTerminate: () => finishGesture(true),
      }),
    [
      effectiveInputMode,
      finishGesture,
      gestureEnabled,
      moveDirectPointer,
      nativePoint,
      onScaleModeChange,
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
          <View
            testID={`remote-desktop-gesture-layer-${sessionId}`}
            style={styles.gestureLayer}
            accessible
            accessibilityRole="imagebutton"
            accessibilityLabel={t('session.remoteDesktopGestureArea', {
              defaultValue: 'Remote desktop input area',
            })}
            {...panResponder.panHandlers}
          />
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
