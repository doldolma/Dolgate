import React from "react";
import renderer, { act } from "react-test-renderer";
import { BackHandler, FlatList, TextInput } from "react-native";
import type {
  AuthState,
  GroupRecord,
  MobileSessionRecord,
  SshHostRecord,
} from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import { HomeScreen } from "../src/screens/HomeScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockNavigate = jest.fn();
const mockFlatListScrollToOffset = jest.fn();
let mockScrollToTopRef: React.RefObject<{ scrollToTop: () => void }> | null = null;
let mockHardwareBackHandler: (() => boolean) | null = null;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = require("react") as typeof import("react");
    React.useEffect(() => callback(), [callback]);
  },
  useScrollToTop: (
    ref: React.RefObject<{ scrollToTop: () => void }>,
  ) => {
    mockScrollToTopRef = ref;
  },
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

describe("HomeScreen group browsing", () => {
  const groups: GroupRecord[] = [
    {
      id: "group-servers",
      path: "Servers",
      name: "Servers",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "group-nas",
      path: "Servers/NAS",
      name: "NAS",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "group-lab",
      path: "Lab",
      name: "Lab",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const hosts: SshHostRecord[] = [
    {
      id: "host-root",
      kind: "ssh",
      label: "Root Host",
      hostname: "root.example.com",
      port: 22,
      username: "root",
      authType: "password",
      secretRef: null,
      groupName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "host-servers",
      kind: "ssh",
      label: "Server Jump",
      hostname: "jump.example.com",
      port: 22,
      username: "ops",
      authType: "password",
      secretRef: null,
      groupName: "Servers",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "host-nas",
      kind: "ssh",
      label: "NAS Shell",
      hostname: "nas.example.com",
      port: 22,
      username: "admin",
      authType: "password",
      secretRef: null,
      groupName: "Servers/NAS",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "host-lab",
      kind: "ssh",
      label: "Lab Node",
      hostname: "lab.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      secretRef: null,
      groupName: "Lab",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const sessions: MobileSessionRecord[] = [
    {
      id: "session-lab",
      sessionId: "session-lab",
      hostId: "host-lab",
      title: "Lab Node",
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
    jest.useFakeTimers();
    mockNavigate.mockReset();
    mockFlatListScrollToOffset.mockReset();
    mockScrollToTopRef = null;
    mockHardwareBackHandler = null;
    jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_eventName, handler) => {
        mockHardwareBackHandler = () => handler() ?? false;
        return {
          remove: jest.fn(() => {
            mockHardwareBackHandler = null;
          }),
        };
      });
    if (!FlatList.prototype.scrollToOffset) {
      Object.defineProperty(FlatList.prototype, "scrollToOffset", {
        configurable: true,
        value: () => undefined,
      });
    }
    jest
      .spyOn(FlatList.prototype, "scrollToOffset")
      .mockImplementation(mockFlatListScrollToOffset);
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
      groups,
      hosts,
      knownHosts: [],
      secretMetadata: [],
      sessions,
      activeSessionTabId: null,
      secretsByRef: {},
      pendingBrowserLoginState: null,
      pendingServerKeyPrompt: null,
      pendingCredentialPrompt: null,
      connectToHost: jest.fn(async (hostId: string) => `session:${hostId}`),
    });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.restoreAllMocks();
    mockScrollToTopRef = null;
    mockHardwareBackHandler = null;
    jest.useRealTimers();
  });

  it("shows root folders first and only ungrouped hosts at the root", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("All Hosts");
    expect(text).toContain("Servers");
    expect(text).toContain("Lab");
    expect(text).toContain("Root Host");
    expect(text.join(" ")).toContain("root@root.example.com:22");
    expect(text.join(" ")).toContain("세션 없음");
    expect(text).not.toContain("Server Jump");
    expect(() =>
      tree!.root.findByProps({ accessibilityLabel: "NAS 그룹 열기" }),
    ).toThrow();

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("does not show a banner while startup sync is only running in the background", async () => {
    act(() => {
      useMobileAppStore.setState({
        syncStatus: {
          ...createDefaultSyncStatus(),
          status: "syncing",
        },
      });
    });

    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).not.toContain("서버 내용을 확인하고 있습니다.");
    expect(text).not.toContain(
      "저장된 목록은 바로 볼 수 있고, 최신 변경사항은 곧 반영됩니다.",
    );

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("enters a group and returns to the same group after clearing search", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const serversButton = tree!.root.findByProps({
      accessibilityLabel: "Servers 그룹 열기",
    });

    await act(async () => {
      serversButton.props.onPress();
    });

    let text = collectText(tree!.toJSON());
    expect(text).toContain("Servers");
    expect(text).toContain("Server Jump");
    expect(text.join(" ")).toContain("ops@jump.example.com:22");
    expect(text).toContain("NAS");
    expect(text).not.toContain("Root Host");

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });

    text = collectText(tree!.toJSON());
    expect(text).toContain("NAS Shell");
    expect(text).toContain("그룹 ");
    expect(text).toContain("Servers/NAS");
    expect(() =>
      tree!.root.findByProps({ accessibilityLabel: "NAS 그룹 열기" }),
    ).toThrow();

    await act(async () => {
      searchInput.props.onChangeText("");
    });

    text = collectText(tree!.toJSON());
    expect(text).toContain("Servers");
    expect(text).toContain("Server Jump");
    expect(() =>
      tree!.root.findByProps({ accessibilityLabel: "NAS 그룹 열기" }),
    ).not.toThrow();

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("uses visit history for the in-screen back button", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "Servers 그룹 열기",
      }).props.onPress();
    });

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "NAS 그룹 열기",
      }).props.onPress();
    });

    let text = collectText(tree!.toJSON());
    expect(text).toContain("NAS");
    expect(text).toContain("NAS Shell");

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "이전 그룹으로 이동",
      }).props.onPress();
    });

    text = collectText(tree!.toJSON());
    expect(text).toContain("Servers");
    expect(text).toContain("Server Jump");
    expect(text).toContain("NAS");

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "이전 그룹으로 이동",
      }).props.onPress();
    });

    text = collectText(tree!.toJSON());
    expect(text).toContain("All Hosts");
    expect(text).toContain("Root Host");
    expect(text).not.toContain("Server Jump");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("clears search first and then pops group history on Android back", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "Servers 그룹 열기",
      }).props.onPress();
    });

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });

    expect(mockHardwareBackHandler).not.toBeNull();

    let handled = false;
    await act(async () => {
      handled = mockHardwareBackHandler?.() ?? false;
    });

    expect(handled).toBe(true);
    let text = collectText(tree!.toJSON());
    expect(text).toContain("Servers");
    expect(text).toContain("Server Jump");
    expect(searchInput.props.value).toBe("");

    await act(async () => {
      handled = mockHardwareBackHandler?.() ?? false;
    });

    expect(handled).toBe(true);
    text = collectText(tree!.toJSON());
    expect(text).toContain("All Hosts");
    expect(text).toContain("Root Host");

    expect(mockHardwareBackHandler?.()).toBe(false);

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("resets to the root list and scrolls to the top when Home is reselected", async () => {
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    await act(async () => {
      tree!.root.findByProps({
        accessibilityLabel: "Servers 그룹 열기",
      }).props.onPress();
    });

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });

    expect(mockScrollToTopRef?.current).toBeTruthy();

    await act(async () => {
      mockScrollToTopRef?.current?.scrollToTop();
      jest.runOnlyPendingTimers();
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("All Hosts");
    expect(text).toContain("Root Host");
    expect(tree!.root.findByType(TextInput).props.value).toBe("");
    expect(mockFlatListScrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: true,
    });

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });
});
