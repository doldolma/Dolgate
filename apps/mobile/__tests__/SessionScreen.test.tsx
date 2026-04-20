import React from "react";
import renderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import type {
  AuthState,
  MobileSessionRecord,
  SshHostRecord,
} from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import { SessionScreen } from "../src/screens/SessionScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

jest.mock("react-native-vector-icons/Ionicons", () => "Ionicons");
jest.mock("@fressh/react-native-uniffi-russh", () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
  },
}));

let capturedXtermProps: Record<string, unknown> | null = null;

jest.mock("@fressh/react-native-xtermjs-webview", () => {
  const mockReact = require("react") as typeof React;
  return {
    XtermJsWebView: (props: {
      onInitialized?: () => void;
      webViewOptions?: Record<string, unknown>;
    }) => {
      capturedXtermProps = props as Record<string, unknown>;
      mockReact.useEffect(() => {
        props.onInitialized?.();
      }, [props.onInitialized]);
      return null;
    },
  };
});
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("../src/lib/screen-layout", () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 0,
    paddingTop: 16,
    paddingBottom: 12,
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

  const host: SshHostRecord = {
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
  };

  beforeEach(() => {
    capturedXtermProps = null;
    useMobileAppStore.setState({
      hydrated: true,
      bootstrapping: false,
      auth: createAuthenticatedState(),
      settings: createDefaultMobileSettings(),
      syncStatus: createDefaultSyncStatus(),
      groups: [],
      hosts: [host],
      knownHosts: [],
      secretMetadata: [],
      sessions: [session],
      secretsByRef: {},
      pendingBrowserLoginState: null,
      pendingServerKeyPrompt: null,
      pendingCredentialPrompt: null,
      resumeSession: jest.fn(async () => "session-1"),
      disconnectSession: jest.fn(async () => undefined),
      writeToSession: jest.fn(async () => undefined),
      subscribeToSessionTerminal: jest.fn(() => () => undefined),
    });
  });

  it("renders a compact header and hides the old large action card by default", async () => {
    const navigation = {
      canGoBack: () => true,
      goBack: jest.fn(),
      replace: jest.fn(),
    };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SessionScreen
          navigation={navigation as never}
          route={{
            key: "Session-session-1",
            name: "Session",
            params: { sessionId: "session-1" },
          }}
        />,
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Synology");
    expect(text).toContain("Connected");
    expect(text).not.toContain("doyoung@doldolma.com:2788");
    expect(text).not.toContain("재연결");
    expect(text).not.toContain("연결 종료");
    expect(capturedXtermProps).not.toBeNull();
    expect(capturedXtermProps?.webViewOptions).toMatchObject({
      hideKeyboardAccessoryView: true,
    });
    expect(
      (capturedXtermProps?.webViewOptions as Record<string, unknown>)
        ?.injectedJavaScript,
    ).toBeUndefined();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("reveals session actions inside the menu", async () => {
    const resumeSession = jest.fn(async () => "session-1");
    const disconnectSession = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      resumeSession,
      disconnectSession,
    });

    const navigation = {
      canGoBack: () => true,
      goBack: jest.fn(),
      replace: jest.fn(),
    };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SessionScreen
          navigation={navigation as never}
          route={{
            key: "Session-session-1",
            name: "Session",
            params: { sessionId: "session-1" },
          }}
        />,
      );
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: "세션 메뉴 열기",
    });

    await act(async () => {
      menuButton.props.onPress();
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("doyoung@doldolma.com:2788");
    expect(text).toContain("재연결");
    expect(text).toContain("연결 종료");

    const reconnectButton = tree!.root.findByProps({
      accessibilityLabel: "세션 재연결",
    });

    await act(async () => {
      await reconnectButton.props.onPress();
    });

    expect(resumeSession).toHaveBeenCalledWith("session-1");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("routes iOS native text input through composed terminal diffs", async () => {
    const writeToSession = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      writeToSession,
    });

    const navigation = {
      canGoBack: () => true,
      goBack: jest.fn(),
      replace: jest.fn(),
    };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SessionScreen
          navigation={navigation as never}
          route={{
            key: "Session-session-1",
            name: "Session",
            params: { sessionId: "session-1" },
          }}
        />,
      );
    });

    const nativeInput = tree!.root.findByType(TextInput);

    await act(async () => {
      nativeInput.props.onChangeText("가");
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "가");

    await act(async () => {
      nativeInput.props.onChangeText("간");
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "\u007f간");

    await act(async () => {
      nativeInput.props.onChangeText("간다");
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "다");

    await act(async () => {
      nativeInput.props.onSubmitEditing();
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "\r");

    await act(async () => {
      nativeInput.props.onKeyPress({
        nativeEvent: { key: "Backspace" },
      });
    });

    expect(writeToSession).toHaveBeenLastCalledWith("session-1", "\u007f");

    await act(async () => {
      tree!.unmount();
    });
  });
});
