import React, { useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import {
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputKeyPressEventData,
  View,
  useWindowDimensions,
} from "react-native";
import Ionicons from "react-native-vector-icons/Ionicons";
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from "@fressh/react-native-xtermjs-webview";
import { formatRelativeTime } from "../lib/mobile";
import { useScreenPadding } from "../lib/screen-layout";
import type { SessionScreenProps } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import type { MobilePalette } from "../theme";
import { useMobilePalette } from "../theme";

const SESSION_SHORTCUTS = [
  { label: "ESC", value: "\u001b" },
  { label: "TAB", value: "\t" },
  { label: "Ctrl+C", value: "\u0003" },
  { label: "Up", value: "\u001b[A" },
  { label: "Down", value: "\u001b[B" },
  { label: "Left", value: "\u001b[D" },
  { label: "Right", value: "\u001b[C" },
  { label: "Enter", value: "\r" },
] as const;

const TERMINAL_BACKSPACE = "\u007f";
const TERMINAL_RESET_BYTES = Uint8Array.from(
  Buffer.from("\u001b[3J\u001b[2J\u001b[H", "utf8"),
);
const NATIVE_SPECIAL_KEY_MAP: Record<string, string> = {
  Tab: "\t",
  Escape: "\u001b",
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowLeft: "\u001b[D",
  ArrowRight: "\u001b[C",
  UIKeyInputUpArrow: "\u001b[A",
  UIKeyInputDownArrow: "\u001b[B",
  UIKeyInputLeftArrow: "\u001b[D",
  UIKeyInputRightArrow: "\u001b[C",
};

function buildTerminalSize(width: number, height: number) {
  return {
    cols: Math.max(32, Math.floor(width / 8)),
    rows: Math.max(18, Math.floor(height / 18)),
  };
}

function diffNativeInputValue(previousValue: string, nextValue: string) {
  const previousChars = Array.from(previousValue);
  const nextChars = Array.from(nextValue);
  let prefixLength = 0;

  while (
    prefixLength < previousChars.length &&
    prefixLength < nextChars.length &&
    previousChars[prefixLength] === nextChars[prefixLength]
  ) {
    prefixLength += 1;
  }

  return {
    deleteCount: previousChars.length - prefixLength,
    insertText: nextChars.slice(prefixLength).join(""),
  };
}

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

export function SessionScreen({
  navigation,
  route,
}: SessionScreenProps): React.JSX.Element {
  const { sessionId } = route.params;
  const palette = useMobilePalette();
  const screenPadding = useScreenPadding({
    horizontal: 0,
    topOffset: 8,
    topMin: 18,
    bottomOffset: 8,
    bottomMin: 12,
  });
  const { width, height } = useWindowDimensions();
  const terminalRef = useRef<XtermWebViewHandle | null>(null);
  const nativeInputRef = useRef<TextInput | null>(null);
  const nativeInputValueRef = useRef("");
  const hasAttemptedInitialResumeRef = useRef(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nativeInputValue, setNativeInputValue] = useState("");
  const useNativeTerminalInput = Platform.OS === "ios";
  const session = useMobileAppStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const host = useMobileAppStore((state) =>
    state.hosts.find((item) => item.id === session?.hostId),
  );
  const resumeSession = useMobileAppStore((state) => state.resumeSession);
  const disconnectSession = useMobileAppStore((state) => state.disconnectSession);
  const writeToSession = useMobileAppStore((state) => state.writeToSession);
  const subscribeToSessionTerminal = useMobileAppStore(
    (state) => state.subscribeToSessionTerminal,
  );
  const terminalSize = useMemo(
    () => buildTerminalSize(width, height - 176),
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
    if (!session || hasAttemptedInitialResumeRef.current) {
      return;
    }
    hasAttemptedInitialResumeRef.current = true;
    if (
      session.status === "connected" ||
      session.status === "connecting" ||
      session.status === "disconnecting"
    ) {
      return;
    }
    void resumeSession(sessionId);
  }, [resumeSession, session, sessionId]);

  useEffect(() => {
    if (!terminalReady || !session || session.status === "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetTerminalViewport(terminal);
    if (session.lastViewportSnapshot) {
      terminal.write(
        Uint8Array.from(Buffer.from(session.lastViewportSnapshot, "utf8")),
      );
    }
  }, [
    session,
    session?.id,
    session?.lastViewportSnapshot,
    session?.status,
    terminalReady,
  ]);

  useEffect(() => {
    if (!useNativeTerminalInput) {
      return;
    }

    const timer = setTimeout(() => {
      nativeInputRef.current?.focus();
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [sessionId, useNativeTerminalInput]);

  useEffect(() => {
    if (!terminalReady || !session || session.status !== "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    resetTerminalViewport(terminal);
    const unsubscribe = subscribeToSessionTerminal(session.id, {
      onReplay: (chunks) => {
        resetTerminalViewport(terminal);
        if (chunks.length > 0) {
          terminal.writeMany(chunks);
        }
        if (useNativeTerminalInput) {
          nativeInputRef.current?.focus();
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
    session,
    session?.id,
    session?.status,
    subscribeToSessionTerminal,
    terminalReady,
    useNativeTerminalInput,
  ]);

  if (!session) {
    return (
      <View
        style={[
          styles.centered,
          {
            backgroundColor: palette.sessionChrome,
          },
        ]}
      >
        <Text style={[styles.fallbackTitle, { color: palette.text }]}>
          세션을 찾을 수 없습니다.
        </Text>
      </View>
    );
  }

  const statusMeta = getSessionStatusMeta(session.status, palette);
  const hostConnectionDetails = host
    ? `${host.username}@${host.hostname}:${host.port}`
    : "연결 정보 없음";

  const focusNativeInput = () => {
    if (!useNativeTerminalInput) {
      return;
    }
    requestAnimationFrame(() => {
      nativeInputRef.current?.focus();
    });
  };

  const resetNativeInputBuffer = () => {
    nativeInputValueRef.current = "";
    setNativeInputValue("");
  };

  const sendSessionInput = (value: string) => {
    if (!value) {
      return;
    }
    void writeToSession(session.id, value);
  };

  const sendShortcut = (value: string) => {
    sendSessionInput(value);
    if (useNativeTerminalInput) {
      resetNativeInputBuffer();
      focusNativeInput();
    }
  };

  const handleNativeInputChange = (nextValue: string) => {
    const normalizedValue = nextValue.replace(/[\r\n]/g, "");
    const previousValue = nativeInputValueRef.current;
    if (normalizedValue === previousValue) {
      return;
    }

    const { deleteCount, insertText } = diffNativeInputValue(
      previousValue,
      normalizedValue,
    );
    nativeInputValueRef.current = normalizedValue;
    setNativeInputValue(normalizedValue);

    const payload = `${TERMINAL_BACKSPACE.repeat(deleteCount)}${insertText}`;
    sendSessionInput(payload);
  };

  const handleNativeInputKeyPress = (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    if (!useNativeTerminalInput) {
      return;
    }

    const { key } = event.nativeEvent;
    const mappedKey = NATIVE_SPECIAL_KEY_MAP[key];
    if (mappedKey) {
      sendSessionInput(mappedKey);
      return;
    }

    if (key === "Backspace" && nativeInputValueRef.current.length === 0) {
      sendSessionInput(TERMINAL_BACKSPACE);
      return;
    }
  };

  const handleNativeInputSubmit = () => {
    sendSessionInput("\r");
    resetNativeInputBuffer();
  };

  const handleGoBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.replace("MainTabs");
  };

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
      <View style={[styles.headerShell, { paddingHorizontal: 16 }]}>
        <View
          style={[
            styles.headerRow,
            {
              backgroundColor: palette.surface,
              borderColor: palette.sessionSurfaceBorder,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="세션 뒤로가기"
            hitSlop={10}
            onPress={handleGoBack}
            style={[
              styles.iconButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Ionicons name="chevron-back" size={20} color={palette.text} />
          </Pressable>

          <View style={styles.headerCenter}>
            <Text
              numberOfLines={1}
              style={[styles.headerTitle, { color: palette.text }]}
            >
              {host?.label ?? session.title}
            </Text>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: statusMeta.color,
                  },
                ]}
              />
              <Text style={[styles.statusText, { color: palette.mutedText }]}>
                {statusMeta.label} • {formatRelativeTime(session.lastEventAt)}
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="세션 메뉴 열기"
            hitSlop={10}
            onPress={() => setMenuOpen((value) => !value)}
            style={[
              styles.iconButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Ionicons
              name={menuOpen ? "close-outline" : "ellipsis-horizontal"}
              size={20}
              color={palette.text}
            />
          </Pressable>
        </View>

        {menuOpen ? (
          <View
            style={[
              styles.menuCard,
              {
                backgroundColor: palette.sessionMenuSurface,
                borderColor: palette.sessionSurfaceBorder,
              },
            ]}
          >
            <Text style={[styles.menuTitle, { color: palette.text }]}>
              {host?.label ?? session.title}
            </Text>
            <Text style={[styles.menuBody, { color: palette.mutedText }]}>
              {hostConnectionDetails}
            </Text>
            <Text style={[styles.menuBody, { color: palette.mutedText }]}>
              {statusMeta.label} • {formatRelativeTime(session.lastEventAt)}
            </Text>
            <View style={styles.menuActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="세션 재연결"
                onPress={async () => {
                  setMenuOpen(false);
                  await resumeSession(session.id);
                }}
                style={[
                  styles.menuActionButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.sessionSurfaceBorder,
                  },
                ]}
              >
                <Text style={[styles.menuActionText, { color: palette.text }]}>
                  재연결
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="세션 연결 종료"
                onPress={async () => {
                  setMenuOpen(false);
                  await disconnectSession(session.id);
                }}
                style={[
                  styles.menuActionButton,
                  {
                    backgroundColor: palette.surfaceAlt,
                    borderColor: palette.sessionSurfaceBorder,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.menuActionText,
                    { color: palette.sessionStatusError },
                  ]}
                >
                  연결 종료
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      {session.errorMessage ? (
        <View
          style={[
            styles.inlineBanner,
            {
              backgroundColor: palette.surface,
              borderColor: palette.sessionStatusError,
              marginHorizontal: 16,
            },
          ]}
        >
          <Text style={[styles.inlineBannerText, { color: palette.text }]}>
            {session.errorMessage}
          </Text>
        </View>
      ) : null}

      <View
        style={[
          styles.terminalCard,
          {
            backgroundColor: palette.sessionTerminalBg,
            borderColor: palette.sessionSurfaceBorder,
            marginHorizontal: 12,
          },
        ]}
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
          <TextInput
            ref={nativeInputRef}
            value={nativeInputValue}
            onChangeText={handleNativeInputChange}
            onKeyPress={handleNativeInputKeyPress}
            onFocus={() => setMenuOpen(false)}
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            caretHidden
            contextMenuHidden
            multiline={false}
            onSubmitEditing={handleNativeInputSubmit}
            selection={{
              start: nativeInputValue.length,
              end: nativeInputValue.length,
            }}
            selectionColor="transparent"
            submitBehavior="submit"
            spellCheck={false}
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
          {SESSION_SHORTCUTS.map((item) => (
            <Pressable
              key={item.label}
              onPress={() => sendShortcut(item.value)}
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
                  { color: palette.sessionToolbarActive },
                ]}
              >
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
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  fallbackTitle: {
    fontSize: 22,
    fontWeight: "900",
  },
  headerShell: {
    position: "relative",
    zIndex: 20,
  },
  headerRow: {
    minHeight: 58,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  statusText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  menuCard: {
    position: "absolute",
    top: 54,
    right: 16,
    width: 250,
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 8,
    shadowColor: "#061019",
    shadowOffset: {
      width: 0,
      height: 12,
    },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 8,
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  menuBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  menuActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  menuActionButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  menuActionText: {
    fontSize: 14,
    fontWeight: "700",
  },
  inlineBanner: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  inlineBannerText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  terminalCard: {
    flex: 1,
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 24,
    overflow: "hidden",
    minHeight: 240,
  },
  terminal: {
    flex: 1,
  },
  nativeTerminalInput: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "transparent",
    color: "transparent",
    opacity: 0.015,
  },
  toolbarShell: {
    marginTop: 12,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  toolbarScroll: {
    flexGrow: 0,
  },
  toolbar: {
    paddingHorizontal: 12,
    gap: 8,
  },
  toolbarButton: {
    minWidth: 58,
    minHeight: 40,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarButtonText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
});
