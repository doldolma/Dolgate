import React from "react";
import renderer, { act } from "react-test-renderer";
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
jest.mock("../src/components/TerminalInputView", () => ({
  TerminalInputView: "TerminalInputView",
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
    capturedXtermProps = null;
    useMobileAppStore.setState({
      hydrated: true,
      bootstrapping: false,
      auth: createAuthenticatedState(),
      settings: createDefaultMobileSettings(),
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

  it("renders the live session tabs and hides the old detail header controls", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Synology");
    expect(text).toContain("Docker-ubuntu");
    expect(text).not.toContain("Connected");
    expect(text).not.toContain("세션 뒤로가기");
    expect(text).not.toContain("세션 메뉴 열기");
    expect(capturedXtermProps).not.toBeNull();
    expect(capturedXtermProps?.autoFit).toBe(false);
    expect(capturedXtermProps?.webViewOptions).toMatchObject({
      hideKeyboardAccessoryView: true,
    });

    await act(async () => {
      tree!.unmount();
    });
  });

  it("disconnects the tab when tapping the tab close button", async () => {
    const disconnectSession = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      disconnectSession,
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

  it("routes iOS native input view events through composed terminal diffs", async () => {
    const writeToSession = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      writeToSession,
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
});
