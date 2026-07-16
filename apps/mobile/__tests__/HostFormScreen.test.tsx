import React from "react";
import renderer, { act } from "react-test-renderer";
import { TextInput } from "react-native";
import type { SshHostRecord } from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import { HostFormScreen } from "../src/screens/HostFormScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockGoBack = jest.fn();
let mockRouteParams: { hostId?: string } | undefined;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
  }),
  useRoute: () => ({ params: mockRouteParams }),
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

function createExistingHost(): SshHostRecord {
  return {
    id: "host-1",
    kind: "ssh",
    label: "Existing host",
    hostname: "old.example.com",
    port: 2200,
    username: "ubuntu",
    authType: "privateKey",
    groupName: "work",
    secretRef: "secret-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function resetStore(hosts: SshHostRecord[] = []): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createUnauthenticatedState(),
    vault: { status: "none" },
    settings: createDefaultMobileSettings(),
    syncStatus: createDefaultSyncStatus(),
    groups: [],
    hosts,
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

function findInputByPlaceholder(
  root: renderer.ReactTestInstance,
  placeholderPrefix: string,
): renderer.ReactTestInstance {
  const match = root
    .findAllByType(TextInput)
    .find((node) =>
      String(node.props.placeholder ?? "").startsWith(placeholderPrefix),
    );
  if (!match) {
    throw new Error(`input not found: ${placeholderPrefix}`);
  }
  return match;
}

function findSaveButton(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      "disabled" in node.props &&
      node.findAll((child) => child.props?.children === label).length > 0,
  )[0];
  if (!match) {
    throw new Error(`save button not found: ${label}`);
  }
  return match;
}

function findActionByLabel(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      node.findAll((child) => child.props?.children === label).length > 0,
  )[0];
  if (!match) {
    throw new Error(`action not found: ${label}`);
  }
  return match;
}

describe("HostFormScreen", () => {
  beforeEach(async () => {
    mockGoBack.mockReset();
    mockRouteParams = undefined;
    await act(async () => {
      resetStore();
    });
  });

  it("collects the form into saveHost and goes back on success", async () => {
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HostFormScreen />);
    });

    await act(async () => {
      findInputByPlaceholder(tree!.root, "이름").props.onChangeText(
        "New host",
      );
      findInputByPlaceholder(tree!.root, "호스트 주소").props.onChangeText(
        "new.example.com",
      );
      findInputByPlaceholder(tree!.root, "포트").props.onChangeText("2222");
      findInputByPlaceholder(tree!.root, "사용자 이름").props.onChangeText(
        "deploy",
      );
      findInputByPlaceholder(tree!.root, "그룹").props.onChangeText(
        "work/aws",
      );
      findInputByPlaceholder(tree!.root, "비밀번호").props.onChangeText(
        "hunter2",
      );
    });

    const saveButton = findSaveButton(tree!.root, "호스트 추가");
    expect(saveButton.props.disabled).toBe(false);
    await act(async () => {
      saveButton.props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith({
      hostId: undefined,
      label: "New host",
      hostname: "new.example.com",
      port: 2222,
      username: "deploy",
      authType: "password",
      groupName: "work/aws",
      credentialMode: "replace",
      credentials: {
        password: "hunter2",
        privateKeyPem: undefined,
        passphrase: undefined,
      },
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("disables saving while the port is invalid", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HostFormScreen />);
    });

    await act(async () => {
      findInputByPlaceholder(tree!.root, "이름").props.onChangeText("Host");
      findInputByPlaceholder(tree!.root, "호스트 주소").props.onChangeText(
        "example.com",
      );
      findInputByPlaceholder(tree!.root, "사용자 이름").props.onChangeText(
        "ubuntu",
      );
      findInputByPlaceholder(tree!.root, "포트").props.onChangeText("99999");
    });

    expect(findSaveButton(tree!.root, "호스트 추가").props.disabled).toBe(
      true,
    );

    await act(async () => {
      findInputByPlaceholder(tree!.root, "포트").props.onChangeText("22");
    });
    expect(findSaveButton(tree!.root, "호스트 추가").props.disabled).toBe(
      false,
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("prefills the form when editing an existing host", async () => {
    const host = createExistingHost();
    await act(async () => {
      resetStore([host]);
    });
    mockRouteParams = { hostId: host.id };
    const saveHostMock = jest.fn(async () => undefined);
    await act(async () => {
      useMobileAppStore.setState({ saveHost: saveHostMock });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HostFormScreen />);
    });

    expect(findInputByPlaceholder(tree!.root, "이름").props.value).toBe(
      host.label,
    );
    expect(findInputByPlaceholder(tree!.root, "호스트 주소").props.value).toBe(
      host.hostname,
    );
    expect(findInputByPlaceholder(tree!.root, "포트").props.value).toBe(
      "2200",
    );
    expect(findInputByPlaceholder(tree!.root, "사용자 이름").props.value).toBe(
      host.username,
    );
    expect(findActionByLabel(tree!.root, "기존 유지")).toBeTruthy();
    expect(
      tree!.root.findAllByType(TextInput).some((node) =>
        String(node.props.placeholder ?? "").startsWith("개인 키 붙여넣기"),
      ),
    ).toBe(false);

    const saveButton = findSaveButton(tree!.root, "변경 사항 저장");
    await act(async () => {
      saveButton.props.onPress();
    });
    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: host.id,
        label: host.label,
        authType: "privateKey",
        credentialMode: "preserve",
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("offers explicit replace and unlink actions for an existing credential", async () => {
    const host = createExistingHost();
    await act(async () => {
      resetStore([host]);
    });
    mockRouteParams = { hostId: host.id };
    const saveHostMock = jest.fn(async () => undefined);
    await act(async () => {
      useMobileAppStore.setState({ saveHost: saveHostMock });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HostFormScreen />);
    });
    await act(async () => {
      findActionByLabel(tree!.root, "교체").props.onPress();
    });
    expect(
      findInputByPlaceholder(tree!.root, "개인 키 붙여넣기"),
    ).toBeTruthy();

    await act(async () => {
      findActionByLabel(tree!.root, "연결 해제").props.onPress();
    });
    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });
    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialMode: "remove" }),
    );
  });

  it("restores preserve mode after changing the auth type away and back", async () => {
    const host = createExistingHost();
    await act(async () => {
      resetStore([host]);
    });
    mockRouteParams = { hostId: host.id };
    const saveHostMock = jest.fn(async () => undefined);
    await act(async () => {
      useMobileAppStore.setState({ saveHost: saveHostMock });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<HostFormScreen />);
    });
    await act(async () => {
      findActionByLabel(tree!.root, "비밀번호").props.onPress();
    });
    expect(
      tree!.root.findAll(
        (node) => node.props?.children === "기존 유지",
      ),
    ).toHaveLength(0);
    expect(findInputByPlaceholder(tree!.root, "비밀번호")).toBeTruthy();

    await act(async () => {
      findActionByLabel(tree!.root, "개인 키").props.onPress();
    });
    expect(findActionByLabel(tree!.root, "기존 유지")).toBeTruthy();
    expect(
      tree!.root.findAllByType(TextInput).some((node) =>
        String(node.props.placeholder ?? "").startsWith("개인 키 붙여넣기"),
      ),
    ).toBe(false);

    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });
    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: "privateKey",
        credentialMode: "preserve",
      }),
    );
  });
});
