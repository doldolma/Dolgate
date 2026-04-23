import React from "react";
import renderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import type { AuthState } from "@dolssh/shared-core";
import { APP_VERSION } from "../src/lib/app-metadata";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import {
  AuthSettingsScreen,
  SettingsScreen,
} from "../src/screens/SettingsScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockGoBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    canGoBack: mockCanGoBack,
  }),
}));
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
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock("../src/lib/screen-layout", () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));

function collectText(node: renderer.ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      return collectText(child);
    })
    .join("");
}

function findPressableByText(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      collectText(node).includes(label),
  )[0];

  if (!match) {
    throw new Error(`pressable not found: ${label}`);
  }

  return match;
}

function resetStore(): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createUnauthenticatedState(),
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    activeSessionTabId: null,
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
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

describe("SettingsScreen server save navigation", () => {
  beforeEach(() => {
    mockGoBack.mockReset();
    mockCanGoBack.mockReset();
    mockCanGoBack.mockReturnValue(true);
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("goes back after saving from the auth settings screen", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AuthSettingsScreen />);
    });

    const input = tree!.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText("https://ssh.example.com");
    });

    const saveButton = findPressableByText(tree!.root, "저장");
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(useMobileAppStore.getState().settings.serverUrl).toBe(
      "https://ssh.example.com",
    );
    expect(mockCanGoBack).toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("does not navigate when saving from the full settings tab", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const input = tree!.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText("https://ssh.full-settings.com");
    });

    const saveButton = findPressableByText(tree!.root, "저장");
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(useMobileAppStore.getState().settings.serverUrl).toBe(
      "https://ssh.full-settings.com",
    );
    expect(mockGoBack).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("shows the app version and hides startup syncing-only copy", async () => {
    useMobileAppStore.setState({
      auth: createAuthenticatedState(),
      syncStatus: {
        ...createDefaultSyncStatus(),
        status: "syncing",
      },
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain(`Version ${APP_VERSION}`);
    expect(text).not.toContain("동기화 상태: syncing");
    expect(text).not.toContain(
      "저장된 캐시를 먼저 보여주고 최신 상태를 확인하는 중입니다.",
    );

    await act(async () => {
      tree!.unmount();
    });
  });
});
