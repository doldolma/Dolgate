import React from 'react';
import { Buffer } from 'buffer';
import renderer, { act } from 'react-test-renderer';
import { Keyboard, Platform, StyleSheet, Text } from 'react-native';
import type {
  AuthState,
  MobileSessionRecord,
  MobileSftpSessionRecord,
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

jest.mock('react-native-vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@fressh/react-native-uniffi-russh', () => ({
  RnRussh: {
    uniffiInitAsync: jest.fn(async () => undefined),
    connect: jest.fn(),
    connectSftp: jest.fn(),
    validatePrivateKey: jest.fn(() => ({ valid: true })),
    validateCertificate: jest.fn(() => ({ valid: true })),
  },
}));
jest.mock('react-native-document-picker', () => ({
  __esModule: true,
  default: {
    pickSingle: jest.fn(),
    isCancel: jest.fn(() => false),
    types: {
      allFiles: '*/*',
      plainText: 'text/plain',
    },
  },
}));

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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 24,
    left: 0,
    right: 0,
  }),
}));

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

  it('does not render the native terminal input overlay on iOS', async () => {
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    const nativeInputs = tree!.root.findAll(
      node => (node.type as unknown) === 'TerminalInputView',
    );
    expect(nativeInputs).toHaveLength(0);

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

  it('toggles the iOS keyboard through terminal focus and blur only', async () => {
    const dismissKeyboard = jest
      .spyOn(Keyboard, 'dismiss')
      .mockImplementation(() => undefined);
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionScreen />);
    });

    mockTerminalHandle!.focus.mockClear();

    const openKeyboardButton = tree!.root.findByProps({
      accessibilityLabel: '키보드 열기',
    });

    await act(async () => {
      openKeyboardButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(mockTerminalHandle!.focus).toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

    mockTerminalHandle!.blur.mockClear();

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

    expect(mockTerminalHandle!.blur).toHaveBeenCalled();
    expect(dismissKeyboard).toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.blur).not.toHaveBeenCalled();

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

    const secondTab = tree!.root.findByProps({
      accessibilityLabel: 'Docker-ubuntu Connecting 세션 탭',
    });

    await act(async () => {
      secondTab.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(setActiveSessionTab).toHaveBeenCalledWith('session-2');
    expect(mockTerminalHandle!.focus).toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

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

    const reconnectButton = tree!.root.findByProps({
      accessibilityLabel: 'Synology 세션 재연결',
    });

    await act(async () => {
      await reconnectButton.props.onPress();
      jest.runOnlyPendingTimers();
    });

    expect(resumeSession).toHaveBeenCalledWith('session-1');
    expect(mockTerminalHandle!.focus).toHaveBeenCalled();
    expect(mockNativeTerminalInputHandle!.focus).not.toHaveBeenCalled();

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
    expect(() =>
      tree!.root.findByProps({ testID: 'session-toolbar-shell' }),
    ).toThrow();

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
      expect.arrayContaining(['drwxr-xr-x', '1970.01.01 09:00']),
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
      tree!.root.findByProps({ accessibilityLabel: '다운로드' }).props.onPress();
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
      tree!.root.findByProps({ accessibilityLabel: '붙여넣기' }).props.onPress();
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
      ['Home', '\u001b[H'],
      ['End', '\u001b[F'],
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
    expect(mockTerminalHandle!.focus).not.toHaveBeenCalled();

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
});
