import { NativeModules } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { act } from 'react-test-renderer';
import type {
  KnownHostRecord,
  LoadedManagedSecretPayload,
  RdpHostRecord,
  SshHostRecord,
  TailnetPayload,
  VncHostRecord,
} from '@dolssh/shared-core';
import {
  isNativeSessionAvailable,
  nativeConnect,
  nativeDisconnect,
  nativeTrustCertificate,
  subscribeToSessionEvents,
  type RemoteDesktopSessionEvent,
} from '@dolssh/react-native-remote-desktop';
import {
  createDefaultMobileSettings,
  createDefaultSyncStatus,
  createUnauthenticatedState,
} from '../src/lib/mobile';
import {
  resetMobileStoreRuntimeForTests,
  useMobileAppStore,
} from '../src/store/useMobileAppStore';
import {
  _resetHandlesForTests,
  getRemoteDesktopHandle,
} from '../src/store/remoteDesktopSlice';
import { resolveAwsSessionForHost } from '../src/lib/aws-session';
import { startSsmPortForwardSession } from '../src/lib/aws-ssm-direct';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => null),
  clear: jest.fn(async () => null),
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  },
  getGenericPassword: jest.fn(async () => null),
  setGenericPassword: jest.fn(async () => true),
  resetGenericPassword: jest.fn(async () => true),
}));

jest.mock('../src/lib/aws-session', () => ({
  ...jest.requireActual('../src/lib/aws-session'),
  resolveAwsSessionForHost: jest.fn(),
}));

jest.mock('../src/lib/aws-ssm-direct', () => ({
  ...jest.requireActual('../src/lib/aws-ssm-direct'),
  startSsmPortForwardSession: jest.fn(),
}));

const engineNative = NativeModules.GoSshEngineModule as Record<
  string,
  jest.Mock
>;
const nativeAvailableMock = isNativeSessionAvailable as jest.MockedFunction<
  typeof isNativeSessionAvailable
>;
const nativeConnectMock = nativeConnect as jest.MockedFunction<
  typeof nativeConnect
>;
const nativeDisconnectMock = nativeDisconnect as jest.MockedFunction<
  typeof nativeDisconnect
>;
const nativeTrustMock = nativeTrustCertificate as jest.MockedFunction<
  typeof nativeTrustCertificate
>;
const resolveAwsSessionMock = resolveAwsSessionForHost as jest.MockedFunction<
  typeof resolveAwsSessionForHost
>;
const startSsmPortForwardSessionMock =
  startSsmPortForwardSession as jest.MockedFunction<
    typeof startSsmPortForwardSession
  >;
const subscribeMock = subscribeToSessionEvents as jest.MockedFunction<
  typeof subscribeToSessionEvents
>;

const openTunnelNative = jest.fn<Promise<string>, [string]>();
const closeTunnelNative = jest.fn<Promise<void>, [string]>();
engineNative.openRemoteDesktopTunnel = openTunnelNative;
engineNative.closeRemoteDesktopTunnel = closeTunnelNative;

const CREATED_AT = '2026-04-13T00:00:00.000Z';
let sessionEventListener: ((event: RemoteDesktopSessionEvent) => void) | null =
  null;
let unsubscribeMock = jest.fn();
let cleanupOrder: string[] = [];

function createVncHost(overrides: Partial<VncHostRecord> = {}): VncHostRecord {
  return {
    id: 'vnc-1',
    kind: 'vnc',
    label: 'Production VNC',
    hostname: 'vnc.internal',
    port: 5901,
    secretRef: 'vnc-secret',
    shared: true,
    viewOnly: false,
    imageQuality: 'balanced',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function createRdpHost(overrides: Partial<RdpHostRecord> = {}): RdpHostRecord {
  return {
    id: 'rdp-1',
    kind: 'rdp',
    label: 'Windows Server',
    hostname: 'windows.internal',
    port: 3389,
    secretRef: 'rdp-secret',
    audioEnabled: true,
    clipboardEnabled: true,
    microphoneEnabled: false,
    cameraEnabled: false,
    adminSession: true,
    colorDepth: 32,
    drives: [{ path: '/Users/mobile/Documents', readOnly: true }],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function createRdpSecret(): LoadedManagedSecretPayload {
  return {
    secretRef: 'rdp-secret',
    kind: 'rdp',
    label: 'Windows credentials',
    username: 'Administrator',
    domain: 'CORP',
    password: 'rdp-pass',
    updatedAt: CREATED_AT,
  };
}

function createVncSecret(): LoadedManagedSecretPayload {
  return {
    secretRef: 'vnc-secret',
    kind: 'vnc',
    label: 'VNC credentials',
    username: 'ard-user',
    password: 'vnc-pass',
    updatedAt: CREATED_AT,
  };
}

function createSshTunnelHost(): SshHostRecord {
  return {
    id: 'ssh-tunnel-1',
    kind: 'ssh',
    label: 'VNC bastion',
    hostname: 'bastion.internal',
    port: 2222,
    username: 'deploy',
    authType: 'password',
    secretRef: 'ssh-secret',
    privateKeyPath: null,
    certificatePath: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function createSshSecret(): LoadedManagedSecretPayload {
  return {
    secretRef: 'ssh-secret',
    kind: 'ssh',
    label: 'Bastion credentials',
    password: 'ssh-pass',
    updatedAt: CREATED_AT,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetStore(overrides: Record<string, unknown> = {}): void {
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
    awsProfiles: [],
    tailnets: [],
    knownHosts: [],
    secretMetadata: [],
    sessions: [],
    sftpSessions: [],
    sftpTransfers: [],
    sftpCopyBuffer: null,
    remoteDesktopSessions: [],
    activeSessionTabId: null,
    activeConnectionTab: null,
    connectionViews: {},
    secretsByRef: {},
    pendingBrowserLoginState: null,
    pendingServerKeyPrompt: null,
    pendingRdpCertificatePrompt: null,
    pendingCredentialPrompt: null,
    ...overrides,
  });
}

async function flushAsyncWork(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function requireSessionId(value: string | null): string {
  if (value === null) throw new Error('Remote desktop session was not created');
  return value;
}

function emitSessionEvent(event: RemoteDesktopSessionEvent): void {
  if (!sessionEventListener) {
    throw new Error('Remote desktop event listener was not registered');
  }
  sessionEventListener(event);
}

function lastTunnelPayload(): Record<string, unknown> {
  const call = openTunnelNative.mock.calls.at(-1);
  if (!call) throw new Error('Remote desktop tunnel was not opened');
  return JSON.parse(call[0]) as Record<string, unknown>;
}

describe('mobile remote desktop connection paths', () => {
  beforeEach(() => {
    resetMobileStoreRuntimeForTests();
    _resetHandlesForTests();
    jest.clearAllMocks();
    cleanupOrder = [];
    sessionEventListener = null;
    unsubscribeMock = jest.fn(() => {
      cleanupOrder.push('unsubscribe');
    });

    nativeAvailableMock.mockReset();
    nativeAvailableMock.mockResolvedValue(true);
    nativeConnectMock.mockReset();
    nativeConnectMock.mockResolvedValue(undefined);
    nativeDisconnectMock.mockReset();
    nativeDisconnectMock.mockImplementation(async () => {
      cleanupOrder.push('native-disconnect');
    });
    nativeTrustMock.mockReset();
    nativeTrustMock.mockResolvedValue(undefined);
    resolveAwsSessionMock.mockReset();
    resolveAwsSessionMock.mockResolvedValue({
      envSpec: { env: {}, unsetEnv: [] },
      credentials: {
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      },
      profileName: 'Production',
      region: 'ap-northeast-2',
      connectionDetails: 'Production · ap-northeast-2 · i-rdp',
    });
    startSsmPortForwardSessionMock.mockReset();
    startSsmPortForwardSessionMock.mockResolvedValue({
      streamUrl: 'wss://ssm.example.test/stream',
      tokenValue: 'ssm-token',
      sessionId: 'ssm-session',
    });
    subscribeMock.mockReset();
    subscribeMock.mockImplementation(listener => {
      sessionEventListener = listener;
      return unsubscribeMock;
    });

    openTunnelNative.mockReset();
    openTunnelNative.mockImplementation(async requestJson => {
      const request = JSON.parse(requestJson) as {
        id: string;
        transport: string;
      };
      return JSON.stringify({
        tunnelId: request.id,
        host: '127.0.0.1',
        port: 45900,
        transport: request.transport,
        authToken: 'ab'.repeat(32),
      });
    });
    closeTunnelNative.mockReset();
    closeTunnelNative.mockImplementation(async () => {
      cleanupOrder.push('tunnel-close');
    });
    engineNative.startTailnet.mockReset();
    engineNative.startTailnet.mockResolvedValue(undefined);
    engineNative.startSsmPortForward.mockReset();
    engineNative.startSsmPortForward.mockResolvedValue({
      forwardId: 'test-forward',
      bindPort: 54321,
    });
    engineNative.stopSsmPortForward.mockReset();
    engineNative.stopSsmPortForward.mockImplementation(async () => {
      cleanupOrder.push('ssm-stop');
    });

    resetStore();
  });

  afterEach(() => {
    _resetHandlesForTests();
    resetMobileStoreRuntimeForTests();
    resetStore();
  });

  it('connects direct VNC with native map options and stores framebuffer metadata', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(sessionId).not.toBeNull();
    expect(openTunnelNative).not.toHaveBeenCalled();
    expect(nativeConnectMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        protocol: 'vnc',
        host: host.hostname,
        port: host.port,
        password: secret.password,
        username: secret.username,
        shared: true,
        viewOnly: false,
        imageQuality: 'balanced',
      }),
    );

    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'status',
        status: 'connected',
        width: 1920,
        height: 1080,
        name: 'QEMU Console',
      });
    });

    const session = useMobileAppStore
      .getState()
      .remoteDesktopSessions.find(record => record.id === sessionId);
    expect(session).toEqual(
      expect.objectContaining({
        status: 'connected',
        desktopWidth: 1920,
        desktopHeight: 1080,
        desktopName: 'QEMU Console',
      }),
    );
    expect(
      getRemoteDesktopHandle(requireSessionId(sessionId))?.tunnelId,
    ).toBeNull();
    expect(
      useMobileAppStore.getState().connectionViews[requireSessionId(sessionId)],
    ).toBeUndefined();
  });

  // 실패한 세션은 탭에 남는다(탭은 status !== 'closed' 를 살아 있는 것으로 본다). SSH 처럼
  // 그 자리에서 다시 붙을 수 있어야 하고, 이때 **세션 id 를 재사용**해야 탭이 안 늘어난다.
  it('reconnects a failed session in the same tab', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);

    // 네이티브가 오류를 알린다 — 세션은 error 로 남고 탭에서 사라지지 않는다.
    await act(async () => {
      emitSessionEvent({
        sessionId: rdId,
        type: 'error',
        message: '연결이 거부되었습니다.',
      });
      await flushAsyncWork();
    });
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === rdId)?.status,
    ).toBe('error');

    nativeConnectMock.mockClear();
    await act(async () => {
      await useMobileAppStore.getState().reconnectRemoteDesktopSession(rdId);
      await flushAsyncWork();
    });

    // 같은 id 로 다시 붙고, 세션이 늘지 않는다.
    expect(nativeConnectMock).toHaveBeenCalledWith(
      rdId,
      expect.objectContaining({ protocol: 'vnc', host: host.hostname }),
    );
    expect(useMobileAppStore.getState().remoteDesktopSessions).toHaveLength(1);
    const session = useMobileAppStore
      .getState()
      .remoteDesktopSessions.find(record => record.id === rdId);
    // 지난 오류 문구는 지워져야 한다 — 남으면 새 시도 중에 옛 실패가 보인다.
    expect(session?.errorMessage).toBeNull();
    expect(session?.status).not.toBe('error');
  });

  // 붙어 있는 세션에 눌러도 새 연결을 만들면 안 된다 — 런타임 핸들이 그 사실이다.
  it('leaves a live session alone when reconnect is requested', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);
    await act(async () => {
      emitSessionEvent({ sessionId: rdId, type: 'status', status: 'connected' });
    });

    nativeConnectMock.mockClear();
    await act(async () => {
      await useMobileAppStore.getState().reconnectRemoteDesktopSession(rdId);
      await flushAsyncWork();
    });
    expect(nativeConnectMock).not.toHaveBeenCalled();
  });

  // 호스트를 지운 뒤 눌렀을 때. 조용히 아무 일도 없으면 고장으로 읽힌다.
  it('reports a missing host instead of silently doing nothing', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);
    await act(async () => {
      emitSessionEvent({ sessionId: rdId, type: 'error', message: '끊겼습니다.' });
      await flushAsyncWork();
    });

    useMobileAppStore.setState({ hosts: [] });
    nativeConnectMock.mockClear();
    await act(async () => {
      await useMobileAppStore.getState().reconnectRemoteDesktopSession(rdId);
      await flushAsyncWork();
    });

    expect(nativeConnectMock).not.toHaveBeenCalled();
    const session = useMobileAppStore
      .getState()
      .remoteDesktopSessions.find(record => record.id === rdId);
    expect(session?.status).toBe('error');
    expect(session?.errorMessage).toBeTruthy();
  });

  // 코어가 올려 보내는 문장은 Go 원문이다. RD 경로만 그 분류를 안 거쳐서 화면에
  // "rdtunnel: connect target: connect tcp ...: connection was refused" 가 그대로 떴다.
  it('classifies a native error event instead of showing the core wording', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);

    await act(async () => {
      emitSessionEvent({
        sessionId: rdId,
        type: 'error',
        // tailnet 을 지나면 같은 원인이 "connection was refused" 로 온다(netstack 문구).
        message:
          'rdtunnel: connect target: connect tcp 192.168.200.27:3389: connection was refused',
      });
      await flushAsyncWork();
    });

    const session = useMobileAppStore
      .getState()
      .remoteDesktopSessions.find(record => record.id === rdId);
    expect(session?.errorMessage).toBe(
      `${host.hostname}:${host.port} 이 연결을 거부했습니다. 포트와 서버 상태를 확인해 주세요.`,
    );
    expect(session?.errorMessage).not.toContain('connect tcp');
  });

  // 분류되지 않은 오류는 원문을 남긴다 — 뭉뚱그린 문구로 덮으면 유일한 단서가 사라진다.
  it('keeps an unclassified core message as-is', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);

    await act(async () => {
      emitSessionEvent({
        sessionId: rdId,
        type: 'error',
        message: 'rfb: unsupported security type 42',
      });
      await flushAsyncWork();
    });

    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === rdId)?.errorMessage,
    ).toBe('rfb: unsupported security type 42');
  });

  // rdp-core 의 "timed out waiting for the certificate decision" 은 timeout 규칙에 먼저
  // 걸리면 "호스트가 응답하지 않는다" 로 뒤바뀐다 — 할 일이 정반대라(인증서 승인) 그 분류가
  // timeout 보다 앞이어야 한다.
  it('does not turn an unanswered certificate prompt into a network timeout', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });
    const rdId = requireSessionId(sessionId);

    await act(async () => {
      emitSessionEvent({
        sessionId: rdId,
        type: 'error',
        message: 'begin connection: timed out waiting for the certificate decision',
      });
      await flushAsyncWork();
    });

    const message =
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === rdId)?.errorMessage ??
      '';
    expect(message).toContain('인증서');
    expect(message).not.toContain('응답하지 않습니다');
    // 원문도 남지 않아야 한다.
    expect(message).not.toContain('certificate decision');
  });

  it('copies remote clipboard text only for the active session', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'clipboard',
        text: 'active clipboard text',
      });
    });

    expect(Clipboard.setString).toHaveBeenCalledWith('active clipboard text');

    jest.mocked(Clipboard.setString).mockClear();
    useMobileAppStore.setState({ activeConnectionTab: null });
    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'clipboard',
        text: 'stale inactive clipboard text',
      });
    });

    expect(Clipboard.setString).not.toHaveBeenCalled();
  });

  it('routes VNC over Tailnet and tears down native, tunnel, then listener on error', async () => {
    const host = createVncHost({ tailnetId: 'corp' });
    const secret = createVncSecret();
    const tailnet: TailnetPayload = {
      id: 'corp',
      label: 'Corp',
      tailnetName: 'example.com',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    resetStore({
      hosts: [host],
      tailnets: [tailnet],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(engineNative.startTailnet).toHaveBeenCalledTimes(1);
    expect(lastTunnelPayload()).toEqual(
      expect.objectContaining({
        id: `rd-tunnel:${sessionId}`,
        host: host.hostname,
        port: host.port,
        transport: 'tailscale',
        tailnetId: 'corp',
        tailnetName: 'example.com',
      }),
    );
    expect(nativeConnectMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        host: '127.0.0.1',
        port: 45900,
        tunnelAuthToken: 'ab'.repeat(32),
      }),
    );

    cleanupOrder = [];
    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'error',
        message: 'network lost',
      });
      await flushAsyncWork(24);
    });

    expect(cleanupOrder).toEqual([
      'native-disconnect',
      'tunnel-close',
      'unsubscribe',
    ]);
    expect(closeTunnelNative).toHaveBeenCalledWith(`rd-tunnel:${sessionId}`);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId),
    ).toEqual(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'network lost',
      }),
    );
  });

  it('opens an SSH VNC tunnel with credentials and trusted host keys, then closes in order', async () => {
    const tunnelHost = createSshTunnelHost();
    const host = createVncHost({ sshTunnelHostId: tunnelHost.id });
    const vncSecret = createVncSecret();
    const sshSecret = createSshSecret();
    const knownHost: KnownHostRecord = {
      id: 'known-bastion',
      host: tunnelHost.hostname,
      port: tunnelHost.port,
      algorithm: 'ssh-ed25519',
      publicKeyBase64: 'AAAATESTBASTIONKEY',
      fingerprintSha256: 'SHA256:bastion',
      createdAt: CREATED_AT,
      lastSeenAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    resetStore({
      hosts: [host, tunnelHost],
      knownHosts: [knownHost],
      secretsByRef: {
        [vncSecret.secretRef]: vncSecret,
        [sshSecret.secretRef]: sshSecret,
      },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(lastTunnelPayload()).toEqual(
      expect.objectContaining({
        id: `rd-tunnel:${sessionId}`,
        transport: 'ssh',
        host: tunnelHost.hostname,
        port: tunnelHost.port,
        username: tunnelHost.username,
        authType: 'password',
        password: sshSecret.password,
        targetHost: host.hostname,
        targetPort: host.port,
        trustedHostKeyBase64: knownHost.publicKeyBase64,
        trustedHostKeysBase64: [knownHost.publicKeyBase64],
      }),
    );
    expect(nativeConnectMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        host: '127.0.0.1',
        port: 45900,
        tunnelAuthToken: 'ab'.repeat(32),
      }),
    );
    expect(
      useMobileAppStore.getState().connectionViews[requireSessionId(sessionId)],
    ).toEqual(
      expect.objectContaining({
        hostKind: 'vnc',
        tunnelLabel: tunnelHost.label,
        stage: 'connecting',
      }),
    );

    cleanupOrder = [];
    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectRemoteDesktopSession(requireSessionId(sessionId));
    });

    expect(cleanupOrder).toEqual([
      'native-disconnect',
      'tunnel-close',
      'unsubscribe',
    ]);
    expect(closeTunnelNative).toHaveBeenCalledWith(`rd-tunnel:${sessionId}`);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
    // 기록은 남는다 — "최근 세션" 에서 다시 붙을 근거다. 탭은 live 만 보므로 닫힌 기록이
    // 남아도 탭에는 나타나지 않는다.
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId)?.status,
    ).toBe('closed');
    expect(
      useMobileAppStore.getState().connectionViews[requireSessionId(sessionId)],
    ).toBeUndefined();
  });

  it('surfaces an SSH target-forward error before the VNC RFB handshake starts', async () => {
    const tunnelHost = createSshTunnelHost();
    const host = createVncHost({ sshTunnelHostId: tunnelHost.id });
    const vncSecret = createVncSecret();
    const sshSecret = createSshSecret();
    const actualError =
      'rdtunnel: connect target: rdtunnel/ssh: forward to 127.0.0.1:5901: connect: connection refused';
    openTunnelNative.mockRejectedValueOnce(new Error(actualError));
    resetStore({
      hosts: [host, tunnelHost],
      knownHosts: [
        {
          id: 'known-bastion',
          host: tunnelHost.hostname,
          port: tunnelHost.port,
          algorithm: 'ssh-ed25519',
          publicKeyBase64: 'AAAATESTBASTIONKEY',
          fingerprintSha256: 'SHA256:bastion',
          createdAt: CREATED_AT,
          lastSeenAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      secretsByRef: {
        [vncSecret.secretRef]: vncSecret,
        [sshSecret.secretRef]: sshSecret,
      },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(nativeConnectMock).not.toHaveBeenCalled();
    // 코어 원문("...: connect: connection refused")은 화면에 그대로 가지 않는다 — SSH 경로와
    // 같은 분류를 거쳐 사람이 읽는 문구가 되고, 대상은 붙으려던 주소로 적힌다.
    const failureMessage = `${host.hostname}:${host.port} 이 연결을 거부했습니다. 포트와 서버 상태를 확인해 주세요.`;
    const session = useMobileAppStore
      .getState()
      .remoteDesktopSessions.find(record => record.id === sessionId);
    expect(session).toEqual(
      expect.objectContaining({ status: 'error', errorMessage: failureMessage }),
    );
    expect(session?.errorMessage).not.toContain('rdtunnel');
    // 막힌 곳은 그대로 SSH 터널 단계여야 한다 — 문구를 바꾼다고 단계가 옮겨가면 안 된다.
    expect(
      useMobileAppStore.getState().connectionViews[requireSessionId(sessionId)],
    ).toEqual(
      expect.objectContaining({
        stage: 'ssh-tunnel-gateway',
        failureMessage,
      }),
    );
  });

  it('connects direct RDP with protocol options and requires an explicit first-use certificate verdict', async () => {
    const host = createRdpHost();
    const secret = createRdpSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    expect(nativeAvailableMock).toHaveBeenCalledWith('rdp');
    expect(openTunnelNative).not.toHaveBeenCalled();
    const options = nativeConnectMock.mock.calls[0]?.[1];
    expect(options).toEqual(
      expect.objectContaining({
        protocol: 'rdp',
        host: host.hostname,
        port: host.port,
        username: secret.username,
        password: secret.password,
        domain: secret.domain,
        audioEnabled: true,
        clipboardEnabled: true,
        microphoneEnabled: false,
        cameraEnabled: false,
        adminSession: true,
        colorDepth: 32,
        drives: [
          {
            label: 'Documents',
            path: '/Users/mobile/Documents',
            readOnly: true,
          },
        ],
      }),
    );
    expect(options?.dialAddress).toBeUndefined();

    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'certificate',
        fingerprint: 'aa-bb',
        subject: 'CN=windows.internal',
        issuer: 'CN=windows.internal',
      });
      await flushAsyncWork();
    });

    expect(nativeTrustMock).not.toHaveBeenCalled();
    expect(useMobileAppStore.getState().pendingRdpCertificatePrompt).toEqual(
      expect.objectContaining({
        sessionId,
        hostId: host.id,
        fingerprint: 'AA-BB',
        previousFingerprint: null,
      }),
    );

    await act(async () => {
      await useMobileAppStore.getState().acceptRdpCertificatePrompt();
    });
    expect(nativeTrustMock).toHaveBeenCalledWith(sessionId, true);
    expect(
      (useMobileAppStore.getState().hosts[0] as RdpHostRecord)
        .certificateFingerprint,
    ).toBe('AA-BB');

    nativeTrustMock.mockClear();
    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'certificate',
        fingerprint: 'aa-bb',
      });
      await flushAsyncWork();
    });
    expect(nativeTrustMock).toHaveBeenCalledWith(sessionId, true);
    expect(useMobileAppStore.getState().pendingRdpCertificatePrompt).toBeNull();
  });

  it('rejects an RDP certificate event with no fingerprint', async () => {
    const host = createRdpHost();
    const secret = createRdpSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'certificate',
        fingerprint: '   ',
      });
      await flushAsyncWork(24);
    });

    expect(nativeTrustMock).toHaveBeenCalledWith(sessionId, false);
    expect(useMobileAppStore.getState().pendingRdpCertificatePrompt).toBeNull();
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId),
    ).toEqual(expect.objectContaining({ status: 'error' }));
  });

  it('shows a changed RDP certificate and sends an explicit rejection', async () => {
    const host = createRdpHost({ certificateFingerprint: 'AA:BB' });
    const secret = createRdpSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'certificate',
        fingerprint: 'CC:DD',
      });
      await flushAsyncWork();
    });

    expect(useMobileAppStore.getState().pendingRdpCertificatePrompt).toEqual(
      expect.objectContaining({ previousFingerprint: 'AA:BB' }),
    );
    await act(async () => {
      await useMobileAppStore.getState().rejectRdpCertificatePrompt();
    });
    expect(nativeTrustMock).toHaveBeenCalledWith(sessionId, false);
    expect(
      (useMobileAppStore.getState().hosts[0] as RdpHostRecord)
        .certificateFingerprint,
    ).toBe('AA:BB');
  });

  it('keeps the logical RDP host while dialing a Tailnet loopback endpoint', async () => {
    const host = createRdpHost({ tailnetId: 'corp' });
    const secret = createRdpSecret();
    const tailnet: TailnetPayload = {
      id: 'corp',
      label: 'Corp',
      tailnetName: 'example.com',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    resetStore({
      hosts: [host],
      tailnets: [tailnet],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(lastTunnelPayload()).toEqual(
      expect.objectContaining({ transport: 'tailscale', host: host.hostname }),
    );
    expect(nativeConnectMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        protocol: 'rdp',
        host: host.hostname,
        dialAddress: '127.0.0.1',
        tunnelAuthToken: 'ab'.repeat(32),
        port: 45900,
      }),
    );
  });

  it('does not fall back by profile name when an explicit SSM profile ID is stale', async () => {
    const host = createRdpHost({
      awsSsm: {
        profileId: 'stale-profile-id',
        profileName: 'Production',
        region: 'ap-northeast-2',
        instanceId: 'i-rdp',
      },
    });
    const secret = createRdpSecret();
    resetStore({
      auth: {
        status: 'authenticated',
        session: { tokens: { accessToken: 'access-token' } },
        offline: null,
        errorMessage: null,
      },
      hosts: [host],
      awsProfiles: [{ id: 'profile-1', name: 'Production', kind: 'static' }],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(resolveAwsSessionMock).not.toHaveBeenCalled();
    expect(startSsmPortForwardSessionMock).not.toHaveBeenCalled();
    expect(nativeConnectMock).not.toHaveBeenCalled();
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId),
    ).toEqual(expect.objectContaining({ status: 'error' }));
  });

  it('routes RDP over SSM and owns the forward through disconnect', async () => {
    const host = createRdpHost({
      awsSsm: {
        profileName: 'Production',
        region: 'ap-northeast-2',
        instanceId: 'i-rdp',
      },
    });
    const secret = createRdpSecret();
    resetStore({
      auth: {
        status: 'authenticated',
        session: { tokens: { accessToken: 'access-token' } },
        offline: null,
        errorMessage: null,
      },
      hosts: [host],
      awsProfiles: [{ id: 'profile-1', name: 'Production', kind: 'static' }],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    expect(resolveAwsSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: expect.objectContaining({
          awsProfileId: 'profile-1',
          awsInstanceId: 'i-rdp',
        }),
      }),
    );
    expect(startSsmPortForwardSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'ap-northeast-2',
        instanceId: 'i-rdp',
        remotePort: 3389,
        localPort: 0,
      }),
    );
    expect(lastTunnelPayload()).toEqual(
      expect.objectContaining({
        id: `rd-tunnel:${sessionId}`,
        transport: 'ssm',
        localPort: 54321,
      }),
    );
    expect(nativeConnectMock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        host: host.hostname,
        dialAddress: '127.0.0.1',
        tunnelAuthToken: 'ab'.repeat(32),
        port: 45900,
      }),
    );
    expect(
      getRemoteDesktopHandle(requireSessionId(sessionId))?.ssmForward,
    ).toBeDefined();

    cleanupOrder = [];
    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectRemoteDesktopSession(requireSessionId(sessionId));
    });
    expect(cleanupOrder).toEqual([
      'native-disconnect',
      'tunnel-close',
      'ssm-stop',
      'unsubscribe',
    ]);
    expect(closeTunnelNative).toHaveBeenCalledWith(`rd-tunnel:${sessionId}`);
    expect(engineNative.stopSsmPortForward).toHaveBeenCalledWith(
      'test-forward',
    );
  });

  it('destroys native ownership when the remote side closes the session', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
    });

    cleanupOrder = [];
    await act(async () => {
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'closed',
      });
      await flushAsyncWork(24);
    });

    expect(cleanupOrder).toEqual(['native-disconnect', 'unsubscribe']);
    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
  });

  it('closes a tunnel that finishes opening after the session was cancelled', async () => {
    const host = createVncHost({ tailnetId: 'corp' });
    const secret = createVncSecret();
    const tailnet: TailnetPayload = {
      id: 'corp',
      label: 'Corp',
      tailnetName: 'example.com',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    resetStore({
      hosts: [host],
      tailnets: [tailnet],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let finishTunnel: ((value: string) => void) | null = null;
    openTunnelNative.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishTunnel = resolve;
        }),
    );

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });
    expect(openTunnelNative).toHaveBeenCalledTimes(1);

    cleanupOrder = [];
    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectRemoteDesktopSession(requireSessionId(sessionId));
    });

    await act(async () => {
      finishTunnel?.(
        JSON.stringify({
          tunnelId: `rd-tunnel:${sessionId}`,
          host: '127.0.0.1',
          port: 45900,
          transport: 'tailscale',
        }),
      );
      await flushAsyncWork(24);
    });

    expect(nativeConnectMock).not.toHaveBeenCalled();
    expect(closeTunnelNative).toHaveBeenCalledWith(`rd-tunnel:${sessionId}`);
    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
  });

  it('disconnects again when native connect completes after cancellation', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    const pendingConnect = deferred<void>();
    nativeConnectMock.mockReturnValueOnce(pendingConnect.promise);
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });
    expect(nativeConnectMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectRemoteDesktopSession(requireSessionId(sessionId));
    });
    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingConnect.resolve(undefined);
      await flushAsyncWork(24);
    });

    expect(nativeDisconnectMock).toHaveBeenCalledTimes(2);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId)?.status,
    ).toBe('closed');
  });

  it('logout owns and closes a tunnel that finishes opening late', async () => {
    const host = createVncHost({ tailnetId: 'corp' });
    const secret = createVncSecret();
    const pendingTunnel = deferred<string>();
    openTunnelNative.mockReturnValueOnce(pendingTunnel.promise);
    resetStore({
      hosts: [host],
      tailnets: [
        {
          id: 'corp',
          label: 'Corp',
          tailnetName: 'example.com',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork(24);
    });

    await act(async () => {
      await useMobileAppStore.getState().logout();
    });

    await act(async () => {
      pendingTunnel.resolve(
        JSON.stringify({
          tunnelId: `rd-tunnel:${sessionId}`,
          host: '127.0.0.1',
          port: 45900,
          transport: 'tailscale',
        }),
      );
      await flushAsyncWork(24);
    });

    expect(nativeConnectMock).not.toHaveBeenCalled();
    expect(closeTunnelNative).toHaveBeenCalledWith(`rd-tunnel:${sessionId}`);
    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
  });

  it('disposes exactly once when error is followed by closed', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'error',
        message: 'network lost',
      });
      await flushAsyncWork(24);
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'closed',
      });
      await flushAsyncWork(24);
    });

    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId),
    ).toEqual(expect.objectContaining({ status: 'error' }));
  });

  it('disposes exactly once when closed is followed by error', async () => {
    const host = createVncHost();
    const secret = createVncSecret();
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'closed',
      });
      await flushAsyncWork(24);
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'error',
        message: 'late error',
      });
      await flushAsyncWork(24);
    });

    expect(nativeDisconnectMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(
      useMobileAppStore
        .getState()
        .remoteDesktopSessions.find(record => record.id === sessionId),
    ).toEqual(expect.objectContaining({ status: 'closed' }));
  });

  it('does not persist a certificate accepted by a cancelled runtime', async () => {
    const host = createRdpHost();
    const secret = createRdpSecret();
    const pendingTrust = deferred<void>();
    nativeTrustMock.mockImplementation(async (_sessionId, accepted) => {
      if (accepted) await pendingTrust.promise;
    });
    resetStore({
      hosts: [host],
      secretsByRef: { [secret.secretRef]: secret },
    });

    let sessionId: string | null = null;
    await act(async () => {
      sessionId = await useMobileAppStore.getState().connectToHost(host.id);
      await flushAsyncWork();
      emitSessionEvent({
        sessionId: requireSessionId(sessionId),
        type: 'certificate',
        fingerprint: 'AA:BB',
      });
      await flushAsyncWork();
    });

    let acceptPromise: Promise<void> | null = null;
    await act(async () => {
      acceptPromise = useMobileAppStore.getState().acceptRdpCertificatePrompt();
      await flushAsyncWork();
    });
    await act(async () => {
      await useMobileAppStore
        .getState()
        .disconnectRemoteDesktopSession(requireSessionId(sessionId));
    });
    await act(async () => {
      pendingTrust.resolve(undefined);
      await acceptPromise;
      await flushAsyncWork();
    });

    expect(
      (useMobileAppStore.getState().hosts[0] as RdpHostRecord)
        .certificateFingerprint,
    ).toBeUndefined();
    expect(getRemoteDesktopHandle(requireSessionId(sessionId))).toBeUndefined();
  });
});
