import React, { useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Ionicons from "react-native-vector-icons/Ionicons";
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from "@fressh/react-native-xtermjs-webview";
import { TerminalInputView } from "../components/TerminalInputView";
import { useScreenPadding } from "../lib/screen-layout";
import {
  TERMINAL_SHORTCUTS,
  translateTerminalInputEventToSequence,
  type NativeTerminalInputEvent,
} from "../lib/terminal-input";
import { estimateTerminalGridSizeFromWindow } from "../lib/terminal-size";
import { useMobileAppStore } from "../store/useMobileAppStore";
import type { MobilePalette } from "../theme";
import { useMobilePalette } from "../theme";

const TERMINAL_RESET_BYTES = Uint8Array.from(
  Buffer.from("\u001b[3J\u001b[2J\u001b[H", "utf8"),
);

function resetTerminalViewport(terminal: XtermWebViewHandle) {
  terminal.write(TERMINAL_RESET_BYTES);
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
  const [terminalReady, setTerminalReady] = useState(false);
  const [nativeInputFocusToken, setNativeInputFocusToken] = useState(0);
  const [nativeInputClearToken, setNativeInputClearToken] = useState(0);
  const useNativeTerminalInput = Platform.OS === "ios";
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
  const terminalSize = useMemo(
    () => estimateTerminalGridSizeFromWindow(width, height),
    [height, width],
  );
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

  useEffect(() => {
    if (!useNativeTerminalInput || !activeSession) {
      return;
    }

    const timer = setTimeout(() => {
      setNativeInputFocusToken((value) => value + 1);
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [activeSession?.id, useNativeTerminalInput]);

  useEffect(() => {
    if (!terminalReady || !activeSession || activeSession.status === "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetTerminalViewport(terminal);
    if (activeSession.lastViewportSnapshot) {
      terminal.write(
        Uint8Array.from(Buffer.from(activeSession.lastViewportSnapshot, "utf8")),
      );
    }
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
        if (useNativeTerminalInput) {
          setNativeInputFocusToken((value) => value + 1);
          return;
        }
        terminal.focus();
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
    subscribeToSessionTerminal,
    terminalReady,
    useNativeTerminalInput,
  ]);

  useEffect(() => {
    if (useNativeTerminalInput || !terminalReady || activeSession?.status !== "connected") {
      return;
    }

    terminalRef.current?.focus();
  }, [
    activeSession?.id,
    activeSession?.status,
    terminalReady,
    useNativeTerminalInput,
  ]);

  const focusNativeInput = () => {
    if (!useNativeTerminalInput) {
      terminalRef.current?.focus();
      return;
    }
    requestAnimationFrame(() => {
      setNativeInputFocusToken((value) => value + 1);
    });
  };

  const resetNativeInputBuffer = () => {
    if (!useNativeTerminalInput) {
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
    focusNativeInput();
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
                  focusNativeInput();
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
              focusNativeInput();
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
        style={[
          styles.terminalCard,
          {
            backgroundColor: palette.sessionTerminalBg,
            borderColor: palette.sessionSurfaceBorder,
            marginHorizontal: 2,
          },
        ]}
      >
        <XtermJsWebView
          ref={terminalRef}
          style={styles.terminal}
          autoFit={false}
          logger={terminalLogger}
          webViewOptions={{
            hideKeyboardAccessoryView: true,
          }}
          onInitialized={() => setTerminalReady(true)}
          onData={(data) => {
            if (useNativeTerminalInput) {
              return;
            }
            sendSessionInput(data);
          }}
          size={terminalSize}
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
        {useNativeTerminalInput ? (
          <TerminalInputView
            clearToken={nativeInputClearToken}
            focusToken={nativeInputFocusToken}
            focused
            onTerminalInput={(event) => {
              sendTranslatedInput(event.nativeEvent);
              if (event.nativeEvent.kind === "special-key") {
                resetNativeInputBuffer();
              }
              focusNativeInput();
            }}
            style={styles.nativeTerminalInput}
          />
        ) : null}
      </View>

      <View
        style={[
          styles.toolbarShell,
          {
            backgroundColor: palette.sessionToolbar,
            borderTopColor: palette.sessionToolbarBorder,
            paddingBottom: screenPadding.paddingBottom,
          },
        ]}
      >
        <ScrollView
          horizontal
          style={styles.toolbarScroll}
          contentContainerStyle={styles.toolbar}
          showsHorizontalScrollIndicator={false}
        >
          {TERMINAL_SHORTCUTS.map((item) => (
            <Pressable
              key={item.label}
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
  nativeTerminalInput: {
    ...StyleSheet.absoluteFill,
  },
  toolbarShell: {
    marginTop: 6,
    borderTopWidth: 1,
    paddingTop: 5,
  },
  toolbarScroll: {
    flexGrow: 0,
  },
  toolbar: {
    paddingHorizontal: 6,
    gap: 6,
  },
  toolbarButton: {
    minWidth: 52,
    minHeight: 32,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarButtonText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
});
