import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, Switch, Text, TextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { HostRecord, SshHostRecord } from "@dolssh/shared-core";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import { HostFormScreen } from "../src/screens/HostFormScreen";
import { GroupNamePromptModal } from "../src/components/GroupNamePromptModal";
import { ListPickerModal } from "../src/components/ListPickerModal";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockGoBack = jest.fn();
const mockDispatch = jest.fn();
let mockRouteParams:
  | { hostId?: string; defaultGroupPath?: string }
  | undefined;
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

function resetStore(hosts: HostRecord[] = []): void {
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

/** 화면에 그 글자가 떠 있는가 — 값만 보여 주는 행(그룹처럼)을 확인할 때. */
function hasText(root: renderer.ReactTestInstance, text: string): boolean {
  return root.findAll((node) => node.props?.children === text).length > 0;
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

/** 라벨로 누를 것을 찾는다 — 고급 접기/펼치기 줄처럼 아이콘만 다른 행을 집을 때 쓴다. */
function findPressableByText(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      (node.props.accessibilityLabel === label ||
        node.findAll((child) => child.props?.children === label).length > 0),
  );
  if (match.length === 0) {
    throw new Error(`pressable not found: ${label}`);
  }
  return match[match.length - 1];
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

/**
 * 분절 컨트롤(인증 방식·시작 명령)의 한 칸.
 *
 * 라벨만으로 찾으면 같은 글자를 값으로 달고 있는 행에 걸린다 — "사용 안 함" 은 시작 명령의
 * 한 칸이면서 Tailnet 행의 값이기도 하다. 고른 상태를 알리는 칸만 본다.
 */
function findSegmentByLabel(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      node.props.accessibilityState !== undefined &&
      "selected" in (node.props.accessibilityState ?? {}) &&
      node.findAll((child) => child.props?.children === label).length > 0,
  )[0];
  if (!match) {
    throw new Error(`segment not found: ${label}`);
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

  it("does not treat the prefilled group as an unsaved change", async () => {
    // 채워 넣은 기본 그룹은 사용자가 고친 것이 아니다. 기준선을 안 맞추면 아무것도
    // 안 건드리고 나가려 할 때 "변경 사항을 버릴까요?" 가 뜬다.
    mockRouteParams = { defaultGroupPath: "test" };
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

    await act(async () => {
      renderForm();
    });

    const untouched = {
      preventDefault: jest.fn(),
      data: { action: { type: "POP" } },
    };
    await act(async () => {
      beforeRemoveListener?.(untouched);
    });

    expect(untouched.preventDefault).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("starts in the group the list was showing", async () => {
    // 그룹을 열어 둔 채 추가하면 그 그룹에 넣으려는 것이다. 폼에서 다시 고르게 하면
    // 손이 한 번 더 가고, 안 고르면 뿌리에 떨어진다.
    mockRouteParams = { defaultGroupPath: "work/aws" };
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    // 그룹은 고르는 행이다 — 값이 행에 적혀 있어야 어느 그룹으로 들어가는지 알 수 있다.
    expect(hasText(tree!.root, "work/aws")).toBe(true);

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("New host");
      findInput(tree!.root, "호스트").props.onChangeText("new.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("deploy");
      findInput(tree!.root, "비밀번호").props.onChangeText("hunter2");
    });
    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "work/aws" }),
    );
  });

  it("collects the form into saveHost and goes back on success", async () => {
    // 그룹은 이제 타이핑이 아니라 고르는 것이다. 여기서 보는 것은 실린 값의 모양이므로
    // 열려 있던 그룹을 그대로 물고 들어온 폼으로 확인한다.
    mockRouteParams = { defaultGroupPath: "work/aws" };
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
      // 고급 항목은 손대지 않았으므로 빈 값이 그대로 실린다. 목록은 빈 배열과 null 이
      // 다른 뜻이라(빈 배열=전부 지움, 생략=보존) 여기서 어느 쪽인지 못 박아 둔다.
      tags: [],
      env: null,
      agentForwarding: false,
      useMosh: false,
      jumpHostIds: null,
      tailnetId: null,
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

    // 시작 명령은 고급 안에 있다 — 자주 쓰는 칸들 사이에 끼워 두면 폼이 길어진다.
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
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

    // 시작 명령은 고급 안에 있다 — 자주 쓰는 칸들 사이에 끼워 두면 폼이 길어진다.
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });

    await act(async () => {
      findSegmentByLabel(tree!.root, "사용 안 함").props.onPress();
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

    // 시작 명령은 고급 안에 있다 — 자주 쓰는 칸들 사이에 끼워 두면 폼이 길어진다.
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
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
  it("고급을 펼쳐 태그와 환경 변수를 넣는다", async () => {
    // 태그는 검색이 이미 보고 있는데(getHostSearchText) 모바일에서 만들 수가 없었다.
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("New host");
      findInput(tree!.root, "호스트").props.onChangeText("new.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("deploy");
      findInput(tree!.root, "비밀번호").props.onChangeText("hunter2");
    });

    // 평소에는 접혀 있다 — 기본 화면이 안 쓰는 항목으로 길어지면 안 된다.
    expect(() => findInput(tree!.root, "태그 추가")).toThrow();

    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });

    // 입력과 제출을 한 act 에 묶으면 제출이 **직전 값**을 본다(상태 반영 전).
    await act(async () => {
      findInput(tree!.root, "태그 추가").props.onChangeText("운영");
    });
    await act(async () => {
      findInput(tree!.root, "태그 추가").props.onSubmitEditing();
    });
    // 이름과 값을 나눠 받는다 — 한 칸에 KEY=VALUE 를 치게 하면 `=` 를 아는 사람만 넣을 수
    // 있고, 모르고 친 값은 아무 말 없이 버려졌다.
    await act(async () => {
      findInput(tree!.root, "변수 이름").props.onChangeText("LANG");
      findInput(tree!.root, "변수 값").props.onChangeText("ko_KR.UTF-8");
    });
    await act(async () => {
      findInput(tree!.root, "변수 값").props.onSubmitEditing();
    });

    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ["운영"],
        env: [{ key: "LANG", value: "ko_KR.UTF-8" }],
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });


  // 데스크톱은 읽고 쓸 때마다 normalizeHostEnvVars 를 통과시킨다. 폰이 규칙에 안 맞는 이름을
  // 받아 주면 동기화된 뒤 그 경계에서 조용히 사라져, 넣었는데 없어진 것으로만 보인다.
  it("규칙에 안 맞는 환경 변수 이름을 거부하고 이유를 말한다", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });

    await act(async () => {
      findInput(tree!.root, "변수 이름").props.onChangeText("MY VAR");
      findInput(tree!.root, "변수 값").props.onChangeText("1");
    });
    await act(async () => {
      findInput(tree!.root, "변수 값").props.onSubmitEditing?.();
    });

    expect(
      hasText(
        tree!.root,
        "변수 이름은 영문·숫자·밑줄만 쓸 수 있고 숫자로 시작할 수 없습니다.",
      ),
    ).toBe(true);
    // 칩은 만들어지지 않는다 — 받아 준 것처럼 보이면 안 된다.
    expect(hasText(tree!.root, "MY VAR=1")).toBe(false);

    // 이름을 고치면 들어간다.
    await act(async () => {
      findInput(tree!.root, "변수 이름").props.onChangeText("MY_VAR");
    });
    await act(async () => {
      findInput(tree!.root, "변수 값").props.onSubmitEditing?.();
    });
    expect(hasText(tree!.root, "MY_VAR=1")).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  // 관례가 대문자라고 강제하면 no_proxy 처럼 소문자인 변수를 넣을 방법이 없어진다.
  it("환경 변수 이름을 대문자로 바꾸지 않는다", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });

    expect(findInput(tree!.root, "변수 이름").props.autoCapitalize).toBe("none");

    await act(async () => {
      findInput(tree!.root, "변수 이름").props.onChangeText("no_proxy");
      findInput(tree!.root, "변수 값").props.onChangeText("localhost");
    });
    await act(async () => {
      findInput(tree!.root, "변수 값").props.onSubmitEditing?.();
    });
    expect(hasText(tree!.root, "no_proxy=localhost")).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });
  it("고급은 값이 있어도 접힌 채로 열고, 무엇이 들었는지 머리글에 적는다", async () => {
    // 값이 있으면 펼쳐 두게 했더니 태그 하나만 넣어도 그 뒤로는 영영 열려 있었다. 보존하고
    // 있다는 사실은 요약이 알려 주면 된다.
    const host: SshHostRecord = {
      id: "host-adv",
      kind: "ssh",
      label: "Advanced host",
      hostname: "adv.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      secretRef: null,
      groupName: null,
      tags: ["운영", "서울"],
      env: [{ key: "LANG", value: "ko_KR.UTF-8" }],
      agentForwarding: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    resetStore([host]);
    mockRouteParams = { hostId: host.id };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });

    expect(() => findInput(tree!.root, "태그 추가")).toThrow();
    // 열어 보지 않아도 무엇이 들었는지는 알 수 있다.
    expect(hasText(tree!.root, "태그 2 · 변수 1 · 에이전트 포워딩")).toBe(true);

    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    expect(() => findInput(tree!.root, "태그 추가")).not.toThrow();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("고급 값을 건드리지 않으면 그대로 다시 저장된다", async () => {
    // 모바일이 모르는 값을 지우지 않는다는 규약. 이름만 고쳐도 데스크톱 설정이 살아야 한다.
    const host: SshHostRecord = {
      id: "host-keep",
      kind: "ssh",
      label: "Keep",
      hostname: "keep.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      secretRef: "secret-1",
      groupName: null,
      tags: ["운영"],
      env: [{ key: "TZ", value: "Asia/Seoul" }],
      useMosh: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    resetStore([host]);
    mockRouteParams = { hostId: host.id };
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Keep renamed");
    });
    await act(async () => {
      findSaveButton(tree!.root, "변경 사항 저장").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Keep renamed",
        tags: ["운영"],
        env: [{ key: "TZ", value: "Asia/Seoul" }],
        useMosh: true,
      }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });
  // 눌러도 아무 일이 없는 목록은 고장으로 읽힌다 — 상한에 걸리면 그 자리에서 이유를 말한다.
  it("점프 호스트 상한에 걸리면 이유를 보여주고 더 고르지 못하게 한다", async () => {
    const candidates: SshHostRecord[] = Array.from({ length: 10 }, (_, index) => ({
      ...createExistingHost(),
      id: `jump-${index}`,
      label: `Hop ${index}`,
      hostname: `h${index}.example.com`,
      secretRef: null,
      jumpHostIds: undefined,
      env: undefined,
      startupCommand: undefined,
    }));
    resetStore(candidates);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "점프 호스트 추가").props.onPress();
    });

    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        findPressableByText(tree!.root, `Hop ${index}`).props.onPress();
      });
    }
    expect(
      hasText(tree!.root, "점프 호스트는 최대 8개까지 넣을 수 있습니다."),
    ).toBe(true);

    // 아직 안 고른 항목은 눌릴 수 없고, 이미 고른 것은 빼야 하므로 눌릴 수 있어야 한다.
    const disabledOf = (label: string): boolean[] =>
      tree!.root
        .findAll(
          node =>
            node.props?.label === label &&
            typeof node.props?.disabled === "boolean",
        )
        .map(node => node.props.disabled as boolean);
    expect(disabledOf("Hop 8")).toContain(true);
    expect(disabledOf("Hop 0")).toContain(false);

    await act(async () => {
      tree!.unmount();
    });
  });

  // 검색어를 남겨 두면 다시 열었을 때 걸러진 목록이 나오고, 그 사이 항목이 8개 미만으로
  // 줄면 검색칸이 사라져 지울 수단도 없어진다.
  it("고르는 시트를 닫으면 검색어를 버린다", async () => {
    const candidates: SshHostRecord[] = Array.from({ length: 9 }, (_, index) => ({
      ...createExistingHost(),
      id: `jump-${index}`,
      label: `Hop ${index}`,
      hostname: `h${index}.example.com`,
      secretRef: null,
      jumpHostIds: undefined,
      env: undefined,
      startupCommand: undefined,
    }));
    resetStore(candidates);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "점프 호스트 추가").props.onPress();
    });

    const search = (): renderer.ReactTestInstance =>
      tree!.root.findByProps({ testID: "list-picker-search" });
    await act(async () => {
      search().props.onChangeText("Hop 3");
    });
    expect(search().props.value).toBe("Hop 3");

    // 닫고 다시 연다.
    await act(async () => {
      findPressableByText(tree!.root, "완료").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "점프 호스트 추가").props.onPress();
    });
    expect(search().props.value).toBe("");

    await act(async () => {
      tree!.unmount();
    });
  });

it("점프 호스트를 목록에서 고르고 순서대로 저장한다", async () => {
    // 연결 경로는 이미 모바일에서 돈다 — 지정만 못 했다.
    const first: SshHostRecord = { ...createExistingHost(), id: "jump-1", label: "Bastion", hostname: "b1.example.com", secretRef: null, jumpHostIds: undefined, env: undefined, startupCommand: undefined };
    const second: SshHostRecord = { ...first, id: "jump-2", label: "Relay", hostname: "b2.example.com" };
    resetStore([first, second]);
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("Target");
      findInput(tree!.root, "호스트").props.onChangeText("target.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("deploy");
      findInput(tree!.root, "비밀번호").props.onChangeText("pw");
    });
    await act(async () => {
      findPressableByText(tree!.root, "고급").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "점프 호스트 추가").props.onPress();
    });
    // 누른 차례가 곧 홉 순서다.
    await act(async () => {
      findPressableByText(tree!.root, "Relay").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "Bastion").props.onPress();
    });
    await act(async () => {
      findPressableByText(tree!.root, "완료").props.onPress();
    });
    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ jumpHostIds: ["jump-2", "jump-1"] }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("그룹을 목록에서 고른다", async () => {
    // 직접 입력은 오타가 곧 새 그룹이 된다.
    const host: SshHostRecord = { ...createExistingHost(), id: "h-1", groupName: "work/aws" };
    resetStore([host]);
    const saveHostMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({ saveHost: saveHostMock });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("New");
      findInput(tree!.root, "호스트").props.onChangeText("new.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("deploy");
      findInput(tree!.root, "비밀번호").props.onChangeText("pw");
    });
    await act(async () => {
      findPressableByText(tree!.root, "그룹").props.onPress();
    });
    await act(async () => {
      // 목록은 이름(aws)을 앞에, 어디에 속하는지(work)를 아랫줄에 보여 준다.
      findPressableByText(tree!.root, "aws").props.onPress();
    });
    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });

    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "work/aws" }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("없는 그룹은 고르는 화면에서 만들어 바로 넣는다", async () => {
    // 만드는 길이 없으면 그룹을 고르는 화면은 "여기 없는 그룹은 포기하라" 는 화면이 된다.
    const host: SshHostRecord = {
      ...createExistingHost(),
      id: "h-1",
      groupName: "work",
    };
    // work 를 열어 둔 채 추가하는 흐름 — 새 그룹은 그 아래에 만들어진다.
    mockRouteParams = { defaultGroupPath: "work" };
    resetStore([host]);
    const saveHostMock = jest.fn(async () => undefined);
    const createGroupMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      saveHost: saveHostMock,
      createGroup: createGroupMock,
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderForm();
    });
    await act(async () => {
      findInput(tree!.root, "이름").props.onChangeText("New");
      findInput(tree!.root, "호스트").props.onChangeText("new.example.com");
      findInput(tree!.root, "사용자").props.onChangeText("deploy");
      findInput(tree!.root, "비밀번호").props.onChangeText("pw");
    });
    await act(async () => {
      findPressableByText(tree!.root, "그룹").props.onPress();
    });

    // 프롬프트는 고르는 시트 **안**에 있어야 한다. 밖에 두면 iOS 가 두 번째 모달 띄우기를
    // 조용히 무시해서 버튼을 눌러도 아무 일도 안 일어난다(실기기에서 그렇게 걸렸다).
    const groupPicker = tree!.root
      .findAllByType(ListPickerModal)
      .find(node => node.props.title === "그룹");
    expect(groupPicker?.findAllByType(GroupNamePromptModal).length).toBe(1);

    await act(async () => {
      findPressableByText(tree!.root, "새 그룹 만들기").props.onPress();
    });
    await act(async () => {
      findInput(tree!.root, "그룹 이름").props.onChangeText("seoul");
    });
    await act(async () => {
      findPressableByText(tree!.root, "새 그룹").props.onPress();
    });

    // 고른 그룹 아래에 만들어지고, 만든 그룹이 곧 이 호스트의 그룹이 된다.
    expect(createGroupMock).toHaveBeenCalledWith("seoul", "work");

    await act(async () => {
      findSaveButton(tree!.root, "호스트 추가").props.onPress();
    });
    expect(saveHostMock).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "work/seoul" }),
    );

    await act(async () => {
      tree!.unmount();
    });
  });
});

// **EC2 호스트는 이 폼이 편집하지 않는다** — 인스턴스 정보는 AWS 가 정한다. 다만 접속 경로(서버
// 프록시)는 기기 사정에 따라 달라지므로 폰에서 껐다 켤 수 있어야 한다.
describe("HostFormScreen — AWS EC2", () => {
  const ec2Host = {
    id: "host-ec2",
    kind: "aws-ec2",
    label: "prod-web",
    awsProfileId: "p-1",
    awsProfileName: "prod",
    awsRegion: "ap-northeast-2",
    awsInstanceId: "i-abc",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as HostRecord;

  beforeEach(() => {
    mockRouteParams = { hostId: "host-ec2" };
  });

  it("서버 프록시를 껐다 켤 수 있다", async () => {
    const setServerProxy = jest.fn(async () => undefined);
    resetStore([ec2Host]);
    useMobileAppStore.setState({
      setAwsSsmServerProxyEnabled: setServerProxy,
    } as never);

    let view: renderer.ReactTestRenderer;
    await act(async () => {
      view = renderForm();
    });
    const toggle = view!.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);

    await act(async () => {
      toggle.props.onValueChange(true);
    });
    expect(setServerProxy).toHaveBeenCalledWith("host-ec2", true);

    // 켜진 호스트에서는 반대로 끌 수 있어야 한다.
    resetStore([{ ...ec2Host, awsSsmServerProxyEnabled: true } as HostRecord]);
    useMobileAppStore.setState({
      setAwsSsmServerProxyEnabled: setServerProxy,
    } as never);
    let enabledView: renderer.ReactTestRenderer;
    await act(async () => {
      enabledView = renderForm();
    });
    const enabledToggle = enabledView!.root.findByType(Switch);
    expect(enabledToggle.props.value).toBe(true);

    await act(async () => {
      enabledToggle.props.onValueChange(false);
    });
    expect(setServerProxy).toHaveBeenLastCalledWith("host-ec2", false);
  });

  it("인스턴스 정보는 읽기 전용으로 보여준다", async () => {
    resetStore([ec2Host]);
    let view: renderer.ReactTestRenderer;
    await act(async () => {
      view = renderForm();
    });
    const texts = view!.root
      .findAllByType(Text)
      .flatMap(node => (typeof node.props.children === "string" ? [node.props.children] : []));

    expect(texts).toContain("i-abc");
    expect(texts).toContain("ap-northeast-2");
    // 이름을 고치는 칸은 없다 — 이 폼은 EC2 를 편집하지 않는다.
    expect(hasInput(view!.root, "이름")).toBe(false);
  });
});
