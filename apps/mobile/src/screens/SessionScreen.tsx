import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "react-native-vector-icons/Ionicons";
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from "@fressh/react-native-xtermjs-webview";
import {
  TerminalInputView,
  type TerminalInputViewHandle,
} from "../components/TerminalInputView";
import { useScreenPadding } from "../lib/screen-layout";
import {
  TERMINAL_PRIMARY_SHORTCUTS,
  TERMINAL_SECONDARY_SHORTCUTS,
  translateTerminalInputEventToSequence,
  type NativeTerminalInputEvent,
} from "../lib/terminal-input";
import { getKeyboardDockInset } from "../lib/keyboard-layout";
import { useMobileAppStore } from "../store/useMobileAppStore";
import type { MobilePalette } from "../theme";
import { useMobilePalette } from "../theme";

const TERMINAL_RESET_BYTES = Uint8Array.from(
  Buffer.from("\u001b[3J\u001b[2J\u001b[H", "utf8"),
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

  terminal.write(Uint8Array.from(Buffer.from(snapshot, "utf8")));
}

function getSessionStatusMeta(status: string, palette: MobilePalette) {
  switch (status) {
    case "connected":
      return {
        label: "Connected",
        color: palette.sessionStatusConnected,
      };
    case "connecting":
    case "pending":
    case "disconnecting":
      return {
        label: "Connecting",
        color: palette.sessionStatusWarning,
      };
    case "error":
      return {
        label: "Error",
        color: palette.sessionStatusError,
      };
    default:
      return {
        label: "Closed",
        color: palette.sessionStatusMuted,
      };
  }
}

function isLiveSession(status: string) {
  return status !== "closed";
}

export function SessionScreen(): React.JSX.Element {
  const palette = useMobilePalette();
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
  const [terminalReady, setTerminalReady] = useState(false);
  const [nativeInputFocusToken, setNativeInputFocusToken] = useState(0);
  const [nativeInputClearToken, setNativeInputClearToken] = useState(0);
  const [inputFocused, setInputFocused] = useState(true);
  const [keyboardRequestedVisible, setKeyboardRequestedVisible] = useState(
    Platform.OS === "ios",
  );
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [showMoreShortcuts, setShowMoreShortcuts] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(56);
  const isAndroid = Platform.OS === "android";
  const useTerminalInputOverlay = Platform.OS === "ios" || isAndroid;
  const keyboardClosedViewportHeightRef = useRef(height);
  const terminalViewportSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const restoredConnectedSnapshotSessionIdRef = useRef<string | null>(null);
  const ignoreKeyboardHideUntilRef = useRef(0);
  const previousActiveSessionRef = useRef<{
    id: string | null;
    status: string | null;
  }>({
    id: null,
    status: null,
  });
  const sessions = useMobileAppStore((state) => state.sessions);
  const activeSessionTabId = useMobileAppStore((state) => state.activeSessionTabId);
  const setActiveSessionTab = useMobileAppStore(
    (state) => state.setActiveSessionTab,
  );
  const resumeSession = useMobileAppStore((state) => state.resumeSession);
  const disconnectSession = useMobileAppStore((state) => state.disconnectSession);
  const writeToSession = useMobileAppStore((state) => state.writeToSession);
  const subscribeToSessionTerminal = useMobileAppStore(
    (state) => state.subscribeToSessionTerminal,
  );

  const liveSessions = useMemo(
    () => sessions.filter((session) => isLiveSession(session.status)),
    [sessions],
  );

  useEffect(() => {
    const nextActiveSessionId =
      (activeSessionTabId &&
      liveSessions.some((session) => session.id === activeSessionTabId)
        ? activeSessionTabId
        : liveSessions[0]?.id) ?? null;

    if (nextActiveSessionId !== activeSessionTabId) {
      setActiveSessionTab(nextActiveSessionId);
    }
  }, [activeSessionTabId, liveSessions, setActiveSessionTab]);

  const activeSession =
    liveSessions.find((session) => session.id === activeSessionTabId) ??
    liveSessions[0] ??
    null;
  const terminalLogger = useMemo(
    () =>
      __DEV__
        ? {
            debug: (...args: unknown[]) => console.log("[xterm-webview]", ...args),
            log: (...args: unknown[]) => console.log("[xterm-webview]", ...args),
            warn: (...args: unknown[]) =>
              console.warn("[xterm-webview]", ...args),
            error: (...args: unknown[]) =>
              console.error("[xterm-webview]", ...args),
          }
        : undefined,
    [],
  );
  const keyboardToggleActive = isAndroid
    ? keyboardVisible || keyboardRequestedVisible
    : keyboardVisible;
  const toolbarKeyboardInset = getKeyboardDockInset({
    keyboardVisible,
    keyboardInset:
      keyboardInset + (isAndroid ? safeAreaInsets.bottom : 0),
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

  const focusRequestedTerminalInput = useCallback(
    (force = false) => {
      if (!force && !inputFocused) {
        return;
      }

      requestAnimationFrame(() => {
        if (useTerminalInputOverlay) {
          if (isAndroid && !force) {
            return;
          }
          if (force) {
            setNativeInputFocusToken((value) => value + 1);
          }
          nativeTerminalInputRef.current?.focus();
          return;
        }
        if (!terminalReady) {
          return;
        }
        terminalRef.current?.focus();
      });
    },
    [inputFocused, isAndroid, terminalReady, useTerminalInputOverlay],
  );

  const openKeyboard = useCallback(() => {
    if (!isAndroid) {
      ignoreKeyboardHideUntilRef.current = Date.now() + 300;
    }
    setInputFocused(true);
    setKeyboardRequestedVisible(true);
    focusRequestedTerminalInput(true);
  }, [focusRequestedTerminalInput, isAndroid]);

  const closeKeyboard = useCallback(() => {
    ignoreKeyboardHideUntilRef.current = 0;
    setKeyboardVisible(false);
    setKeyboardInset(0);
    if (isAndroid) {
      setInputFocused(true);
      setKeyboardRequestedVisible(false);
      focusRequestedTerminalInput(true);
      return;
    }

    setInputFocused(false);
    setKeyboardRequestedVisible(false);
    if (useTerminalInputOverlay) {
      nativeTerminalInputRef.current?.blur();
      return;
    }

    requestAnimationFrame(() => {
      terminalRef.current?.blur();
    });
  }, [
    focusRequestedTerminalInput,
    isAndroid,
    useTerminalInputOverlay,
  ]);

  const toggleKeyboard = useCallback(() => {
    if (keyboardToggleActive) {
      closeKeyboard();
      return;
    }

    openKeyboard();
  }, [closeKeyboard, keyboardToggleActive, openKeyboard]);

  useEffect(() => {
    const syncKeyboardShown = (event?: { endCoordinates?: { height?: number } }) => {
      setKeyboardVisible(true);
      setKeyboardInset(event?.endCoordinates?.height ?? 0);
      setInputFocused(true);
      setKeyboardRequestedVisible(true);
    };
    const syncKeyboardHidden = () => {
      setKeyboardVisible(false);
      setKeyboardInset(0);
      if (Date.now() > ignoreKeyboardHideUntilRef.current) {
        if (!isAndroid) {
          setInputFocused(false);
        }
        setKeyboardRequestedVisible(false);
      }
    };
    const subscriptions =
      Platform.OS === "ios"
        ? [
            Keyboard.addListener("keyboardWillShow", syncKeyboardShown),
            Keyboard.addListener("keyboardDidShow", syncKeyboardShown),
            Keyboard.addListener("keyboardWillHide", syncKeyboardHidden),
            Keyboard.addListener("keyboardDidHide", syncKeyboardHidden),
          ]
        : [
            Keyboard.addListener("keyboardDidShow", syncKeyboardShown),
            Keyboard.addListener("keyboardDidHide", syncKeyboardHidden),
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
        previousActiveSession.status !== "connected" &&
        activeSession.status === "connected");

    previousActiveSessionRef.current = {
      id: activeSession.id,
      status: activeSession.status,
    };

    if (!shouldAutoOpenKeyboard) {
      return;
    }

    setInputFocused(true);
    if (isAndroid) {
      focusRequestedTerminalInput(true);
      return;
    }

    setKeyboardRequestedVisible(true);
    const timer = setTimeout(() => {
      openKeyboard();
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [activeSession, focusRequestedTerminalInput, isAndroid, openKeyboard]);

  useEffect(() => {
    if (!terminalReady || !activeSession || activeSession.status === "connected") {
      return;
    }

    if (restoredConnectedSnapshotSessionIdRef.current === activeSession.id) {
      restoredConnectedSnapshotSessionIdRef.current = null;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    restoreTerminalSnapshot(terminal, activeSession.lastViewportSnapshot);
  }, [
    activeSession,
    activeSession?.id,
    activeSession?.lastViewportSnapshot,
    activeSession?.status,
    terminalReady,
  ]);

  useEffect(() => {
    if (!terminalReady || !activeSession || activeSession.status !== "connected") {
      return;
    }

    if (restoredConnectedSnapshotSessionIdRef.current === activeSession.id) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    restoredConnectedSnapshotSessionIdRef.current = activeSession.id;
    restoreTerminalSnapshot(terminal, activeSession.lastViewportSnapshot);
  }, [
    activeSession,
    activeSession?.id,
    activeSession?.lastViewportSnapshot,
    activeSession?.status,
    terminalReady,
  ]);

  useEffect(() => {
    if (!terminalReady || !activeSession || activeSession.status !== "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetTerminalViewport(terminal);
    const unsubscribe = subscribeToSessionTerminal(activeSession.id, {
      onReplay: (chunks) => {
        resetTerminalViewport(terminal);
        if (chunks.length > 0) {
          terminal.writeMany(chunks);
        }
        focusRequestedTerminalInput(isAndroid);
      },
      onData: (chunk) => {
        terminal.write(chunk);
      },
    });

    return unsubscribe;
  }, [
    activeSession,
    activeSession?.id,
    activeSession?.status,
    isAndroid,
    subscribeToSessionTerminal,
    terminalReady,
    focusRequestedTerminalInput,
  ]);

  useEffect(() => {
    if (
      useTerminalInputOverlay ||
      !terminalReady ||
      activeSession?.status !== "connected"
    ) {
      return;
    }

    focusRequestedTerminalInput();
  }, [
    activeSession?.id,
    activeSession?.status,
    focusRequestedTerminalInput,
    terminalReady,
    useTerminalInputOverlay,
  ]);

  const resetNativeInputBuffer = () => {
    if (!useTerminalInputOverlay) {
      return;
    }
    setNativeInputClearToken((value) => value + 1);
  };

  const sendSessionInput = (value: string) => {
    if (!value || !activeSession) {
      return;
    }
    void writeToSession(activeSession.id, value);
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
    if (isAndroid) {
      focusRequestedTerminalInput(true);
      return;
    }
    openKeyboard();
  };

  if (!activeSession) {
    return (
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
        </View>
      </View>
    );
  }
  return (
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
          {liveSessions.map((session) => {
            const tabStatus = getSessionStatusMeta(session.status, palette);
            const isActive = session.id === activeSession.id;
            return (
              <Pressable
                key={session.id}
                accessibilityRole="button"
                accessibilityLabel={`${session.title} ${tabStatus.label} 세션 탭`}
                accessibilityState={{ selected: isActive }}
                onPress={() => {
                  setActiveSessionTab(session.id);
                  if (isAndroid) {
                    focusRequestedTerminalInput(true);
                    return;
                  }
                  openKeyboard();
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
                <Text
                  numberOfLines={1}
                  style={[
                    styles.sessionTabTitle,
                    {
                      color: isActive ? palette.text : palette.mutedText,
                      fontWeight: isActive ? "800" : "700",
                    },
                  ]}
                >
                  {session.title}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${session.title} 세션 닫기`}
                  hitSlop={8}
                  onPress={async (event) => {
                    event.stopPropagation();
                    await disconnectSession(session.id);
                  }}
                  style={styles.sessionTabCloseButton}
                >
                  <Ionicons
                    name="close"
                    size={14}
                    color={isActive ? palette.accent : palette.mutedText}
                  />
                </Pressable>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {activeSession.errorMessage ? (
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
            <Text style={[styles.inlineBannerText, { color: palette.mutedText }]}>
              {activeSession.errorMessage}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${activeSession.title} 세션 재연결`}
            onPress={async () => {
              await resumeSession(activeSession.id);
              if (isAndroid) {
                focusRequestedTerminalInput(true);
                return;
              }
              openKeyboard();
            }}
            style={[
              styles.inlineBannerButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Text style={[styles.inlineBannerButtonText, { color: palette.text }]}>
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
            paddingBottom: toolbarHeight + toolbarKeyboardInset,
          },
        ]}
      >
        <View
          testID="session-terminal-card"
          onLayout={(event) => {
            const nextWidth = Math.ceil(event.nativeEvent.layout.width);
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            if (nextWidth <= 0 || nextHeight <= 0) {
              return;
            }
            const current = terminalViewportSizeRef.current;
            if (current?.width === nextWidth && current?.height === nextHeight) {
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
          onTouchEnd={isAndroid ? () => focusRequestedTerminalInput(true) : undefined}
        >
          <XtermJsWebView
            ref={terminalRef}
            style={styles.terminal}
            logger={terminalLogger}
            webViewOptions={{
              hideKeyboardAccessoryView: true,
            }}
            onInitialized={() => setTerminalReady(true)}
            onData={(data) => {
              if (useTerminalInputOverlay) {
                return;
              }
              sendSessionInput(data);
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
              <Text style={[styles.terminalLoadingTitle, { color: palette.text }]}>
                터미널 준비 중
              </Text>
              <Text
                style={[styles.terminalLoadingBody, { color: palette.mutedText }]}
              >
                연결 화면을 불러오고 있습니다.
              </Text>
            </View>
          ) : null}
          {useTerminalInputOverlay ? (
            <View pointerEvents="none" style={styles.nativeTerminalInputShell}>
              <TerminalInputView
                ref={nativeTerminalInputRef}
                clearToken={nativeInputClearToken}
                focusToken={nativeInputFocusToken}
                focused={inputFocused}
                softKeyboardEnabled={isAndroid ? keyboardRequestedVisible : undefined}
                onTerminalInput={(event) => {
                  sendTranslatedInput(event.nativeEvent);
                  if (event.nativeEvent.kind === "special-key") {
                    resetNativeInputBuffer();
                  }
                  if (!isAndroid) {
                    focusRequestedTerminalInput(true);
                  }
                }}
                style={styles.nativeTerminalInput}
              />
            </View>
          ) : null}
        </View>

        <View
          testID="session-toolbar-shell"
          onLayout={(event) => {
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
                contentContainerStyle={[styles.toolbar, styles.toolbarSecondaryContent]}
                showsHorizontalScrollIndicator={false}
              >
                {TERMINAL_SECONDARY_SHORTCUTS.map((item) => (
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
                    <Text style={[styles.toolbarButtonText, { color: palette.text }]}>
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
              {TERMINAL_PRIMARY_SHORTCUTS.map((item) => (
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
                  <Text style={[styles.toolbarButtonText, { color: palette.text }]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  showMoreShortcuts ? "추가 제어키 숨기기" : "추가 제어키 표시"
                }
                onPress={() => setShowMoreShortcuts((value) => !value)}
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
                  name={showMoreShortcuts ? "chevron-down" : "ellipsis-horizontal"}
                  size={14}
                  color={showMoreShortcuts ? palette.accent : palette.mutedText}
                />
                <Text
                  style={[
                    styles.toolbarButtonText,
                    {
                      color: palette.text,
                      fontWeight: showMoreShortcuts ? "800" : "700",
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
                accessibilityLabel={keyboardToggleActive ? "키보드 닫기" : "키보드 열기"}
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
                  color={keyboardToggleActive ? palette.accent : palette.mutedText}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  centered: {
    justifyContent: "center",
    alignItems: "center",
  },
  emptyCard: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 16,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "800",
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
    flexDirection: "row",
    alignItems: "center",
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
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  sessionTabCloseButton: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineBanner: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  inlineBannerCopy: {
    flex: 1,
    gap: 2,
  },
  inlineBannerTitle: {
    fontSize: 13,
    fontWeight: "700",
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
    fontWeight: "700",
  },
  screenBody: {
    flex: 1,
  },
  terminalCard: {
    flex: 1,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
    minHeight: 240,
  },
  terminal: {
    flex: 1,
  },
  terminalLoadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 24,
  },
  terminalLoadingTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  terminalLoadingBody: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  nativeTerminalInput: {
    ...StyleSheet.absoluteFill,
  },
  nativeTerminalInputShell: {
    ...StyleSheet.absoluteFill,
  },
  toolbarShell: {
    position: "absolute",
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
    flexDirection: "row",
    alignItems: "center",
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
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarActionButton: {
    flexDirection: "row",
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
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarButtonText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
});
