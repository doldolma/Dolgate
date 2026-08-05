import { t } from "../i18n";
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

export type EngineTailnetRoute = {
  /** The synced Tailnet configuration this connection must use. */
  tailnetId: string;
  /** Refuses the connection if the local node joins a different Tailnet. */
  tailnetName?: string;
};

export type ConnectOptions = {
  /** Caller-chosen handle, used for diagnostics and native-side bookkeeping. */
  connectionId: string;
  host: string;
  port: number;
  username: string;
  credential: EngineCredential;
  /** Omitted for a normal direct-network connection. */
  tailnet?: EngineTailnetRoute;
  /** Initial PTY geometry, applied to shells that do not override it. */
  size?: EngineTerminalSize;
  /**
   * Every host key already on file for this host and port.
   *
   * Supplying them lets the engine connect straight away instead of probing the
   * host first to find out what it presents, which saves a TCP connection and a
   * full key exchange on every connect after the first. All of them are passed,
   * not just one, because the server picks the algorithm — handing over only the
   * Ed25519 key would fail against a server that negotiates ECDSA.
   *
   * onServerKey is not called when the connect succeeds this way: the keys were
   * accepted before, and the engine verifies the presented key against exactly
   * this list. A key outside the list still reaches onServerKey — see connect().
   */
  trustedHostKeysBase64?: string[];
  /**
   * Decides whether to trust the host key. Resolving false aborts the connect.
   *
   * Called once per connect that has to ask — that is, when the host is new, or
   * when it presents a key that is not in trustedHostKeysBase64.
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
  /** 내장 편집기용 읽기. 크기·바이너리·디렉터리 판정은 엔진(sftpedit)이 한다. */
  readTextFile(path: string): Promise<EngineSftpTextFile>;
  writeTextFile(request: EngineSftpWriteTextFile): Promise<void>;
  close(): Promise<void>;
}

/** 편집기가 연 파일. size·mtime 은 저장할 때 원격이 바뀌었는지 대조하는 기준이다. */
export interface EngineSftpTextFile {
  content: string;
  size: number;
  mtime: string;
  mode: number;
}

export interface EngineSftpWriteTextFile {
  path: string;
  content: string;
  /** 열었을 때의 값. 함께 넘기지 않으면 조건 없이 덮어쓴다. */
  expectedSize?: number | null;
  expectedMtime?: string | null;
  mode?: number;
  preserveMtime?: boolean;
  /** 충돌을 무시하고 덮어쓴다 — 사용자가 "덮어쓰기"를 고른 경우. */
  force?: boolean;
}

/** Cost parameters for the vault KDF, plus the key length to produce. */
export type EngineArgon2idParams = {
  memoryKib: number;
  timeCost: number;
  parallelism: number;
  outputLength: number;
};

/** Tailnet configuration accepted by the shared Go runtime. */
export type EngineTailnetConfig = {
  id: string;
  hostname?: string;
  controlUrl?: string;
  authKey?: string;
  ephemeral?: boolean;
};

export type EngineTailnetPeer = {
  hostName?: string;
  dnsName?: string;
  ips?: string[];
  direct: boolean;
  relay?: string;
  rxBytes?: number;
  txBytes?: number;
};

export type EngineTailnetStatus = {
  id: string;
  state: string;
  authUrl?: string;
  error?: string;
  loginName?: string;
  tailnetName?: string;
  nodeName?: string;
  nodeIp?: string;
  expired?: boolean;
  health?: string[];
  ready?: boolean;
  authorized?: boolean;
  identityInvalid?: boolean;
  online?: boolean;
  degraded?: boolean;
  backendState?: string;
  keyExpiry?: string;
  cancelled?: boolean;
  attempting?: boolean;
  restarts?: number;
  restartRefused?: boolean;
  reRegistrations?: number;
  loginError?: string;
  backendError?: string;
  peers?: EngineTailnetPeer[];
};

export type EngineTailnetEvent =
  | {
      type: 'tailnetStatus';
      requestId?: string;
      payload: EngineTailnetStatus;
    }
  | {
      type: 'tailnetSnapshot';
      requestId?: string;
      payload: {
        statuses: EngineTailnetStatus[];
        localNodeName?: string;
      };
    };

export interface MobileSshEngine {
  readonly name: string;
  /**
   * Applies the complete Tailnet snapshot for one server/account scope.
   * Reusing the same scope preserves local node identities; changing it closes
   * the previous runtime before using the new account's state directory.
   */
  configureTailnets(
    stateScope: string,
    configs: EngineTailnetConfig[],
    onEvent: (event: EngineTailnetEvent) => void,
  ): Promise<void>;
  startTailnet(
    requestId: string,
    config: EngineTailnetConfig,
    timeoutMs?: number,
  ): Promise<void>;
  cancelTailnet(requestId: string, tailnetId: string): Promise<void>;
  disconnectTailnet(requestId: string, tailnetId: string): Promise<void>;
  snapshotTailnets(requestId: string): Promise<void>;
  forgetTailnet(tailnetId: string): Promise<void>;
  closeTailnets(): Promise<void>;
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
    super(t('engine.hostKeyRejected'));
    this.name = 'HostKeyRejectedError';
  }
}
