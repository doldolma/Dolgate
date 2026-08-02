import { fromByteArray } from 'base64-js';

// The Go engine reaches the native module through NativeModules, so the module
// is installed before the adapter is imported.
const mockNative = {
  getEngineVersion: jest.fn(),
  probeHostKey: jest.fn(),
  inspectPrivateKey: jest.fn(),
  inspectCertificate: jest.fn(),
  connect: jest.fn(),
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

// What the engine reports for a probe: the key only, no address.
const PROBED_KEY = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5probe',
  fingerprintSha256: 'SHA256:probe',
};

// What the caller must receive: the known-hosts shape, address included.
const EXPECTED_KEY_INFO = {
  host: '10.0.0.1',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:probe',
  keyBase64: 'AAAAC3NzaC1lZDI1NTE5probe',
};

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

  mockNative.probeHostKey.mockResolvedValue(JSON.stringify(PROBED_KEY));
  mockNative.connect.mockResolvedValue(JSON.stringify({ id: 'conn-1' }));
  mockNative.startShell.mockResolvedValue({
    shellId: 'conn-1#1',
    info: JSON.stringify({ channelId: 1 }),
  });
  mockNative.followOutput.mockResolvedValue(7);
});

describe('connect', () => {
  it('probes the host, asks the caller, then connects trusting that exact key', async () => {
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions();

    const connection = await engine.connect(options);

    expect(options.onServerKey).toHaveBeenCalledWith(EXPECTED_KEY_INFO);

    // The probe must not claim to trust anything yet.
    const probePayload = JSON.parse(mockNative.probeHostKey.mock.calls[0][0]);
    expect(probePayload.trustedHostKeyBase64).toBe('');
    expect(probePayload.host).toBe('10.0.0.1');

    // The real connect carries exactly the accepted key.
    const [connectionId, requestJson] = mockNative.connect.mock.calls[0];
    expect(connectionId).toBe('conn-1');
    const connectPayload = JSON.parse(requestJson);
    expect(connectPayload.trustedHostKeyBase64).toBe(PROBED_KEY.publicKeyBase64);
    expect(connectPayload.authType).toBe('password');
    expect(connectPayload.password).toBe('s3cret');
    expect(connectPayload.rows).toBe(30);
    expect(connectPayload.cols).toBe(100);

    expect(connection.id).toBe('conn-1');
  });

  it('aborts without connecting when the caller rejects the host key', async () => {
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      onServerKey: jest.fn().mockResolvedValue(false),
    });

    await expect(engine.connect(options)).rejects.toThrow(/신뢰/);
    expect(mockNative.connect).not.toHaveBeenCalled();
  });

  // The probe is a whole extra TCP connection and key exchange, so a host whose
  // keys are already on file must not pay for it.
  it('skips the probe entirely when keys are already on file', async () => {
    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      trustedHostKeysBase64: ['AAAAKEY1', 'AAAAKEY2'],
    });

    const connection = await engine.connect(options);

    expect(mockNative.probeHostKey).not.toHaveBeenCalled();
    expect(options.onServerKey).not.toHaveBeenCalled();
    expect(connection.id).toBe('conn-1');

    // All of them go over, because the server picks which algorithm it presents.
    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.trustedHostKeysBase64).toEqual(['AAAAKEY1', 'AAAAKEY2']);
  });

  it('does not skip the probe when the key list is empty', async () => {
    const engine = new GoSshEngineAdapter();
    await engine.connect(baseConnectOptions({ trustedHostKeysBase64: [] }));

    expect(mockNative.probeHostKey).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.trustedHostKeysBase64).toBeUndefined();
  });

  it('uses the same Tailnet route for the host-key probe and connection', async () => {
    const engine = new GoSshEngineAdapter();
    await engine.connect(
      baseConnectOptions({
        tailnet: { tailnetId: 'corp', tailnetName: 'example.com' },
      }),
    );

    const probe = JSON.parse(mockNative.probeHostKey.mock.calls[0][0]);
    const connect = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(probe).toEqual(
      expect.objectContaining({
        tailnetId: 'corp',
        tailnetName: 'example.com',
      }),
    );
    expect(connect).toEqual(
      expect.objectContaining({
        tailnetId: 'corp',
        tailnetName: 'example.com',
      }),
    );
  });

  // A host that presents something outside the list has to reach the prompt, not
  // hand the caller a bare mismatch error: it may have rotated its key, dropped
  // the algorithm on file, or be an impostor, and only the caller can tell.
  it('falls back to the probe when the keys on file are rejected', async () => {
    mockNative.connect
      .mockRejectedValueOnce(new Error('connect: host key mismatch'))
      .mockResolvedValueOnce(JSON.stringify({ id: 'conn-1' }));

    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      trustedHostKeysBase64: ['AAAASTALE'],
    });

    const connection = await engine.connect(options);

    expect(mockNative.probeHostKey).toHaveBeenCalledTimes(1);
    expect(options.onServerKey).toHaveBeenCalledWith(EXPECTED_KEY_INFO);
    expect(connection.id).toBe('conn-1');

    // The retry trusts what the caller just accepted, not the stale list.
    const retry = JSON.parse(mockNative.connect.mock.calls[1][1]);
    expect(retry.trustedHostKeyBase64).toBe(PROBED_KEY.publicKeyBase64);
    expect(retry.trustedHostKeysBase64).toBeUndefined();
  });

  it('surfaces a non-mismatch failure instead of probing again', async () => {
    mockNative.connect.mockRejectedValueOnce(new Error('connection refused'));

    const engine = new GoSshEngineAdapter();
    const options = baseConnectOptions({
      trustedHostKeysBase64: ['AAAAKEY1'],
    });

    await expect(engine.connect(options)).rejects.toThrow(/refused/);
    expect(mockNative.probeHostKey).not.toHaveBeenCalled();
    expect(options.onServerKey).not.toHaveBeenCalled();
  });

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
