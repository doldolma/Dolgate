import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Buffer } from 'buffer';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  isAwsEc2HostRecord,
  isSshHostRecord,
  type MobileSessionRecord,
} from '@dolssh/shared-core';
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from '@fressh/react-native-xtermjs-webview';
import { ConnectionStagesPanel } from '../components/ConnectionStagesPanel';
import { openInAppBrowser } from '../lib/in-app-browser';
import { resolveMobileConnectionStages } from '../lib/connection-stages';
import { IosEdgeSwipeBack } from '../components/IosEdgeSwipeBack';
import {
  TerminalInputView,
  type TerminalInputViewHandle,
} from '../components/TerminalInputView';
import { RemoteFileEditorModal } from '../components/RemoteFileEditorModal';
import { SftpBrowserView } from '../components/SftpBrowserView';
import { useScreenPadding } from '../lib/screen-layout';
import {
  TERMINAL_PRIMARY_SHORTCUTS,
  TERMINAL_SECONDARY_SHORTCUTS,
  stripTerminalQueryReplies,
  translateTerminalInputEventToSequence,
  type NativeTerminalInputEvent,
  type TerminalShortcutItem,
} from '../lib/terminal-input';
import { getKeyboardDockInset } from '../lib/keyboard-layout';
import {
  TERMINAL_GRID_REPORT_SCRIPT,
  parseReportedTerminalGrid,
} from '../lib/terminal-size';
import {
  buildTerminalGestureScript,
  TERMINAL_SCROLL_TO_BOTTOM_SEQUENCE,
  arrowSequence,
  parseTerminalGestureEvent,
  terminalPasteSequence,
  type TerminalGestureEvent,
} from '../lib/terminal-gestures';
import Clipboard from '@react-native-clipboard/clipboard';
import type { MainTabParamList } from '../navigation/RootNavigator';
import {
  sortSessionsByRecency,
  useMobileAppStore,
} from '../store/useMobileAppStore';
import type { MobilePalette } from '../theme';
import { useMobilePalette } from '../theme';
import { useTranslation } from 'react-i18next';

const TERMINAL_RESET_BYTES = Uint8Array.from(
  Buffer.from('\u001b[3J\u001b[2J\u001b[H', 'utf8'),
);

// 터미널 준비 워치독 파라미터 — initialized 신호 유실 시 WebView 리마운트 간격/횟수.
const TERMINAL_READY_RETRY_DELAY_MS = 2000;
const TERMINAL_READY_RETRY_LIMIT = 4;

// 입력할 때마다 터미널에 흘려보내는 "맨 아래로" 신호. 주입 스크립트의 OSC 핸들러가 잡아
// 화면에는 아무것도 남기지 않는다.
const TERMINAL_SCROLL_TO_BOTTOM_BYTES = Uint8Array.from(
  Buffer.from(TERMINAL_SCROLL_TO_BOTTOM_SEQUENCE, 'utf8'),
);

function resetTerminalViewport(terminal: XtermWebViewHandle) {
  terminal.write(TERMINAL_RESET_BYTES);
}

function restoreTerminalSnapshot(
  terminal: XtermWebViewHandle,
  snapshot: string | null | undefined,
) {
  resetTerminalViewport(terminal);
  if (!snapshot) {
    return;
  }

  terminal.write(Uint8Array.from(Buffer.from(snapshot, 'utf8')));
}

function getSessionStatusMeta(
  status: string,
  palette: MobilePalette,
  // 밖에서 끊긴 세션은 상태가 'error' 지만 사용자에게 오류가 아니다 — 앱을 전환했거나 네트워크가
  // 끊긴 것뿐이다. "Error" 로 붉게 보여주면 무언가 잘못된 것처럼 읽히므로 중립으로 표시한다.
  disconnectReason?: MobileSessionRecord['disconnectReason'],
) {
  // 상태를 함께 본다. 이유만 보면 다시 붙는 중이거나 이미 붙은 탭까지 "Disconnected" 로
  // 표시된다 — 표시가 실제 상태보다 오래 남는 쪽이 훨씬 나쁜 거짓말이다.
  if (disconnectReason === 'dropped' && status === 'error') {
    return {
      label: 'Disconnected',
      color: palette.sessionStatusMuted,
    };
  }
  switch (status) {
    case 'connected':
      return {
        label: 'Connected',
        color: palette.sessionStatusConnected,
      };
    case 'connecting':
    case 'pending':
    case 'disconnecting':
      return {
        label: 'Connecting',
        color: palette.sessionStatusWarning,
      };
    case 'error':
      return {
        label: 'Error',
        color: palette.sessionStatusError,
      };
    default:
      return {
        label: 'Closed',
        color: palette.sessionStatusMuted,
      };
  }
}

// 단축키 버튼의 표면. 방향키처럼 icon 이 지정된 키는 기호로 그린다 — 좁은 키보드
// 액세서리 바에서 "Up"/"Down" 글자보다 화살표가 훨씬 빨리 읽힌다. 접근성 이름은
// 호출부의 accessibilityLabel(=item.label)이 계속 담당하므로 여기서는 aria 를 만들지
// 않는다. 아이콘 크기는 버튼 높이(38)와 글자(12pt bold) 사이에서 고른 값이다.
function renderShortcutFace(item: TerminalShortcutItem, color: string) {
  if (item.icon) {
    return <Ionicons name={item.icon} size={16} color={color} />;
  }
  return <Text style={[styles.toolbarButtonText, { color }]}>{item.label}</Text>;
}

function isLiveSession(status: string) {
  return status !== 'closed';
}

export function SessionScreen(): React.JSX.Element {
  const { t: translate } = useTranslation();
  const palette = useMobilePalette();
  const navigation = useNavigation<NavigationProp<MainTabParamList>>();
  const safeAreaInsets = useSafeAreaInsets();
  const screenPadding = useScreenPadding({
    horizontal: 0,
    topOffset: 4,
    topMin: 12,
    includeSafeBottom: false,
    bottomOffset: 4,
    bottomMin: 4,
  });
  const { width, height } = useWindowDimensions();
  const terminalRef = useRef<XtermWebViewHandle | null>(null);
  const nativeTerminalInputRef = useRef<TerminalInputViewHandle | null>(null);
  const directTerminalInputSuppressedRef = useRef(false);
  const terminalInputStateRef = useRef<{
    sessionId: string | null;
    terminalVisible: boolean;
  }>({
    sessionId: null,
    terminalVisible: false,
  });
  const [terminalReady, setTerminalReady] = useState(false);
  // 터미널 준비 워치독 — nonce 가 바뀌면 WebView 를 리마운트해 로드를 처음부터 다시 시도한다.
  const [terminalRetryNonce, setTerminalRetryNonce] = useState(0);
  const terminalRetryCountRef = useRef(0);
  const [nativeInputFocusToken, setNativeInputFocusToken] = useState(0);
  const [nativeInputClearToken, setNativeInputClearToken] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [keyboardRequestedVisible, setKeyboardRequestedVisible] =
    useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [showMoreShortcuts, setShowMoreShortcuts] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(56);
  const isAndroid = Platform.OS === 'android';
  // iOS도 네이티브 입력 오버레이를 쓴다 — WebView(xterm) 직접 입력은 iOS WKWebView에서
  // 한글 IME 조합이 글자마다 끊겨 자모가 분리된다(조합은 네이티브 UITextView에서만 안전).
  const useTerminalInputOverlay = true;
  const keyboardClosedViewportHeightRef = useRef(height);
  const terminalViewportSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const restoredConnectedSnapshotSessionIdRef = useRef<string | null>(null);
  const previousActiveSessionRef = useRef<{
    id: string | null;
    status: string | null;
  }>({
    id: null,
    status: null,
  });
  const sessions = useMobileAppStore(state => state.sessions);
  const hosts = useMobileAppStore(state => state.hosts);
  const sftpSessions = useMobileAppStore(state => state.sftpSessions);
  const sftpTransfers = useMobileAppStore(state => state.sftpTransfers);
  const activeSessionTabId = useMobileAppStore(
    state => state.activeSessionTabId,
  );
  const activeConnectionTab = useMobileAppStore(
    state => state.activeConnectionTab,
  );
  const setActiveConnectionTab = useMobileAppStore(
    state => state.setActiveConnectionTab,
  );
  const setActiveSessionTab = useMobileAppStore(
    state => state.setActiveSessionTab,
  );
  const resumeSession = useMobileAppStore(state => state.resumeSession);
  const disconnectSession = useMobileAppStore(state => state.disconnectSession);
  const duplicateSession = useMobileAppStore(state => state.duplicateSession);
  const openSftpEditor = useMobileAppStore(state => state.openSftpEditor);
  const openSftpForSession = useMobileAppStore(
    state => state.openSftpForSession,
  );
  const disconnectSftpSession = useMobileAppStore(
    state => state.disconnectSftpSession,
  );
  const listSftpDirectory = useMobileAppStore(state => state.listSftpDirectory);
  const sftpCopyBuffer = useMobileAppStore(state => state.sftpCopyBuffer);
  const downloadSftpFile = useMobileAppStore(state => state.downloadSftpFile);
  const downloadSftpEntries = useMobileAppStore(
    state => state.downloadSftpEntries,
  );
  const uploadSftpFile = useMobileAppStore(state => state.uploadSftpFile);
  const createSftpDirectory = useMobileAppStore(
    state => state.createSftpDirectory,
  );
  const renameSftpEntry = useMobileAppStore(state => state.renameSftpEntry);
  const chmodSftpEntry = useMobileAppStore(state => state.chmodSftpEntry);
  const deleteSftpEntries = useMobileAppStore(state => state.deleteSftpEntries);
  const copySftpEntries = useMobileAppStore(state => state.copySftpEntries);
  const pasteSftpEntries = useMobileAppStore(state => state.pasteSftpEntries);
  const clearSftpCopyBuffer = useMobileAppStore(
    state => state.clearSftpCopyBuffer,
  );
  const writeToSession = useMobileAppStore(state => state.writeToSession);
  const subscribeToSessionTerminal = useMobileAppStore(
    state => state.subscribeToSessionTerminal,
  );
  const reportTerminalGrid = useMobileAppStore(
    state => state.reportTerminalGrid,
  );

  const goBackToPreviousMainTab = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate('Home');
  }, [navigation]);

  // OS 가 백그라운드에서 프로세스를 회수하면 SSH 연결도 함께 끊기고, 콜드스타트에서
  // 살아있던 세션은 closed 로 정규화된다. 탭은 live 세션만 보여주므로 사용자 눈에는
  // 세션이 사라진 것처럼 보인다 — 다시 붙을 수 있게 재연결 목록으로 남겨준다.
  // One entry per host, newest first. Reconnecting to the same host over a day
  // leaves a closed session behind each time, so without this the list fills up
  // with the same name repeated — and `sessions` is in tab order, not recency,
  // so the five it used to show were an arbitrary five.
  const reconnectableSessions = useMemo(() => {
    const restorable = sortSessionsByRecency(
      sessions.filter(
        session => !isLiveSession(session.status) && session.isRestorable,
      ),
    );
    const seenHosts = new Set<string>();
    const newestPerHost: typeof restorable = [];
    for (const session of restorable) {
      if (seenHosts.has(session.hostId)) {
        continue;
      }
      seenHosts.add(session.hostId);
      newestPerHost.push(session);
    }
    return newestPerHost.slice(0, 5);
  }, [sessions]);
  const liveSessions = useMemo(
    () => sessions.filter(session => isLiveSession(session.status)),
    [sessions],
  );
  const liveSftpSessions = useMemo(
    () => sftpSessions.filter(session => session.status !== 'closed'),
    [sftpSessions],
  );

  // 탭은 연 순서로 늘어서고 그 뒤로 움직이지 않는다. 터미널·SFTP 를 종류별로 이어 붙이면
  // 터미널 다음에 SFTP 를 열고 또 터미널을 열었을 때 새 터미널이 SFTP 앞으로 끼어든다 —
  // 두 종류를 openedAt 하나로 섞어 정렬한다(lastEventAt 은 활동마다 바뀌어 기준이 못 된다).
  const connectionTabs = useMemo(() => {
    const tabs = [
      ...liveSessions.map(session => ({
        kind: 'terminal' as const,
        id: session.id,
        session,
      })),
      ...liveSftpSessions.map(session => ({
        kind: 'sftp' as const,
        id: session.id,
        session,
      })),
    ];
    // openedAt 이 없던 버전의 레코드는 순서를 바꾸지 않도록 제자리에 둔다.
    return tabs
      .map((tab, index) => ({ tab, index }))
      .sort((left, right) => {
        const leftOpenedAt = left.tab.session.openedAt;
        const rightOpenedAt = right.tab.session.openedAt;
        if (!leftOpenedAt || !rightOpenedAt) {
          return left.index - right.index;
        }
        return (
          leftOpenedAt.localeCompare(rightOpenedAt) || left.index - right.index
        );
      })
      .map(entry => entry.tab);
  }, [liveSessions, liveSftpSessions]);

  useEffect(() => {
    const tabStillExists =
      activeConnectionTab?.kind === 'terminal'
        ? liveSessions.some(session => session.id === activeConnectionTab.id)
        : activeConnectionTab?.kind === 'sftp'
          ? liveSftpSessions.some(
              session => session.id === activeConnectionTab.id,
            )
          : false;
    if (tabStillExists) {
      return;
    }
    const fallbackTerminalId =
      activeSessionTabId &&
      liveSessions.some(session => session.id === activeSessionTabId)
        ? activeSessionTabId
        : liveSessions[0]?.id;
    const nextTab = fallbackTerminalId
      ? { kind: 'terminal' as const, id: fallbackTerminalId }
      : liveSftpSessions[0]
        ? { kind: 'sftp' as const, id: liveSftpSessions[0].id }
        : null;
    setActiveConnectionTab(nextTab);
  }, [
    activeConnectionTab,
    activeSessionTabId,
    liveSessions,
    liveSftpSessions,
    setActiveConnectionTab,
  ]);

  const activeTab =
    activeConnectionTab &&
    connectionTabs.some(
      tab =>
        tab.kind === activeConnectionTab.kind &&
        tab.id === activeConnectionTab.id,
    )
      ? activeConnectionTab
      : connectionTabs[0]
        ? { kind: connectionTabs[0].kind, id: connectionTabs[0].id }
        : null;
  const activeSession =
    activeTab?.kind === 'terminal'
      ? (liveSessions.find(session => session.id === activeTab.id) ?? null)
      : null;
  const activeSftpSession =
    activeTab?.kind === 'sftp'
      ? (liveSftpSessions.find(session => session.id === activeTab.id) ?? null)
      : null;
  // 붙는 중에만 값이 있다. 실패하면 실패한 단계가 남는다 — 그때가 이 화면이 가장 필요한 순간이다.
  const activeConnectionView = useMobileAppStore(state =>
    activeSession ? state.connectionViews[activeSession.id] : undefined,
  );
  // 서버 배너는 여기서 터미널에 쓰지 않는다. 스토어가 세션 스냅샷에 합쳐 두고
  // (lib/terminal-banner), 아래 스냅샷 복원 effect 들이 그리므로 백그라운드 탭·늦은
  // WebView 부팅·재접속이 한 경로로 처리된다. 직접 쓰면 다음 복원에서 지워진다.

  // 액션 바 문구는 주입 시점에 정해진다(WebView 안에서는 i18n 을 쓸 수 없다).
  const terminalGestureScript = useMemo(
    () =>
      buildTerminalGestureScript({
        copy: translate('session.terminalCopy'),
        paste: translate('session.terminalPaste'),
        selectAll: translate('session.terminalSelectAll'),
      }),
    [translate],
  );

  const connectionStages = useMemo(
    () =>
      resolveMobileConnectionStages({
        view: activeConnectionView,
        status: activeSession?.status,
      }),
    [activeConnectionView, activeSession?.status],
  );
  // 내장 편집기는 엔진 SFTP 에만 있다 — AWS SFTP 는 sync-api 브로커를 지나며 파일
  // 읽기/쓰기 연산이 없어 편집 항목을 내보내지 않는다.
  const activeSftpHost = activeSftpSession
    ? hosts.find(host => host.id === activeSftpSession.hostId)
    : undefined;
  const canEditSftpFiles = Boolean(
    activeSftpHost && isSshHostRecord(activeSftpHost),
  );
  const [rememberedTerminalSessionId, setRememberedTerminalSessionId] =
    useState<string | null>(() => {
      if (activeTab?.kind === 'terminal') {
        return activeTab.id;
      }
      if (
        activeSessionTabId &&
        liveSessions.some(session => session.id === activeSessionTabId)
      ) {
        return activeSessionTabId;
      }
      return liveSessions[0]?.id ?? null;
    });
  useEffect(() => {
    if (activeTab?.kind === 'terminal') {
      setRememberedTerminalSessionId(activeTab.id);
      return;
    }

    setRememberedTerminalSessionId(current => {
      if (current && liveSessions.some(session => session.id === current)) {
        return current;
      }
      if (
        activeSessionTabId &&
        liveSessions.some(session => session.id === activeSessionTabId)
      ) {
        return activeSessionTabId;
      }
      return liveSessions[0]?.id ?? null;
    });
  }, [activeSessionTabId, activeTab?.id, activeTab?.kind, liveSessions]);
  const rememberedTerminalSession =
    rememberedTerminalSessionId != null
      ? (liveSessions.find(
          session => session.id === rememberedTerminalSessionId,
        ) ?? null)
      : null;
  const renderedTerminalSession = activeSession ?? rememberedTerminalSession;
  const terminalVisible = Boolean(
    activeSession && renderedTerminalSession?.id === activeSession.id,
  );
  const menuSession =
    liveSessions.find(session => session.id === menuSessionId) ?? null;
  const menuHost = menuSession
    ? (hosts.find(host => host.id === menuSession.hostId) ?? null)
    : null;
  const canOpenSftpFromMenu = Boolean(
    menuHost && (isSshHostRecord(menuHost) || isAwsEc2HostRecord(menuHost)),
  );
  const handleTerminalGesture = useCallback(
    (gesture: TerminalGestureEvent) => {
      if (gesture.type === 'copy') {
        // 선택 UI 는 WebView 안에 있고(RN→웹 채널이 없다), 클립보드만 네이티브를 쓴다.
        Clipboard.setString(gesture.text);
        return;
      }
      if (gesture.type === 'paste') {
        // 클립보드는 네이티브에만 있다. 읽어서 base64 OSC 로 웹에 되돌려주면
        // xterm 의 paste() 가 bracketed paste 까지 알아서 처리한다.
        void Clipboard.getString().then(text => {
          if (!text) {
            return;
          }
          terminalRef.current?.write(
            Uint8Array.from(Buffer.from(terminalPasteSequence(text), 'utf8')),
          );
        });
        return;
      }
      if (gesture.type === 'trace') {
        // 웹 쪽 판정 트레이스 — 시뮬레이션 검증용 채널이라 UI 에는 띄우지 않는다.
        return;
      }
      if (gesture.type === 'key') {
        // sendDirectTerminalInput 이 아니라 sendSessionInput 이다. 전자는 xterm 자체
        // 키 에코용 경로라 소프트 키보드가 떠 있으면 이중 입력 방지로 통째로 막힌다
        // (directTerminalInputSuppressedRef) — 제스처로 만든 Tab 까지 함께 사라진다.
        // 이건 사용자 입력이므로 타이핑과 같이 맨 아래로 되돌린다.
        sendSessionInput('\t');
        return;
      }
      // 방향키는 하단 바의 Left/Right 와 같은 시퀀스다. 다만 맨 아래로 튕기지는 않는다.
      sendSessionInput(arrowSequence(gesture.direction, gesture.count), {
        scrollToBottom: false,
      });
    },
    // sendDirectTerminalInput 은 ref 만 읽으므로 재생성되지 않아도 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // logger 는 릴리스에서도 항상 넘긴다 — xterm 이 실제로 fit 한 그리드가 이 채널로
  // 오고(TERMINAL_GRID_REPORT_SCRIPT), 그 값이 원격 PTY 크기의 기준이 된다.
  const terminalLogger = useMemo(
    () => ({
      debug: (...args: unknown[]) => {
        if (__DEV__) {
          console.log('[xterm-webview]', ...args);
        }
      },
      log: (...args: unknown[]) => {
        const grid = parseReportedTerminalGrid(args);
        if (grid) {
          reportTerminalGrid(grid);
          if (__DEV__) {
            console.log('[xterm-grid]', `${grid.cols}x${grid.rows}`);
          }
          return;
        }
        const gesture = parseTerminalGestureEvent(args);
        if (gesture) {
          handleTerminalGesture(gesture);
          return;
        }
        if (__DEV__) {
          console.log('[xterm-webview]', ...args);
        }
      },
      warn: (...args: unknown[]) => {
        if (__DEV__) {
          console.warn('[xterm-webview]', ...args);
        }
      },
      error: (...args: unknown[]) => {
        if (__DEV__) {
          console.error('[xterm-webview]', ...args);
        }
      },
    }),
    [reportTerminalGrid, handleTerminalGesture],
  );
  const keyboardToggleActive = isAndroid
    ? keyboardVisible || keyboardRequestedVisible
    : keyboardVisible;
  terminalInputStateRef.current = {
    sessionId: renderedTerminalSession?.id ?? null,
    terminalVisible,
  };
  // 소프트 키보드가 떠 있는 동안은 네이티브 오버레이가 입력을 담당하므로 WebView(xterm)
  // 직접 입력을 막아 이중 입력을 방지한다. 키보드가 없을 때(하드웨어 키보드 등)는 허용.
  directTerminalInputSuppressedRef.current = isAndroid
    ? keyboardRequestedVisible || keyboardVisible
    : keyboardVisible;
  const toolbarKeyboardInset = getKeyboardDockInset({
    keyboardVisible,
    keyboardInset: keyboardInset + (isAndroid ? safeAreaInsets.bottom : 0),
    currentViewportHeight: height,
    keyboardClosedViewportHeight: keyboardClosedViewportHeightRef.current,
    minimumVisibleInset: isAndroid ? safeAreaInsets.bottom + 12 : 0,
  });

  useEffect(() => {
    if (!keyboardVisible || height >= keyboardClosedViewportHeightRef.current) {
      keyboardClosedViewportHeightRef.current = height;
    }
  }, [height, keyboardVisible]);

  useEffect(() => {
    if (!terminalReady || !terminalViewportSizeRef.current) {
      return;
    }
    terminalRef.current?.fit();
  }, [terminalReady]);

  useEffect(() => {
    if (renderedTerminalSession) {
      return;
    }
    setTerminalReady(false);
    terminalViewportSizeRef.current = null;
    restoredConnectedSnapshotSessionIdRef.current = null;
  }, [renderedTerminalSession]);

  // 터미널 준비 워치독: 벤더드 xterm WebView 페이지는 로드 후 200ms 에 initialized 를
  // "딱 한 번" 쏘고 재시도가 없다(그 시점에 xterm 렌더가 늦으면 신호가 영영 유실 —
  // dist-internal 번들이라 페이지 쪽 수정 불가). 신호가 유실되면 "터미널 준비 중"
  // 오버레이가 남는데, WebView 를 리마운트하면 로드부터 다시 시도되어 회복된다
  // (홈→복귀 시 우연히 회복되던 것의 자동화). 세션당 제한 횟수만 재시도한다.
  const renderedTerminalSessionId = renderedTerminalSession?.id ?? null;

  useEffect(() => {
    terminalRetryCountRef.current = 0;
  }, [renderedTerminalSessionId]);

  useEffect(() => {
    if (terminalReady || !renderedTerminalSessionId) {
      return;
    }
    if (terminalRetryCountRef.current >= TERMINAL_READY_RETRY_LIMIT) {
      return;
    }
    const timer = setTimeout(() => {
      terminalRetryCountRef.current += 1;
      setTerminalRetryNonce(nonce => nonce + 1);
    }, TERMINAL_READY_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [terminalReady, renderedTerminalSessionId, terminalRetryNonce]);

  const focusTerminal = useCallback(() => {
    if (Platform.OS === 'android') {
      return;
    }
    requestAnimationFrame(() => {
      terminalRef.current?.focus();
    });
  }, []);

  const blurTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      terminalRef.current?.blur();
    });
  }, []);

  const focusRequestedTerminalInput = useCallback(
    (force = false) => {
      if (!useTerminalInputOverlay) {
        focusTerminal();
        return;
      }

      if (!force && !inputFocused) {
        return;
      }

      requestAnimationFrame(() => {
        if (isAndroid && !force) {
          return;
        }
        if (force) {
          setNativeInputFocusToken(value => value + 1);
        }
        nativeTerminalInputRef.current?.focus();
      });
    },
    [focusTerminal, inputFocused, isAndroid, useTerminalInputOverlay],
  );

  useEffect(() => {
    if (
      !useTerminalInputOverlay ||
      !terminalReady ||
      !activeSession ||
      !terminalVisible
    ) {
      return;
    }

    focusRequestedTerminalInput(true);
  }, [
    activeSession,
    focusRequestedTerminalInput,
    terminalReady,
    terminalVisible,
    useTerminalInputOverlay,
  ]);

  useEffect(() => {
    if (!terminalReady || !terminalVisible || !renderedTerminalSession) {
      return;
    }

    requestAnimationFrame(() => {
      terminalRef.current?.fit();
      if (isAndroid) {
        focusRequestedTerminalInput(true);
      }
    });
  }, [
    focusRequestedTerminalInput,
    isAndroid,
    renderedTerminalSession,
    terminalReady,
    terminalVisible,
  ]);

  const openKeyboard = useCallback(() => {
    if (Platform.OS === 'android') {
      setInputFocused(true);
      directTerminalInputSuppressedRef.current = true;
      setKeyboardRequestedVisible(true);
      focusRequestedTerminalInput(true);
      return;
    }

    setInputFocused(true);
    focusRequestedTerminalInput(true);
  }, [focusRequestedTerminalInput]);

  const closeKeyboard = useCallback(() => {
    setKeyboardVisible(false);
    setKeyboardInset(0);
    if (Platform.OS === 'android') {
      setInputFocused(true);
      directTerminalInputSuppressedRef.current = false;
      setKeyboardRequestedVisible(false);
      focusRequestedTerminalInput(true);
      return;
    }

    setInputFocused(false);
    Keyboard.dismiss();
    nativeTerminalInputRef.current?.blur();
  }, [focusRequestedTerminalInput]);

  const toggleKeyboard = useCallback(() => {
    if (keyboardToggleActive) {
      closeKeyboard();
      return;
    }

    openKeyboard();
  }, [closeKeyboard, keyboardToggleActive, openKeyboard]);

  useEffect(() => {
    const syncKeyboardShown = (event?: {
      endCoordinates?: { height?: number };
    }) => {
      setKeyboardVisible(true);
      setKeyboardInset(event?.endCoordinates?.height ?? 0);
      if (isAndroid) {
        setInputFocused(true);
        directTerminalInputSuppressedRef.current = true;
        setKeyboardRequestedVisible(true);
      }
    };
    const syncKeyboardHidden = () => {
      setKeyboardVisible(false);
      setKeyboardInset(0);
      if (isAndroid) {
        directTerminalInputSuppressedRef.current = false;
        setKeyboardRequestedVisible(false);
      }
    };
    const subscriptions =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillShow', syncKeyboardShown),
            Keyboard.addListener('keyboardDidShow', syncKeyboardShown),
            Keyboard.addListener('keyboardWillHide', syncKeyboardHidden),
            Keyboard.addListener('keyboardDidHide', syncKeyboardHidden),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', syncKeyboardShown),
            Keyboard.addListener('keyboardDidHide', syncKeyboardHidden),
          ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  }, [isAndroid]);

  useEffect(() => {
    if (!activeSession) {
      previousActiveSessionRef.current = {
        id: null,
        status: null,
      };
      restoredConnectedSnapshotSessionIdRef.current = null;
      return;
    }

    const previousActiveSession = previousActiveSessionRef.current;
    const shouldAutoOpenKeyboard =
      previousActiveSession.id !== activeSession.id ||
      (previousActiveSession.id === activeSession.id &&
        previousActiveSession.status !== 'connected' &&
        activeSession.status === 'connected');

    previousActiveSessionRef.current = {
      id: activeSession.id,
      status: activeSession.status,
    };

    if (!shouldAutoOpenKeyboard) {
      return;
    }

    setInputFocused(true);
    focusRequestedTerminalInput(true);
  }, [activeSession, focusRequestedTerminalInput]);

  useEffect(() => {
    if (
      !terminalReady ||
      !renderedTerminalSession ||
      renderedTerminalSession.status === 'connected'
    ) {
      return;
    }

    if (
      restoredConnectedSnapshotSessionIdRef.current ===
      renderedTerminalSession.id
    ) {
      restoredConnectedSnapshotSessionIdRef.current = null;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    restoreTerminalSnapshot(
      terminal,
      renderedTerminalSession.lastViewportSnapshot,
    );
  }, [
    renderedTerminalSession,
    renderedTerminalSession?.id,
    renderedTerminalSession?.lastViewportSnapshot,
    renderedTerminalSession?.status,
    terminalReady,
  ]);

  useEffect(() => {
    if (
      !terminalReady ||
      !renderedTerminalSession ||
      renderedTerminalSession.status !== 'connected'
    ) {
      return;
    }

    if (
      restoredConnectedSnapshotSessionIdRef.current ===
      renderedTerminalSession.id
    ) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    restoredConnectedSnapshotSessionIdRef.current = renderedTerminalSession.id;
    restoreTerminalSnapshot(
      terminal,
      renderedTerminalSession.lastViewportSnapshot,
    );
  }, [
    renderedTerminalSession,
    renderedTerminalSession?.id,
    renderedTerminalSession?.lastViewportSnapshot,
    renderedTerminalSession?.status,
    terminalReady,
  ]);

  useEffect(() => {
    if (
      !terminalReady ||
      !renderedTerminalSession ||
      renderedTerminalSession.status !== 'connected'
    ) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetTerminalViewport(terminal);
    const unsubscribe = subscribeToSessionTerminal(renderedTerminalSession.id, {
      onReplay: chunks => {
        resetTerminalViewport(terminal);
        if (chunks.length > 0) {
          terminal.writeMany(chunks);
        }
        if (!terminalVisible) {
          return;
        }
        focusRequestedTerminalInput(true);
      },
      onData: chunk => {
        terminal.write(chunk);
      },
    });

    return unsubscribe;
  }, [
    renderedTerminalSession,
    renderedTerminalSession?.id,
    renderedTerminalSession?.status,
    isAndroid,
    subscribeToSessionTerminal,
    terminalReady,
    terminalVisible,
    focusTerminal,
    focusRequestedTerminalInput,
  ]);

  useEffect(() => {
    if (
      useTerminalInputOverlay ||
      !terminalReady ||
      !terminalVisible ||
      activeSession?.status !== 'connected'
    ) {
      return;
    }

    focusTerminal();
  }, [
    activeSession?.id,
    activeSession?.status,
    focusTerminal,
    terminalReady,
    terminalVisible,
    useTerminalInputOverlay,
  ]);

  const resetNativeInputBuffer = () => {
    setNativeInputClearToken(value => value + 1);
  };

  const sendSessionInput = (
    value: string,
    // 제스처 방향키는 false 다. 타이핑이 아니라 화면을 다루는 동작이라, 매 방향키마다 맨
    // 아래로 튕기면 스크롤과 싸우는 것처럼 보인다.
    options?: { scrollToBottom?: boolean },
  ) => {
    const inputState = terminalInputStateRef.current;
    if (!value || !inputState.terminalVisible || !inputState.sessionId) {
      return;
    }
    // 스크롤백을 올려다본 상태에서 뭔가 입력하면 커서 위치로 돌아오는 것이 터미널의 기본
    // 동작이다. xterm 의 scrollOnUserInput 은 xterm 이 키를 직접 받을 때만 발동하는데 이 앱은
    // 네이티브 입력 오버레이를 쓰므로, 입력과 함께 신호를 흘려보내 같은 효과를 낸다.
    if (options?.scrollToBottom !== false) {
      terminalRef.current?.write(TERMINAL_SCROLL_TO_BOTTOM_BYTES);
    }
    void writeToSession(inputState.sessionId, value);
  };

  const sendDirectTerminalInput = (value: string) => {
    const inputState = terminalInputStateRef.current;
    if (
      !inputState.terminalVisible ||
      directTerminalInputSuppressedRef.current
    ) {
      return;
    }
    // xterm 자동 질의 응답은 걸러낸다 — 셸 에코와 만나면 무한 핑퐁이 된다
    // (stripTerminalQueryReplies 주석 참고).
    const sanitized = stripTerminalQueryReplies(value);
    if (!sanitized) {
      return;
    }
    sendSessionInput(sanitized);
  };

  const sendTranslatedInput = (event: NativeTerminalInputEvent) => {
    const payload = translateTerminalInputEventToSequence(event);
    if (!payload) {
      return;
    }
    sendSessionInput(payload);
  };

  const sendShortcut = (event: NativeTerminalInputEvent) => {
    sendTranslatedInput(event);
    resetNativeInputBuffer();
    focusRequestedTerminalInput(true);
  };

  if (!activeTab) {
    return (
      <IosEdgeSwipeBack onBack={goBackToPreviousMainTab}>
        <View
          style={[
            styles.screen,
            styles.centered,
            {
              backgroundColor: palette.sessionChrome,
              paddingTop: screenPadding.paddingTop,
              paddingBottom: screenPadding.paddingBottom,
              paddingHorizontal: 14,
            },
          ]}
        >
          <View
            style={[
              styles.emptyCard,
              {
                backgroundColor: palette.surface,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Text style={[styles.emptyTitle, { color: palette.text }]}>
              {translate("session.noSessionsTitle")}
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              {translate("session.noSessionsBody")}
            </Text>
            {reconnectableSessions.length > 0 ? (
              <View style={styles.reconnectList}>
                <Text
                  style={[styles.reconnectHeading, { color: palette.mutedText }]}
                >
                  {translate("session.recentSessions")}
                </Text>
                {reconnectableSessions.map(session => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={translate("session.reconnectAria", { title: session.title })}
                    onPress={() => {
                      void resumeSession(session.id);
                    }}
                    style={[
                      styles.reconnectRow,
                      {
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.sessionSurfaceBorder,
                      },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.reconnectTitle, { color: palette.text }]}
                    >
                      {session.title}
                    </Text>
                    <Text
                      style={[styles.reconnectAction, { color: palette.accent }]}
                    >
                      {translate("session.reconnect")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </IosEdgeSwipeBack>
    );
  }
  return (
    <IosEdgeSwipeBack onBack={goBackToPreviousMainTab}>
      <View
        style={[
          styles.screen,
          {
            backgroundColor: palette.sessionChrome,
            paddingTop: screenPadding.paddingTop,
          },
        ]}
      >
      <View style={styles.tabStripShell}>
        <ScrollView
          horizontal
          contentContainerStyle={styles.tabStrip}
          showsHorizontalScrollIndicator={false}
        >
          {connectionTabs.map(tab => {
            const isTerminal = tab.kind === 'terminal';
            const session = tab.session;
            const droppedReason = isTerminal
              ? (session as MobileSessionRecord).disconnectReason
              : undefined;
            const tabStatus = getSessionStatusMeta(
              session.status,
              palette,
              droppedReason,
            );
            const isActive =
              activeTab.kind === tab.kind && activeTab.id === tab.id;
            const title = isTerminal ? session.title : session.title;
            return (
              <Pressable
                key={`${tab.kind}:${session.id}`}
                accessibilityRole="button"
                accessibilityLabel={translate("session.tabAria", { title, status: tabStatus.label })}
                accessibilityState={{ selected: isActive }}
                onPress={() => {
                  if (isTerminal) {
                    // 밖에서 끊긴 탭은 탭하면 다시 붙인다. 전에는 전환만 되어 빈 화면을
                    // 보게 됐고, 재연결하려면 오류 배너나 "최근 세션" 까지 가야 했다.
                    // 표시와 같은 조건을 쓴다 — 이미 붙는 중인 탭을 탭했다고 재연결을
                    // 다시 걸지 않는다.
                    if (droppedReason === 'dropped' && session.status === 'error') {
                      void resumeSession(session.id);
                    } else {
                      setActiveSessionTab(session.id);
                    }
                  } else {
                    setActiveConnectionTab({ kind: tab.kind, id: session.id });
                  }
                  if (isTerminal) {
                    focusRequestedTerminalInput(true);
                  }
                }}
                style={[
                  styles.sessionTab,
                  {
                    backgroundColor: isActive
                      ? palette.accentSoft
                      : palette.surfaceAlt,
                    borderColor: isActive
                      ? palette.accent
                      : palette.sessionToolbarBorder,
                    borderWidth: isActive ? 2 : 1,
                  },
                ]}
              >
                <View
                  style={[
                    styles.sessionTabStatusDot,
                    { backgroundColor: tabStatus.color },
                  ]}
                />
                {!isTerminal ? (
                  <Ionicons
                    name="folder"
                    size={15}
                    color={isActive ? palette.accent : palette.mutedText}
                  />
                ) : null}
                <Text
                  numberOfLines={1}
                  style={[
                    styles.sessionTabTitle,
                    {
                      color: isActive ? palette.text : palette.mutedText,
                      fontWeight: isActive ? '800' : '700',
                    },
                  ]}
                >
                  {title}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    isTerminal
                      ? translate("session.menuAria", { title: session.title })
                      : translate("session.closeAria", { title: session.title })
                  }
                  hitSlop={8}
                  onPress={async event => {
                    event.stopPropagation();
                    if (isTerminal) {
                      setMenuSessionId(session.id);
                      return;
                    }
                    await disconnectSftpSession(session.id);
                  }}
                  style={styles.sessionTabCloseButton}
                >
                  <Ionicons
                    name={isTerminal ? 'ellipsis-vertical' : 'close'}
                    size={14}
                    color={isActive ? palette.accent : palette.mutedText}
                  />
                </Pressable>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(menuSession)}
        onRequestClose={() => setMenuSessionId(null)}
      >
        <Pressable
          style={[
            styles.sessionMenuOverlay,
            { backgroundColor: palette.overlay },
          ]}
          onPress={() => setMenuSessionId(null)}
        >
          <View
            style={[
              styles.sessionMenuCard,
              {
                backgroundColor: palette.sessionMenuSurface,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            {menuSession ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={translate("session.duplicateAria", { title: menuSession.title })}
                onPress={async () => {
                  const sessionId = menuSession.id;
                  setMenuSessionId(null);
                  await duplicateSession(sessionId);
                }}
                style={styles.sessionMenuItem}
              >
                <Ionicons name="copy" size={22} color={palette.mutedText} />
                <Text style={[styles.sessionMenuText, { color: palette.text }]}>
                  Duplicate
                </Text>
              </Pressable>
            ) : null}
            {menuSession && canOpenSftpFromMenu ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Connect via SFTP"
                onPress={async () => {
                  const sessionId = menuSession.id;
                  setMenuSessionId(null);
                  await openSftpForSession(sessionId);
                }}
                style={styles.sessionMenuItem}
              >
                <Ionicons name="folder" size={22} color={palette.mutedText} />
                <Text style={[styles.sessionMenuText, { color: palette.text }]}>
                  Connect via SFTP
                </Text>
              </Pressable>
            ) : null}
            {menuSession ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={translate("session.closeSessionAria", { title: menuSession.title })}
                onPress={async () => {
                  const sessionId = menuSession.id;
                  setMenuSessionId(null);
                  await disconnectSession(sessionId);
                }}
                style={styles.sessionMenuItem}
              >
                <Ionicons name="close" size={22} color={palette.mutedText} />
                <Text style={[styles.sessionMenuText, { color: palette.text }]}>
                  Close
                </Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Modal>

      {/* 연결이 어디까지 갔는지. 한 줄 문구였을 때는 지나간 관문이 사라져서, 실패했을 때
          tailnet 인지 SSH 인지 구분할 수 없었다 — 데스크톱과 같은 단계 목록을 쓴다. 실패한
          뒤에도 남겨 보여준다(그때가 가장 필요하다). */}
      {activeSession && connectionStages.length > 0 ? (
        <ConnectionStagesPanel
          title={activeSession.title}
          stages={connectionStages}
          busy={activeSession.status === 'connecting'}
        />
      ) : null}

      {activeSession?.errorMessage ? (
        <View
          style={[
            styles.inlineBanner,
            {
              backgroundColor: palette.surface,
              borderColor: palette.sessionStatusError,
              marginHorizontal: 4,
            },
          ]}
        >
          <View style={styles.inlineBannerCopy}>
            <Text style={[styles.inlineBannerTitle, { color: palette.text }]}>
              {activeSession.title}
            </Text>
            <Text
              style={[styles.inlineBannerText, { color: palette.mutedText }]}
            >
              {activeSession.errorMessage}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translate("session.reconnectAria", { title: activeSession.title })}
            onPress={async () => {
              await resumeSession(activeSession.id);
              focusRequestedTerminalInput(true);
            }}
            style={[
              styles.inlineBannerButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Text
              style={[styles.inlineBannerButtonText, { color: palette.text }]}
            >
              {translate("session.reconnect")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View
        testID="session-screen-body"
        style={[
          styles.screenBody,
          {
            paddingBottom:
              activeTab.kind === 'terminal'
                ? toolbarHeight + toolbarKeyboardInset
                : screenPadding.paddingBottom,
          },
        ]}
      >
        <View style={styles.connectionLayerShell}>
          {renderedTerminalSession ? (
            <View
              pointerEvents={terminalVisible ? 'auto' : 'none'}
              style={[
                styles.connectionLayer,
                terminalVisible
                  ? styles.activeConnectionLayer
                  : styles.inactiveConnectionLayer,
              ]}
            >
              <View
                testID="session-terminal-card"
                onLayout={event => {
                  const nextWidth = Math.ceil(event.nativeEvent.layout.width);
                  const nextHeight = Math.ceil(event.nativeEvent.layout.height);
                  if (nextWidth <= 0 || nextHeight <= 0) {
                    return;
                  }
                  const current = terminalViewportSizeRef.current;
                  if (
                    current?.width === nextWidth &&
                    current?.height === nextHeight
                  ) {
                    return;
                  }
                  terminalViewportSizeRef.current = {
                    width: nextWidth,
                    height: nextHeight,
                  };
                  if (!terminalReady) {
                    return;
                  }
                  terminalRef.current?.fit();
                }}
                style={[
                  styles.terminalCard,
                  {
                    backgroundColor: palette.sessionTerminalBg,
                    borderColor: palette.sessionSurfaceBorder,
                    marginHorizontal: 2,
                  },
                ]}
                onTouchEnd={
                  terminalVisible
                    ? () => focusRequestedTerminalInput(true)
                    : undefined
                }
              >
                <XtermJsWebView
                  key={`terminal-retry-${terminalRetryNonce}`}
                  ref={terminalRef}
                  style={styles.terminal}
                  logger={terminalLogger}
                  webViewOptions={{
                    hideKeyboardAccessoryView: true,
                    // 스크롤은 주입 스크립트가 term.scrollLines 로 직접 굴린다. WebView 자체
                    // 스크롤뷰를 켜 두면 방향키 제스처와 동시에 돌아 화면이 두 번 움직인다.
                    // CSS(touch-action·overflow)만으로는 네이티브 스크롤뷰를 막지 못한다.
                    scrollEnabled: false,
                    // 실제 fit 된 그리드를 보고받아 PTY 크기를 맞춘다. onMessage 는
                    // 넘기면 안 된다 — 패키지 핸들러를 덮어써 입출력이 끊긴다.
                    injectedJavaScript: `${TERMINAL_GRID_REPORT_SCRIPT}\n${terminalGestureScript}`,
                  }}
                  onInitialized={() => setTerminalReady(true)}
                  // 링크는 xterm 의 web-links 애드온이 찾고, 여는 것은 여기서 정한다. 페이지가
                  // 직접 열면 WebView 가 그 주소로 이동해 터미널이 사라진다(세션도 함께).
                  // 계정·tailnet 로그인과 같은 인앱 시트로 연다 — 앱을 벗어나지 않아야 승인이
                  // 필요한 연결을 그 자리에서 끝낼 수 있다.
                  onLinkActivated={uri => {
                    void openInAppBrowser(uri).catch(() => {
                      // 열 수 없는 주소는 그대로 둔다. 글은 터미널에 남아 있으므로 사용자가
                      // 직접 옮겨 적을 수 있고, 여기서 오류창을 띄우면 화면을 가린다.
                    });
                  }}
                  onData={data => {
                    sendDirectTerminalInput(data);
                  }}
                  xtermOptions={{
                    fontSize: width > height ? 12 : 11,
                    scrollback: 2_000,
                    theme: {
                      background: palette.sessionTerminalBg,
                      foreground: palette.sessionTerminalFg,
                      cursor: palette.sessionTerminalCursor,
                      selectionBackground: palette.sessionTerminalSelection,
                    },
                  }}
                />
                {!terminalReady ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.terminalLoadingOverlay,
                      { backgroundColor: palette.sessionTerminalBg },
                    ]}
                  >
                    <ActivityIndicator size="small" color={palette.accent} />
                    <Text
                      style={[
                        styles.terminalLoadingTitle,
                        { color: palette.text },
                      ]}
                    >
                      {translate("session.terminalPreparing")}
                    </Text>
                    <Text
                      style={[
                        styles.terminalLoadingBody,
                        { color: palette.mutedText },
                      ]}
                    >
                      {activeSession?.connectionStatusMessage ??
                        translate("session.loadingScreen")}
                    </Text>
                  </View>
                ) : null}
                {useTerminalInputOverlay && terminalVisible ? (
                  <View
                    pointerEvents="none"
                    style={styles.nativeTerminalInputShell}
                  >
                    <TerminalInputView
                      ref={nativeTerminalInputRef}
                      clearToken={nativeInputClearToken}
                      focusToken={nativeInputFocusToken}
                      focused={inputFocused}
                      softKeyboardEnabled={
                        isAndroid ? keyboardRequestedVisible : undefined
                      }
                      onTerminalInput={event => {
                        sendTranslatedInput(event.nativeEvent);
                        if (event.nativeEvent.kind === 'special-key') {
                          resetNativeInputBuffer();
                        }
                      }}
                      style={styles.nativeTerminalInput}
                    />
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {activeSftpSession ? (
            <View
              style={[styles.connectionLayer, styles.activeConnectionLayer]}
            >
              <SftpBrowserView
                palette={palette}
                session={activeSftpSession}
                transfers={sftpTransfers}
                onNavigate={path =>
                  listSftpDirectory(activeSftpSession.id, path)
                }
                onRefresh={() => listSftpDirectory(activeSftpSession.id)}
                onUpload={() => uploadSftpFile(activeSftpSession.id)}
                onDownload={path =>
                  downloadSftpFile(activeSftpSession.id, path)
                }
                onDownloadEntries={paths =>
                  downloadSftpEntries(activeSftpSession.id, paths)
                }
                onMkdir={name =>
                  createSftpDirectory(activeSftpSession.id, name)
                }
                onRename={(sourcePath, nextName) =>
                  renameSftpEntry(activeSftpSession.id, sourcePath, nextName)
                }
                onChmod={(path, mode) =>
                  chmodSftpEntry(activeSftpSession.id, path, mode)
                }
                onDelete={paths =>
                  deleteSftpEntries(activeSftpSession.id, paths)
                }
                onEdit={
                  canEditSftpFiles
                    ? path => void openSftpEditor(activeSftpSession.id, path)
                    : undefined
                }
                copyBufferCount={
                  sftpCopyBuffer?.sftpSessionId === activeSftpSession.id
                    ? sftpCopyBuffer.entries.length
                    : 0
                }
                onCopy={paths => copySftpEntries(activeSftpSession.id, paths)}
                onPaste={() => pasteSftpEntries(activeSftpSession.id)}
                onClearCopy={clearSftpCopyBuffer}
              />
            </View>
          ) : null}
        </View>

        {activeSession ? (
          <View
            testID="session-toolbar-shell"
            onLayout={event => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              if (nextHeight > 0 && nextHeight !== toolbarHeight) {
                setToolbarHeight(nextHeight);
              }
            }}
            style={[
              styles.toolbarShell,
              {
                backgroundColor: palette.sessionToolbar,
                borderTopColor: palette.sessionToolbarBorder,
                paddingBottom: screenPadding.paddingBottom,
                bottom: toolbarKeyboardInset,
              },
            ]}
          >
            {showMoreShortcuts ? (
              <View
                style={[
                  styles.toolbarSecondaryShell,
                  {
                    borderBottomColor: palette.sessionToolbarBorder,
                  },
                ]}
              >
                <ScrollView
                  horizontal
                  style={styles.toolbarScroll}
                  contentContainerStyle={[
                    styles.toolbar,
                    styles.toolbarSecondaryContent,
                  ]}
                  showsHorizontalScrollIndicator={false}
                >
                  {TERMINAL_SECONDARY_SHORTCUTS.map(item => (
                    <Pressable
                      key={item.label}
                      accessibilityRole="button"
                      accessibilityLabel={translate("session.controlKeyAria", { label: item.label })}
                      onPress={() => sendShortcut(item.event)}
                      style={[
                        styles.toolbarButton,
                        {
                          backgroundColor: palette.surfaceAlt,
                          borderColor: palette.sessionToolbarBorder,
                        },
                      ]}
                    >
                      {renderShortcutFace(item, palette.text)}
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
            <View style={styles.toolbarPrimaryRow}>
              <ScrollView
                horizontal
                style={styles.toolbarPrimaryScroll}
                contentContainerStyle={styles.toolbar}
                showsHorizontalScrollIndicator={false}
              >
                {TERMINAL_PRIMARY_SHORTCUTS.map(item => (
                  <Pressable
                    key={item.label}
                    accessibilityRole="button"
                    accessibilityLabel={translate("session.controlKeyAria", { label: item.label })}
                    onPress={() => sendShortcut(item.event)}
                    style={[
                      styles.toolbarButton,
                      {
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.sessionToolbarBorder,
                      },
                    ]}
                  >
                    {renderShortcutFace(item, palette.text)}
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    showMoreShortcuts
                      ? translate("session.hideExtraKeys")
                      : translate("session.showExtraKeys")
                  }
                  onPress={() => setShowMoreShortcuts(value => !value)}
                  style={[
                    styles.toolbarButton,
                    styles.toolbarActionButton,
                    {
                      backgroundColor: showMoreShortcuts
                        ? palette.accentSoft
                        : palette.surfaceAlt,
                      borderColor: showMoreShortcuts
                        ? palette.accent
                        : palette.sessionToolbarBorder,
                    },
                  ]}
                >
                  <Ionicons
                    name={
                      showMoreShortcuts ? 'chevron-down' : 'ellipsis-horizontal'
                    }
                    size={14}
                    color={
                      showMoreShortcuts ? palette.accent : palette.mutedText
                    }
                  />
                  <Text
                    style={[
                      styles.toolbarButtonText,
                      {
                        color: palette.text,
                        fontWeight: showMoreShortcuts ? '800' : '700',
                      },
                    ]}
                  >
                    {translate("session.more")}
                  </Text>
                </Pressable>
              </ScrollView>
              <View style={styles.toolbarKeyboardDock}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    translate(keyboardToggleActive ? "session.closeKeyboard" : "session.openKeyboard")
                  }
                  onPress={toggleKeyboard}
                  style={[
                    styles.toolbarKeyboardButton,
                    {
                      backgroundColor: keyboardToggleActive
                        ? palette.accentSoft
                        : palette.surfaceAlt,
                      borderColor: keyboardToggleActive
                        ? palette.accent
                        : palette.sessionToolbarBorder,
                    },
                  ]}
                >
                  <Ionicons
                    name="keypad-outline"
                    size={18}
                    color={
                      keyboardToggleActive ? palette.accent : palette.mutedText
                    }
                  />
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
      </View>
      </View>
      {/* 편집기는 전체화면 모달이라 SFTP 브라우저 위에 얹는다 — 열려 있을 때만 렌더된다. */}
      <RemoteFileEditorModal />
    </IosEdgeSwipeBack>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyCard: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 16,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  reconnectList: {
    marginTop: 18,
    gap: 8,
  },
  reconnectHeading: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  reconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  reconnectTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  reconnectAction: {
    fontSize: 14,
    fontWeight: '700',
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  tabStripShell: {
    paddingHorizontal: 4,
  },
  tabStrip: {
    paddingHorizontal: 2,
    gap: 8,
  },
  sessionTab: {
    minWidth: 124,
    maxWidth: 220,
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  sessionTabStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  sessionTabTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  sessionTabCloseButton: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionMenuOverlay: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 62,
    paddingRight: 14,
  },
  sessionMenuCard: {
    minWidth: 240,
    borderWidth: 1,
    borderRadius: 22,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 4,
  },
  sessionMenuItem: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 10,
  },
  sessionMenuText: {
    fontSize: 17,
    fontWeight: '800',
  },
  inlineBanner: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inlineBannerCopy: {
    flex: 1,
    gap: 2,
  },
  inlineBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  inlineBannerText: {
    fontSize: 12,
    lineHeight: 16,
  },
  inlineBannerButton: {
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineBannerButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  screenBody: {
    flex: 1,
  },
  connectionLayerShell: {
    flex: 1,
  },
  connectionLayer: {
    ...StyleSheet.absoluteFill,
  },
  activeConnectionLayer: {
    opacity: 1,
    zIndex: 1,
  },
  inactiveConnectionLayer: {
    opacity: 0,
    zIndex: 0,
  },
  terminalCard: {
    flex: 1,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 6,
    overflow: 'hidden',
    minHeight: 240,
  },
  terminal: {
    flex: 1,
  },
  terminalLoadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  terminalLoadingTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  terminalLoadingBody: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  nativeTerminalInput: {
    ...StyleSheet.absoluteFill,
  },
  nativeTerminalInputShell: {
    ...StyleSheet.absoluteFill,
  },
  toolbarShell: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
    borderTopWidth: 1,
    paddingTop: 5,
  },
  toolbarSecondaryShell: {
    borderBottomWidth: 1,
    marginBottom: 6,
    paddingBottom: 6,
  },
  toolbarScroll: {
    flexGrow: 0,
  },
  toolbarPrimaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
  },
  toolbarPrimaryScroll: {
    flex: 1,
  },
  toolbar: {
    gap: 6,
  },
  toolbarSecondaryContent: {
    paddingHorizontal: 6,
  },
  toolbarButton: {
    minWidth: 54,
    minHeight: 38,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarActionButton: {
    flexDirection: 'row',
    gap: 6,
  },
  toolbarKeyboardDock: {
    paddingRight: 2,
  },
  toolbarKeyboardButton: {
    width: 46,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarButtonText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
});
