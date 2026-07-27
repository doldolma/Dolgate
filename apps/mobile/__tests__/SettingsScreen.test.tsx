import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, Modal, Platform, TextInput } from "react-native";
import type { AuthState } from "@dolssh/shared-core";
import { APP_VERSION } from "../src/lib/app-metadata";
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from "../src/lib/mobile";
import {
  AuthSettingsScreen,
  SettingsScreen,
} from "../src/screens/SettingsScreen";
import { useMobileAppStore } from "../src/store/useMobileAppStore";

const mockGoBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);
const mockNavigate = jest.fn();
const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

function setPlatformOs(os: "ios" | "android") {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    get: () => os,
  });
}

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    canGoBack: mockCanGoBack,
    navigate: mockNavigate,
  }),
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
jest.mock("../src/lib/screen-layout", () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));

function collectText(node: renderer.ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      return collectText(child);
    })
    .join("");
}

function findPressableByText(
  root: renderer.ReactTestInstance,
  label: string,
): renderer.ReactTestInstance {
  const match = root.findAll(
    (node) =>
      typeof node.props.onPress === "function" &&
      collectText(node).includes(label),
  )[0];

  if (!match) {
    throw new Error(`pressable not found: ${label}`);
  }

  return match;
}

function resetStore(): void {
  useMobileAppStore.setState({
    hydrated: true,
    bootstrapping: false,
    authGateResolved: true,
    secureStateReady: true,
    auth: createUnauthenticatedState(),
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

function createOfflineAuthenticatedState(): AuthState {
  const base = createAuthenticatedState();
  return {
    ...base,
    status: "offline-authenticated",
    offline: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastOnlineAt: new Date().toISOString(),
      reason: "network",
    },
  };
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

describe("SettingsScreen server save navigation", () => {
  beforeEach(() => {
    setPlatformOs("ios");
    mockGoBack.mockReset();
    mockCanGoBack.mockReset();
    mockCanGoBack.mockReturnValue(true);
    mockNavigate.mockReset();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  afterAll(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, "OS", platformOsDescriptor);
    }
  });

  it("goes back after saving from the auth settings screen", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AuthSettingsScreen />);
    });

    const input = tree!.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText("https://ssh.example.com");
    });

    const saveButton = findPressableByText(tree!.root, "저장");
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(useMobileAppStore.getState().settings.serverUrl).toBe(
      "https://ssh.example.com",
    );
    expect(mockCanGoBack).toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  it("does not navigate when saving from the full settings tab", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const input = tree!.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText("https://ssh.full-settings.com");
    });

    const saveButton = findPressableByText(tree!.root, "저장");
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(useMobileAppStore.getState().settings.serverUrl).toBe(
      "https://ssh.full-settings.com",
    );
    expect(mockGoBack).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("uses iOS edge-swipe to return to the previous bottom tab", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    await act(async () => {
      tree!.root
        .findByProps({ testID: "ios-edge-swipe-back" })
        .props.onTouchEnd();
    });

    expect(mockCanGoBack).toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("falls back to Home when settings edge-swipe has no tab history", async () => {
    mockCanGoBack.mockReturnValue(false);
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    await act(async () => {
      tree!.root
        .findByProps({ testID: "ios-edge-swipe-back" })
        .props.onTouchEnd();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("Home");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("shows the app version and hides startup syncing-only copy", async () => {
    useMobileAppStore.setState({
      auth: createAuthenticatedState(),
      syncStatus: {
        ...createDefaultSyncStatus(),
        status: "syncing",
      },
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const text = collectText(tree!.root);
    expect(text).toContain(`Version ${APP_VERSION}`);
    expect(text).not.toContain("동기화 상태: syncing");
    expect(text).not.toContain(
      "저장된 캐시를 먼저 보여주고 최신 상태를 확인하는 중입니다.",
    );

    await act(async () => {
      tree!.unmount();
    });
  });

  it("deletes the account only after both confirmation alerts", async () => {
    const deleteAccountMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      auth: createAuthenticatedState(),
      deleteAccount: deleteAccountMock,
    });
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const deleteButton = findPressableByText(tree!.root, "회원 탈퇴");
    await act(async () => {
      deleteButton.props.onPress();
    });

    // 1단계 경고에서 "계속"을 누르기 전에는 아무 일도 일어나지 않는다.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe("회원 탈퇴");
    expect(deleteAccountMock).not.toHaveBeenCalled();

    const firstButtons = alertSpy.mock.calls[0][2];
    const continueButton = firstButtons?.find(
      (button) => button.text === "계속",
    );
    expect(continueButton).toBeDefined();
    await act(async () => {
      continueButton?.onPress?.();
    });

    // 2단계 최종 확인에서 "영구 삭제"를 눌러야 스토어 액션이 호출된다.
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[1][0]).toBe("정말 탈퇴할까요?");
    expect(deleteAccountMock).not.toHaveBeenCalled();

    const secondButtons = alertSpy.mock.calls[1][2];
    const confirmButton = secondButtons?.find(
      (button) => button.text === "영구 삭제",
    );
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton?.onPress?.();
    });

    expect(deleteAccountMock).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    await act(async () => {
      tree!.unmount();
    });
  });

  it("hides the delete account button while using the offline cache", async () => {
    useMobileAppStore.setState({
      auth: createOfflineAuthenticatedState(),
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    expect(() => findPressableByText(tree!.root, "로그아웃")).not.toThrow();
    expect(() => findPressableByText(tree!.root, "회원 탈퇴")).toThrow();

    await act(async () => {
      tree!.unmount();
    });
  });

  it("sets an OIDC-only account password without a current password", async () => {
    const originalChangeAccountPassword =
      useMobileAppStore.getState().changeAccountPassword;
    const changeAccountPasswordMock = jest.fn(async () => undefined);
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const authenticated = createAuthenticatedState();
    if (!authenticated.session) {
      throw new Error("authenticated test session is missing");
    }
    authenticated.session.user.passwordState = "unset";
    useMobileAppStore.setState({
      auth: authenticated,
      vault: { status: "none" },
      changeAccountPassword: changeAccountPasswordMock,
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });
    await act(async () => {
      findPressableByText(tree!.root, "비밀번호 설정").props.onPress();
    });
    let modal = tree!.root.findByType(Modal);
    expect(
      modal.findAllByProps({ placeholder: "현재 로그인 비밀번호" }),
    ).toHaveLength(0);
    await act(async () => {
      modal
        .findByProps({ placeholder: "새 로그인 비밀번호" })
        .props.onChangeText("new-password");
      modal
        .findByProps({ placeholder: "새 로그인 비밀번호 확인" })
        .props.onChangeText("new-password");
    });
    modal = tree!.root.findByType(Modal);
    await act(async () => {
      await findPressableByText(modal, "비밀번호 설정").props.onPress();
    });

    expect(changeAccountPasswordMock).toHaveBeenCalledWith("", "new-password");
    expect(alertSpy).toHaveBeenCalledWith("로그인 비밀번호 설정 완료");

    alertSpy.mockRestore();
    await act(async () => {
      useMobileAppStore.setState({
        changeAccountPassword: originalChangeAccountPassword,
      });
      tree!.unmount();
    });
  });

  it("changes a local account password after confirming the current password", async () => {
    const originalChangeAccountPassword =
      useMobileAppStore.getState().changeAccountPassword;
    const changeAccountPasswordMock = jest.fn(async () => undefined);
    const authenticated = createAuthenticatedState();
    if (!authenticated.session) {
      throw new Error("authenticated test session is missing");
    }
    authenticated.session.user.passwordState = "set";
    useMobileAppStore.setState({
      auth: authenticated,
      vault: { status: "none" },
      changeAccountPassword: changeAccountPasswordMock,
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });
    await act(async () => {
      findPressableByText(tree!.root, "비밀번호 변경").props.onPress();
    });
    let modal = tree!.root.findByType(Modal);
    await act(async () => {
      modal
        .findByProps({ placeholder: "현재 로그인 비밀번호" })
        .props.onChangeText("old-password");
      modal
        .findByProps({ placeholder: "새 로그인 비밀번호" })
        .props.onChangeText("new-password");
      modal
        .findByProps({ placeholder: "새 로그인 비밀번호 확인" })
        .props.onChangeText("new-password");
    });
    modal = tree!.root.findByType(Modal);
    await act(async () => {
      await findPressableByText(modal, "비밀번호 변경").props.onPress();
    });

    expect(changeAccountPasswordMock).toHaveBeenCalledWith(
      "old-password",
      "new-password",
    );

    await act(async () => {
      useMobileAppStore.setState({
        changeAccountPassword: originalChangeAccountPassword,
      });
      tree!.unmount();
    });
  });

  it("opens sync passphrase changes explicitly and clears drafts when cancelled", async () => {
    const originalChangeVaultPassphrase =
      useMobileAppStore.getState().changeVaultPassphrase;
    const changeVaultPassphraseMock = jest.fn(async () => undefined);
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    useMobileAppStore.setState({
      auth: createAuthenticatedState(),
      vault: {
        status: "unlocked",
        dekBase64: "a2V5",
        epoch: 1,
        wrapRevision: 1,
      },
      changeVaultPassphrase: changeVaultPassphraseMock,
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    expect(
      tree!.root.findAllByProps({ placeholder: "현재 동기화 암호" }),
    ).toHaveLength(0);
    await act(async () => {
      findPressableByText(tree!.root, "암호 변경").props.onPress();
    });

    let modal = tree!.root.findByType(Modal);
    let currentInput = modal.findByProps({
      placeholder: "현재 동기화 암호",
    });
    await act(async () => {
      currentInput.props.onChangeText("current-passphrase");
      findPressableByText(modal, "취소").props.onPress();
    });

    expect(tree!.root.findAllByType(Modal)).toHaveLength(0);
    await act(async () => {
      findPressableByText(tree!.root, "암호 변경").props.onPress();
    });
    modal = tree!.root.findByType(Modal);
    currentInput = modal.findByProps({ placeholder: "현재 동기화 암호" });
    expect(currentInput.props.value).toBe("");

    await act(async () => {
      currentInput.props.onChangeText("current-passphrase");
      modal
        .findByProps({ placeholder: "새 동기화 암호" })
        .props.onChangeText("next-passphrase");
      modal
        .findByProps({ placeholder: "새 동기화 암호 확인" })
        .props.onChangeText("next-passphrase");
    });
    modal = tree!.root.findByType(Modal);
    await act(async () => {
      findPressableByText(modal, "암호 변경").props.onPress();
      await Promise.resolve();
    });

    expect(changeVaultPassphraseMock).toHaveBeenCalledWith(
      "current-passphrase",
      "next-passphrase",
    );
    expect(tree!.root.findAllByType(Modal)).toHaveLength(0);
    expect(alertSpy).toHaveBeenCalledWith("동기화 암호 변경 완료");

    alertSpy.mockRestore();
    await act(async () => {
      useMobileAppStore.setState({
        changeVaultPassphrase: originalChangeVaultPassphrase,
      });
      tree!.unmount();
    });
  });
});
