import React from "react";
import renderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { HostRecord, VncHostRecord } from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import { HostFormScreen } from "../src/screens/HostFormScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

// RDP·VNC 호스트는 접속만 되고 주소 하나 못 고쳤다. 필드가 SSH 와 겹치지 않아 화면을 나눴다.

const mockGoBack = jest.fn();
let mockRouteParams:
  | { hostId?: string; kind?: "ssh" | "rdp" | "vnc" }
  | undefined;

jest.mock("@react-navigation/native", () => ({
  // SSH 폼이 나가기를 가로채므로(beforeRemove) 그 자리도 채워 준다 — 이 화면은 SSH 폼을
  // 거쳐 들어온다.
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
    addListener: () => () => undefined,
    dispatch: jest.fn(),
  }),
  useRoute: () => ({ params: mockRouteParams }),
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

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function render(): renderer.ReactTestRenderer {
  return renderer.create(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <HostFormScreen />
    </SafeAreaProvider>,
  );
}

function resetStore(hosts: HostRecord[] = []): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createUnauthenticatedState(),
    settings: createDefaultMobileSettings(),
    // RDP·VNC 는 서버가 계정 데이터 수준을 판정할 때만 만들 수 있다. 기본은 그런 서버로 둔다
    // — 막힌 경우는 아래에서 따로 본다.
    syncStatus: {
      ...createDefaultSyncStatus(),
      dataFloorServerSupport: "supported",
    },
    groups: [],
    hosts,
    tailnets: [],
    snippets: [],
    secretsByRef: {},
    secretMetadata: [],
    syncOutbox: [],
  });
}

function findInput(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root
    .findAllByType(TextInput)
    .find(node => node.props.accessibilityLabel === label);
  if (!match) {
    throw new Error(`input not found: ${label}`);
  }
  return match;
}

function findPressableByText(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    node =>
      typeof node.props.onPress === "function" &&
      (node.props.accessibilityLabel === label ||
        node.findAll(child => child.props?.children === label).length > 0),
  );
  if (match.length === 0) {
    throw new Error(`pressable not found: ${label}`);
  }
  return match[match.length - 1];
}

function vncHost(): VncHostRecord {
  return {
    id: "vnc-1",
    kind: "vnc",
    label: "Lab console",
    hostname: "console.example.com",
    port: 5900,
    secretRef: "secret-vnc",
    groupName: null,
    viewOnly: true,
    imageQuality: "fast",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as VncHostRecord;
}

describe("원격 데스크톱 호스트 폼", () => {
  beforeEach(() => {
    mockGoBack.mockReset();
    mockRouteParams = undefined;
    resetStore();
  });

  it("VNC 호스트의 주소와 화면 설정을 고친다", async () => {
    const host = vncHost();
    resetStore([host]);
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });

    await act(async () => {
      findInput(tree!.root, "호스트").props.onChangeText("moved.example.com");
    });
    await act(async () => {
      findPressableByText(tree!.root, "무손실").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "vnc-1",
        kind: "vnc",
        hostname: "moved.example.com",
        imageQuality: "lossless",
        viewOnly: true,
      }),
    );
  });

  it("비밀번호를 비워 두면 저장된 자격증명을 건드리지 않는다", async () => {
    // 이름만 고치려고 들어왔다가 비밀번호가 지워지면 다음 접속이 막힌다.
    const host = vncHost();
    resetStore([host]);
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Renamed");
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialMode: "preserve", credentials: null }),
    );
  });

  it("수준을 판정 못 하는 서버에서는 RDP·VNC 칸이 막힌다", async () => {
    // 못 막는 서버에서 만들면 같은 계정의 옛 기기가 그 레코드를 받고 조용히 망가진다.
    mockRouteParams = {};
    resetStore();
    useMobileAppStore.setState({
      syncStatus: {
        ...useMobileAppStore.getState().syncStatus,
        dataFloorServerSupport: "unsupported",
      },
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });

    const rdp = findPressableByText(tree!.root, "RDP");
    expect(rdp.props.disabled).toBe(true);
    // 눌리지 않는 칸은 이유가 안 보이면 고장으로 읽힌다.
    expect(
      tree!.root.findAll(
        node =>
          typeof node.props?.children === "string" &&
          node.props.children.includes("서버를 업데이트하면"),
      ).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("종류를 RDP 로 바꿔 새로 만든다", async () => {
    // 폼은 SSH 로 열린다 — 가장 흔한 길이라 손이 더 들지 않아야 한다. 종류는 맨 위 칸에서
    // 바꾸고, 바꾸면 그 종류의 폼으로 갈린다.
    mockRouteParams = {};
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });

    // SSH 로 열렸다 — 인증 방식 칸은 SSH 폼에만 있다.
    expect(() => findInput(tree!.root, "개인 키")).toThrow();

    await act(async () => {
      findPressableByText(tree!.root, "RDP").props.onPress();
    });

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Office PC");
      findInput(tree!.root, "호스트").props.onChangeText("pc.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("doyoung");
      findInput(tree!.root, "비밀번호").props.onChangeText("hunter2");
    });
    await act(async () => {
      findPressableByText(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rdp",
        label: "Office PC",
        hostname: "pc.example.com",
        // RDP 는 기본 포트가 3389 다.
        port: 3389,
        credentialMode: "replace",
        credentials: expect.objectContaining({
          username: "doyoung",
          password: "hunter2",
        }),
      }),
    );
  });
});
