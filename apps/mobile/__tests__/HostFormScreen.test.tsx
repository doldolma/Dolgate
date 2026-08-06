import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, TextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { SshHostRecord } from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import { HostFormScreen } from "../src/screens/HostFormScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockGoBack = jest.fn();
const mockDispatch = jest.fn();
let mockRouteParams: { hostId?: string } | undefined;
// 화면이 beforeRemove 로 나가기를 가로챈다 — 등록된 콜백을 잡아 두고 테스트에서 직접 부른다.
let beforeRemoveListener: ((event: unknown) => void) | null = null;

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
    dispatch: mockDispatch,
    addListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "beforeRemove") {
        beforeRemoveListener = listener;
      }
      return () => {
        if (name === "beforeRemove") {
          beforeRemoveListener = null;
        }
      };
    },
  }),
  useRoute: () => ({ params: mockRouteParams }),
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

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function renderForm(): renderer.ReactTestRenderer {
  return renderer.create(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <HostFormScreen />
    </SafeAreaProvider>,
  );
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

// placeholder 는 예시 값("10.0.0.1")이라 칸을 가리키지 못한다 — 라벨이 칸의 이름이고,
// 스크린리더가 읽는 것과 같은 값으로 찾는다.
function findInput(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root
    .findAllByType(TextInput)
    .find((node) => node.props.accessibilityLabel === label);
  if (!match) {
    throw new Error(`input not found: ${label}`);
  }
  return match;
}

function hasInput(root: renderer.ReactTestInstance, label: string): boolean {
  return root
    .findAllByType(TextInput)
    .some((node) => node.props.accessibilityLabel === label);
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
    mockDispatch.mockReset();
    beforeRemoveListener = null;
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
      tree = renderForm();
    });

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText(
        "New host",
      );
      findInput(tree!.root, "호스트").props.onChangeText(
        "new.example.com",
      );
      findInput(tree!.root, "포트").props.onChangeText("2222");
      findInput(tree!.root, "사용자").props.onChangeText(
        "deploy",
      );
      findInput(tree!.root, "그룹").props.onChangeText(
        "work/aws",
      );
      findInput(tree!.root, "비밀번호").props.onChangeText(
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
        certificateText: undefined,
      },
      // 새 호스트는 startup command 를 고르지 않았으므로 명시적 해제다.
      startupCommand: null,
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  // 인증서 인증은 런타임(엔진·자격 증명 프롬프트)에는 이미 있었고 폼에만 없었다.
  it("collects a certificate credential as a key and certificate pair", async () => {
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Cert host");
      findInput(tree!.root, "호스트").props.onChangeText(
        "cert.example.com",
      );
      findInput(tree!.root, "사용자").props.onChangeText(
        "ubuntu",
      );
      findActionByLabel(tree!.root, "인증서").props.onPress();
    });

    await act(async () => {
      findInput(tree!.root, "개인 키").props.onChangeText(
        "-----BEGIN OPENSSH PRIVATE KEY-----",
      );
    });

    // 한쪽만 채운 상태에서는 저장을 막는다 — 시크릿이 조용히 버려지는 걸 방지한다.
    expect(findSaveButton(tree!.root, "호스트 추가").props.disabled).toBe(true);

    await act(async () => {
      findInput(tree!.root, "인증서").props.onChangeText(
        "ssh-ed25519-cert-v01@openssh.com AAAA",
      );
    });

    const saveButton = findSaveButton(tree!.root, "호스트 추가");
    expect(saveButton.props.disabled).toBe(false);
    await act(async () => {
      saveButton.props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: "certificate",
        credentials: {
          password: undefined,
          privateKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----",
          passphrase: "",
          certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
        },
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  // 데스크톱에서 agent 로 설정한 호스트는 모바일에서 값을 바꾸지 않고 그대로 실어 보내야
  // 한다 — password 로 떨어뜨리면 이름만 고쳐 저장해도 데스크톱에서 그 호스트가 깨진다.
  it("preserves a desktop-only auth type instead of rewriting it", async () => {
    const host = { ...createExistingHost(), authType: "agent" as const, secretRef: null };
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
      tree = renderForm();
    });

    // 무엇으로 설정돼 있는지는 보여 주고, 고르는 칩은 감춘다.
    expect(
      tree!.root.findAll((node) => node.props?.children === "SSH Agent"),
    ).not.toHaveLength(0);
    expect(
      tree!.root.findAll((node) => node.props?.children === "비밀번호"),
    ).toHaveLength(0);

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Renamed");
    });
    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Renamed",
        authType: "agent",
        credentialMode: undefined,
        credentials: null,
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  // 모달에는 back chevron 이 없어 헤더의 취소와 아래로 스와이프하는 제스처가 유일한 출구다.
  // 둘 다 beforeRemove 를 지나므로, 저장하지 않은 입력은 어느 쪽으로 나가도 확인을 받는다.
  it("guards an exit with unsaved edits and lets the user discard", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    // 아무것도 고치지 않았으면 막지 않는다.
    const untouched = { preventDefault: jest.fn(), data: { action: { type: "POP" } } };
    await act(async () => {
      beforeRemoveListener?.(untouched);
    });
    expect(untouched.preventDefault).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Half typed");
    });

    const dirty = { preventDefault: jest.fn(), data: { action: { type: "POP" } } };
    await act(async () => {
      beforeRemoveListener?.(dirty);
    });
    expect(dirty.preventDefault).toHaveBeenCalledTimes(1);

    // "버리기"를 고르면 원래 가려던 곳으로 보낸다.
    const buttons = alertSpy.mock.calls[0][2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    const discard = buttons.find((button) => button.text === "버리기");
    expect(discard).toBeTruthy();
    await act(async () => {
      discard?.onPress?.();
    });
    expect(mockDispatch).toHaveBeenCalledWith({ type: "POP" });

    alertSpy.mockRestore();
    await act(async () => {
      tree!.unmount();
    });
  });

  // 저장에 성공해 스스로 닫을 때는 물어보지 않는다.
  it("does not guard the exit after a successful save", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    useMobileAppStore.setState({ saveHost: jest.fn(async () => undefined) });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Saved host");
      findInput(tree!.root, "호스트").props.onChangeText("saved.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("ubuntu");
    });
    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    const afterSave = { preventDefault: jest.fn(), data: { action: { type: "POP" } } };
    await act(async () => {
      beforeRemoveListener?.(afterSave);
    });
    expect(afterSave.preventDefault).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    alertSpy.mockRestore();
    await act(async () => {
      tree!.unmount();
    });
  });

  it("disables saving while the port is invalid", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Host");
      findInput(tree!.root, "호스트").props.onChangeText(
        "example.com",
      );
      findInput(tree!.root, "사용자").props.onChangeText(
        "ubuntu",
      );
      findInput(tree!.root, "포트").props.onChangeText("99999");
    });

    expect(findSaveButton(tree!.root, "호스트 추가").props.disabled).toBe(
      true,
    );

    await act(async () => {
      findInput(tree!.root, "포트").props.onChangeText("22");
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
      tree = renderForm();
    });

    expect(findInput(tree!.root, "이름").props.value).toBe(
      host.label,
    );
    expect(findInput(tree!.root, "호스트").props.value).toBe(
      host.hostname,
    );
    expect(findInput(tree!.root, "포트").props.value).toBe(
      "2200",
    );
    expect(findInput(tree!.root, "사용자").props.value).toBe(
      host.username,
    );
    expect(findActionByLabel(tree!.root, "기존 유지")).toBeTruthy();
    expect(hasInput(tree!.root, "개인 키")).toBe(false);

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
      tree = renderForm();
    });
    await act(async () => {
      findActionByLabel(tree!.root, "교체").props.onPress();
    });
    expect(hasInput(tree!.root, "개인 키")).toBe(true);

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
      tree = renderForm();
    });
    await act(async () => {
      findActionByLabel(tree!.root, "비밀번호").props.onPress();
    });
    expect(
      tree!.root.findAll(
        (node) => node.props?.children === "기존 유지",
      ),
    ).toHaveLength(0);
    expect(findInput(tree!.root, "비밀번호")).toBeTruthy();

    await act(async () => {
      findActionByLabel(tree!.root, "개인 키").props.onPress();
    });
    expect(findActionByLabel(tree!.root, "기존 유지")).toBeTruthy();
    expect(hasInput(tree!.root, "개인 키")).toBe(false);

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
  it("shows the existing startup command and can switch it to a snippet", async () => {
    const existing = {
      ...createExistingHost(),
      startupCommand: { type: "command" as const, command: "cd /srv" },
    };
    mockRouteParams = { hostId: existing.id };
    resetStore([existing]);
    useMobileAppStore.setState({
      snippets: [
        {
          id: "snippet-1",
          label: "Deploy",
          command: "deploy {{env}}",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderForm();
    });

    // 기존 명령이 그대로 보인다.
    expect(findInput(tree!.root, "명령").props.value).toBe("cd /srv");

    // 스니펫 모드로 바꾸고 목록에서 고른다.
    await act(async () => {
      findActionByLabel(tree!.root, "스니펫").props.onPress();
    });
    await act(async () => {
      findActionByLabel(tree!.root, "스니펫 선택").props.onPress();
    });
    await act(async () => {
      tree!.root
        .findAll((node) => node.props?.testID === "startup-snippet-snippet-1")[0]
        .props.onPress();
    });

    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("clears the startup command when the mode goes back to none", async () => {
    const existing = {
      ...createExistingHost(),
      startupCommand: { type: "command" as const, command: "cd /srv" },
    };
    mockRouteParams = { hostId: existing.id };
    resetStore([existing]);
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderForm();
    });

    await act(async () => {
      findActionByLabel(tree!.root, "사용 안 함").props.onPress();
    });
    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ startupCommand: null }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("warns when the linked snippet is gone", async () => {
    const existing = {
      ...createExistingHost(),
      startupCommand: { type: "snippet" as const, snippetId: "gone" },
    };
    mockRouteParams = { hostId: existing.id };
    resetStore([existing]);
    useMobileAppStore.setState({ snippets: [] });

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderForm();
    });

    const warning = tree!.root.findAll(
      (node) =>
        typeof node.props?.children === "string" &&
        node.props.children.includes("찾을 수 없습니다"),
    );
    expect(warning.length).toBeGreaterThan(0);

    await act(async () => {
      tree!.unmount();
    });
  });
});
