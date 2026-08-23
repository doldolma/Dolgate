import React from "react";
import renderer, { act } from "react-test-renderer";
import { Alert, Modal, Platform, ScrollView, Text, TextInput } from "react-native";
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
const mockSetParams = jest.fn();
// 홈 검색의 "설정 — 보안" 같은 항목이 넘겨 주는 라우트 파라미터. 기본은 비어 있다.
let mockRoute: { params?: { section?: string } } = { params: undefined };
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
    setParams: mockSetParams,
  }),
  useRoute: () => mockRoute,
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
jest.mock("../src/lib/in-app-browser", () => ({
  openInAppBrowser: jest.fn(async () => undefined),
  closeInAppBrowser: jest.fn(async () => undefined),
}));

const { openInAppBrowser: openInAppBrowserMock } = jest.requireMock(
  "../src/lib/in-app-browser",
) as { openInAppBrowser: jest.Mock };

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
    mockSetParams.mockReset();
    mockRoute = { params: undefined };
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

  // 30초 폴링이 syncStatus 를 ready→syncing→ready 로 돌린다. 동기화 행을 조건부로 언마운트하면
  // 그때마다 카드 높이가 바뀌어 화면이 흔들린다 — 행은 남고 값만 바뀌어야 한다.
  it("shows the app version and keeps the sync row mounted while syncing", async () => {
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
    // 버전은 그룹 리스트의 값 행이라 라벨과 값이 각각 그려진다.
    expect(text).toContain("버전");
    expect(text).toContain(APP_VERSION);
    // 동기화 중에도 행은 그대로 있고 값만 "동기화 중" 이 된다.
    expect(text).toContain("동기화");
    expect(text).toContain("동기화 중");

    await act(async () => {
      tree!.unmount();
    });
  });

  // 심사 가이드라인 5.1.1(i) 은 스토어 메타데이터 URL 과 별개로 "앱 안에서 쉽게 접근"을
  // 요구한다. 로그인해야 쓰는 앱이라 로그인 전 화면(서버 설정)에서도 닿아야 한다.
  it("changes the theme from the settings picker", async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    // 기본은 기기 외형을 따르고, 고른 값이 그대로 행에 보여야 한다 — 고르는 자리가
    // 없어서 다크로 바꿀 방법이 없던 것이 이 테스트가 지키는 것이다.
    expect(useMobileAppStore.getState().settings.theme).toBe("system");
    const themeRow = findPressableByText(tree!.root, "시스템 설정 따르기");
    await act(async () => {
      themeRow.props.onPress();
    });

    // 시트 뒤 배경도 눌리는 요소이고 시트 전체 문구를 품고 있으므로, 문구가 정확히
    // 일치하는 가장 안쪽 항목을 골라야 한다.
    const darkOption = tree!.root
      .findAll(
        (node) =>
          typeof node.props.onPress === "function" &&
          collectText(node).trim() === "어둡게",
      )
      .slice(-1)[0];
    await act(async () => {
      darkOption.props.onPress();
    });

    expect(useMobileAppStore.getState().settings.theme).toBe("dark");
    expect(tree!.root.findAllByType(Modal).length).toBe(0);
    findPressableByText(tree!.root, "어둡게");

    await act(async () => {
      tree!.unmount();
    });
  });

  it("opens the privacy policy from both the settings tab and the pre-login screen", async () => {
    useMobileAppStore.setState({ auth: createAuthenticatedState() });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    await act(async () => {
      findPressableByText(tree!.root, "개인정보 처리방침").props.onPress();
    });

    expect(openInAppBrowserMock).toHaveBeenCalledWith(
      "https://github.com/doldolma/dolgate/blob/main/PRIVACY.md",
    );

    await act(async () => {
      tree!.unmount();
    });

    openInAppBrowserMock.mockClear();
    resetStore();

    let authTree: renderer.ReactTestRenderer;
    await act(async () => {
      authTree = renderer.create(<AuthSettingsScreen />);
    });

    await act(async () => {
      findPressableByText(authTree!.root, "개인정보 처리방침").props.onPress();
    });

    expect(openInAppBrowserMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      authTree!.unmount();
    });
  });

  // 로그아웃은 이 기기의 시크릿·볼트 키·호스트까지 지운다. 목록 행이라 잘못 눌리기 쉬우므로
  // 확인 없이 실행되면 안 된다.
  it("signs out only after confirming", async () => {
    const originalLogout = useMobileAppStore.getState().logout;
    const logoutMock = jest.fn(async () => undefined);
    useMobileAppStore.setState({
      auth: createAuthenticatedState(),
      logout: logoutMock,
    });
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    await act(async () => {
      findPressableByText(tree!.root, "로그아웃").props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe("로그아웃할까요?");
    expect(logoutMock).not.toHaveBeenCalled();

    const confirmButton = alertSpy.mock.calls[0][2]?.find(
      (button) => button.style === "destructive",
    );
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton?.onPress?.();
    });

    expect(logoutMock).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
    await act(async () => {
      useMobileAppStore.setState({ logout: originalLogout });
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
  it("scrolls to the section the home search asked for and clears the parameter", async () => {
    useMobileAppStore.setState({ auth: createAuthenticatedState() });
    mockRoute = { params: { section: "security" } };

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SettingsScreen />);
    });

    const scrollView = tree!.root.findByType(ScrollView);
    const scrollTo = jest.fn();
    // ScrollView 의 ref 는 테스트 렌더러에서 비어 있다 — 화면이 실제로 부르는 메서드만 심는다.
    scrollView.instance.scrollTo = scrollTo;

    // 그룹이 배치되기 전에는 갈 곳을 모른다. onLayout 이 오고 나서야 스크롤한다.
    expect(scrollTo).not.toHaveBeenCalled();

    // 그룹마다 다른 y 를 준다 — 아무 데나 스크롤해도 통과하는 시험이 되지 않게.
    // 같은 onLayout 이 컴포넌트·View·호스트 뷰 세 겹으로 잡힌다 — 호스트 뷰만 남긴다.
    const groups = tree!.root.findAll(
      (node) =>
        typeof node.props.onLayout === "function" &&
        typeof node.type === "string",
    );
    // SettingsGroup 은 머리글 Text 를 맨 앞에 렌더한다.
    const securityIndex = groups.findIndex((node) => {
      const [header] = node.findAllByType(Text);
      return header ? collectText(header) === "보안" : false;
    });
    expect(securityIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      groups.forEach((node, index) => {
        node.props.onLayout({
          nativeEvent: {
            layout: { x: 0, y: (index + 1) * 400, width: 320, height: 200 },
          },
        });
      });
    });

    // 머리글이 화면 맨 위에 붙지 않게 12 만큼 위를 남긴다.
    expect(scrollTo).toHaveBeenCalledWith({
      y: (securityIndex + 1) * 400 - 12,
      animated: true,
    });
    // 파라미터를 비워 두지 않으면 다음에 탭으로 들어와도 이 섹션으로 끌려간다.
    expect(mockSetParams).toHaveBeenCalledWith({ section: undefined });

    await act(async () => {
      tree!.unmount();
    });
  });
});
