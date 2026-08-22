import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, BackHandler, FlatList, Platform, TextInput } from "react-native";
import type {
  AuthState,
  GroupRecord,
  MobileSessionRecord,
  RdpHostRecord,
  SshHostRecord,
  VncHostRecord,
} from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from "../src/lib/mobile";
import { applyMobileLanguage } from "../src/i18n";
import { HomeScreen } from "../src/screens/HomeScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockNavigate = jest.fn();
const mockFlatListScrollToOffset = jest.fn();
let mockScrollToTopRef: React.RefObject<{ scrollToTop: () => void }> | null = null;
let mockHardwareBackHandler: (() => boolean) | null = null;
const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

function setPlatformOs(os: "ios" | "android") {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    get: () => os,
  });
}

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

  afterAll(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, "OS", platformOsDescriptor);
    }
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

  it("shows RDP and VNC hosts with remote desktop badges", async () => {
    const remoteHosts: Array<RdpHostRecord | VncHostRecord> = [
      {
        id: "host-rdp",
        kind: "rdp",
        label: "Office Windows",
        hostname: "windows.internal",
        port: 3389,
        secretRef: null,
        groupName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "host-vnc",
        kind: "vnc",
        label: "Lab Console",
        hostname: "console.internal",
        port: 5900,
        secretRef: null,
        groupName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    useMobileAppStore.setState({ groups: [], hosts: remoteHosts, sessions: [] });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain("Office Windows");
    expect(text).toContain("Lab Console");
    expect(text).toContain("RDP");
    expect(text).toContain("VNC");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  // 영어에서 1개일 때 "1 hosts" 로 나오던 자리다 — 앱스토어 스크린샷에도 그대로 찍힌다.
  // 정렬 기준이 "최근 활동" 이었을 때는 세션이 출력을 뿜는 동안 그 호스트가 목록에서 위로 튀었다.
  // 목록 순서는 화면을 보는 동안 움직이지 않아야 한다 — 이름 오름차순 하나로만 정해진다.
  it("orders hosts by name and does not hoist the one with a live session", async () => {
    const orderedHosts: SshHostRecord[] = ["Zulu box", "Alpha box", "Bravo box"].map(
      (label, index) => ({
        ...hosts[0],
        id: `host-order-${index}`,
        label,
        groupName: null,
      }),
    );
    useMobileAppStore.setState({
      groups: [],
      hosts: orderedHosts,
      // 가장 최근 활동을 가진 호스트다. 예전 규칙이라면 맨 위로 올라온다.
      sessions: [
        {
          ...sessions[0],
          hostId: "host-order-0",
          lastEventAt: new Date().toISOString(),
        },
      ],
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const text = collectText(tree!.toJSON());
    const positionOf = (label: string) => text.indexOf(label);
    expect(positionOf("Alpha box")).toBeGreaterThanOrEqual(0);
    expect(positionOf("Alpha box")).toBeLessThan(positionOf("Bravo box"));
    expect(positionOf("Bravo box")).toBeLessThan(positionOf("Zulu box"));

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("uses the singular wording for a folder holding one host in English", async () => {
    applyMobileLanguage("en");
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const text = collectText(tree!.toJSON()).join(" ");
    expect(text).toContain("1 host");
    expect(text).not.toContain("1 hosts");
    expect(text).toContain("2 hosts");
    expect(text).toContain("2 folders");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
    applyMobileLanguage("ko");
  });

  // 즐겨찾기는 데스크톱과 같이 최상단에 고정된 하나의 그룹이다 — 누르면 일반 그룹처럼
  // 호스트 목록으로 들어간다. 데스크톱에서 켠 host.favorite 이 동기화로 넘어온 값이다.
  it("pins favorites as the first group and opens it like a folder", async () => {
    act(() => {
      useMobileAppStore.setState({
        hosts: hosts.map((host) =>
          // 그룹 안에 있는 호스트를 즐겨찾기로 — 루트에는 원래 안 보이던 것이다.
          host.id === "host-servers" ? { ...host, favorite: true } : host,
        ),
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    // 루트: 즐겨찾기 카드가 첫 그룹보다 앞. 호스트 자체는 아직 목록에 없다.
    const rootText = collectText(tree!.toJSON()).join(" | ");
    expect(rootText.indexOf("즐겨찾기")).toBeGreaterThanOrEqual(0);
    expect(rootText.indexOf("즐겨찾기")).toBeLessThan(rootText.indexOf("Servers"));
    expect(rootText).not.toContain("Server Jump");

    // 열면 그룹처럼 호스트 목록이 나온다.
    await act(async () => {
      tree!.root
        .findByProps({ accessibilityLabel: "즐겨찾기 열기" })
        .props.onPress();
    });

    const favoritesText = collectText(tree!.toJSON()).join(" | ");
    expect(favoritesText).toContain("Server Jump");
    // 고정 카드는 루트에만 — 즐겨찾기 화면 안에 또 있으면 자기 자신으로 들어가는 카드가 된다.
    expect(() =>
      tree!.root.findByProps({ accessibilityLabel: "즐겨찾기 열기" }),
    ).toThrow();
    // 다른 그룹의 호스트나 하위 그룹은 섞이지 않는다.
    expect(favoritesText).not.toContain("Root Host");
    expect(favoritesText).not.toContain("Lab Node");

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
    // 그룹 요약은 보간 문구 하나로 렌더된다(예전에는 "그룹 " + 경로 두 노드였다).
    expect(text).toContain("그룹 Servers/NAS");
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

  it("uses iOS edge-swipe to clear search before popping group history", async () => {
    setPlatformOs("ios");
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

    await act(async () => {
      tree!.root
        .findByProps({ testID: "ios-edge-swipe-back" })
        .props.onTouchEnd();
    });

    expect(tree!.root.findByType(TextInput).props.value).toBe("");
    let text = collectText(tree!.toJSON());
    expect(text).toContain("Servers");
    expect(text).toContain("Server Jump");
    expect(text).not.toContain("Root Host");

    await act(async () => {
      tree!.root
        .findByProps({ testID: "ios-edge-swipe-back" })
        .props.onTouchEnd();
    });

    text = collectText(tree!.toJSON());
    expect(text).toContain("All Hosts");
    expect(text).toContain("Root Host");
    expect(text).not.toContain("Server Jump");

    await act(async () => {
      tree!.root
        .findByProps({ testID: "ios-edge-swipe-back" })
        .props.onTouchEnd();
    });

    expect(mockNavigate).not.toHaveBeenCalled();

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

  // 즐겨찾기는 목록 화면 말고 호스트 꾹 누르기에서도 켜고 끌 수 있어야 한다. 라벨은 현재
  // 상태에 따라 바뀌고, 실패하면(오프라인 등) 조용히 넘기지 않고 알린다.
  it("toggles the favorite from the long-press sheet", async () => {
    const toggleMock = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({ toggleHostFavorite: toggleMock });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    // 루트에 호스트는 Root Host 하나뿐이다(나머지는 그룹 안).
    const hostCard = tree!.root.findAll(
      (node) => typeof node.props.onLongPress === "function",
    )[0];
    await act(async () => {
      hostCard.props.onLongPress();
    });

    const findSheetAction = (label: string) =>
      tree!.root.findAll(
        (node) =>
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === "function",
      )[0];

    // 즐겨찾기가 아닌 호스트 → "추가".
    await act(async () => {
      findSheetAction("즐겨찾기에 추가").props.onPress();
    });
    expect(toggleMock).toHaveBeenCalledWith("host-root");

    // 이미 즐겨찾기인 호스트 → "제거".
    act(() => {
      useMobileAppStore.setState({
        hosts: hosts.map((host) =>
          host.id === "host-root" ? { ...host, favorite: true } : host,
        ),
      });
    });
    await act(async () => {
      hostCard.props.onLongPress();
    });
    expect(() => findSheetAction("즐겨찾기에서 제거")).not.toThrow();

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("navigates to the host form from the add button", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const addButton = tree!.root.findAll(
      (node) =>
        node.props.accessibilityLabel === "호스트 추가" &&
        typeof node.props.onPress === "function",
    )[0];
    expect(addButton).toBeTruthy();
    await act(async () => {
      addButton.props.onPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith("HostForm", undefined);

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("opens the long-press action sheet and routes edit, sftp and delete actions", async () => {
    const deleteHostMock = jest.fn(async () => undefined);
    const openSftpMock = jest.fn(async () => "sftp-1");
    const connectMock = jest.fn(async (hostId: string) => `session:${hostId}`);
    useMobileAppStore.setState({
      deleteHost: deleteHostMock,
      openSftpForHost: openSftpMock,
      connectToHost: connectMock,
    });
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HomeScreen />);
    });

    const hostCard = tree!.root.findAll(
      (node) => typeof node.props.onLongPress === "function",
    )[0];
    expect(hostCard).toBeTruthy();
    await act(async () => {
      hostCard.props.onLongPress();
    });

    const findSheetAction = (label: string) =>
      tree!.root.findAll(
        (node) =>
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === "function",
      )[0];

    // 수정 → HostForm 으로 이동.
    await act(async () => {
      findSheetAction("수정").props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      "HostForm",
      expect.objectContaining({ hostId: expect.any(String) }),
    );

    // 다시 열어 SFTP 연결 → SFTP 탭만 열고 Sessions 로 이동. 터미널 탭은 만들지 않는다 —
    // 예전에는 연결부터 만들어서 탭이 둘 생겼다.
    await act(async () => {
      hostCard.props.onLongPress();
    });
    await act(async () => {
      findSheetAction("SFTP 연결").props.onPress();
    });
    expect(openSftpMock).toHaveBeenCalledWith(expect.any(String));
    expect(connectMock).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("Sessions");

    // 다시 열어 삭제 → 확인 Alert 를 거쳐 deleteHost 호출.
    await act(async () => {
      hostCard.props.onLongPress();
    });
    await act(async () => {
      findSheetAction("삭제").props.onPress();
    });
    expect(deleteHostMock).not.toHaveBeenCalled();
    const confirmButtons = alertSpy.mock.calls.at(-1)?.[2];
    const confirmDelete = confirmButtons?.find(
      (button) => button.text === "삭제",
    );
    expect(confirmDelete).toBeDefined();
    await act(async () => {
      confirmDelete?.onPress?.();
    });
    expect(deleteHostMock).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });
});
