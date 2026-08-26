import React from "react";
import renderer, { act } from "react-test-renderer";
import { Text, TextInput } from "react-native";
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
const mockDispatch = jest.fn();
let mockRouteParams:
  | {
      hostId?: string;
      kind?: "ssh" | "rdp" | "vnc";
      defaultGroupPath?: string;
    }
  | undefined;
// 이 화면은 SSH 폼과 **같은 라우트** 안에서 자식으로 그려지므로 beforeRemove 리스너가 둘
// 붙는다. 어느 쪽이 나가기를 막는지가 곧 동작이라 모아 두고 직접 쏜다.
let mockBeforeRemoveListeners: Array<(event: unknown) => void> = [];

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
    addListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "beforeRemove") {
        mockBeforeRemoveListeners.push(listener);
        return () => {
          mockBeforeRemoveListeners = mockBeforeRemoveListeners.filter(
            entry => entry !== listener,
          );
        };
      }
      return () => undefined;
    },
    dispatch: mockDispatch,
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

function rdpHost(): HostRecord {
  return {
    id: "rdp-1",
    kind: "rdp",
    label: "Office PC",
    hostname: "10.0.0.5",
    port: 3389,
    secretRef: "secret-rdp",
    groupName: null,
    awsSsm: {
      profileId: "profile-1",
      profileName: "prod-old-name",
      region: "ap-northeast-2",
      instanceId: "i-0abc123",
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as HostRecord;
}

describe("원격 데스크톱 호스트 폼", () => {
  beforeEach(() => {
    mockGoBack.mockReset();
    mockDispatch.mockReset();
    mockBeforeRemoveListeners = [];
    mockRouteParams = undefined;
    resetStore();
  });

  function fireBeforeRemove(): { preventDefault: jest.Mock } {
    const event = {
      preventDefault: jest.fn(),
      data: { action: { type: "POP" } },
    };
    for (const listener of mockBeforeRemoveListeners) {
      listener(event);
    }
    return event;
  }

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

  // 기본값이 "켜짐" 인 필드는 레코드에 없다 — 그것을 꺼짐으로 읽으면 이름만 고쳐도 값이
  // 뒤집히고, 그 뒤집힌 값이 모든 기기로 동기화된다.
  it("VNC 기본값(공유·무손실)을 뒤집지 않는다", async () => {
    const host = {
      ...(vncHost() as VncHostRecord),
      viewOnly: null,
      imageQuality: null,
      shared: null,
    } as VncHostRecord;
    resetStore([host]);
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    // 화면에 보이는 값부터 규약과 같아야 한다 — 화질은 무손실이 골라져 있어야 한다.
    const qualityRows = tree!.root.findAll(
      node =>
        typeof node.props?.check === "boolean" &&
        typeof node.props?.label === "string" &&
        ["속도 우선", "균형", "무손실"].includes(node.props.label as string),
    );
    expect(
      qualityRows
        .filter(node => node.props.check === true)
        .map(node => node.props.label),
    ).toEqual(["무손실"]);

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Renamed");
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    // 기본값인 쪽은 명시값으로 굳히지 않는다(데스크톱이 디스크에 쓰는 정규형과 같다).
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ shared: true, imageQuality: "lossless" }),
    );
  });

  // RDP 는 계정이 호스트가 아니라 자격증명에 있다. 빈 칸으로 열면 계정만 고칠 길이 없고,
  // 비밀번호만 바꾸려던 사람이 저장된 계정을 지운다.
  it("RDP 계정을 저장된 자격증명에서 채우고, 계정만 고쳐도 저장한다", async () => {
    const host = rdpHost();
    resetStore([host]);
    useMobileAppStore.setState({
      secretsByRef: {
        "secret-rdp": {
          secretRef: "secret-rdp",
          label: "Office PC credentials",
          kind: "rdp",
          username: "Administrator",
          domain: "CORP",
          password: "hunter2",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    expect(findInput(tree!.root, "사용자").props.value).toBe("Administrator");
    expect(findInput(tree!.root, "도메인").props.value).toBe("CORP");

    await act(async () => {
      findInput(tree!.root, "사용자").props.onChangeText("doyoung");
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialMode: "replace",
        credentials: expect.objectContaining({ username: "doyoung" }),
      }),
    );
  });

  // 주소만 봐서는 SSM 을 거치는지 알 수 없다 — 사설 IP 가 적혀 있어 직접 붙는 것처럼 보인다.
  it("RDP 고급은 접혀 있고, 열면 동기화되는 설정들이 나온다", async () => {
    const host = rdpHost();
    resetStore([host]);
    mockRouteParams = { hostId: host.id };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });

    // 접혀 있는 동안에는 안쪽 항목이 없다 — 자주 쓰는 칸이 안 쓰는 항목에 묻히면 안 된다.
    expect(() => findPressableByText(tree!.root, "마이크")).toThrow();

    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });

    for (const label of ["관리 세션", "소리", "클립보드", "32비트", "16비트"]) {
      expect(findPressableByText(tree!.root, label)).toBeTruthy();
    }
    // 폰이 붙이지 않는 설정은 아예 두지 않는다 — 손에 든 기기에서 아무 일도 안 하는 토글은
    // footer 로 해명해야만 읽히는 거짓말이 된다. 값은 저장부가 보존한다.
    for (const label of ["마이크", "카메라", "전체 모니터"]) {
      expect(() => findPressableByText(tree!.root, label)).toThrow();
    }
  });

  it("RDP 고급에서 고친 값이 호스트에 저장된다", async () => {
    const host = rdpHost();
    resetStore([host]);
    useMobileAppStore.setState({
      secretsByRef: {
        "secret-rdp": {
          secretRef: "secret-rdp",
          label: "Office PC credentials",
          kind: "rdp",
          username: "Administrator",
          domain: "CORP",
          password: "hunter2",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "16비트").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "rdp-1",
        kind: "rdp",
        colorDepth: 16,
        // 손대지 않은 것은 기본값 그대로 실린다(저장부가 기본이면 null 로 접는다).
        adminSession: false,
        audioEnabled: true,
        clipboardEnabled: true,
      }),
    );
    // 폼에 없는 것은 **보내지 않는다** — 저장부가 생략을 보존으로 읽어, 데스크톱에서 켜 둔
    // 마이크·카메라가 폰에서 저장했다고 꺼지면 안 된다.
    const saved = (saveMock.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >)[0][0];
    expect(saved).not.toHaveProperty("microphoneEnabled");
    expect(saved).not.toHaveProperty("cameraEnabled");
    expect(saved).not.toHaveProperty("useAllMonitors");
  });

  it("RDP 고급에서 태그를 붙여 저장한다", async () => {
    // 데스크톱에서 붙인 태그를 모바일이 보존만 하고 있었다 — 여기서도 고칠 수 있어야 한다.
    const host = rdpHost();
    resetStore([host]);
    useMobileAppStore.setState({
      secretsByRef: {
        "secret-rdp": {
          secretRef: "secret-rdp",
          label: "Office PC credentials",
          kind: "rdp",
          username: "Administrator",
          domain: "CORP",
          password: "hunter2",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    await act(async () => {
      findInput(tree!.root, "태그 추가").props.onChangeText("사무실");
    });
    await act(async () => {
      findInput(tree!.root, "태그 추가").props.onSubmitEditing();
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "rdp-1", tags: ["사무실"] }),
    );
  });

  it("SSM 경유 호스트는 인스턴스·리전·프로파일을 보여준다", async () => {
    const host = rdpHost();
    resetStore([host]);
    useMobileAppStore.setState({
      awsProfiles: [
        {
          id: "profile-1",
          // 이름은 바뀔 수 있다. id 로 찾은 지금 이름이 보여야 한다.
          name: "prod",
          kind: "static",
          accessKeyId: "AKIA",
          secretAccessKey: "secret",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    mockRouteParams = { hostId: host.id };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });

    const texts: string[] = [];
    tree!.root.findAll(node => typeof node.props?.children === "string")
      .forEach(node => texts.push(node.props.children as string));
    expect(texts).toContain("SSM 경유");
    expect(texts).toContain("i-0abc123 · ap-northeast-2 · prod");
  });

  // 저장한 뒤의 goBack 을 부모의 가드가 가로채면 "버릴까요?" 가 뜨고, 계속 편집을 누른 뒤
  // 다시 저장하면 호스트와 시크릿이 하나 더 만들어졌다.
  it("종류를 바꿔 저장한 뒤에는 나가기를 막지 않는다", async () => {
    mockRouteParams = {};
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    // SSH 폼에 먼저 입력해 부모를 dirty 로 만든다 — 실제로 이 순서로 겪는다.
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Office PC");
    });
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
    expect(saveMock).toHaveBeenCalledTimes(1);

    expect(fireBeforeRemove().preventDefault).not.toHaveBeenCalled();
  });

  // 반대로 저장하지 않고 나가면 확인을 받아야 한다 — 이 화면에는 그 가드가 아예 없었다.
  it("고친 것을 저장하지 않고 나가면 확인을 받는다", async () => {
    const host = vncHost();
    resetStore([host]);
    mockRouteParams = { hostId: host.id };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findInput(tree!.root, "호스트").props.onChangeText("moved.example.com");
    });

    expect(fireBeforeRemove().preventDefault).toHaveBeenCalledTimes(1);
  });

  // 계정만 바꾸는 것도 교체로 받게 되면서, 값 없는 replace 가 자격증명을 통째로 떼어 갈
  // 자리가 생겼다 — 지우려던 것은 계정이었다.
  it("RDP 계정을 비우면 저장을 막고 자격증명을 떼지 않는다", async () => {
    const host = rdpHost();
    resetStore([host]);
    useMobileAppStore.setState({
      secretsByRef: {
        "secret-rdp": {
          secretRef: "secret-rdp",
          label: "Office PC credentials",
          kind: "rdp",
          username: "Administrator",
          password: "hunter2",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    mockRouteParams = { hostId: host.id };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findInput(tree!.root, "사용자").props.onChangeText("");
    });
    await act(async () => {
      findPressableByText(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveMock).not.toHaveBeenCalled();
  });

  // 저장은 되는데 접속만 안 되는 호스트가 만들어졌다 — 연결은 계정과 비밀번호를 둘 다
  // 필수로 보는데(시크릿에만 있다) 폼은 이름·주소·포트만 검사했다.
  it("RDP 를 만들 때 계정과 비밀번호를 요구한다", async () => {
    mockRouteParams = {};
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "RDP").props.onPress();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Office PC");
      findInput(tree!.root, "호스트").props.onChangeText("pc.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("Administrator");
    });
    // 계정은 넣었지만 비밀번호가 없다.
    await act(async () => {
      findPressableByText(tree!.root, "호스트 추가").props.onPress();
    });
    expect(saveMock).not.toHaveBeenCalled();

    await act(async () => {
      findInput(tree!.root, "비밀번호").props.onChangeText("hunter2");
    });
    await act(async () => {
      findPressableByText(tree!.root, "호스트 추가").props.onPress();
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  // 종류를 바꿔도 같은 컴포넌트가 남으므로, 포트를 state 초기값으로 굳히면 이전 종류의
  // 기본값이 그대로 저장됐다(VNC 를 3389 로 만들면 연결이 거부된다).
  it("종류를 바꾸면 기본 포트가 따라온다", async () => {
    mockRouteParams = {};
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "RDP").props.onPress();
    });
    expect(findInput(tree!.root, "포트").props.value).toBe("3389");

    await act(async () => {
      findPressableByText(tree!.root, "VNC").props.onPress();
    });
    expect(findInput(tree!.root, "포트").props.value).toBe("5900");

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Lab VNC");
      findInput(tree!.root, "호스트").props.onChangeText("lab.example.com");
    });
    await act(async () => {
      findPressableByText(tree!.root, "호스트 추가").props.onPress();
    });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "vnc", port: 5900 }),
    );
  });

  // 직접 고친 포트는 종류를 바꿔도 남아야 한다 — 유도값이 사용자 입력을 덮으면 안 된다.
  it("직접 고친 포트는 종류를 바꿔도 지켜진다", async () => {
    mockRouteParams = {};
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "RDP").props.onPress();
    });
    await act(async () => {
      findInput(tree!.root, "포트").props.onChangeText("13389");
    });
    await act(async () => {
      findPressableByText(tree!.root, "VNC").props.onPress();
    });
    expect(findInput(tree!.root, "포트").props.value).toBe("13389");
  });

  // 그룹을 보다가 들어왔으면 그 그룹에 만들어야 한다 — SSH 폼은 그렇게 하는데 이쪽만 빠져
  // 있어서 호스트가 최상위에 생겼다.
  it("보고 있던 그룹을 그대로 물려받는다", async () => {
    mockRouteParams = { defaultGroupPath: "work/aws" };
    const saveMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveRemoteDesktopHost: saveMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = render();
    });
    await act(async () => {
      findPressableByText(tree!.root, "RDP").props.onPress();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Office PC");
      findInput(tree!.root, "호스트").props.onChangeText("pc.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("Administrator");
      findInput(tree!.root, "비밀번호").props.onChangeText("hunter2");
    });
    await act(async () => {
      findPressableByText(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "work/aws" }),
    );
  });
});
