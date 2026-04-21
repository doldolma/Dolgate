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
import { ConnectionsScreen } from "../src/screens/ConnectionsScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockNavigate = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));
jest.mock("react-native-vector-icons/Ionicons", () => "Ionicons");
jest.mock("@fressh/react-native-uniffi-russh", () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
  },
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock("../src/lib/screen-layout", () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));

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

describe("ConnectionsScreen", () => {
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
  ];

  const sessions: MobileSessionRecord[] = [
    {
      id: "session-live",
      sessionId: "session-live",
      hostId: "host-1",
      title: "Synology",
      status: "connected",
      hasReceivedOutput: true,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: null,
      errorMessage: null,
    },
    {
      id: "session-closed",
      sessionId: "session-closed",
      hostId: "host-1",
      title: "Synology old",
      status: "closed",
      hasReceivedOutput: false,
      isRestorable: true,
      lastViewportSnapshot: "",
      lastEventAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: new Date().toISOString(),
      errorMessage: null,
    },
  ];

  beforeEach(() => {
    mockNavigate.mockReset();
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
      sessions,
      activeSessionTabId: "session-live",
      secretsByRef: {},
      pendingBrowserLoginState: null,
      pendingServerKeyPrompt: null,
      pendingCredentialPrompt: null,
      resumeSession: jest.fn(async (sessionId: string) => sessionId),
      removeSession: jest.fn(async () => undefined),
    });
  });

  it("shows delete only for removable sessions and calls removeSession", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ConnectionsScreen />);
    });

    expect(() =>
      tree!.root.findByProps({ accessibilityLabel: "Synology 세션 삭제" }),
    ).toThrow();

    const removeButton = tree!.root.findByProps({
      accessibilityLabel: "Synology old 세션 삭제",
    });

    await act(async () => {
      removeButton.props.onPress();
    });

    expect(useMobileAppStore.getState().removeSession).toHaveBeenCalledWith(
      "session-closed",
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("opens the session when tapping the header title area", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<ConnectionsScreen />);
    });

    const openButton = tree!.root.findByProps({
      accessibilityLabel: "Synology 세션 열기",
    });

    await act(async () => {
      await openButton.props.onPress();
    });

    expect(useMobileAppStore.getState().resumeSession).toHaveBeenCalledWith(
      "session-live",
    );
    expect(mockNavigate).toHaveBeenCalledWith("Sessions");

    await act(async () => {
      tree!.unmount();
    });
  });
});
