import React from "react";
import renderer, { act } from "react-test-renderer";
import { NavigationContainer } from "@react-navigation/native";
import type { AuthState } from "@dolssh/shared-core";
import { createDefaultMobileSettings, createDefaultSyncStatus, createUnauthenticatedState } from "../src/lib/mobile";
import { RootNavigator } from "../src/navigation/RootNavigator";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

jest.mock("react-native-vector-icons/Ionicons", () => "Ionicons");
jest.mock("../src/screens/SessionScreen", () => ({
  SessionScreen: () => null,
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

function collectText(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | null): string[] {
  if (!node) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectText(child));
  }

  const ownChildren = node.children ?? [];
  return ownChildren.flatMap((child) => {
    if (typeof child === "string") {
      return [child];
    }
    return collectText(child);
  });
}

function resetStore(authState: AuthState): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    auth: authState,
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    hosts: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingCredentialPrompt: null,
  });
}

describe("RootNavigator auth gating", () => {
  beforeEach(async () => {
    await act(async () => {
      resetStore(createUnauthenticatedState());
    });
  });

  afterEach(async () => {
    await act(async () => {
      resetStore(createUnauthenticatedState());
    });
  });

  it("renders the auth landing flow while unauthenticated", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <NavigationContainer>
          <RootNavigator authState={createUnauthenticatedState()} />
        </NavigationContainer>,
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Dolgate");
    expect(text).toContain("로그인");
    expect(text).not.toContain("현재 서버");
    expect(text).not.toContain(
      "로그인 후에만 동기화된 SSH 호스트와 세션을 사용할 수 있습니다.",
    );
    expect(text).not.toContain("Connections");
    expect(
      tree!.root.findAll((node) => String(node.type) === "Ionicons"),
    ).toHaveLength(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("renders the authenticated tabs and tab icons when a session exists", async () => {
    const authenticatedState: AuthState = {
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
    await act(async () => {
      resetStore(authenticatedState);
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <NavigationContainer>
          <RootNavigator authState={authenticatedState} />
        </NavigationContainer>,
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Home");
    expect(text).toContain("Connections");
    expect(text).toContain("Settings");
    expect(text).toContain("아직 SSH 호스트가 없습니다.");
    expect(text).not.toContain("Sync 상태");
    expect(text).not.toContain("지금 동기화");
    expect(
      tree!.root.findAll((node) => String(node.type) === "Ionicons").length,
    ).toBeGreaterThanOrEqual(3);

    await act(async () => {
      tree!.unmount();
    });
  });
});
