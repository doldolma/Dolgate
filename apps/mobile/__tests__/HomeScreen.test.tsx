import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, BackHandler, FlatList, Platform, Text, TextInput } from "react-native";
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
import { ActionSheet } from "../src/components/ActionSheet";
import { GroupActionSheet } from "../src/components/GroupActionSheet";
import {
  SwipeableRow,
  type SwipeableRowAction,
} from "../src/components/SwipeableRow";
import { GroupNamePromptModal } from "../src/components/GroupNamePromptModal";
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

/**
 * 이 파일이 띄운 트리들. **테스트마다 걷어내야 한다.**
 *
 * 남겨 두면 다음 테스트의 `useMobileAppStore.setState` 가 아직 붙어 있는 옛 트리까지 전부
 * 다시 그리고, 그 렌더는 act() 밖이라 React 가 경고를 찍는다. 테스트는 통과하는데 로그만
 * 빨갛게 쌓여서 진짜 오류를 덮었다. 개별 테스트의 unmount 에 맡기면 하나 빠뜨리는 순간
 * 다시 그렇게 된다(실제로 21번 띄우고 19번만 걷어내고 있었다).
 */
const mountedTrees: renderer.ReactTestRenderer[] = [];

function renderHome(): renderer.ReactTestRenderer {
  const tree = renderer.create(<HomeScreen />);
  mountedTrees.push(tree);
  return tree;
}

// 걷어내는 것도 렌더라 act() 안에서 한다 — 밖에서 하면 그것이 또 경고가 된다.
afterEach(() => {
  act(() => {
    while (mountedTrees.length > 0) {
      mountedTrees.pop()?.unmount();
    }
  });
});

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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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
      tree = renderHome();
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

  // 동기화는 **사용자가 신경 쓸 일이 아니다.** 대기 건수도, 실패 이유도 홈에 띄우지
  // 않는다 — 알아서 올라가고, 안 되면 설정의 동기화 상태 한 줄이 말해 준다.
  it("never shows a sync queue banner", async () => {
    act(() => {
      useMobileAppStore.setState({
        syncOutbox: [{ kind: "hosts", id: "h1", op: "upsert" }],
        syncOutboxFailure: { count: 5, message: "볼트 잠금을 풀어야 합니다." },
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const text = tree!.root
      .findAllByType(Text)
      .map((node) => node.props.children)
      .filter((child) => typeof child === "string") as string[];
    expect(text.some((line) => line.includes("동기화 대기"))).toBe(false);
    expect(
      text.some((line) => line.includes("볼트 잠금을 풀어야 합니다.")),
    ).toBe(false);

    act(() => {
      useMobileAppStore.setState({ syncOutbox: [], syncOutboxFailure: null });
    });
  });

  // 그룹 꾹 누르기 → 이름 변경. **시트를 먼저 닫아야 한다** — React Native 는 Modal 두 개가
  // 겹치면 나중 것이 아래 깔려, 입력 모달을 띄워도 탭이 전부 시트로 가 "눌러도 아무 일이
  // 없는" 상태가 된다. iOS 는 닫히는 도중 띄우기도 무시하므로 onDismiss 를 기다린다.
  it("closes the group sheet before opening the rename prompt", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const groupCard = tree!.root.findAll(
      (node) =>
        typeof node.props.onLongPress === "function" &&
        node.props.accessibilityLabel === "Servers 그룹 열기",
    )[0];
    await act(async () => {
      groupCard.props.onLongPress();
    });

    const sheet = tree!.root.findAllByType(GroupActionSheet)[0]!;
    expect(sheet.props.group?.path).toBe("Servers");

    await act(async () => {
      sheet.props.onRename(sheet.props.group);
    });

    // 시트가 먼저 닫힌다.
    expect(tree!.root.findAllByType(GroupActionSheet)[0]!.props.group).toBeNull();
    // 아직 입력 모달은 뜨지 않는다 — 시트가 사라졌다는 신호를 기다린다(iOS).
    expect(
      tree!.root.findAllByType(GroupNamePromptModal)[0]!.props.visible,
    ).toBe(false);

    await act(async () => {
      tree!.root.findAllByType(GroupActionSheet)[0]!.props.onDismissed();
    });

    const prompt = tree!.root.findAllByType(GroupNamePromptModal)[0]!;
    expect(prompt.props.visible).toBe(true);
    expect(prompt.props.initialValue).toBe("Servers");
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
      tree = renderHome();
    });

    // 루트에 호스트는 Root Host 하나뿐이다(나머지는 그룹 안).
    // 그룹 카드도 길게 누를 수 있으므로(그룹 편집) 라벨로 호스트를 집는다.
    const hostCard = tree!.root.findAll(
      (node) =>
        typeof node.props.onLongPress === "function" &&
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.includes("Root Host"),
    )[0];
    await act(async () => {
      hostCard.props.onLongPress();
    });

    // **시트 안에서만 찾는다.** 호스트 카드에는 밀어서 나오는 수정·삭제도 있고, 그쪽은 같은
    // 핸들러를 부르므로 전체에서 찾으면 시트를 안 눌러도 단언이 통과한다(가짜 초록).
    const findSheetAction = (label: string) =>
      tree!.root
        .findAllByType(ActionSheet)
        .flatMap((sheet) =>
          sheet.findAll(
            (node) =>
              node.props.accessibilityLabel === label &&
              typeof node.props.onPress === "function",
          ),
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
      tree = renderHome();
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

    // 한 탭으로 폼까지 간다 — 종류(SSH·RDP·VNC)는 폼 맨 위에서 고르고 SSH 가 기본이다.
    expect(mockNavigate).toHaveBeenCalledWith("HostForm", undefined);

    // 그룹을 열어 둔 채 추가하면 그 그룹이 미리 채워진다 — 열어 둔 그룹에 넣으려는 것이
    // 뻔한데 폼에서 다시 고르게 하면 손이 한 번 더 간다(데스크톱은 이미 그렇게 한다).
    const serversButton = tree!.root.findByProps({
      accessibilityLabel: "Servers 그룹 열기",
    });
    await act(async () => {
      serversButton.props.onPress();
    });
    await act(async () => {
      tree!.root
        .findAll(
          (node) =>
            node.props.accessibilityLabel === "호스트 추가" &&
            typeof node.props.onPress === "function",
        )[0]
        .props.onPress();
    });
    expect(mockNavigate).toHaveBeenLastCalledWith("HostForm", {
      defaultGroupPath: "Servers",
    });

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("호스트 카드를 밀면 수정·삭제가 나오고 같은 경로로 이어진다", async () => {
    const deleteHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ deleteHost: deleteHostMock });
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    // 호스트 카드를 감싼 줄을 찾는다. 그룹 카드에는 스와이프를 붙이지 않았다.
    const rows = tree!.root.findAllByType(SwipeableRow);
    expect(rows.length).toBeGreaterThan(0);

    const rendered = rows[0].props.actions as SwipeableRowAction[];
    expect(rendered.map(action => action.label)).toEqual(["수정", "삭제"]);
    // 엄지가 먼저 닿는 자리가 수정이다. 빨강은 화면에 하나뿐이어야 눈에 먼저 들어온다.
    expect(rendered[1].background).toBe("#FF453A");

    await act(async () => {
      rendered[0].onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      "HostForm",
      expect.objectContaining({ hostId: expect.any(String) }),
    );

    // 삭제는 길게 누르기와 같은 경로다 — 확인창을 한 번 더 받는다.
    await act(async () => {
      rendered[1].onPress();
    });
    expect(alertSpy).toHaveBeenCalled();
    alertSpy.mockRestore();

    await act(async () => {
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
      tree = renderHome();
    });

    // 그룹 카드도 길게 누를 수 있으므로(그룹 편집) 라벨로 호스트를 집는다.
    const hostCard = tree!.root.findAll(
      (node) =>
        typeof node.props.onLongPress === "function" &&
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.includes("Root Host"),
    )[0];
    expect(hostCard).toBeTruthy();
    await act(async () => {
      hostCard.props.onLongPress();
    });

    // **시트 안에서만 찾는다.** 호스트 카드에는 밀어서 나오는 수정·삭제도 있고, 그쪽은 같은
    // 핸들러를 부르므로 전체에서 찾으면 시트를 안 눌러도 단언이 통과한다(가짜 초록).
    const findSheetAction = (label: string) =>
      tree!.root
        .findAllByType(ActionSheet)
        .flatMap((sheet) =>
          sheet.findAll(
            (node) =>
              node.props.accessibilityLabel === label &&
              typeof node.props.onPress === "function",
          ),
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
  // ── 검색 = 명령 팔레트 ────────────────────────────────────────────────────
  // 데스크톱 팔레트를 그대로 옮긴 것이라, 데스크톱에서 되는 네 가지가 여기서도 돼야 한다.

  it("keeps connect and the long-press menu on search results", async () => {
    const connectMock = jest.fn(async (hostId: string) => `session:${hostId}`);
    useMobileAppStore.setState({ connectToHost: connectMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });

    const card = tree!.root.findByProps({
      accessibilityLabel: "NAS Shell 접속",
    });

    // 탭 = 바로 접속.
    await act(async () => {
      card.props.onPress();
    });
    expect(connectMock).toHaveBeenCalledWith(expect.any(String));
    expect(mockNavigate).toHaveBeenCalledWith("Sessions");

    // 길게 = 수정·삭제까지 있는 시트. 검색 결과를 동작 줄로 바꿨더니 이 길이 통째로
    // 사라져서 검색해서 호스트를 고칠 수 없었다 — 그래서 카드를 그대로 둔다.
    await act(async () => {
      card.props.onLongPress();
    });
    expect(
      tree!.root.findAll(
        (node) =>
          node.props.accessibilityLabel === "수정" &&
          typeof node.props.onPress === "function",
      )[0],
    ).toBeTruthy();

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("offers an instant SSH connection when the query reads as an address", async () => {
    const quickConnectMock = jest.fn(async () => "session:quick");
    useMobileAppStore.setState({ quickConnectSsh: quickConnectMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const searchInput = tree!.root.findByType(TextInput);
    // 이름만 치면 검색이어야 한다 — 여기서 즉석 접속이 뜨면 검색할 때마다 이 줄을 지나친다.
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });
    expect(collectText(tree!.toJSON()).join(" ")).not.toContain(" 에 접속");

    await act(async () => {
      searchInput.props.onChangeText("ops@10.0.0.9:2222");
    });

    const quickRow = tree!.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.includes("ops@10.0.0.9:2222"),
    )[0];
    expect(quickRow).toBeTruthy();
    await act(async () => {
      quickRow.props.onPress();
    });

    expect(quickConnectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "ops",
        hostname: "10.0.0.9",
        port: 2222,
      }),
    );
    expect(mockNavigate).toHaveBeenCalledWith("Sessions");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("jumps to a settings section from the search field", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("보안");
    });

    const settingsRow = tree!.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.startsWith("설정 —"),
    )[0];
    expect(settingsRow).toBeTruthy();
    await act(async () => {
      settingsRow.props.onPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith("Settings", {
      section: "security",
    });

    // 호스트를 찾는 도중에 끼어들면 안 된다 — "nas" 의 첫 글자 "n" 은 예전에 account·
    // server·app 을 한꺼번에 걸어 설정 줄 셋을 목록 맨 위로 올렸다가 다음 글자에서 지웠다.
    await act(async () => {
      searchInput.props.onChangeText("n");
    });
    expect(collectText(tree!.toJSON()).join(" ")).not.toContain("설정 —");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it("does not add per-host action rows next to the cards", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderHome();
    });

    const searchInput = tree!.root.findByType(TextInput);
    await act(async () => {
      searchInput.props.onChangeText("nas");
    });

    // 카드가 이미 탭=접속, 길게=SFTP 를 한다. 같은 일을 하는 줄을 더 내면 목록만 길어지고
    // 카드가 밀려난다 — 팔레트에서 가져온 것은 카드가 못 하는 것뿐이다.
    const text = collectText(tree!.toJSON());
    expect(text.filter((part) => part.includes("NAS Shell"))).toHaveLength(1);
    expect(text.join(" ")).not.toContain("SFTP 열기");

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });
});
