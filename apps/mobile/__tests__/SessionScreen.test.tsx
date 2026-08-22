import React from 'react';
import { Buffer } from 'buffer';
import renderer, { act } from 'react-test-renderer';
import { Keyboard, Platform, StyleSheet, Text } from 'react-native';
import type {
  AwsEc2HostRecord,
  AuthState,
  MobileSessionRecord,
  MobileSftpSessionRecord,
  MobileRemoteDesktopSessionRecord,
  SshHostRecord,
} from '@dolssh/shared-core';
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
} from '../src/lib/mobile';
import {
  TERMINAL_PRIMARY_SHORTCUTS,
  TERMINAL_SECONDARY_SHORTCUTS,
} from '../src/lib/terminal-input';
import { SessionScreen } from '../src/screens/SessionScreen';
import { useMobileAppStore } from '../src/store/useMobileAppStore';
import { getPalette } from '../src/theme';

const mockNavigationGoBack = jest.fn();
const mockNavigationCanGoBack = jest.fn(() => true);
const mockNavigationNavigate = jest.fn();
let mockScreenFocused = true;
const mockSetOrientationUnlocked = jest.fn<Promise<void>, [boolean]>(
  async () => undefined,
);

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockNavigationGoBack,
    canGoBack: mockNavigationCanGoBack,
    navigate: mockNavigationNavigate,
  }),
  useIsFocused: () => mockScreenFocused,
}));
jest.mock('react-native-vector-icons/Ionicons', () => 'Ionicons');
let mockCapturedXtermProps: Record<string, unknown> | null = null;
let mockNativeTerminalInputHandle: {
  focus: jest.Mock;
  blur: jest.Mock;
} | null = null;
let mockTerminalHandle: {
  write: jest.Mock;
  writeMany: jest.Mock;
  flush: jest.Mock;
  clear: jest.Mock;
  focus: jest.Mock;
  blur: jest.Mock;
  resize: jest.Mock;
  fit: jest.Mock;
} | null = null;
const keyboardListeners = new Map<string, Set<(event?: unknown) => void>>();
const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');

function setPlatformOs(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    get: () => os,
  });
}

function emitKeyboardEvent(
  name: string,
  event?: { endCoordinates?: { height?: number } },
) {
  const listeners = keyboardListeners.get(name);
  if (!listeners) {
    return;
  }

  for (const listener of [...listeners]) {
    listener(event);
  }
}

jest.mock('@fressh/react-native-xtermjs-webview', () => {
  const mockReact = require('react') as typeof React;
  return {
    XtermJsWebView: mockReact.forwardRef(
      (
        props: {
          onInitialized?: () => void;
          webViewOptions?: Record<string, unknown>;
        },
        ref: React.ForwardedRef<unknown>,
      ) => {
        mockCapturedXtermProps = props as Record<string, unknown>;
        mockReact.useImperativeHandle(ref, () => mockTerminalHandle, []);
        mockReact.useEffect(() => {
          props.onInitialized?.();
        }, [props.onInitialized]);
        return null;
      },
    ),
  };
});
const mockOpenInAppBrowser = jest.fn<Promise<void>, [string]>(
  async () => undefined,
);
jest.mock('../src/lib/in-app-browser', () => ({
  openInAppBrowser: (url: string) => mockOpenInAppBrowser(url),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));
jest.mock('../src/components/TerminalInputView', () => {
  const mockReact = require('react') as typeof React;
  return {
    TerminalInputView: mockReact.forwardRef(
      (props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
        mockReact.useImperativeHandle(
          ref,
          () => mockNativeTerminalInputHandle,
          [],
        );
        return mockReact.createElement('TerminalInputView', props);
      },
    ),
  };
});
jest.mock('../src/lib/screen-layout', () => ({
  useScreenPadding: () => ({
    paddingHorizontal: 0,
    paddingTop: 16,
    paddingBottom: 12,
  }),
}));
jest.mock('react-native-safe-area-context', () => {
  const insets = { top: 0, bottom: 24, left: 0, right: 0 };
  return {
    useSafeAreaInsets: () => insets,
    // 컨텍스트를 직접 읽는 화면도 있다(RemoteDesktopSurface). 훅만 흉내내면 그쪽이 죽는다.
    SafeAreaInsetsContext: (require('react') as typeof React).createContext(
      insets,
    ),
  };
});

jest.mock('@dolssh/react-native-remote-desktop', () => {
  const mockReact = require('react') as typeof React;
  return {
    RemoteDesktopView: (props: any) =>
      mockReact.createElement('RemoteDesktopView', props),
    nativeSetActive: jest.fn(async () => undefined),
    setOrientationUnlocked: (unlocked: boolean) =>
      mockSetOrientationUnlocked(unlocked),
    nativePointerMove: jest.fn(),
    nativePointerButton: jest.fn(),
    nativeScroll: jest.fn(),
    nativeKeyEvent: jest.fn(),
    nativeRefresh: jest.fn(async () => undefined),
  };
});

function collectText(
  node:
    | renderer.ReactTestRendererJSON
    | renderer.ReactTestRendererJSON[]
    | null,
): string[] {
  if (!node) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(child => collectText(child));
  }

  return (node.children ?? []).flatMap(child => {
    if (typeof child === 'string') {
      return [child];
    }
    return collectText(child);
  });
}

function formatExpectedModifiedTime(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createAuthenticatedState(): AuthState {
  return {
    status: 'authenticated',
    session: {
      user: {
        id: 'user-1',
        email: 'mobile@example.com',
      },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresInSeconds: 900,
      },
      vaultBootstrap: {
        keyBase64: 'a2V5',
      },
      offlineLease: {
        token: 'offline-token',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationPublicKeyPem: 'public-key',
      },
      syncServerTime: new Date().toISOString(),
    },
    offline: null,
    errorMessage: null,
  };
}

describe('SessionScreen', () => {
  const session: MobileSessionRecord = {
    id: 'session-1',
    sessionId: 'session-1',
    hostId: 'host-1',
    title: 'Synology',
    status: 'connected',
    hasReceivedOutput: true,
    isRestorable: true,
    lastViewportSnapshot: 'prompt',
    lastEventAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
    lastDisconnectedAt: null,
    errorMessage: null,
  };

  const secondSession: MobileSessionRecord = {
    id: 'session-2',
    sessionId: 'session-2',
    hostId: 'host-2',
    title: 'Docker-ubuntu',
    status: 'connecting',
    hasReceivedOutput: false,
    isRestorable: true,
    lastViewportSnapshot: '',
    lastEventAt: new Date(Date.now() - 1_000).toISOString(),
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    errorMessage: null,
  };

  const hosts: SshHostRecord[] = [
    {
      id: 'host-1',
      kind: 'ssh',
      label: 'Synology',
      hostname: 'doldolma.com',
      port: 2788,
      username: 'doyoung',
      authType: 'password',
      secretRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'host-2',
      kind: 'ssh',
      label: 'Docker-ubuntu',
      hostname: 'docker.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password',
      secretRef: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    jest.useFakeTimers();
    setPlatformOs('ios');
    mockNavigationGoBack.mockReset();
    mockNavigationCanGoBack.mockReset();
    mockNavigationCanGoBack.mockReturnValue(true);
    mockNavigationNavigate.mockReset();
    mockScreenFocused = true;
    mockSetOrientationUnlocked.mockClear();
    keyboardListeners.clear();
    jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation((eventName, listener) => {
        const typedListener = listener as (event?: unknown) => void;
        const listeners = keyboardListeners.get(eventName) ?? new Set();
        listeners.add(typedListener);
        keyboardListeners.set(eventName, listeners);
        return {
          remove: () => {
            listeners.delete(typedListener);
          },
        } as ReturnType<typeof Keyboard.addListener>;
      });
    mockCapturedXtermProps = null;
    mockNativeTerminalInputHandle = {
      focus: jest.fn(),
      blur: jest.fn(),
    };
    mockTerminalHandle = {
      write: jest.fn(),
      writeMany: jest.fn(),
      flush: jest.fn(),
      clear: jest.fn(),
      focus: jest.fn(),
      blur: jest.fn(),
      resize: jest.fn(),
      fit: jest.fn(),
    };
    act(() => {
      useMobileAppStore.setState({
        hydrated: true,
        bootstrapping: false,
        authGateResolved: true,
        secureStateReady: true,
        auth: createAuthenticatedState(),
        settings: {
          ...createDefaultMobileSettings(),
          theme: 'dark',
        },
        syncStatus: createDefaultSyncStatus(),
        groups: [],
        hosts,
        knownHosts: [],
        secretMetadata: [],
        sessions: [session, secondSession],
        sftpSessions: [],
        sftpTransfers: [],
        sftpCopyBuffer: null,
        remoteDesktopSessions: [],
        activeSessionTabId: 'session-1',
        activeConnectionTab: { kind: 'terminal', id: 'session-1' },
        secretsByRef: {},
        pendingBrowserLoginState: null,
        pendingServerKeyPrompt: null,
        pendingCredentialPrompt: null,
        resumeSession: jest.fn(async () => 'session-1'),
        duplicateSession: jest.fn(async () => 'session-copy'),
        disconnectSession: jest.fn(async () => undefined),
        writeToSession: jest.fn(async () => undefined),
        subscribeToSessionTerminal: jest.fn(() => () => undefined),
        setActiveConnectionTab: jest.fn(),
        setActiveSessionTab: jest.fn(),
        openSftpForSession: jest.fn(async () => 'sftp-1'),
        disconnectSftpSession: jest.fn(async () => undefined),
        listSftpDirectory: jest.fn(async () => undefined),
        downloadSftpFile: jest.fn(async () => undefined),
        downloadSftpEntries: jest.fn(async () => undefined),
        uploadSftpFile: jest.fn(async () => undefined),
        createSftpDirectory: jest.fn(async () => undefined),
        renameSftpEntry: jest.fn(async () => undefined),
        chmodSftpEntry: jest.fn(async () => undefined),
        deleteSftpEntries: jest.fn(async () => undefined),
        copySftpEntries: jest.fn(),
        pasteSftpEntries: jest.fn(async () => undefined),
        clearSftpCopyBuffer: jest.fn(),
        updateRemoteDesktopSession: jest.fn(),
        disconnectRemoteDesktopSession: jest.fn(async () => undefined),
      });
    });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (platformOsDescriptor) {
      Object.defineProperty(Platform, 'OS', platformOsDescriptor);
    }
  });

  it('renders the live session tabs and hides the old detail header controls', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain('Synology');
    expect(text).toContain('Docker-ubuntu');
    expect(text).not.toContain('키보드');
    expect(text).toContain('더보기');
    expect(text).not.toContain('Backspace');
    expect(text).not.toContain('Connected');
    expect(text).not.toContain('세션 뒤로가기');
    expect(text).not.toContain('세션 메뉴 열기');
    expect(mockCapturedXtermProps).not.toBeNull();
    expect(mockCapturedXtermProps?.webViewOptions).toMatchObject({
      hideKeyboardAccessoryView: true,
    });
    expect(
      tree!.root.findByProps({
        accessibilityLabel: '키보드 열기',
      }),
    ).toBeDefined();

    await act(async () => {
      tree!.unmount();
    });
  });

  // 탭은 연 순서로 늘어서고 그 뒤로 움직이지 않아야 한다. 종류별로 이어 붙이면 SFTP 뒤에 연
  // 터미널이 SFTP 앞으로 끼어들고, SFTP 를 활동 순으로 재정렬하면 목록을 새로 읽을 때마다
  // 탭이 튄다 — 두 경우 모두 여기서 막는다.
  // 배너는 터미널에 찍는다 — OpenSSH 가 하는 것과 같고, 데스크톱도 그렇게 한다. 패널에 글로
  // 두면 링크를 누를 수 없다(URL 을 찾는 일은 xterm 의 web-links 애드온이 한다).
  //
  // 화면이 배너를 직접 쓰지는 않는다. 스토어의 onBanner 가 세션 스냅샷에 합쳐 두고
  // (lib/terminal-banner) 화면은 그 스냅샷을 그린다 — 그래야 활성 탭이 아닌 세션의
  // 배너도 살아남고, 스냅샷 복원이 화면을 지울 때 같이 지워지지 않는다.
  it('writes the server banner into the terminal', async () => {
    const BANNER_URL = 'https://login.example.com/a/abc';
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          {
            ...session,
            lastViewportSnapshot: `To authenticate, visit: ${BANNER_URL}\r\n`,
          },
          secondSession,
        ],
        connectionViews: {
          'session-1': {
            hostId: 'host-1',
            hasTailnet: false,
            banner: `To authenticate, visit: ${BANNER_URL}`,
          },
        },
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const written = (mockTerminalHandle?.write.mock.calls ?? [])
      .map(call => Buffer.from(call[0] as Uint8Array).toString('utf8'))
      .join('');
    expect(written).toContain(BANNER_URL);
    // 패널이 같은 글을 또 보여주면 화면에 두 번 뜬다.
    expect(collectText(tree!.toJSON())).not.toContain('login.example.com');

    await act(async () => {
      tree!.unmount();
    });
  });

  // 탭을 옮겼다 돌아오면 스냅샷을 다시 그린다. 그때 화면을 먼저 지우므로 배너가 두 번
  // 쌓이지 않는다 — 덧쓰기가 되면 같은 안내가 화면에 겹쳐 보인다.
  it('redraws the banner from the snapshot without stacking it', async () => {
    const BANNER_URL = 'https://login.example.com/a/abc';
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          {
            ...session,
            lastViewportSnapshot: `approve at ${BANNER_URL}\r\n`,
          },
          secondSession,
        ],
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      useMobileAppStore.setState({
        activeConnectionTab: { kind: 'terminal', id: 'session-2' },
      });
    });
    await act(async () => {
      useMobileAppStore.setState({
        activeConnectionTab: { kind: 'terminal', id: 'session-1' },
      });
    });

    const writes = (mockTerminalHandle?.write.mock.calls ?? []).map(call =>
      Buffer.from(call[0] as Uint8Array).toString('utf8'),
    );
    // 배너를 담은 쓰기마다 그 직전에 화면 초기화가 있어야 한다.
    for (const [index, text] of writes.entries()) {
      if (!text.includes('login.example.com')) {
        continue;
      }
      const preceding = writes.slice(0, index).join('');
      expect(preceding).toMatch(/\x1b\[2J|\x1bc/);
    }
    expect(writes.join('')).toContain(BANNER_URL);

    await act(async () => {
      tree!.unmount();
    });
  });

  // 애드온이 링크를 찾아 올려주면 앱이 어디서 열지 정한다. 페이지가 직접 열면 WebView 가 그
  // 주소로 이동해 터미널이 사라진다 — 세션도 함께 죽는다.
  it('opens a tapped terminal link in the in-app browser', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const onLinkActivated = mockCapturedXtermProps?.onLinkActivated as
      | ((uri: string) => void)
      | undefined;
    expect(onLinkActivated).toBeInstanceOf(Function);

    await act(async () => {
      onLinkActivated?.('https://ubuntu.com/pro');
    });

    expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://ubuntu.com/pro');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('orders tabs by the time they were opened, mixing terminal and SFTP', async () => {
    const openedAt = (offsetMs: number) =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          {
            ...session,
            id: 'session-1',
            title: 'First',
            openedAt: openedAt(0),
          },
          // 나중에 연 터미널 — SFTP 보다 뒤에 와야 한다.
          {
            ...secondSession,
            id: 'session-2',
            title: 'Third',
            openedAt: openedAt(2000),
          },
        ],
        sftpSessions: [
          {
            id: 'sftp-1',
            hostId: 'host-1',
            sourceSessionId: 'session-1',
            title: 'Second SFTP',
            status: 'connected',
            currentPath: '.',
            listing: null,
            connectionStatusMessage: null,
            errorMessage: null,
            openedAt: openedAt(1000),
            // 활동이 가장 최근이다 — 활동 순으로 정렬하면 이 탭이 앞으로 튄다.
            lastEventAt: openedAt(9000),
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
          {
            id: 'sftp-2',
            hostId: 'host-2',
            sourceSessionId: 'session-2',
            title: 'Fourth SFTP',
            status: 'connected',
            currentPath: '.',
            listing: null,
            connectionStatusMessage: null,
            errorMessage: null,
            openedAt: openedAt(3000),
            lastEventAt: openedAt(1000),
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
        ],
        activeSessionTabId: 'session-1',
        activeConnectionTab: { kind: 'terminal', id: 'session-1' },
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const text = collectText(tree!.toJSON());
    expect(text.indexOf('First')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second SFTP'));
    expect(text.indexOf('Second SFTP')).toBeLessThan(text.indexOf('Third'));
    expect(text.indexOf('Third')).toBeLessThan(text.indexOf('Fourth SFTP'));

    await act(async () => {
      tree!.unmount();
    });
  });

  it('uses iOS edge-swipe to return to the previous tab without closing sessions', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const { disconnectSession, disconnectSftpSession } =
      useMobileAppStore.getState();
    await act(async () => {
      tree!.root
        .findByProps({ testID: 'ios-edge-swipe-back' })
        .props.onTouchEnd();
    });

    expect(mockNavigationCanGoBack).toHaveBeenCalled();
    expect(mockNavigationGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigationNavigate).not.toHaveBeenCalled();
    expect(disconnectSession).not.toHaveBeenCalled();
    expect(disconnectSftpSession).not.toHaveBeenCalled();

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it('falls back to Home when iOS edge-swipe has no tab history', async () => {
    mockNavigationCanGoBack.mockReturnValue(false);
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    await act(async () => {
      tree!.root
        .findByProps({ testID: 'ios-edge-swipe-back' })
        .props.onTouchEnd();
    });

    expect(mockNavigationGoBack).not.toHaveBeenCalled();
    expect(mockNavigationNavigate).toHaveBeenCalledWith('Home');

    await act(async () => {
      jest.runOnlyPendingTimers();
      tree!.unmount();
    });
  });

  it('expands and collapses the secondary keyboard shortcut row', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const expandButton = tree!.root.findByProps({
      accessibilityLabel: '추가 제어키 표시',
    });

    await act(async () => {
      expandButton.props.onPress();
    });

    expect(collectText(tree!.toJSON())).toContain('Backspace');
    expect(collectText(tree!.toJSON())).toContain(':');
    expect(collectText(tree!.toJSON())).toContain('!');
    expect(collectText(tree!.toJSON())).toContain('Ctrl+Z');

    const collapseButton = tree!.root.findByProps({
      accessibilityLabel: '추가 제어키 숨기기',
    });

    await act(async () => {
      collapseButton.props.onPress();
    });

    expect(collectText(tree!.toJSON())).not.toContain('Backspace');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('makes the selected tab visually distinct without reusing the session status color', async () => {
    const palette = getPalette('dark', 'dark');
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const activeTab = tree!.root.findByProps({
      accessibilityLabel: 'Synology Connected 세션 탭',
    });
    const inactiveTab = tree!.root.findByProps({
      accessibilityLabel: 'Docker-ubuntu Connecting 세션 탭',
    });

    const activeTabStyle = StyleSheet.flatten(activeTab.props.style);
    const inactiveTabStyle = StyleSheet.flatten(inactiveTab.props.style);

    expect(activeTab.props.accessibilityState).toEqual({ selected: true });
    expect(inactiveTab.props.accessibilityState).toEqual({ selected: false });
    expect(activeTabStyle.backgroundColor).toBe(palette.accentSoft);
    expect(activeTabStyle.borderColor).toBe(palette.accent);
    expect(activeTabStyle.borderWidth).toBe(2);
    expect(inactiveTabStyle.backgroundColor).toBe(palette.surfaceAlt);
    expect(inactiveTabStyle.borderColor).toBe(palette.sessionToolbarBorder);
    expect(inactiveTabStyle.borderWidth).toBe(1);

    const activeTabTitle = activeTab.findByType(Text);
    const activeTitleStyle = StyleSheet.flatten(activeTabTitle.props.style);
    expect(activeTitleStyle.color).toBe(palette.text);
    expect(activeTitleStyle.fontWeight).toBe('800');

    await act(async () => {
      tree!.unmount();
    });
  });

  // OS 가 백그라운드 프로세스를 회수하면 세션이 closed 로 정규화되고 탭에서 사라진다.
  // 사용자가 다시 붙을 수 있도록 빈 상태에 재연결 목록을 남겨야 한다.
  it('offers reconnect for sessions closed by a cold start', async () => {
    const resumeSession = jest.fn(async () => 'session-1');
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          { ...session, status: 'closed', isRestorable: true },
          { ...secondSession, status: 'closed', isRestorable: false },
        ],
        resumeSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const reconnect = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 재연결',
    });

    // 복원 불가 세션은 노출하지 않는다.
    expect(() =>
      tree!.root.findByProps({
        accessibilityLabel: 'Docker-ubuntu 세션 재연결',
      }),
    ).toThrow();

    await act(async () => {
      reconnect.props.onPress();
    });

    expect(resumeSession).toHaveBeenCalledWith('session-1');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('renders the native terminal input overlay on iOS', async () => {
    // iOS도 네이티브 입력 오버레이를 쓴다 — WebView(xterm) 직접 입력은 한글 IME 조합이
    // 깨져 자모가 분리되기 때문(SessionScreen.useTerminalInputOverlay 참고).
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const nativeInputs = tree!.root.findAll(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInputs).toHaveLength(1);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('routes iOS terminal input directly from the xterm webview', async () => {
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    await act(async () => {
      (
        mockCapturedXtermProps?.onData as ((data: string) => void) | undefined
      )?.('ls');
    });

    expect(writeToSession).toHaveBeenLastCalledWith('session-1', 'ls');
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  // 출력이 흐르는 동안 세션 레코드는 750ms 마다 새 객체로 바뀐다(스냅샷 플러시). 그때마다
  // fit() 을 다시 부르면 안드로이드에서는 이미 떠 있는 IME 를 다시 띄우게 되어 화면이 깜빡였다
  // — 실기기에서 "3~4글자마다 한 번" 으로 보였다. 세션 id 가 그대로면 다시 맞출 이유가 없다.
  it('does not refit the terminal when only the session snapshot changes', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    // 마운트 때 한 번 맞추는 것은 정상이다 — 여기서부터 세 본다.
    expect(mockTerminalHandle!.fit).toHaveBeenCalled();
    mockTerminalHandle!.fit.mockClear();

    // 같은 세션의 스냅샷·활동 시각만 바뀐 경우(= 타이핑 중 플러시).
    await act(async () => {
      useMobileAppStore.setState(state => ({
        sessions: state.sessions.map(item =>
          item.id === 'session-1'
            ? {
                ...item,
                lastViewportSnapshot: `${item.lastViewportSnapshot}x`,
                lastEventAt: new Date(Date.now() + 1_000).toISOString(),
              }
            : item,
        ),
      }));
      jest.runOnlyPendingTimers();
    });
    // 이펙트는 act 가 끝날 때 흘러 rAF 를 예약한다. 그 rAF 까지 돌려야 fit 이 불렸는지 볼 수 있다.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(mockTerminalHandle!.fit).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  /**
   * 트립와이어 — 출력이 흐를 때 세션 레코드가 갱신되는 것만으로 **터미널에 아무 일도
   * 일어나지 않아야 한다.**
   *
   * 이 규칙이 깨진 것을 지금까지 세 번 고쳤다: 터미널 옵션 신원(73e57335), 주기적 fit
   * (26a6e460), 화면 클리어(이슈 #1). 매번 "그 이펙트의 의존성을 좁힌다" 로 대응했으므로,
   * 새 이펙트가 같은 실수를 하면 또 재발한다. 개별 증상이 아니라 **경로 전체**를 여기서 막는다.
   */
  it('touches nothing in the terminal when only session activity changes', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    function focusToken() {
      const input = tree!.root.findAll(
        node => (node.type as unknown) === 'TerminalInputView',
      )[0];
      return input?.props.focusToken as number | undefined;
    }

    // 마운트 때 하는 일(클리어·리플레이·fit·포커스)은 정상이다 — 여기서부터 센다.
    const tokenBefore = focusToken();
    mockTerminalHandle!.write.mockClear();
    mockTerminalHandle!.writeMany.mockClear();
    mockTerminalHandle!.fit.mockClear();
    mockNativeTerminalInputHandle!.focus.mockClear();

    // 출력이 흐르는 동안 스토어가 하는 일: 스냅샷과 활동 시각만 바뀐다.
    await act(async () => {
      useMobileAppStore.setState(state => ({
        sessions: state.sessions.map(item =>
          item.id === 'session-1'
            ? {
                ...item,
                lastViewportSnapshot: `${item.lastViewportSnapshot}x`,
                lastEventAt: new Date(Date.now() + 1_000).toISOString(),
              }
            : item,
        ),
      }));
      jest.runOnlyPendingTimers();
    });
    // 이펙트는 rAF 안에서 일하는 것도 있다. 그것까지 흘려보낸 뒤에 센다.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(mockTerminalHandle!.write).not.toHaveBeenCalled();
    expect(mockTerminalHandle!.writeMany).not.toHaveBeenCalled();
    expect(mockTerminalHandle!.fit).not.toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();
    expect(focusToken()).toBe(tokenBefore);

    await act(async () => {
      tree!.unmount();
    });
  });

  /**
   * 이슈 #1 의 본체 — 출력이 흐르는 동안 화면 전체가 주기적으로 번쩍였다.
   *
   * 터미널 출력 구독 이펙트가 세션 레코드를 의존성에 두고 있었다. 그 이펙트는 다시 돌 때마다
   * 구독을 끊고 **화면을 지운다**(ESC[3J ESC[2J ESC[H — 스크롤백까지). 레코드는 스냅샷
   * 플러시마다 새 객체가 되므로, 750ms 마다 "지우고 리플레이로 되그리기"가 반복됐다. 키보드와
   * 무관하고(그래서 키보드를 내려도 보였다), 에뮬레이터에서는 한 프레임에 끝나 안 보였다.
   */
  it('does not clear the terminal when only the session snapshot changes', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    // 마운트 때 한 번 지우고 리플레이하는 것은 정상이다 — 여기서부터 센다.
    mockTerminalHandle!.write.mockClear();

    await act(async () => {
      useMobileAppStore.setState(state => ({
        sessions: state.sessions.map(item =>
          item.id === 'session-1'
            ? {
                ...item,
                lastViewportSnapshot: `${item.lastViewportSnapshot}x`,
                lastEventAt: new Date(Date.now() + 1_000).toISOString(),
              }
            : item,
        ),
      }));
      jest.runOnlyPendingTimers();
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    // 화면 클리어 시퀀스가 다시 나가면 그것이 번쩍임이다.
    const reset = Buffer.from('\u001b[3J\u001b[2J\u001b[H', 'utf8').toString();
    const wroteReset = mockTerminalHandle!.write.mock.calls.some(call => {
      const payload = call[0] as Uint8Array | undefined;
      return payload ? Buffer.from(payload).toString() === reset : false;
    });
    expect(wroteReset).toBe(false);

    await act(async () => {
      tree!.unmount();
    });
  });

  /**
   * 이슈 #1 — 태블릿에서 화면 전체가 0.6~1.3초 간격으로 한 프레임 번쩍였다.
   *
   * 그 주기는 스냅샷 플러시(750ms)다. 세션 레코드를 의존성에 둔 이펙트가 그때마다 포커스를
   * 다시 요청했고, 포커스 토큰이 올라가면 네이티브 입력 뷰가 showSoftInput 을 다시 부른다 —
   * 이미 떠 있는 IME 가 다시 뜨며 창 전체가 재배치되는 것이 그 번쩍임이었다. claude-code·htop
   * 처럼 출력이 끊이지 않는 화면에서 계속 보였고, 하드웨어 키보드를 쓰는 에뮬레이터에서는
   * 보이지 않았다.
   */
  it('does not re-request input focus when only the session snapshot changes', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    function focusToken() {
      const input = tree!.root.findAll(
        node => (node.type as unknown) === 'TerminalInputView',
      )[0];
      return input?.props.focusToken as number | undefined;
    }

    // 마운트 때 한 번 잡는 것은 정상이다 — 여기서부터 센다.
    const tokenBefore = focusToken();
    mockNativeTerminalInputHandle!.focus.mockClear();

    // 출력이 흐를 때 벌어지는 일: 스냅샷과 활동 시각만 바뀐 새 레코드.
    await act(async () => {
      useMobileAppStore.setState(state => ({
        sessions: state.sessions.map(item =>
          item.id === 'session-1'
            ? {
                ...item,
                lastViewportSnapshot: `${item.lastViewportSnapshot}x`,
                lastEventAt: new Date(Date.now() + 1_000).toISOString(),
              }
            : item,
        ),
      }));
      jest.runOnlyPendingTimers();
    });
    // 이펙트는 rAF 안에서 포커스를 잡는다. 그 rAF 까지 돌려야 안 잡혔음을 볼 수 있다.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(focusToken()).toBe(tokenBefore);
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  // 패키지는 옵션 변경을 **얕은 비교**로 판단한다(dist 의 ee: 키 한 겹). theme 이 중첩 객체라
  // 인라인으로 넘기면 렌더마다 비교가 실패해 WebView 로 setOptions 가 다시 나가고, xterm 은
  // theme 을 다시 세울 때 값이 같아도 전체를 다시 그린다 — 실기기에서 주기적 깜빡임으로 보였다.
  it('keeps terminal option identities stable across re-renders', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    const before = {
      xtermOptions: mockCapturedXtermProps?.xtermOptions,
      webViewOptions: mockCapturedXtermProps?.webViewOptions,
    };
    expect(before.xtermOptions).toBeDefined();
    expect(before.webViewOptions).toBeDefined();

    // 출력이 흐르는 동안 벌어지는 일: 스냅샷 플러시가 세션 레코드를 패치해 이 화면이 리렌더된다.
    await act(async () => {
      useMobileAppStore.setState(state => ({
        sessions: state.sessions.map(item =>
          item.id === 'session-1'
            ? {
                ...item,
                lastViewportSnapshot: `${item.lastViewportSnapshot}y`,
                lastEventAt: new Date(Date.now() + 2_000).toISOString(),
              }
            : item,
        ),
      }));
      jest.runOnlyPendingTimers();
    });

    expect(mockCapturedXtermProps?.xtermOptions).toBe(before.xtermOptions);
    expect(mockCapturedXtermProps?.webViewOptions).toBe(before.webViewOptions);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('toggles the iOS keyboard through the native terminal input overlay', async () => {
    const dismissKeyboard = jest
      .spyOn(Keyboard, 'dismiss')
      .mockImplementation(() => undefined);
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    mockTerminalHandle!.focus.mockClear();
    mockNativeTerminalInputHandle!.focus.mockClear();

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 열기',
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(mockNativeTerminalInputHandle!.focus).toHaveBeenCalled();
    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();

    mockTerminalHandle!.blur.mockClear();
    mockNativeTerminalInputHandle!.blur.mockClear();

    await act(async () => {
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
    });

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 닫기',
    });

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(dismissKeyboard).toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.blur).toHaveBeenCalled();
    expect(mockTerminalHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('does not try to reopen the iOS keyboard after a system dismiss event', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    mockTerminalHandle!.focus.mockClear();

    await act(async () => {
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
      emitKeyboardEvent('keyboardDidHide');
    });

    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 열기',
    });
    expect(openKeyboardButton).toBeDefined();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('focuses the iOS terminal when switching tabs after a manual close', async () => {
    const setActiveSessionTab = jest.fn();
    act(() => {
      useMobileAppStore.setState({
        setActiveSessionTab,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    await act(async () => {
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
    });

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 닫기',
    });

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    mockTerminalHandle!.focus.mockClear();
    mockNativeTerminalInputHandle!.focus.mockClear();

    const secondTab = tree!.root.findByProps({
      accessibilityLabel: 'Docker-ubuntu Connecting 세션 탭',
    });

    await act(async () => {
      secondTab.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(setActiveSessionTab).toHaveBeenCalledWith('session-2');
    expect(mockNativeTerminalInputHandle!.focus).toHaveBeenCalled();
    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('focuses the iOS terminal when retrying a failed session after a manual close', async () => {
    const resumeSession = jest.fn(async () => 'session-1');
    act(() => {
      useMobileAppStore.setState({
        sessions: [
          {
            ...session,
            status: 'error',
            errorMessage: '세션이 종료되었습니다.',
          },
          secondSession,
        ],
        resumeSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    await act(async () => {
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
    });

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 닫기',
    });

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    mockTerminalHandle!.focus.mockClear();
    mockNativeTerminalInputHandle!.focus.mockClear();

    const reconnectButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 재연결',
    });

    await act(async () => {
      await reconnectButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(resumeSession).toHaveBeenCalledWith('session-1');
    expect(mockNativeTerminalInputHandle!.focus).toHaveBeenCalled();
    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('adds keyboard inset to the session body so the toolbar can ride above the keyboard', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const screenBody = tree!.root.findByProps({
      testID: 'session-screen-body',
    });

    let screenBodyStyle = StyleSheet.flatten(screenBody.props.style);
    expect(screenBodyStyle.paddingBottom).toBe(56);

    await act(async () => {
      emitKeyboardEvent('keyboardWillShow', {
        endCoordinates: { height: 280 },
      });
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
    });

    const screenBodyNode = tree!.root.findByProps({
      testID: 'session-screen-body',
    });
    await act(async () => {
      tree!.root
        .findByProps({ testID: 'session-toolbar-shell' })
        .props.onLayout({
          nativeEvent: {
            layout: {
              height: 72,
            },
          },
        });
    });
    expect(screenBodyNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 352 })]),
    );
    screenBodyStyle = StyleSheet.flatten(screenBodyNode.props.style);
    expect(screenBodyStyle.paddingBottom).toBe(352);

    await act(async () => {
      emitKeyboardEvent('keyboardWillHide');
      emitKeyboardEvent('keyboardDidHide');
    });

    screenBodyStyle = StyleSheet.flatten(
      tree!.root.findByProps({ testID: 'session-screen-body' }).props.style,
    );
    expect(screenBodyStyle.paddingBottom).toBe(72);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('fits the terminal to the measured terminal viewport', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const terminalCard = tree!.root.findByProps({
      testID: 'session-terminal-card',
    });

    await act(async () => {
      terminalCard.props.onLayout({
        nativeEvent: {
          layout: {
            width: 360,
            height: 240,
          },
        },
      });
    });

    expect(mockTerminalHandle!.fit).toHaveBeenCalledTimes(1);

    await act(async () => {
      terminalCard.props.onLayout({
        nativeEvent: {
          layout: {
            width: 360,
            height: 180,
          },
        },
      });
    });

    expect(mockTerminalHandle!.fit).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('disconnects the tab from the tab overflow menu', async () => {
    const disconnectSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        disconnectSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 메뉴',
    });

    await act(async () => {
      await menuButton.props.onPress({ stopPropagation: jest.fn() });
    });

    const closeButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 닫기',
    });

    await act(async () => {
      await closeButton.props.onPress();
    });

    expect(disconnectSession).toHaveBeenCalledWith('session-1');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('duplicates the terminal session from the tab overflow menu', async () => {
    const duplicateSession = jest.fn(async () => 'session-copy');
    act(() => {
      useMobileAppStore.setState({
        duplicateSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 메뉴',
    });

    await act(async () => {
      await menuButton.props.onPress({ stopPropagation: jest.fn() });
    });

    const duplicateButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 복제',
    });

    await act(async () => {
      await duplicateButton.props.onPress();
    });

    expect(duplicateSession).toHaveBeenCalledWith('session-1');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('orders the terminal overflow menu as Duplicate, SFTP, Close', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 메뉴',
    });

    await act(async () => {
      await menuButton.props.onPress({ stopPropagation: jest.fn() });
    });

    const menuLabels = tree!.root
      .findAll(node => {
        if (node.type !== Text) {
          return false;
        }
        const child = node.props.children;
        return (
          typeof child === 'string' &&
          ['Duplicate', 'Connect via SFTP', 'Close'].includes(child)
        );
      })
      .map(node => {
        const child = String(node.props.children);
        return child === 'Duplicate'
          ? 'Synology 세션 복제'
          : child === 'Close'
            ? 'Synology 세션 닫기'
            : child;
      })
      .filter((label: unknown) =>
        [
          'Synology 세션 복제',
          'Connect via SFTP',
          'Synology 세션 닫기',
        ].includes(String(label)),
      );
    expect(menuLabels).toEqual([
      'Synology 세션 복제',
      'Connect via SFTP',
      'Synology 세션 닫기',
    ]);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('opens SSH SFTP from the terminal tab menu', async () => {
    const openSftpForSession = jest.fn(async () => 'sftp-1');
    act(() => {
      useMobileAppStore.setState({
        openSftpForSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 메뉴',
    });

    await act(async () => {
      menuButton.props.onPress({ stopPropagation: jest.fn() });
    });

    const sftpItem = tree!.root.findByProps({
      accessibilityLabel: 'Connect via SFTP',
    });

    await act(async () => {
      await sftpItem.props.onPress();
    });

    expect(openSftpForSession).toHaveBeenCalledWith('session-1');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('opens AWS SFTP from an AWS terminal tab menu', async () => {
    const awsHost: AwsEc2HostRecord = {
      id: 'host-aws',
      kind: 'aws-ec2',
      label: 'AWS EC2',
      awsProfileName: 'prod',
      awsRegion: 'ap-northeast-2',
      awsInstanceId: 'i-0123456789abcdef0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const awsSession: MobileSessionRecord = {
      ...session,
      id: 'session-aws',
      sessionId: 'session-aws',
      hostId: awsHost.id,
      title: awsHost.label,
      connectionKind: 'aws-ssm',
    };
    const openSftpForSession = jest.fn(async () => 'sftp-aws');
    act(() => {
      useMobileAppStore.setState({
        hosts: [awsHost],
        sessions: [awsSession],
        activeSessionTabId: awsSession.id,
        activeConnectionTab: { kind: 'terminal', id: awsSession.id },
        openSftpForSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const menuButton = tree!.root.findByProps({
      accessibilityLabel: 'AWS EC2 세션 메뉴',
    });

    await act(async () => {
      menuButton.props.onPress({ stopPropagation: jest.fn() });
    });

    const sftpItem = tree!.root.findByProps({
      accessibilityLabel: 'Connect via SFTP',
    });

    await act(async () => {
      await sftpItem.props.onPress();
    });

    expect(openSftpForSession).toHaveBeenCalledWith('session-aws');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('renders an active SFTP tab beside terminal tabs', async () => {
    const sftpSession: MobileSftpSessionRecord = {
      id: 'sftp-1',
      hostId: 'host-1',
      sourceSessionId: 'session-1',
      title: 'Synology SFTP',
      status: 'connected',
      currentPath: '/home/doyoung',
      listing: {
        path: '/home/doyoung',
        entries: [
          {
            name: 'logs',
            path: '/home/doyoung/logs',
            isDirectory: true,
            size: 0,
            mtime: '',
            kind: 'folder',
          },
          {
            name: 'notes.txt',
            path: '/home/doyoung/notes.txt',
            isDirectory: false,
            size: 120,
            mtime: '',
            kind: 'file',
          },
        ],
      },
      errorMessage: null,
      lastEventAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: null,
    };
    act(() => {
      useMobileAppStore.setState({
        sftpSessions: [sftpSession],
        activeConnectionTab: { kind: 'sftp', id: 'sftp-1' },
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    expect(
      tree!.root.findByProps({
        accessibilityLabel: 'Synology SFTP Connected 세션 탭',
      }),
    ).toBeDefined();
    const text = collectText(tree!.toJSON());
    expect(text).toContain('/home/doyoung');
    expect(text).toContain('logs');
    expect(text).toContain('notes.txt');
    expect(
      tree!.root.findByProps({ testID: 'session-terminal-card' }),
    ).toBeDefined();
    expect(() =>
      tree!.root.findByProps({ testID: 'session-toolbar-shell' }),
    ).toThrow();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('keeps the Android terminal webview mounted while an SFTP tab is active', async () => {
    setPlatformOs('android');
    const sftpSession: MobileSftpSessionRecord = {
      id: 'sftp-1',
      hostId: 'host-1',
      sourceSessionId: 'session-1',
      title: 'Synology SFTP',
      status: 'connected',
      currentPath: '/home/doyoung',
      listing: {
        path: '/home/doyoung',
        entries: [],
      },
      errorMessage: null,
      lastEventAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: null,
    };
    act(() => {
      useMobileAppStore.setState({
        sftpSessions: [sftpSession],
        activeConnectionTab: { kind: 'sftp', id: 'sftp-1' },
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    const hiddenTerminalCard = tree!.root.findByProps({
      testID: 'session-terminal-card',
    });
    expect(
      StyleSheet.flatten(hiddenTerminalCard.parent?.props.style).opacity,
    ).toBe(0);
    expect(hiddenTerminalCard.parent?.props.pointerEvents).toBe('none');
    expect(
      tree!.root.findAll(
        node => (node.type as unknown) === 'TerminalInputView',
      ),
    ).toHaveLength(0);
    expect(() =>
      tree!.root.findByProps({ testID: 'session-toolbar-shell' }),
    ).toThrow();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

    await act(async () => {
      useMobileAppStore.setState({
        activeConnectionTab: { kind: 'terminal', id: 'session-1' },
      });
      jest.runOnlyPendingTimers();
    });

    const visibleTerminalCard = tree!.root.findByProps({
      testID: 'session-terminal-card',
    });
    expect(
      StyleSheet.flatten(visibleTerminalCard.parent?.props.style).opacity,
    ).toBe(1);
    expect(visibleTerminalCard.parent?.props.pointerEvents).toBe('auto');
    expect(
      tree!.root.findAll(
        node => (node.type as unknown) === 'TerminalInputView',
      ),
    ).toHaveLength(1);
    expect(
      tree!.root.findByProps({ testID: 'session-toolbar-shell' }),
    ).toBeDefined();
    await act(async () => {
      visibleTerminalCard.props.onLayout({
        nativeEvent: {
          layout: {
            width: 360,
            height: 220,
          },
        },
      });
    });
    expect(mockTerminalHandle!.fit).toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('supports SFTP long-press multi-select and polished row metadata', async () => {
    const listSftpDirectory = jest.fn(async () => undefined);
    const downloadSftpEntries = jest.fn(async () => undefined);
    const copySftpEntries = jest.fn();
    const pasteSftpEntries = jest.fn(async () => undefined);
    const sftpSession: MobileSftpSessionRecord = {
      id: 'sftp-1',
      hostId: 'host-1',
      sourceSessionId: 'session-1',
      title: 'Synology SFTP',
      status: 'connected',
      currentPath: '/home/doyoung',
      listing: {
        path: '/home/doyoung',
        entries: [
          {
            name: 'logs',
            path: '/home/doyoung/logs',
            isDirectory: true,
            size: 0,
            mtime: '0',
            kind: 'folder',
            permissions: '0755',
          },
          {
            name: 'notes.txt',
            path: '/home/doyoung/notes.txt',
            isDirectory: false,
            size: 120,
            mtime: '0',
            kind: 'file',
            permissions: '0644',
          },
        ],
      },
      errorMessage: null,
      lastEventAt: new Date().toISOString(),
      lastConnectedAt: new Date().toISOString(),
      lastDisconnectedAt: null,
    };
    act(() => {
      useMobileAppStore.setState({
        sftpSessions: [sftpSession],
        activeConnectionTab: { kind: 'sftp', id: 'sftp-1' },
        listSftpDirectory,
        downloadSftpEntries,
        copySftpEntries,
        pasteSftpEntries,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const initialText = collectText(tree!.toJSON());
    expect(initialText).toEqual(
      expect.arrayContaining(['drwxr-xr-x', formatExpectedModifiedTime(0)]),
    );
    expect(initialText.some(value => value.includes('-rw-r--r--'))).toBe(true);

    const fileRow = tree!.root.findByProps({
      accessibilityLabel: 'notes.txt 파일',
    });
    await act(async () => {
      fileRow.props.onLongPress();
    });
    expect(collectText(tree!.toJSON()).join('')).toContain('선택 1개');

    const folderRow = tree!.root.findByProps({
      accessibilityLabel: 'logs 폴더',
    });
    await act(async () => {
      folderRow.props.onPress();
    });
    expect(collectText(tree!.toJSON()).join('')).toContain('선택 2개');
    expect(listSftpDirectory).not.toHaveBeenCalledWith(
      'sftp-1',
      '/home/doyoung/logs',
    );

    await act(async () => {
      tree!.root
        .findByProps({ accessibilityLabel: '다운로드' })
        .props.onPress();
    });
    expect(downloadSftpEntries).toHaveBeenCalledWith('sftp-1', [
      '/home/doyoung/notes.txt',
      '/home/doyoung/logs',
    ]);

    await act(async () => {
      fileRow.props.onLongPress();
    });
    await act(async () => {
      tree!.root.findByProps({ accessibilityLabel: '복사' }).props.onPress();
    });
    expect(copySftpEntries).toHaveBeenCalledWith('sftp-1', [
      '/home/doyoung/notes.txt',
    ]);

    act(() => {
      useMobileAppStore.setState({
        sftpCopyBuffer: {
          sftpSessionId: 'sftp-1',
          hostId: 'host-1',
          entries: [
            {
              path: '/home/doyoung/notes.txt',
              name: 'notes.txt',
              isDirectory: false,
              kind: 'file',
            },
          ],
          createdAt: new Date().toISOString(),
        },
      });
    });
    await act(async () => {
      tree!.root
        .findByProps({ accessibilityLabel: '붙여넣기' })
        .props.onPress();
    });
    expect(pasteSftpEntries).toHaveBeenCalledWith('sftp-1');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('maps the keyboard dock shortcuts to terminal control sequences', async () => {
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const expectedSequences = new Map<string, string>([
      ['ESC', '\u001b'],
      ['TAB', '\t'],
      ['Ctrl+C', '\u0003'],
      ['Left', '\u001b[D'],
      ['Right', '\u001b[C'],
      ['Up', '\u001b[A'],
      ['Down', '\u001b[B'],
      ['Enter', '\r'],
      ['Backspace', '\u007f'],
      ['Delete', '\u001b[3~'],
      ['Home', '\u001b[1~'],
      ['End', '\u001b[4~'],
      ['PageUp', '\u001b[5~'],
      ['PageDown', '\u001b[6~'],
      [':', ':'],
      ['!', '!'],
      ['/', '/'],
      ['?', '?'],
      ['Ctrl+D', '\u0004'],
      ['Ctrl+L', '\u000c'],
      ['Ctrl+Z', '\u001a'],
    ]);

    for (const item of TERMINAL_PRIMARY_SHORTCUTS) {
      const button = tree!.root.findByProps({
        accessibilityLabel: `${item.label} 제어키`,
      });
      await act(async () => {
        button.props.onPress();
        jest.runOnlyPendingTimers();
      });
      expect(writeToSession).toHaveBeenLastCalledWith(
        'session-1',
        expectedSequences.get(item.label),
      );
    }

    const expandButton = tree!.root.findByProps({
      accessibilityLabel: '추가 제어키 표시',
    });

    await act(async () => {
      expandButton.props.onPress();
    });

    for (const item of TERMINAL_SECONDARY_SHORTCUTS) {
      const button = tree!.root.findByProps({
        accessibilityLabel: `${item.label} 제어키`,
      });
      await act(async () => {
        button.props.onPress();
        jest.runOnlyPendingTimers();
      });
      expect(writeToSession).toHaveBeenLastCalledWith(
        'session-1',
        expectedSequences.get(item.label),
      );
    }

    await act(async () => {
      tree!.unmount();
    });
  });

  it('replays the last snapshot into the terminal when a connected tab becomes ready', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    expect(mockTerminalHandle!.write).toHaveBeenCalled();
    expect(
      mockTerminalHandle!.write.mock.calls.some(
        ([bytes]) => Buffer.from(bytes).toString('utf8') === 'prompt',
      ),
    ).toBe(true);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('accepts Android hardware keyboard input from the xterm webview when the soft keyboard is closed', async () => {
    setPlatformOs('android');
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    await act(async () => {
      (
        mockCapturedXtermProps?.onData as ((data: string) => void) | undefined
      )?.('ls');
    });

    expect(writeToSession).toHaveBeenLastCalledWith('session-1', 'ls');

    await act(async () => {
      tree!.unmount();
    });
  });

  it('ignores Android xterm webview input while the soft keyboard is open', async () => {
    setPlatformOs('android');
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 열기',
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    writeToSession.mockClear();

    await act(async () => {
      (
        mockCapturedXtermProps?.onData as ((data: string) => void) | undefined
      )?.('pwd');
    });

    expect(writeToSession).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('refocuses the Android input overlay when the terminal is touched', async () => {
    setPlatformOs('android');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    const terminalCard = tree!.root.findByProps({
      testID: 'session-terminal-card',
    });
    expect(typeof terminalCard.props.onTouchEnd).toBe('function');

    const initialFocusCalls =
      mockNativeTerminalInputHandle!.focus.mock.calls.length;

    await act(async () => {
      terminalCard.props.onTouchEnd();
      jest.runOnlyPendingTimers();
    });

    const nativeInput = tree!.root.find(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);
    expect(
      mockNativeTerminalInputHandle!.focus.mock.calls.length,
    ).toBeGreaterThan(initialFocusCalls);

    await act(async () => {
      tree!.unmount();
    });
  });

  it('does not refocus the Android input overlay after each typed event', async () => {
    setPlatformOs('android');
    const writeToSession = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState({
        writeToSession,
      });
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    const nativeInput = tree!.root.find(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInput.props.focused).toBe(true);
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);

    const initialFocusCalls =
      mockNativeTerminalInputHandle!.focus.mock.calls.length;

    await act(async () => {
      nativeInput.props.onTerminalInput({
        nativeEvent: {
          kind: 'text-delta',
          deleteCount: 0,
          insertText: 'a',
        },
      });
    });

    expect(writeToSession).toHaveBeenLastCalledWith('session-1', 'a');
    expect(mockNativeTerminalInputHandle!.focus.mock.calls.length).toBe(
      initialFocusCalls,
    );
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it('uses the native terminal input overlay when toggling the keyboard on Android', async () => {
    setPlatformOs('android');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
      jest.runOnlyPendingTimers();
    });

    await act(async () => {
      tree!.root
        .findByProps({ testID: 'session-toolbar-shell' })
        .props.onLayout({
          nativeEvent: {
            layout: {
              height: 72,
            },
          },
        });
    });

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 열기',
    });
    const terminalFocusCallsBeforeOpen =
      mockTerminalHandle!.focus.mock.calls.length;

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    let nativeInput = tree!.root.find(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInput.props.softKeyboardEnabled).toBe(true);
    expect(
      mockNativeTerminalInputHandle!.focus.mock.calls.length,
    ).toBeGreaterThan(0);
    expect(mockTerminalHandle!.focus.mock.calls.length).toBe(
      terminalFocusCallsBeforeOpen,
    );

    await act(async () => {
      emitKeyboardEvent('keyboardDidShow', {
        endCoordinates: { height: 280 },
      });
    });

    const screenBody = tree!.root.findByProps({
      testID: 'session-screen-body',
    });
    const toolbarShell = tree!.root.findByProps({
      testID: 'session-toolbar-shell',
    });

    expect(StyleSheet.flatten(screenBody.props.style).paddingBottom).toBe(376);
    expect(StyleSheet.flatten(toolbarShell.props.style).bottom).toBe(304);

    const closeKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 닫기',
    });

    const focusCallCountBeforeClose =
      mockNativeTerminalInputHandle!.focus.mock.calls.length;

    await act(async () => {
      closeKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    nativeInput = tree!.root.find(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInput.props.softKeyboardEnabled).toBe(false);
    expect(
      mockNativeTerminalInputHandle!.focus.mock.calls.length,
    ).toBeGreaterThan(focusCallCountBeforeClose);
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();
    expect(mockTerminalHandle!.blur).not.toHaveBeenCalled();

    await act(async () => {
      tree!.unmount();
    });
  });

  it.each(['rdp', 'vnc'] as const)(
    'unlocks orientation only while the focused %s tab is active',
    async protocol => {
      const remoteSession: MobileRemoteDesktopSessionRecord = {
        id: `${protocol}-orientation`,
        hostId: 'host-1',
        protocol,
        title: `${protocol.toUpperCase()} orientation`,
        status: 'error',
        inputMode: 'trackpad',
        scaleMode: 'fit',
        errorMessage: 'Test session',
        openedAt: '2024-01-01T00:00:02.000Z',
        lastEventAt: '2024-01-01T00:00:02.000Z',
        lastConnectedAt: null,
        lastDisconnectedAt: null,
      };

      act(() => {
        useMobileAppStore.setState({
          remoteDesktopSessions: [remoteSession],
          activeConnectionTab: { kind: protocol, id: remoteSession.id },
        });
      });

      let tree: renderer.ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(<SessionScreen />);
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(true);

      await act(async () => {
        useMobileAppStore.setState({
          activeConnectionTab: { kind: 'terminal', id: session.id },
        });
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(false);

      await act(async () => {
        useMobileAppStore.setState({
          activeConnectionTab: { kind: protocol, id: remoteSession.id },
        });
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(true);

      await act(async () => {
        mockScreenFocused = false;
        tree!.update(<SessionScreen />);
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(false);

      await act(async () => {
        mockScreenFocused = true;
        tree!.update(<SessionScreen />);
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(true);

      await act(async () => {
        tree!.unmount();
      });
      expect(mockSetOrientationUnlocked).toHaveBeenLastCalledWith(false);
    },
  );

  it('renders RDP session tab and handles close', async () => {
    const rdSession: MobileRemoteDesktopSessionRecord = {
      id: 'rd-1',
      hostId: 'host-1',
      protocol: 'rdp',
      title: 'My RDP',
      status: 'error',
      inputMode: 'trackpad',
      scaleMode: 'fit',
      errorMessage: 'Native RDP engine is not available on this build.',
      openedAt: '2024-01-01T00:00:02.000Z',
      lastEventAt: '2024-01-01T00:00:02.000Z',
      lastConnectedAt: null,
      lastDisconnectedAt: null,
    };

    const disconnectRd = jest.fn(async () => undefined);
    act(() => {
      useMobileAppStore.setState(state => ({
        ...state,
        remoteDesktopSessions: [rdSession],
        activeConnectionTab: { kind: 'rdp', id: 'rd-1' },
        connectionViews: {
          'rd-1': {
            hostId: 'host-1',
            hasTailnet: false,
            hostKind: 'rdp',
            stage: 'ssm-tunnel',
            ssmTunnel: true,
            failureMessage: rdSession.errorMessage ?? undefined,
          },
        },
        disconnectRemoteDesktopSession: disconnectRd,
      }));
    });

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    // The RD surface should be rendered
    const surface = tree!.root.findByProps({
      testID: 'remote-desktop-surface-rd-1',
    });
    expect(surface).toBeTruthy();
    const rendered = collectText(tree!.toJSON());
    expect(rendered).toContain('My RDP');
    expect(rendered).toContain('RDP');
    expect(rendered).toContain('SSM 연결');
    expect(rendered).toContain(rdSession.errorMessage);

    const tabCloseButton = tree!.root.find(
      node => node.props.accessibilityLabel === 'My RDP 닫기',
    );
    const stopPropagation = jest.fn();
    await act(async () => {
      await tabCloseButton.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalled();
    expect(disconnectRd).toHaveBeenCalledWith('rd-1');

    await act(async () => {
      tree!.unmount();
    });
  });
});
