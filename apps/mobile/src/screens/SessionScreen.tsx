import React, { useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  XtermJsWebView,
  type XtermWebViewHandle,
} from "@fressh/react-native-xtermjs-webview";
import { formatRelativeTime } from "../lib/mobile";
import type { SessionScreenProps } from "../navigation/RootNavigator";
import { useMobileAppStore } from "../store/useMobileAppStore";
import { useMobilePalette } from "../theme";

function buildTerminalSize(width: number, height: number) {
  return {
    cols: Math.max(32, Math.floor(width / 8)),
    rows: Math.max(18, Math.floor(height / 18)),
  };
}

export function SessionScreen({
  route,
}: SessionScreenProps): React.JSX.Element {
  const { sessionId } = route.params;
  const palette = useMobilePalette();
  const { width, height } = useWindowDimensions();
  const terminalRef = useRef<XtermWebViewHandle | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
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
    () => buildTerminalSize(width, height - 260),
    [height, width],
  );

  useEffect(() => {
    void resumeSession(sessionId);
  }, [resumeSession, sessionId]);

  useEffect(() => {
    if (!terminalReady || !session || session.status === "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.clear();
    if (session.lastViewportSnapshot) {
      terminal.write(
        Uint8Array.from(Buffer.from(session.lastViewportSnapshot, "utf8")),
      );
    }
  }, [session?.id, session?.lastViewportSnapshot, session?.status, terminalReady]);

  useEffect(() => {
    if (!terminalReady || !session || session.status !== "connected") {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.clear();
    const unsubscribe = subscribeToSessionTerminal(session.id, {
      onReplay: (chunks) => {
        terminal.clear();
        if (chunks.length > 0) {
          terminal.writeMany(chunks);
        }
        terminal.focus();
      },
      onData: (chunk) => {
        terminal.write(chunk);
      },
    });

    return unsubscribe;
  }, [
    session?.id,
    session?.status,
    subscribeToSessionTerminal,
    terminalReady,
  ]);

  if (!session) {
    return (
      <View
        style={[
          styles.centered,
          {
            backgroundColor: palette.background,
          },
        ]}
      >
        <Text style={[styles.title, { color: palette.text }]}>
          세션을 찾을 수 없습니다.
        </Text>
      </View>
    );
  }

  const sendShortcut = (value: string) => {
    void writeToSession(session.id, value);
  };

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: palette.background,
        },
      ]}
    >
      <View
        style={[
          styles.headerCard,
          {
            backgroundColor: palette.surface,
            borderColor: palette.border,
          },
        ]}
      >
        <Text style={[styles.title, { color: palette.text }]}>
          {host?.label ?? session.title}
        </Text>
        <Text style={[styles.subtitle, { color: palette.mutedText }]}>
          {host
            ? `${host.username}@${host.hostname}:${host.port}`
            : "연결 정보 없음"}
        </Text>
        <Text style={[styles.subtitle, { color: palette.mutedText }]}>
          {session.status} • {formatRelativeTime(session.lastEventAt)}
        </Text>
        {session.errorMessage ? (
          <Text style={[styles.errorText, { color: palette.danger }]}>
            {session.errorMessage}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Pressable
            onPress={() => void resumeSession(session.id)}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              재연결
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void disconnectSession(session.id)}
            style={[
              styles.secondaryButton,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>
              연결 종료
            </Text>
          </Pressable>
        </View>
      </View>

      <View
        style={[
          styles.terminalCard,
          {
            backgroundColor: "#020A10",
            borderColor: palette.border,
          },
        ]}
      >
        <XtermJsWebView
          ref={terminalRef}
          style={styles.terminal}
          onInitialized={() => setTerminalReady(true)}
          onData={(data) => void writeToSession(session.id, data)}
          size={terminalSize}
          xtermOptions={{
            fontSize: width > height ? 12 : 11,
            theme: {
              background: "#020A10",
              foreground: "#E7F0F7",
              cursor: "#5ED0FF",
              selectionBackground: "#22465d",
            },
          }}
        />
      </View>

      <ScrollView
        horizontal
        style={styles.toolbarScroll}
        contentContainerStyle={styles.toolbar}
        showsHorizontalScrollIndicator={false}
      >
        {[
          { label: "ESC", value: "\u001b" },
          { label: "TAB", value: "\t" },
          { label: "Ctrl+C", value: "\u0003" },
          { label: "Up", value: "\u001b[A" },
          { label: "Down", value: "\u001b[B" },
          { label: "Left", value: "\u001b[D" },
          { label: "Right", value: "\u001b[C" },
          { label: "Enter", value: "\r" },
        ].map((item) => (
          <Pressable
            key={item.label}
            onPress={() => sendShortcut(item.value)}
            style={[
              styles.toolbarButton,
              {
                backgroundColor: palette.surface,
                borderColor: palette.border,
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
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  headerCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 6,
  },
  title: {
    fontSize: 22,
    fontWeight: "900",
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    fontSize: 13,
    fontWeight: "700",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: "800",
  },
  terminalCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    overflow: "hidden",
    minHeight: 320,
  },
  terminal: {
    flex: 1,
  },
  toolbarScroll: {
    flexGrow: 0,
  },
  toolbar: {
    gap: 10,
    paddingBottom: 4,
  },
  toolbarButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  toolbarButtonText: {
    fontSize: 13,
    fontWeight: "800",
  },
});
