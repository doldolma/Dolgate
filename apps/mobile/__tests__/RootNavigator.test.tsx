import React from "react";
import renderer, { act } from "react-test-renderer";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { AuthState } from "@dolssh/shared-core";
import { createDefaultMobileSettings, createDefaultSyncStatus, createUnauthenticatedState } from "../src/lib/mobile";
import {
  MAIN_TAB_BACK_BEHAVIOR,
  MAIN_TAB_INITIAL_ROUTE,
  RootNavigator,
} from "../src/navigation/RootNavigator";
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

function resetStore(
  authState: AuthState,
  vault?: ReturnType<typeof useMobileAppStore.getState>["vault"],
): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: authState,
    vault: vault ?? { status: "none" },
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
    expect(text).not.toContain("Sessions");
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
    const safeAreaMetrics = {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Home");
    expect(text).toContain("Sessions");
    expect(text).toContain("Settings");
    expect(text).toContain("아직 호스트가 없습니다.");
    expect(text).not.toContain("Sync 상태");
    expect(text).not.toContain("지금 동기화");
    expect(
      tree!.root.findAll((node) => String(node.type) === "Ionicons").length,
    ).toBeGreaterThanOrEqual(3);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("keeps the main tabs on Home with full visit-history back behavior", () => {
    expect(MAIN_TAB_INITIAL_ROUTE).toBe("Home");
    expect(MAIN_TAB_BACK_BEHAVIOR).toBe("fullHistory");
  });

  it("gates authenticated users into vault setup and unlock screens", async () => {
    const authenticatedState: AuthState = {
      status: "authenticated",
      session: {
        user: {
          id: "user-1",
          email: "vault@example.com",
        },
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresInSeconds: 900,
        },
        vaultBootstrap: {
          version: 0,
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

    // 신규 유저: 동기화 암호 설정 화면이 메인 탭 대신 뜬다.
    await act(async () => {
      resetStore(authenticatedState, { status: "setup-required", epoch: 0 });
    });
    const safeAreaMetrics = {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });
    let text = collectText(tree!.toJSON());
    expect(text).toContain("동기화 암호 설정");
    expect(text).not.toContain("Sessions");
    await act(async () => {
      tree!.unmount();
    });

    // 새 기기: 잠금해제 화면이 뜬다.
    await act(async () => {
      resetStore(authenticatedState, {
        status: "locked",
        wrappedDekBase64: "wrapped",
        kdf: {
          algorithm: "argon2id",
          saltBase64: "c2FsdA==",
          memoryKib: 65536,
          timeCost: 3,
          parallelism: 1,
        },
        epoch: 1,
        wrapRevision: 0,
      });
    });
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });
    text = collectText(tree!.toJSON());
    expect(text).toContain("동기화 잠금 해제");
    expect(text).not.toContain("Sessions");
    await act(async () => {
      tree!.unmount();
    });

    // descriptor를 안전하게 해석하지 못하면 메인 탭이나 암호 입력 대신 오류 게이트다.
    await act(async () => {
      resetStore(authenticatedState, {
        status: "error",
        errorMessage: "지원하지 않는 볼트 형식입니다.",
      });
    });
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });
    text = collectText(tree!.toJSON());
    expect(text).toContain("동기화 볼트 오류");
    expect(text).toContain("지원하지 않는 볼트 형식입니다.");
    expect(text).not.toContain("Sessions");
    await act(async () => {
      tree!.unmount();
    });
  });

  it("prompts legacy users to migrate and honors the defer button", async () => {
    const authenticatedState: AuthState = {
      status: "authenticated",
      session: {
        user: { id: "user-1", email: "legacy@example.com" },
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresInSeconds: 900,
        },
        vaultBootstrap: { version: 1, keyBase64: "a2V5" },
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
      resetStore(authenticatedState, {
        status: "legacy",
        epoch: 0,
        migrationRequired: false,
      });
      useMobileAppStore.setState({
        syncStatus: {
          ...createDefaultSyncStatus(),
          vaultE2eeServerSupport: "supported",
        },
        vaultMigrationDeferred: false,
      });
    });

    const safeAreaMetrics = {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });

    let text = collectText(tree!.toJSON());
    expect(text).toContain("종단간 암호화 켜기");
    expect(text).not.toContain("Sessions");

    // "나중에" → 이번 실행 동안 프롬프트가 사라지고 메인 탭이 뜬다.
    const deferButton = tree!.root.findAll(
      (node) =>
        node.props.accessibilityLabel === "나중에" &&
        typeof node.props.onPress === "function",
    )[0];
    await act(async () => {
      deferButton.props.onPress();
    });

    text = collectText(tree!.toJSON());
    expect(text).not.toContain("종단간 암호화 켜기");
    expect(text).toContain("Sessions");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("keeps mandatory legacy migration gated without a defer action", async () => {
    const authenticatedState: AuthState = {
      status: "authenticated",
      session: {
        user: { id: "user-1", email: "legacy@example.com" },
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresInSeconds: 900,
        },
        vaultBootstrap: {
          version: 1,
          keyBase64: "a2V5",
          epoch: 3,
          e2eeRequired: true,
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
      resetStore(authenticatedState, {
        status: "legacy",
        epoch: 3,
        migrationRequired: true,
      });
      useMobileAppStore.setState({
        syncStatus: {
          ...createDefaultSyncStatus(),
          vaultE2eeServerSupport: "unknown",
        },
        vaultMigrationDeferred: true,
      });
    });

    const safeAreaMetrics = {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, left: 0, right: 0, bottom: 0 },
    };
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <NavigationContainer>
            <RootNavigator authState={authenticatedState} />
          </NavigationContainer>
        </SafeAreaProvider>,
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("종단간 암호화 켜기");
    expect(text).not.toContain("나중에");
    expect(text).not.toContain("Sessions");

    await act(async () => {
      tree!.unmount();
    });
  });
});
