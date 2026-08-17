import { fromByteArray } from 'base64-js';

// The Go engine reaches the native module through NativeModules, so the module
// is installed before the adapter is imported.
const mockNative = {
  getEngineVersion: jest.fn(),
  probeHostKey: jest.fn(),
  inspectPrivateKey: jest.fn(),
  inspectCertificate: jest.fn(),
  connect: jest.fn(),
  respondKeyboardInteractive: jest.fn(),
  respondHostKeyTrust: jest.fn(),
  cancelConnect: jest.fn(),
  disconnect: jest.fn(),
  startShell: jest.fn(),
  sendData: jest.fn(),
  resize: jest.fn(),
  closeShell: jest.fn(),
  readBuffer: jest.fn(),
  getShellStats: jest.fn(),
  getCurrentSeq: jest.fn(),
  followOutput: jest.fn(),
  unfollowOutput: jest.fn(),
  configureTailnets: jest.fn(),
  startTailnet: jest.fn(),
  cancelTailnet: jest.fn(),
  disconnectTailnet: jest.fn(),
  snapshotTailnets: jest.fn(),
  forgetTailnet: jest.fn(),
  closeTailnets: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

// NativeEventEmitter delegates to RCTDeviceEventEmitter, which is what
// DeviceEventEmitter exports, so events can be injected through the real
// plumbing instead of a stand-in emitter.
import { DeviceEventEmitter, NativeModules } from 'react-native';

// The adapter looks the native module up on each call rather than at import
// time, so installing it here is enough regardless of module order.
(NativeModules as Record<string, unknown>).GoSshEngineModule = mockNative;

// 어댑터가 마지막 구독에 부여한 토큰. 이벤트는 이 토큰으로만 라우팅된다.
function lastToken(): string {
  const calls = mockNative.followOutput.mock.calls;
  return String(calls[calls.length - 1]?.[1] ?? '');
}

function emitNative(eventName: string, payload: unknown): void {
  DeviceEventEmitter.emit(eventName, payload);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engineModule = require('../src/engine');
const { GoSshEngineAdapter } = require('../src/engine/goEngine');

const EVENT_CONNECTION = 'GoSshEngine:connection';

// What the engine reports when a server presents a key it was not given.
const PRESENTED_KEY = {
  challengeId: 'hostkey-trust-1',
  algorithm: 'ssh-ed25519',
  publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5presented',
  fingerprintSha256: 'SHA256:presented',
  mismatch: false,
};

// What the caller must receive: the known-hosts shape, address included.
const EXPECTED_KEY_INFO = {
  host: '10.0.0.1',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:presented',
  keyBase64: 'AAAAC3NzaC1lZDI1NTE5presented',
};

/**
 * Makes the native connect behave the way the engine does: it raises a question
 * mid-dial, waits for the answer, and ends the dial if the answer refuses.
 *
 * A mock that only emitted would prove nothing — the whole point is that the
 * connect is still open while the person is being asked, so the answer has to be
 * what decides it.
 */
function nativeConnectAsking(
  event: Record<string, unknown>,
  options: { failWhenRefused?: boolean } = {},
): void {
  mockNative.connect.mockImplementation(async (connectionId: string) => {
    const answered = new Promise<{ trust?: boolean; cancelled?: boolean }>(resolve => {
      mockNative.respondHostKeyTrust.mockImplementation(
        async (_challengeId: string, trust: boolean) => {
          resolve({ trust });
        },
      );
      mockNative.respondKeyboardInteractive.mockImplementation(
        async (payloadJson: string) => {
          resolve(JSON.parse(payloadJson));
        },
      );
    });
    emitNative(EVENT_CONNECTION, {
      eventJson: JSON.stringify({ sessionId: connectionId, ...event }),
    });
    const answer = await answered;
    if (options.failWhenRefused !== false && (answer.trust === false || answer.cancelled)) {
      throw new Error('connect: trusted host key is required');
    }
    return JSON.stringify({ id: connectionId });
  });
}

function trustChallengeEvent(payload: Record<string, unknown> = {}) {
  return {
    type: 'hostKeyTrustChallenge',
    payload: { ...PRESENTED_KEY, ...payload },
  };
}

function baseConnectOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'conn-1',
    host: '10.0.0.1',
    port: 22,
    username: 'tester',
    credential: { type: 'password' as const, password: 's3cret' },
    size: { rows: 30, cols: 100 },
    onServerKey: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockNative).forEach(fn => fn.mockReset());
  engineModule.resetGoEngineEvents();
  engineModule.resetEngine();

  mockNative.connect.mockResolvedValue(JSON.stringify({ id: 'conn-1' }));
  mockNative.startShell.mockResolvedValue({
    shellId: 'conn-1#1',
    info: JSON.stringify({ channelId: 1 }),
  });
  mockNative.followOutput.mockResolvedValue(7);
});

describe('connect', () => {
  // 이 한 건이 이번 변경의 핵심이다. 예전에는 붙기 **전에** 별도 연결로 키를 읽어 와 물었다 —
  // OTP 를 요구하는 호스트에서는 그 프로브가 코드를 한 번 먹고, 진짜 연결이 다시 물을 때는 코드가
  // 이미 바뀌어 있었다.
  it('asks about the key inside the connection, without a probe', async () => {
    nativeConnectAsking(trustChallengeEvent());
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions();

    const connection = await engine.connect(options);

    expect(mockNative.probeHostKey).not.toHaveBeenCalled();
    expect(options.onServerKey).toHaveBeenCalledWith(
      EXPECTED_KEY_INFO,
      expect.objectContaining({
        challengeId: 'hostkey-trust-1',
        mismatch: false,
      }),
    );
    // 승낙은 그 물음으로 되돌아가야 한다. 안 보내면 연결은 예산까지 서 있는다.
    expect(mockNative.respondHostKeyTrust).toHaveBeenCalledWith('hostkey-trust-1', true);

    const [connectionId, requestJson] = mockNative.connect.mock.calls[0];
    expect(connectionId).toBe('conn-1');
    const connectPayload = JSON.parse(requestJson);
    expect(connectPayload.authType).toBe('password');
    expect(connectPayload.password).toBe('s3cret');
    expect(connectPayload.rows).toBe(30);
    expect(connectPayload.cols).toBe(100);
    expect(connection.id).toBe('conn-1');
  });

  // 거절은 답을 **보내기 전에** 기록돼야 한다. 브리지를 건너는 respondHostKeyTrust 가 끝나기를
  // 기다린 뒤에 기록하면, 코어가 "아니오" 를 듣고 dial 을 끝낸 오류가 먼저 도착해 사용자의 거절이
  // "호스트 키를 확인할 수 없음" 으로 바뀐다. 여기서는 그 왕복을 일부러 늦춰 그 순서를 붙잡는다.
  it('refuses the key when the caller declines, and says so', async () => {
    mockNative.connect.mockImplementation(async (connectionId: string) => {
      const decided = new Promise<boolean>(resolve => {
        mockNative.respondHostKeyTrust.mockImplementation(
          (_challengeId: string, trust: boolean) => {
            // 결정은 곧바로 알려지지만, 이 호출의 약속은 나중에 끝난다(네이티브 왕복).
            resolve(trust);
            return new Promise<void>(done => setTimeout(done, 20));
          },
        );
      });
      emitNative(EVENT_CONNECTION, {
        eventJson: JSON.stringify({ sessionId: connectionId, ...trustChallengeEvent() }),
      });
      if (!(await decided)) {
        throw new Error('connect: trusted host key is required');
      }
      return JSON.stringify({ id: connectionId });
    });

    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      onServerKey: jest.fn().mockResolvedValue(false),
    });

    await expect(engine.connect(options)).rejects.toThrow(/신뢰/);
    expect(mockNative.respondHostKeyTrust).toHaveBeenCalledWith('hostkey-trust-1', false);
  });

  // 사용자가 거절한 것과 키를 확인할 수 없는 것은 다른 일이다. 코어의 문구를 그대로 올리면
  // "당신이 아니라고 했다" 가 "확인 실패" 로 보인다.
  it('reports a core failure as itself when nothing was declined', async () => {
    mockNative.connect.mockRejectedValueOnce(new Error('connection refused'));
    const engine = new GoSshEngineAdapter();

    await expect(engine.connect(baseConnectOptions())).rejects.toThrow(/refused/);
  });

  // 저장된 키를 내민 호스트는 물어볼 일이 없다 — 코어가 목록과 맞춰 보고 통과시킨다.
  it('sends every key on file so the server can pick its algorithm', async () => {
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      trustedHostKeysBase64: ['AAAAKEY1', 'AAAAKEY2'],
    });

    const connection = await engine.connect(options);

    expect(options.onServerKey).not.toHaveBeenCalled();
    expect(connection.id).toBe('conn-1');
    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.trustedHostKeysBase64).toEqual(['AAAAKEY1', 'AAAAKEY2']);
    expect(payload.trustedHostKeyBase64).toBe('AAAAKEY1');
  });

  it('omits the key list when there is nothing on file', async () => {
    nativeConnectAsking(trustChallengeEvent());
    const engine = new GoSshEngineAdapter();
    await engine.connect(baseConnectOptions({ trustedHostKeysBase64: [] }));

    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.trustedHostKeysBase64).toBeUndefined();
    expect(payload.trustedHostKeyBase64).toBe('');
  });

  // 키가 바뀐 경우도 실패가 아니라 물음이다 — 회전했을 수도, 알고리즘이 달라졌을 수도, 다른
  // 장비일 수도 있고, 그 판단은 사용자만 할 수 있다.
  it('asks again when the presented key is not the one on file', async () => {
    nativeConnectAsking(trustChallengeEvent({ mismatch: true }));
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({ trustedHostKeysBase64: ['AAAASTALE'] });

    const connection = await engine.connect(options);

    expect(mockNative.probeHostKey).not.toHaveBeenCalled();
    expect(options.onServerKey).toHaveBeenCalledWith(
      EXPECTED_KEY_INFO,
      expect.objectContaining({ mismatch: true }),
    );
    expect(connection.id).toBe('conn-1');
    // 다시 붙지 않는다. 예전에는 여기서 프로브를 하고 두 번째 connect 를 걸었다.
    expect(mockNative.connect).toHaveBeenCalledTimes(1);
  });

  // 점프 체인에서는 키를 내민 쪽이 요청한 호스트가 아니다. 요청 주소로 기록하면 베스천의 키가
  // 그 뒤 호스트의 것으로 저장된다.
  it('files the key under the server that presented it', async () => {
    nativeConnectAsking(
      trustChallengeEvent({ hop: { username: 'jump', host: '10.9.9.9', port: 2222 } }),
    );
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions();

    await engine.connect(options);

    expect(options.onServerKey).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.9.9.9', port: 2222 }),
      expect.objectContaining({
        hop: { username: 'jump', host: '10.9.9.9', port: 2222 },
      }),
    );
  });

  it('carries the Tailnet route on the connect', async () => {
    const engine = new GoSshEngineAdapter();
    await engine.connect(
      baseConnectOptions({
        trustedHostKeysBase64: ['AAAAKEY1'],
        tailnet: { tailnetId: 'corp', tailnetName: 'example.com' },
      }),
    );

    expect(JSON.parse(mockNative.connect.mock.calls[0][1])).toEqual(
      expect.objectContaining({
        tailnetId: 'corp',
        tailnetName: 'example.com',
      }),
    );
  });
});

describe('interactive authentication', () => {
  function otpChallengeEvent(payload: Record<string, unknown> = {}) {
    return {
      type: 'keyboardInteractiveChallenge',
      payload: {
        challengeId: 'conn-1-2',
        attempt: 2,
        name: '',
        instruction: 'Two-factor',
        hasStoredPassword: true,
        prompts: [
          {
            label: 'Verification code:',
            echo: false,
            allowStoredPassword: false,
            masked: false,
          },
        ],
        ...payload,
      },
    };
  }

  // 모바일에는 이 창구가 없어서 OTP 호스트에 아예 붙을 수 없었다.
  it('asks the caller and sends the answer back to the challenge', async () => {
    nativeConnectAsking(otpChallengeEvent());
    const onInteractiveChallenge = jest.fn().mockResolvedValue({ responses: ['123456'] });
    const engine = new GoSshEngineAdapter();

    const connection = await engine.connect(
      baseConnectOptions({ trustedHostKeysBase64: ['AAAAKEY1'], onInteractiveChallenge }),
    );

    expect(onInteractiveChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'conn-1-2',
        attempt: 2,
        instruction: 'Two-factor',
        hasStoredPassword: true,
        prompts: [
          {
            label: 'Verification code:',
            echo: false,
            allowStoredPassword: false,
            // 인증 코드는 일부러 가리지 않는다 — 코어가 프롬프트마다 내리는 판정을 그대로 옮긴다.
            masked: false,
          },
        ],
      }),
    );
    expect(JSON.parse(mockNative.respondKeyboardInteractive.mock.calls[0][0])).toEqual({
      challengeId: 'conn-1-2',
      responses: ['123456'],
    });
    expect(connection.id).toBe('conn-1');
  });

  // 값이 아니라 칸 번호만 돌려보낸다. 비밀번호를 앱으로 꺼냈다 다시 넣지 않는다.
  it('points at the prompts the saved password should fill', async () => {
    nativeConnectAsking(
      otpChallengeEvent({
        prompts: [
          { label: 'Password:', echo: false, allowStoredPassword: true, masked: true },
          {
            label: 'Verification code:',
            echo: false,
            allowStoredPassword: false,
            masked: false,
          },
        ],
      }),
    );
    const engine = new GoSshEngineAdapter();

    await engine.connect(
      baseConnectOptions({
        trustedHostKeysBase64: ['AAAAKEY1'],
        onInteractiveChallenge: jest.fn().mockResolvedValue({
          responses: ['', '123456'],
          storedPasswordIndexes: [0],
        }),
      }),
    );

    expect(JSON.parse(mockNative.respondKeyboardInteractive.mock.calls[0][0])).toEqual({
      challengeId: 'conn-1-2',
      responses: ['', '123456'],
      storedPasswordIndexes: [0],
    });
  });

  // 닫았다는 것도 답이다. 아무것도 보내지 않으면 연결은 예산(5분)까지 기다리고, tailnet 경유면
  // 그동안 그 노드의 리스를 붙잡고 있다.
  it('reports a dismissed prompt as cancelled', async () => {
    nativeConnectAsking(otpChallengeEvent());
    const engine = new GoSshEngineAdapter();

    await expect(
      engine.connect(
        baseConnectOptions({
          trustedHostKeysBase64: ['AAAAKEY1'],
          onInteractiveChallenge: jest.fn().mockResolvedValue(null),
        }),
      ),
    ).rejects.toThrow();

    expect(JSON.parse(mockNative.respondKeyboardInteractive.mock.calls[0][0])).toEqual({
      challengeId: 'conn-1-2',
      responses: [],
      cancelled: true,
    });
  });

  // 물어볼 자리가 없는 호출(백그라운드 재연결 등)은 기다리게 두지 않고 접는다.
  it('cancels instead of hanging when the caller cannot ask', async () => {
    nativeConnectAsking(otpChallengeEvent());
    const engine = new GoSshEngineAdapter();

    await expect(
      engine.connect(baseConnectOptions({ trustedHostKeysBase64: ['AAAAKEY1'] })),
    ).rejects.toThrow();

    expect(JSON.parse(mockNative.respondKeyboardInteractive.mock.calls[0][0])).toEqual({
      challengeId: 'conn-1-2',
      responses: [],
      cancelled: true,
    });
  });

  it('hands the server banner to the caller while the connection waits', async () => {
    nativeConnectAsking(otpChallengeEvent());
    const onBanner = jest.fn();
    mockNative.connect.mockImplementation(async (connectionId: string) => {
      emitNative(EVENT_CONNECTION, {
        eventJson: JSON.stringify({
          type: 'sshBanner',
          sessionId: connectionId,
          payload: { text: 'Approve this login at https://example.com/approve' },
        }),
      });
      return JSON.stringify({ id: connectionId });
    });
    const engine = new GoSshEngineAdapter();

    await engine.connect(
      baseConnectOptions({ trustedHostKeysBase64: ['AAAAKEY1'], onBanner }),
    );

    expect(onBanner).toHaveBeenCalledWith(
      'Approve this login at https://example.com/approve',
    );
  });

  // 다른 연결의 물음이 이 연결의 창구로 가면 사용자는 엉뚱한 코드를 넣게 되고, 방식당 시도는
  // 한 번뿐이라 그걸로 끝난다.
  it('ignores a prompt addressed to another connection', async () => {
    const onInteractiveChallenge = jest.fn().mockResolvedValue({ responses: ['123456'] });
    mockNative.connect.mockImplementation(async (connectionId: string) => {
      emitNative(EVENT_CONNECTION, {
        eventJson: JSON.stringify({
          ...otpChallengeEvent(),
          sessionId: 'someone-else',
        }),
      });
      return JSON.stringify({ id: connectionId });
    });
    const engine = new GoSshEngineAdapter();

    await engine.connect(
      baseConnectOptions({ trustedHostKeysBase64: ['AAAAKEY1'], onInteractiveChallenge }),
    );

    expect(onInteractiveChallenge).not.toHaveBeenCalled();
    expect(mockNative.respondKeyboardInteractive).not.toHaveBeenCalled();
  });
});

describe('connect payload', () => {
  it('maps a private key credential onto the desktop connect payload', async () => {
    const engine = new GoSshEngineAdapter();
    await engine.connect(
      baseConnectOptions({
        credential: {
          type: 'key',
          privateKey: 'PEM',
          passphrase: 'phrase',
        },
      }),
    );

    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.authType).toBe('privateKey');
    expect(payload.privateKeyPem).toBe('PEM');
    expect(payload.passphrase).toBe('phrase');
  });

  it('maps a certificate credential onto the desktop connect payload', async () => {
    const engine = new GoSshEngineAdapter();
    await engine.connect(
      baseConnectOptions({
        credential: {
          type: 'certificate',
          privateKey: 'PEM',
          certificate: 'CERT',
        },
      }),
    );

    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.authType).toBe('certificate');
    expect(payload.privateKeyPem).toBe('PEM');
    expect(payload.certificateText).toBe('CERT');
    expect(payload.passphrase).toBeUndefined();
  });

  it('routes a transport loss to onDisconnected', async () => {
    const engine = new GoSshEngineAdapter();
    const onDisconnected = jest.fn();
    await engine.connect(baseConnectOptions({ onDisconnected }));

    emitNative('GoSshEngine:disconnected', { connectionId: 'conn-1' });
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('stops routing disconnects after an explicit disconnect', async () => {
    const engine = new GoSshEngineAdapter();
    const onDisconnected = jest.fn();
    const connection = await engine.connect(baseConnectOptions({ onDisconnected }));

    await connection.disconnect();
    emitNative('GoSshEngine:disconnected', { connectionId: 'conn-1' });

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(mockNative.disconnect).toHaveBeenCalledWith('conn-1');
  });
});

describe('tailnet runtime', () => {
  it('configures an account scope and routes native status events', async () => {
    const engine = new GoSshEngineAdapter();
    const onEvent = jest.fn();

    await engine.configureTailnets(
      'https://sync.example.test|user-1',
      [{ id: 'corp', controlUrl: 'https://control.example.test' }],
      onEvent,
    );
    expect(mockNative.configureTailnets).toHaveBeenCalledWith(
      'https://sync.example.test|user-1',
      JSON.stringify({
        configs: [{ id: 'corp', controlUrl: 'https://control.example.test' }],
      }),
    );

    emitNative('GoSshEngine:tailnet', {
      eventJson: JSON.stringify({
        type: 'tailnetStatus',
        requestId: 'start-1',
        payload: { id: 'corp', state: 'Running', ready: true },
      }),
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'tailnetStatus',
      requestId: 'start-1',
      payload: { id: 'corp', state: 'Running', ready: true },
    });
  });

  it('serializes start and lifecycle commands without changing their ids', async () => {
    const engine = new GoSshEngineAdapter();

    await engine.startTailnet('start-1', { id: 'corp', authKey: 'tskey-secret' }, 12_000);
    expect(mockNative.startTailnet).toHaveBeenCalledWith(
      'start-1',
      JSON.stringify({
        config: { id: 'corp', authKey: 'tskey-secret' },
        timeoutMs: 12_000,
      }),
    );

    await engine.cancelTailnet('cancel-1', 'corp');
    await engine.disconnectTailnet('disconnect-1', 'corp');
    await engine.snapshotTailnets('snapshot-1');
    await engine.forgetTailnet('corp');
    await engine.closeTailnets();

    expect(mockNative.cancelTailnet).toHaveBeenCalledWith('cancel-1', 'corp');
    expect(mockNative.disconnectTailnet).toHaveBeenCalledWith('disconnect-1', 'corp');
    expect(mockNative.snapshotTailnets).toHaveBeenCalledWith('snapshot-1');
    expect(mockNative.forgetTailnet).toHaveBeenCalledWith('corp');
    expect(mockNative.closeTailnets).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed native Tailnet events', async () => {
    const engine = new GoSshEngineAdapter();
    const onEvent = jest.fn();
    await engine.configureTailnets('scope', [], onEvent);

    emitNative('GoSshEngine:tailnet', { eventJson: '{bad' });
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('shell output', () => {
  async function openShell() {
    const engine = new GoSshEngineAdapter();
    const connection = await engine.connect(baseConnectOptions());
    return connection.startShell({ term: 'xterm-256color' });
  }

  it('falls back to the connect geometry when shell options omit it', async () => {
    await openShell();
    const options = JSON.parse(mockNative.startShell.mock.calls[0][1]);
    expect(options.rows).toBe(30);
    expect(options.cols).toBe(100);
    expect(options.term).toBe('xterm-256color');
  });

  it('sends bytes as base64', async () => {
    const shell = await openShell();
    await shell.sendData(new Uint8Array([104, 105, 10]));

    expect(mockNative.sendData).toHaveBeenCalledWith('conn-1#1', fromByteArray(new Uint8Array([104, 105, 10])));
  });

  it('decodes a replay read and reports its resume cursor', async () => {
    const shell = await openShell();
    mockNative.readBuffer.mockResolvedValue({
      dataBase64: fromByteArray(new Uint8Array([1, 2, 3])),
      nextSeq: 42,
      hasDropped: false,
    });

    const result = await shell.readBuffer({ mode: 'head' });

    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(result.nextSeq).toBe(42);
    expect(result.dropped).toBeUndefined();

    // Cursor flattening: head is mode 0 with unused slots zeroed.
    expect(mockNative.readBuffer).toHaveBeenCalledWith('conn-1#1', 0, 0, 0, 0, 0);
  });

  it('surfaces an evicted range so the terminal can show a gap', async () => {
    const shell = await openShell();
    mockNative.readBuffer.mockResolvedValue({
      dataBase64: '',
      nextSeq: 9,
      hasDropped: true,
      droppedFromSeq: 3,
      droppedToSeq: 5,
    });

    const result = await shell.readBuffer({ mode: 'seq', seq: 3 });

    expect(result.dropped).toEqual({ fromSeq: 3, toSeq: 5 });
    expect(mockNative.readBuffer).toHaveBeenCalledWith('conn-1#1', 2, 3, 0, 0, 0);
  });

  it('flattens every cursor mode onto the positional arguments', async () => {
    const shell = await openShell();
    mockNative.readBuffer.mockResolvedValue({ dataBase64: '', nextSeq: 0, hasDropped: false });

    await shell.readBuffer({ mode: 'live' });
    expect(mockNative.readBuffer).toHaveBeenLastCalledWith('conn-1#1', 4, 0, 0, 0, 0);

    await shell.readBuffer({ mode: 'tailBytes', bytes: 4096 });
    expect(mockNative.readBuffer).toHaveBeenLastCalledWith('conn-1#1', 1, 0, 4096, 0, 0);

    await shell.readBuffer({ mode: 'timeMs', tMs: 1234.5 });
    expect(mockNative.readBuffer).toHaveBeenLastCalledWith('conn-1#1', 3, 0, 0, 1234.5, 0);
  });

  it('delivers followed chunks to the handler', async () => {
    const shell = await openShell();
    const onChunk = jest.fn();
    const onDropped = jest.fn();

    const listenerId = await shell.follow({ onChunk, onDropped }, {
      cursor: { mode: 'seq', seq: 42 },
      coalesceMs: 16,
    });
    expect(listenerId).toBe(7);
    expect(mockNative.followOutput).toHaveBeenCalledWith(
      'conn-1#1',
      expect.any(String),
      2,
      42,
      0,
      0,
      16,
    );

    emitNative('GoSshEngine:chunk', {
      shellId: 'conn-1#1',
      subscriptionToken: lastToken(),
      seq: 43,
      tMs: 1000,
      stream: 0,
      dataBase64: fromByteArray(new Uint8Array([65, 66])),
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    const chunk = onChunk.mock.calls[0][0];
    expect(Array.from(chunk.bytes)).toEqual([65, 66]);
    expect(chunk.stream).toBe('stdout');
    expect(chunk.seq).toBe(43);

    emitNative('GoSshEngine:dropped', {
      shellId: 'conn-1#1',
      subscriptionToken: lastToken(),
      fromSeq: 44,
      toSeq: 46,
    });
    expect(onDropped).toHaveBeenCalledWith({ fromSeq: 44, toSeq: 46 });
  });

  it('tags stderr chunks distinctly', async () => {
    const shell = await openShell();
    const onChunk = jest.fn();
    await shell.follow({ onChunk }, { cursor: { mode: 'live' } });

    emitNative('GoSshEngine:chunk', {
      shellId: 'conn-1#1',
      subscriptionToken: lastToken(),
      seq: 1,
      tMs: 1,
      stream: 1,
      dataBase64: fromByteArray(new Uint8Array([33])),
    });

    expect(onChunk.mock.calls[0][0].stream).toBe('stderr');
  });

  it('ignores output addressed to another shell', async () => {
    const shell = await openShell();
    const onChunk = jest.fn();
    await shell.follow({ onChunk }, { cursor: { mode: 'live' } });

    emitNative('GoSshEngine:chunk', {
      shellId: 'someone-else#9',
      subscriptionToken: 'someone-else~sub1',
      seq: 1,
      tMs: 1,
      stream: 0,
      dataBase64: fromByteArray(new Uint8Array([1])),
    });

    expect(onChunk).not.toHaveBeenCalled();
  });

  it('stops delivering after unfollow', async () => {
    const shell = await openShell();
    const onChunk = jest.fn();
    const listenerId = await shell.follow({ onChunk }, { cursor: { mode: 'live' } });

    await shell.unfollow(listenerId);
    emitNative('GoSshEngine:chunk', {
      shellId: 'conn-1#1',
      subscriptionToken: lastToken(),
      seq: 1,
      tMs: 1,
      stream: 0,
      dataBase64: fromByteArray(new Uint8Array([1])),
    });

    expect(onChunk).not.toHaveBeenCalled();
    expect(mockNative.unfollowOutput).toHaveBeenCalledWith('conn-1#1', listenerId);
  });

  it('routes the shell-closed callback', async () => {
    const engine = new GoSshEngineAdapter();
    const connection = await engine.connect(baseConnectOptions());
    const onClosed = jest.fn();
    await connection.startShell({ onClosed });

    emitNative('GoSshEngine:shellClosed', { shellId: 'conn-1#1' });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('delivers a close event emitted before startShell returns', async () => {
    mockNative.startShell.mockImplementationOnce(async () => {
      emitNative('GoSshEngine:shellClosed', { shellId: 'conn-1#fast' });
      return {
        shellId: 'conn-1#fast',
        info: JSON.stringify({ channelId: 2 }),
      };
    });
    const engine = new GoSshEngineAdapter();
    const connection = await engine.connect(baseConnectOptions());
    const onClosed = jest.fn();

    await connection.startShell({ onClosed });
    emitNative('GoSshEngine:shellClosed', { shellId: 'conn-1#fast' });

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('forwards a resize', async () => {
    const shell = await openShell();
    await shell.resize({ rows: 50, cols: 200 });
    expect(mockNative.resize).toHaveBeenCalledWith('conn-1#1', 50, 200);
  });
});

describe('credential validation', () => {
  it('reports no problem for a key the engine accepts', async () => {
    mockNative.inspectPrivateKey.mockResolvedValue(JSON.stringify({ algorithm: 'ssh-ed25519' }));
    const engine = new GoSshEngineAdapter();
    await expect(engine.validatePrivateKey('PEM', 'phrase')).resolves.toBeNull();
    expect(mockNative.inspectPrivateKey).toHaveBeenCalledWith('PEM', 'phrase');
  });

  it('reports the engine message for an unusable key', async () => {
    mockNative.inspectPrivateKey.mockRejectedValue(new Error('개인키를 해독할 수 없습니다.'));
    const engine = new GoSshEngineAdapter();
    await expect(engine.validatePrivateKey('bad')).resolves.toMatch(/개인키/);
  });

  it('rejects a certificate the engine reports as not valid', async () => {
    mockNative.inspectCertificate.mockResolvedValue(JSON.stringify({ status: 'expired' }));
    const engine = new GoSshEngineAdapter();
    await expect(engine.validateCertificate('CERT')).resolves.toMatch(/expired/);
  });

  it('accepts a valid certificate', async () => {
    mockNative.inspectCertificate.mockResolvedValue(JSON.stringify({ status: 'valid' }));
    const engine = new GoSshEngineAdapter();
    await expect(engine.validateCertificate('CERT')).resolves.toBeNull();
  });
});
