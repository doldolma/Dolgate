import React from "react";
import { Buffer } from "buffer";
import renderer, { act } from "react-test-renderer";
import { Keyboard, Platform, StyleSheet, Text } from "react-native";
import type {
  AuthState,
  MobileSessionRecord,
  SshHostRecord,
} from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import {
  TERMINAL_PRIMARY_SHORTCUTS,
  TERMINAL_SECONDARY_SHORTCUTS,
} from "../src/lib/terminal-input";
import { SessionScreen } from "../src/screens/SessionScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";
import { getPalette } from "../src/theme";

jest.mock("react-native-vector-icons/Ionicons", () => "Ionicons");
jest.mock("@fressh/react-native-uniffi-russh", () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
  },
}));

let mockCapturedXtermProps: Record<string, unknown> | null = null;
let mockNativeTerminalInputHandle: {
  focus: jest.Mock;
  blur: jest.Mock;
} | null = null;
let mockTerminalHandle: {
  write: jest.Mock;
  writeMany: jest.Mock;
  flush: jest.Mock;
  clear: jest.Mock;
  focus: jest.Mock;
  blur: jest.Mock;
  resize: jest.Mock;
  fit: jest.Mock;
} | null = null;
const keyboardListeners = new Map<string, Set<(event?: unknown) => void>>();
const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

function setPlatformOs(os: "ios" | "android") {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    get: () => os,
  });
}

function emitKeyboardEvent(
  name: string,
  event?: { endCoordinates?: { height?: number } },
) {
  const listeners = keyboardListeners.get(name);
  if (!listeners) {
    return;
  }

  for (const listener of [...listeners]) {
    listener(event);
  }
}

jest.mock("@fressh/react-native-xtermjs-webview", () => {
  const mockReact = require("react") as typeof React;
  return {
    XtermJsWebView: mockReact.forwardRef(
      (
        props: {
          onInitialized?: () => void;
          webViewOptions?: Record<string, unknown>;
        },
        ref: React.ForwardedRef<unknown>,
      ) => {
        mockCapturedXtermProps = props as Record<string, unknown>;
        mockReact.useImperativeHandle(ref, () => mockTerminalHandle, []);
        mockReact.useEffect(() => {
          props.onInitialized?.();
        }, [props.onInitialized]);
        return null;
      },
    ),
  };
});
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("../src/components/TerminalInputView", () => {
  const mockReact = require("react") as typeof React;
  return {
    TerminalInputView: mockReact.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mockReact.useImperativeHandle(ref, () => mockNativeTerminalInputHandle, []);
        return mockReact.createElement("TerminalInputView", props);
      },
    ),
  };
});
jest.mock("../src/lib/screen-layout", () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 0,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 24,
    left: 0,
    right: 0,
  }),
}));

function collectText(
  node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null,
): string[] {
  if (!node) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectText(child));
  }

  return (node.children ?? []).flatMap((child) => {
    if (typeof child === "string") {
      return [child];
    }
    return collectText(child);
  });
}

function createAuthenticatedState(): AuthState {
  return {
    status: "authenticated",
    session: {
      user: {
        id: "user-1",
        email: "mobile@example.com",
      },
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresInSeconds: 900,
      },
      vaultBootstrap: {
        keyBase64: "a2V5",
      },
      offlineLease: {
        token: "offline-token",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: "public-key",
      },
      syncServerTime: new Date().toISOString(),
    },
    offline: null,
    errorMessage: null,
  };
}

describe("SessionScreen", () => {
  const session: MobileSessionRecord = {
    id: "session-1",
    sessionId: "session-1",
    hostId: "host-1",
    title: "Synology",
    status: "connected",
    hasReceivedOutput: true,
    isRestorable: true,
    lastViewportSnapshot: "prompt",
    lastEventAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    lastDisconnectedAt: null,
    errorMessage: null,
  };

  const secondSession: MobileSessionRecord = {
    id: "session-2",
    sessionId: "session-2",
    hostId: "host-2",
    title: "Docker-ubuntu",
    status: "connecting",
    hasReceivedOutput: false,
    isRestorable: true,
    lastViewportSnapshot: "",
    lastEventAt: new Date(Date.now() - 1_000).toISOString(),
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    errorMessage: null,
  };

  const hosts: SshHostRecord[] = [
    {
      id: "host-1",
      kind: "ssh",
      label: "Synology",
      hostname: "doldolma.com",
      port: 2788,
      username: "doyoung",
      authType: "password",
      secretRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "host-2",
      kind: "ssh",
      label: "Docker-ubuntu",
      hostname: "docker.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      secretRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    jest.useFakeTimers();
    setPlatformOs("ios");
    keyboardListeners.clear();
    jest.spyOn(Keyboard, "addListener").mockImplementation((eventName, listener) => {
      const typedListener = listener as (event?: unknown) => void;
      const listeners = keyboardListeners.get(eventName) ?? new Set();
      listeners.add(typedListener);
      keyboardListeners.set(eventName, listeners);
      return {
        remove: () => {
          listeners.delete(typedListener);
        },
      } as ReturnType<typeof Keyboard.addListener>;
    });
    mockCapturedXtermProps = null;
    mockNativeTerminalInputHandle = {
      focus: jest.fn(),
      blur: jest.fn(),
    };
    mockTerminalHandle = {
      write: jest.fn(),
      writeMany: jest.fn(),
      flush: jest.fn(),
      clear: jest.fn(),
      focus: jest.fn(),
      blur: jest.fn(),
      resize: jest.fn(),
      fit: jest.fn(),
    };
    act(() => {
      useMobileAppStore.setState({
        hydrated: true,
        bootstrapping: false,
        authGateResolved: true,
        secureStateReady: true,
        auth: createAuthenticatedState(),
        settings: {
          ...createDefaultMobileSettings(),
          theme: "dark",
        },
        syncStatus: createDefaultSyncStatus(),
        groups: [],
        hosts,
        knownHosts: [],
        secretMetadata: [],
        sessions: [session, secondSession],
        activeSessionTabId: "session-1",
        secretsByRef: {},
        pendingBrowserLoginState: null,
        pendingServerKeyPrompt: null,
        pendingCredentialPrompt: null,
        resumeSession: jest.fn(async () => "session-1"),
        disconnectSession: jest.fn(async () => undefined),
        writeToSession: jest.fn(async () => undefined),
        subscribeToSessionTerminal: jest.fn(() => () => undefined),
        setActiveSessionTab: jest.fn(),
      });
    });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, "OS", platformOsDescriptor);
    }
  });

  it("renders the live session tabs and hides the old detail header controls", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Synology");
    expect(text).toContain("Docker-ubuntu");
    expect(text).not.toContain("키보드");
    expect(text).toContain("더보기");
    expect(text).not.toContain("Backspace");
    expect(text).not.toContain("Connected");
    expect(text).not.toContain("세션 뒤로가기");
    expect(text).not.toContain("세션 메뉴 열기");
    expect(mockCapturedXtermProps).not.toBeNull();
    expect(mockCapturedXtermProps?.autoFit).toBe(false);
    expect(mockCapturedXtermProps?.webViewOptions).toMatchObject({
      hideKeyboardAccessoryView: true,
    });
    expect(
      tree!.root.findByProps({
        accessibilityLabel: "키보드 열기",
      }),
    ).toBeDefined();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("expands and collapses the secondary keyboard shortcut row", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const expandButton = tree!.root.findByProps({
      accessibilityLabel: "추가 제어키 표시",
    });

    await act(async () => {
      expandButton.props.onPress();
    });

    expect(collectText(tree!.toJSON())).toContain("Backspace");
    expect(collectText(tree!.toJSON())).toContain(":");
    expect(collectText(tree!.toJSON())).toContain("!");
    expect(collectText(tree!.toJSON())).toContain("Ctrl+Z");

    const collapseButton = tree!.root.findByProps({
      accessibilityLabel: "추가 제어키 숨기기",
    });

    await act(async () => {
      collapseButton.props.onPress();
    });

    expect(collectText(tree!.toJSON())).not.toContain("Backspace");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("makes the selected tab visually distinct without reusing the session status color", async () => {
    const palette = getPalette("dark", "dark");
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const activeTab = tree!.root.findByProps({
      accessibilityLabel: "Synology Connected 세션 탭",
    });
    const inactiveTab = tree!.root.findByProps({
      accessibilityLabel: "Docker-ubuntu Connecting 세션 탭",
    });

    const activeTabStyle = StyleSheet.flatten(activeTab.props.style);
    const inactiveTabStyle = StyleSheet.flatten(inactiveTab.props.style);

    expect(activeTab.props.accessibilityState).toEqual({ selected: true });
    expect(inactiveTab.props.accessibilityState).toEqual({ selected: false });
    expect(activeTabStyle.backgroundColor).toBe(palette.accentSoft);
    expect(activeTabStyle.borderColor).toBe(palette.accent);
    expect(activeTabStyle.borderWidth).toBe(2);
    expect(inactiveTabStyle.backgroundColor).toBe(palette.surfaceAlt);
    expect(inactiveTabStyle.borderColor).toBe(palette.sessionToolbarBorder);
    expect(inactiveTabStyle.borderWidth).toBe(1);

    const activeTabTitle = activeTab.findByType(Text);
    const activeTitleStyle = StyleSheet.flatten(activeTabTitle.props.style);
    expect(activeTitleStyle.color).toBe(palette.text);
    expect(activeTitleStyle.fontWeight).toBe("800");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("toggles the iOS keyboard through TerminalInputView focus state", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    let nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.focused).toBe(true);

    await act(async () => {
      emitKeyboardEvent("keyboardDidShow", {
        endCoordinates: { height: 280 },
      });
    });

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 닫기",
    });

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(mockNativeTerminalInputHandle!.blur).toHaveBeenCalled();
    nativeInput = tree!.root.find((node) => (node.type as unknown) === "TerminalInputView");
    expect(nativeInput.props.focused).toBe(false);

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 열기",
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(mockNativeTerminalInputHandle!.focus).toHaveBeenCalled();
    nativeInput = tree!.root.find((node) => (node.type as unknown) === "TerminalInputView");
    expect(nativeInput.props.focused).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("reopens the iOS keyboard after a system dismiss event", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    let nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.focused).toBe(true);

    await act(async () => {
      emitKeyboardEvent("keyboardDidShow", {
        endCoordinates: { height: 280 },
      });
      emitKeyboardEvent("keyboardDidHide");
    });

    nativeInput = tree!.root.find((node) => (node.type as unknown) === "TerminalInputView");
    expect(nativeInput.props.focused).toBe(false);

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 열기",
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    nativeInput = tree!.root.find((node) => (node.type as unknown) === "TerminalInputView");
    expect(nativeInput.props.focused).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("keeps the manual open request alive when a late keyboard hide event arrives", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    await act(async () => {
      emitKeyboardEvent("keyboardDidShow", {
        endCoordinates: { height: 280 },
      });
    });

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 닫기",
    });

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 열기",
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      emitKeyboardEvent("keyboardDidHide");
      jest.runOnlyPendingTimers();
    });

    expect(mockNativeTerminalInputHandle!.focus).toHaveBeenCalled();
    const nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.focused).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("adds keyboard inset to the session body so the toolbar can ride above the keyboard", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const screenBody = tree!.root.findByProps({
      testID: "session-screen-body",
    });

    let screenBodyStyle = StyleSheet.flatten(screenBody.props.style);
    expect(screenBodyStyle.paddingBottom).toBe(56);

    await act(async () => {
      emitKeyboardEvent("keyboardWillShow", {
        endCoordinates: { height: 280 },
      });
      emitKeyboardEvent("keyboardDidShow", {
        endCoordinates: { height: 280 },
      });
    });

    const screenBodyNode = tree!.root.findByProps({ testID: "session-screen-body" });
    await act(async () => {
      tree!.root.findByProps({ testID: "session-toolbar-shell" }).props.onLayout({
        nativeEvent: {
          layout: {
            height: 72,
          },
        },
      });
    });
    expect(screenBodyNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 352 })]),
    );
    screenBodyStyle = StyleSheet.flatten(screenBodyNode.props.style);
    expect(screenBodyStyle.paddingBottom).toBe(352);

    await act(async () => {
      emitKeyboardEvent("keyboardWillHide");
      emitKeyboardEvent("keyboardDidHide");
    });

    screenBodyStyle = StyleSheet.flatten(
      tree!.root.findByProps({ testID: "session-screen-body" }).props.style,
    );
    expect(screenBodyStyle.paddingBottom).toBe(72);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("disconnects the tab when tapping the tab close button", async () => {
    const disconnectSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        disconnectSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const closeButton = tree!.root.findByProps({
      accessibilityLabel: "Synology 세션 닫기",
    });

    await act(async () => {
      await closeButton.props.onPress({ stopPropagation: jest.fn() });
    });

    expect(disconnectSession).toHaveBeenCalledWith("session-1");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("maps the keyboard dock shortcuts to terminal control sequences", async () => {
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const expectedSequences = new Map<string, string>([
      ["ESC", "\u001b"],
      ["TAB", "\t"],
      ["Ctrl+C", "\u0003"],
      ["Left", "\u001b[D"],
      ["Right", "\u001b[C"],
      ["Up", "\u001b[A"],
      ["Down", "\u001b[B"],
      ["Enter", "\r"],
      ["Backspace", "\u007f"],
      ["Delete", "\u001b[3~"],
      ["Home", "\u001b[H"],
      ["End", "\u001b[F"],
      ["PageUp", "\u001b[5~"],
      ["PageDown", "\u001b[6~"],
      [":", ":"],
      ["!", "!"],
      ["/", "/"],
      ["?", "?"],
      ["Ctrl+D", "\u0004"],
      ["Ctrl+L", "\u000c"],
      ["Ctrl+Z", "\u001a"],
    ]);

    for (const item of TERMINAL_PRIMARY_SHORTCUTS) {
      const button = tree!.root.findByProps({
        accessibilityLabel: `${item.label} 제어키`,
      });
      await act(async () => {
        button.props.onPress();
        jest.runOnlyPendingTimers();
      });
      expect(writeToSession).toHaveBeenLastCalledWith(
        "session-1",
        expectedSequences.get(item.label),
      );
    }

    const expandButton = tree!.root.findByProps({
      accessibilityLabel: "추가 제어키 표시",
    });

    await act(async () => {
      expandButton.props.onPress();
    });

    for (const item of TERMINAL_SECONDARY_SHORTCUTS) {
      const button = tree!.root.findByProps({
        accessibilityLabel: `${item.label} 제어키`,
      });
      await act(async () => {
        button.props.onPress();
        jest.runOnlyPendingTimers();
      });
      expect(writeToSession).toHaveBeenLastCalledWith(
        "session-1",
        expectedSequences.get(item.label),
      );
    }

    await act(async () => {
      tree!.unmount();
    });
  });

  it("replays the last snapshot into the terminal when a connected tab becomes ready", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    expect(mockTerminalHandle!.write).toHaveBeenCalled();
    expect(
      mockTerminalHandle!.write.mock.calls.some(
        ([bytes]) => Buffer.from(bytes).toString("utf8") === "prompt",
      ),
    ).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("routes iOS native input view events through composed terminal diffs", async () => {
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );

    await act(async () => {
      nativeInput.props.onTerminalInput({
        nativeEvent: {
          kind: "text-delta",
          deleteCount: 0,
          insertText: "가",
        },
      });
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "가");

    await act(async () => {
      nativeInput.props.onTerminalInput({
        nativeEvent: {
          kind: "text-delta",
          deleteCount: 1,
          insertText: "간",
        },
      });
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "\u007f간");

    await act(async () => {
      nativeInput.props.onTerminalInput({
        nativeEvent: {
          kind: "special-key",
          key: "enter",
        },
      });
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "\r");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("keeps Android terminal taps in hardware-focus mode without opening the soft keyboard", async () => {
    setPlatformOs("android");
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    const nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.focused).toBe(true);
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);

    const initialFocusCalls = mockNativeTerminalInputHandle!.focus.mock.calls.length;
    const terminalCard = tree!.root.findByProps({ testID: "session-terminal-card" });

    await act(async () => {
      terminalCard.props.onTouchEnd();
      jest.runOnlyPendingTimers();
    });

    const updatedNativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(updatedNativeInput.props.softKeyboardEnabled).toBe(false);
    expect(mockNativeTerminalInputHandle!.focus.mock.calls.length).toBeGreaterThan(
      initialFocusCalls,
    );
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("uses the native terminal input overlay when toggling the keyboard on Android", async () => {
    setPlatformOs("android");
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    await act(async () => {
      tree!.root.findByProps({ testID: "session-toolbar-shell" }).props.onLayout({
        nativeEvent: {
          layout: {
            height: 72,
          },
        },
      });
    });

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 열기",
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    let nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.softKeyboardEnabled).toBe(true);
    expect(mockNativeTerminalInputHandle!.focus.mock.calls.length).toBeGreaterThan(
      0,
    );
    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();

    await act(async () => {
      emitKeyboardEvent("keyboardDidShow", {
        endCoordinates: { height: 280 },
      });
    });

    const screenBody = tree!.root.findByProps({
      testID: "session-screen-body",
    });
    const toolbarShell = tree!.root.findByProps({
      testID: "session-toolbar-shell",
    });

    expect(StyleSheet.flatten(screenBody.props.style).paddingBottom).toBe(376);
    expect(StyleSheet.flatten(toolbarShell.props.style).bottom).toBe(304);

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: "키보드 닫기",
    });

    const focusCallCountBeforeClose = mockNativeTerminalInputHandle!.focus.mock.calls.length;

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    nativeInput = tree!.root.find(
      (node) => (node.type as unknown) === "TerminalInputView",
    );
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);
    expect(mockNativeTerminalInputHandle!.focus.mock.calls.length).toBeGreaterThan(
      focusCallCountBeforeClose,
    );
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();
    expect(mockTerminalHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });
});
