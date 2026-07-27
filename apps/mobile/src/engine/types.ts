// The engine-neutral SSH surface the session flow talks to.
//
// One implementation backs it: the Go engine (gomobile bindings over
// services/ssh-core/mobile). The interface remains because it is what keeps the
// bridge out of the session flow.
//
// The shapes here deliberately match what the store already produces. That is
// what allowed the engine underneath to be replaced without the session flow
// changing, and it is worth preserving for the same reason.

/** Credentials, in the same shape the host records already yield. */
export type EngineCredential =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string }
  | {
      type: 'certificate';
      privateKey: string;
      certificate: string;
      passphrase?: string;
    };

/**
 * A host key as presented by the server.
 *
 * The field names match MobileServerPublicKeyInfo in src/lib/mobile.ts, so the
 * known-hosts logic accepts this without a translation step.
 */
export type ServerPublicKeyInfo = {
  host: string;
  port: number;
  remoteIp?: string;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
};

/** Where to start reading a shell's retained output. */
export type EngineCursor =
  | { mode: 'head' }
  | { mode: 'live' }
  | { mode: 'seq'; seq: number }
  | { mode: 'tailBytes'; bytes: number }
  | { mode: 'timeMs'; tMs: number };

export type EngineStream = 'stdout' | 'stderr';

export type EngineChunk = {
  seq: number;
  tMs: number;
  stream: EngineStream;
  bytes: Uint8Array;
};

/** An inclusive span of output the reader will never receive. */
export type EngineDroppedRange = {
  fromSeq: number;
  toSeq: number;
};

export type EngineOutputHandler = {
  onChunk: (chunk: EngineChunk) => void;
  onDropped?: (range: EngineDroppedRange) => void;
};

export type EngineReadResult = {
  /** Retained output, concatenated in sequence order. */
  bytes: Uint8Array;
  /** Cursor to resume from; hand it straight to the next read or subscription. */
  nextSeq: number;
  dropped?: EngineDroppedRange;
};

export type EngineTerminalSize = {
  rows: number;
  cols: number;
};

export type EngineFollowOptions = {
  cursor: EngineCursor;
  coalesceMs?: number;
};

export type StartShellOptions = {
  /** TERM name; defaults to xterm-256color. */
  term?: string;
  size?: EngineTerminalSize;
  /** Fires once after the channel ends and all output has been retained. */
  onClosed?: () => void;
};

export type ConnectOptions = {
  /** Caller-chosen handle, used for diagnostics and native-side bookkeeping. */
  connectionId: string;
  host: string;
  port: number;
  username: string;
  credential: EngineCredential;
  /** Initial PTY geometry, applied to shells that do not override it. */
  size?: EngineTerminalSize;
  /**
   * Decides whether to trust the host key. Resolving false aborts the connect.
   *
   * Both engines call this exactly once per connect, but they get there
   * differently: russh invokes it mid-handshake, while the Go engine probes the
   * host first and then connects trusting only what was accepted. The contract
   * is the same either way, so callers do not branch on the engine.
   */
  onServerKey: (info: ServerPublicKeyInfo) => Promise<boolean>;
  /** Fires if the transport goes away without disconnect() being called. */
  onDisconnected?: () => void;
};

export interface EngineShell {
  readonly id: string;
  sendData(bytes: Uint8Array): Promise<void>;
  resize(size: EngineTerminalSize): Promise<void>;
  readBuffer(cursor: EngineCursor): Promise<EngineReadResult>;
  /** Replays from a cursor then follows live output; resolves to a listener id. */
  follow(handler: EngineOutputHandler, options: EngineFollowOptions): Promise<number>;
  unfollow(listenerId: number): Promise<void>;
  close(): Promise<void>;
}

export interface EngineConnection {
  readonly id: string;
  startShell(options: StartShellOptions): Promise<EngineShell>;
  disconnect(): Promise<void>;
}

/**
 * One directory entry. The field names match FileEntry in shared-core and the
 * records ssh-core already sends the desktop, so the file browser needs no
 * translation step.
 */
export type EngineSftpEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  kind: 'folder' | 'file' | 'symlink' | 'unknown';
  permissions?: string;
  uid?: number;
  gid?: number;
  owner?: string;
  group?: string;
};

export type EngineDirectoryListing = {
  path: string;
  entries: EngineSftpEntry[];
};

export type EngineSftpReadChunk = {
  bytes: Uint8Array;
  /** The read reached the end of the file; a transfer loop stops here. */
  eof: boolean;
};

/**
 * A file-transfer session.
 *
 * Recursive deletion is not offered: the caller already walks the tree to report
 * progress, so doing it here would duplicate the walk with no way to report.
 */
export interface EngineSftpConnection {
  readonly id: string;
  list(path: string): Promise<EngineDirectoryListing>;
  readChunk(path: string, offset: number, length: number): Promise<EngineSftpReadChunk>;
  writeChunk(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<EngineSftpEntry>;
  close(): Promise<void>;
}

/** Cost parameters for the vault KDF, plus the key length to produce. */
export type EngineArgon2idParams = {
  memoryKib: number;
  timeCost: number;
  parallelism: number;
  outputLength: number;
};

export interface MobileSshEngine {
  readonly name: string;
  connect(options: ConnectOptions): Promise<EngineConnection>;
  /**
   * Opens a file-transfer session. This is its own connection rather than a
   * channel on a terminal session, matching how the app treats the file browser:
   * independent of whichever shells happen to be open.
   */
  connectSftp(options: ConnectOptions): Promise<EngineSftpConnection>;
  /**
   * Derives the sync vault's key-encryption key.
   *
   * Native because a memory-hard KDF is impractically slow in Hermes. The
   * passphrase must already be NFC-normalised; the result has to match every
   * other implementation byte for byte or an existing vault stops opening.
   */
  deriveArgon2idKey(
    passphrase: Uint8Array,
    salt: Uint8Array,
    params: EngineArgon2idParams,
  ): Promise<Uint8Array>;
  /** Returns a human-readable problem, or null when the key is usable. */
  validatePrivateKey(privateKeyPem: string, passphrase?: string): Promise<string | null>;
  /** Returns a human-readable problem, or null when the certificate is usable. */
  validateCertificate(certificateText: string): Promise<string | null>;
}

/** Raised when a host key is presented and the caller declines it. */
export class HostKeyRejectedError extends Error {
  constructor() {
    super('호스트 키를 신뢰하지 않아 연결을 중단했습니다.');
    this.name = 'HostKeyRejectedError';
  }
}
