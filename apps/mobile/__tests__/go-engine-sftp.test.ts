import { fromByteArray, toByteArray } from 'base64-js';

const mockNative = {
  probeHostKey: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  startSftp: jest.fn(),
  sftpList: jest.fn(),
  sftpReadChunk: jest.fn(),
  sftpWriteChunk: jest.fn(),
  sftpMkdir: jest.fn(),
  sftpRename: jest.fn(),
  sftpChmod: jest.fn(),
  sftpRemove: jest.fn(),
  sftpStat: jest.fn(),
  closeSftp: jest.fn(),
  deriveArgon2idKey: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};


import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).GoSshEngineModule = mockNative;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoSshEngineAdapter } = require('../src/engine/goEngine');

const PROBED_KEY = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5probe',
  fingerprintSha256: 'SHA256:probe',
};

function connectOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'sftp-conn-1',
    host: '10.0.0.1',
    port: 22,
    username: 'tester',
    credential: { type: 'password' as const, password: 's3cret' },
    onServerKey: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockNative).forEach(fn => fn.mockReset());
  mockNative.probeHostKey.mockResolvedValue(JSON.stringify(PROBED_KEY));
  mockNative.connect.mockResolvedValue(JSON.stringify({ id: 'sftp-conn-1' }));
  mockNative.startSftp.mockResolvedValue('sftp-conn-1~sftp1');
});

async function openSftp() {
  const engine = new GoSshEngineAdapter();
  return engine.connectSftp(connectOptions());
}

describe('connectSftp', () => {
  it('goes through the same probe-then-connect handshake as a shell', async () => {
    const engine = new GoSshEngineAdapter();
    const options = connectOptions();

    const sftp = await engine.connectSftp(options);

    expect(options.onServerKey).toHaveBeenCalledWith(
      expect.objectContaining({ keyBase64: PROBED_KEY.publicKeyBase64 }),
    );
    const payload = JSON.parse(mockNative.connect.mock.calls[0][1]);
    expect(payload.trustedHostKeyBase64).toBe(PROBED_KEY.publicKeyBase64);
    expect(mockNative.startSftp).toHaveBeenCalledWith('sftp-conn-1');
    expect(sftp.id).toBe('sftp-conn-1~sftp1');
  });

  it('aborts without connecting when the host key is rejected', async () => {
    const engine = new GoSshEngineAdapter();
    await expect(
      engine.connectSftp(connectOptions({ onServerKey: jest.fn().mockResolvedValue(false) })),
    ).rejects.toThrow(/신뢰/);
    expect(mockNative.connect).not.toHaveBeenCalled();
    expect(mockNative.startSftp).not.toHaveBeenCalled();
  });

  // The connection is already established by the time the session is opened, so
  // a failure there has to tear it down rather than leave it dangling.
  it('drops the connection when opening the session fails', async () => {
    mockNative.startSftp.mockRejectedValue(new Error('subsystem refused'));
    const engine = new GoSshEngineAdapter();

    await expect(engine.connectSftp(connectOptions())).rejects.toThrow(/subsystem/);
    expect(mockNative.disconnect).toHaveBeenCalledWith('sftp-conn-1');
  });
});

describe('file operations', () => {
  it('decodes a listing into the browser’s entry shape', async () => {
    const sftp = await openSftp();
    mockNative.sftpList.mockResolvedValue(
      JSON.stringify({
        path: '/home/u',
        entries: [
          {
            name: 'note.txt',
            path: '/home/u/note.txt',
            isDirectory: false,
            size: 12,
            mtime: '2026-07-27T00:00:00Z',
            kind: 'file',
            permissions: '-rw-r--r--',
          },
        ],
      }),
    );

    const listing = await sftp.list('/home/u');

    expect(mockNative.sftpList).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/home/u');
    expect(listing.path).toBe('/home/u');
    expect(listing.entries[0]).toEqual(
      expect.objectContaining({ name: 'note.txt', kind: 'file', size: 12 }),
    );
  });

  it('decodes a read and carries the eof flag through', async () => {
    const sftp = await openSftp();
    mockNative.sftpReadChunk.mockResolvedValue({
      dataBase64: fromByteArray(new Uint8Array([1, 2, 3])),
      eof: true,
    });

    const chunk = await sftp.readChunk('/f.bin', 128, 64);

    expect(mockNative.sftpReadChunk).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/f.bin', 128, 64);
    expect(Array.from(chunk.bytes)).toEqual([1, 2, 3]);
    expect(chunk.eof).toBe(true);
  });

  it('encodes a write as base64 at the requested offset', async () => {
    const sftp = await openSftp();
    const bytes = new Uint8Array([9, 8, 7]);

    await sftp.writeChunk('/f.bin', 256, bytes);

    expect(mockNative.sftpWriteChunk).toHaveBeenCalledWith(
      'sftp-conn-1~sftp1',
      '/f.bin',
      256,
      fromByteArray(bytes),
    );
  });

  it('forwards the mutating operations', async () => {
    const sftp = await openSftp();

    await sftp.mkdir('/d');
    await sftp.rename('/a', '/b');
    await sftp.chmod('/f', 0o600);
    await sftp.remove('/f');

    expect(mockNative.sftpMkdir).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/d');
    expect(mockNative.sftpRename).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/a', '/b');
    expect(mockNative.sftpChmod).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/f', 0o600);
    expect(mockNative.sftpRemove).toHaveBeenCalledWith('sftp-conn-1~sftp1', '/f');
  });

  it('decodes a stat entry', async () => {
    const sftp = await openSftp();
    mockNative.sftpStat.mockResolvedValue(
      JSON.stringify({ name: 'f', path: '/f', isDirectory: false, size: 1, mtime: 'x', kind: 'file' }),
    );

    const entry = await sftp.stat('/f');
    expect(entry.name).toBe('f');
  });

  // The session rides on its own connection, so closing it has to take the
  // connection with it or the transport leaks for the life of the process.
  it('closes the session and its connection', async () => {
    const sftp = await openSftp();
    await sftp.close();

    expect(mockNative.closeSftp).toHaveBeenCalledWith('sftp-conn-1~sftp1');
    expect(mockNative.disconnect).toHaveBeenCalledWith('sftp-conn-1');
  });

  it('still drops the connection when closing the session errors', async () => {
    const sftp = await openSftp();
    mockNative.closeSftp.mockRejectedValue(new Error('already gone'));

    await expect(sftp.close()).rejects.toThrow(/already gone/);
    expect(mockNative.disconnect).toHaveBeenCalledWith('sftp-conn-1');
  });
});

describe('vault KDF', () => {
  // A KEK that differs by a byte makes an existing vault undecryptable, so the
  // parameters must reach the engine exactly as given.
  it('passes the passphrase, salt and cost through unchanged', async () => {
    const engine = new GoSshEngineAdapter();
    const derived = new Uint8Array(32).fill(7);
    mockNative.deriveArgon2idKey.mockResolvedValue(fromByteArray(derived));

    const passphrase = new Uint8Array([1, 2, 3]);
    const salt = new Uint8Array(16).fill(9);

    const got = await engine.deriveArgon2idKey(passphrase, salt, {
      memoryKib: 65536,
      timeCost: 3,
      parallelism: 1,
      outputLength: 32,
    });

    expect(mockNative.deriveArgon2idKey).toHaveBeenCalledWith(
      fromByteArray(passphrase),
      fromByteArray(salt),
      65536,
      3,
      1,
      32,
    );
    expect(Array.from(got)).toEqual(Array.from(toByteArray(fromByteArray(derived))));
  });

  it('surfaces a derivation failure rather than returning a wrong key', async () => {
    const engine = new GoSshEngineAdapter();
    mockNative.deriveArgon2idKey.mockRejectedValue(new Error('salt must be 8-64 bytes'));

    await expect(
      engine.deriveArgon2idKey(new Uint8Array([1]), new Uint8Array([1]), {
        memoryKib: 65536,
        timeCost: 3,
        parallelism: 1,
        outputLength: 32,
      }),
    ).rejects.toThrow(/salt/);
  });
});
