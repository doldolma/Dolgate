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
import { isAwsEc2HostRecord, isSshHostRecord } from '@dolssh/shared-core';
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from '@fressh/react-native-xtermjs-webview';
import { IosEdgeSwipeBack } from '../components/IosEdgeSwipeBack';
import {
  TerminalInputView,
  type TerminalInputViewHandle,
} from '../components/TerminalInputView';
import { SftpBrowserView } from '../components/SftpBrowserView';
import { useScreenPadding } from '../lib/screen-layout';
import {
  TERMINAL_PRIMARY_SHORTCUTS,
  TERMINAL_SECONDARY_SHORTCUTS,
  stripTerminalQueryReplies,
  translateTerminalInputEventToSequence,
  type NativeTerminalInputEvent,
} from '../lib/terminal-input';
import { getKeyboardDockInset } from '../lib/keyboard-layout';
import {
  TERMINAL_GRID_REPORT_SCRIPT,
  parseReportedTerminalGrid,
} from '../lib/terminal-size';
import type { MainTabParamList } from '../navigation/RootNavigator';
import { useMobileAppStore } from '../store/useMobileAppStore';
import type { MobilePalette } from '../theme';
import { useMobilePalette } from '../theme';

const TERMINAL_RESET_BYTES = Uint8Array.from(
  Buffer.from('\u001b[3J\u001b[2J\u001b[H', 'utf8'),
);

// 터미널 준비 워치독 파라미터 — initialized 신호 유실 시 WebView 리마운트 간격/횟수.
const TERMINAL_READY_RETRY_DELAY_MS = 2000;
const TERMINAL_READY_RETRY_LIMIT = 4;

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

function getSessionStatusMeta(status: string, palette: MobilePalette) {
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

function isLiveSession(status: string) {
  return status !== 'closed';
}

export function SessionScreen(): React.JSX.Element {
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
  const reconnectableSessions = useMemo(
    () =>
      sessions
        .filter(
          session => !isLiveSession(session.status) && session.isRestorable,
        )
        .slice(0, 5),
    [sessions],
  );
  const liveSessions = useMemo(
    () => sessions.filter(session => isLiveSession(session.status)),
    [sessions],
  );
  const liveSftpSessions = useMemo(
    () => sftpSessions.filter(session => session.status !== 'closed'),
    [sftpSessions],
  );

  const connectionTabs = useMemo(
    () => [
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
    ],
    [liveSessions, liveSftpSessions],
  );

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
    [reportTerminalGrid],
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

  const sendSessionInput = (value: string) => {
    const inputState = terminalInputStateRef.current;
    if (!value || !inputState.terminalVisible || !inputState.sessionId) {
      return;
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
              열린 세션이 없습니다.
            </Text>
            <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
              Home에서 호스트를 열면 여기에 현재 연결 탭이 표시됩니다.
            </Text>
            {reconnectableSessions.length > 0 ? (
              <View style={styles.reconnectList}>
                <Text
                  style={[styles.reconnectHeading, { color: palette.mutedText }]}
                >
                  최근 세션
                </Text>
                {reconnectableSessions.map(session => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${session.title} 세션 재연결`}
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
                      재연결
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
            const tabStatus = getSessionStatusMeta(session.status, palette);
            const isActive =
              activeTab.kind === tab.kind && activeTab.id === tab.id;
            const title = isTerminal ? session.title : session.title;
            return (
              <Pressable
                key={`${tab.kind}:${session.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${title} ${tabStatus.label} 세션 탭`}
                accessibilityState={{ selected: isActive }}
                onPress={() => {
                  if (isTerminal) {
                    setActiveSessionTab(session.id);
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
                      ? `${session.title} 세션 메뉴`
                      : `${session.title} 닫기`
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
                accessibilityLabel={`${menuSession.title} 세션 복제`}
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
                accessibilityLabel={`${menuSession.title} 세션 닫기`}
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
            accessibilityLabel={`${activeSession.title} 세션 재연결`}
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
              재연결
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
                    // 실제 fit 된 그리드를 보고받아 PTY 크기를 맞춘다. onMessage 는
                    // 넘기면 안 된다 — 패키지 핸들러를 덮어써 입출력이 끊긴다.
                    injectedJavaScript: TERMINAL_GRID_REPORT_SCRIPT,
                  }}
                  onInitialized={() => setTerminalReady(true)}
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
                      터미널 준비 중
                    </Text>
                    <Text
                      style={[
                        styles.terminalLoadingBody,
                        { color: palette.mutedText },
                      ]}
                    >
                      연결 화면을 불러오고 있습니다.
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
                      accessibilityLabel={`${item.label} 제어키`}
                      onPress={() => sendShortcut(item.event)}
                      style={[
                        styles.toolbarButton,
                        {
                          backgroundColor: palette.surfaceAlt,
                          borderColor: palette.sessionToolbarBorder,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.toolbarButtonText,
                          { color: palette.text },
                        ]}
                      >
                        {item.label}
                      </Text>
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
                    accessibilityLabel={`${item.label} 제어키`}
                    onPress={() => sendShortcut(item.event)}
                    style={[
                      styles.toolbarButton,
                      {
                        backgroundColor: palette.surfaceAlt,
                        borderColor: palette.sessionToolbarBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.toolbarButtonText,
                        { color: palette.text },
                      ]}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    showMoreShortcuts
                      ? '추가 제어키 숨기기'
                      : '추가 제어키 표시'
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
                    더보기
                  </Text>
                </Pressable>
              </ScrollView>
              <View style={styles.toolbarKeyboardDock}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    keyboardToggleActive ? '키보드 닫기' : '키보드 열기'
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
