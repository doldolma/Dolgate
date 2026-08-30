import { t } from '../i18n';
import type {
  TerminalAutocompleteCapability,
  TerminalAutocompleteSnapshot,
} from '@dolssh/shared-core';
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
  /**
   * 셸 통합(OSC 133 훅)을 넣을지. 기본은 넣는다.
   *
   * 끄면 엔진이 이 셸에 아무것도 타이핑하지 않는다 — 프로브도, 주입도, 서브셸 재주입도.
   * 자동완성 설정의 "끔"이 곧 이것이다: 명령 단위를 알아내려면 사용자 셸에 훅을 걸어야
   * 하므로, 그 대가를 원하지 않는 사용자에게는 평범한 PTY 로 남아야 한다.
   */
  shellIntegration?: boolean;
  /** Fires once after the channel ends and all output has been retained. */
  onClosed?: () => void;
};

export type EngineTailnetRoute = {
  /** The synced Tailnet configuration this connection must use. */
  tailnetId: string;
  /** Refuses the connection if the local node joins a different Tailnet. */
  tailnetName?: string;
};

/**
 * Which server in the chain is speaking.
 *
 * Present on every prompt so a jump chain can say whose key is being trusted and
 * whose code is being asked for. Without it, two hops asking in a row look like
 * the same question twice — and answering the wrong one ends the connection,
 * because SSH allows one attempt per method.
 */
export type EngineConnectionHop = {
  username?: string;
  host?: string;
  port?: number;
};

/**
 * 지금 어느 홉을 붙고 있는지.
 *
 * 점프 체인에서는 이것이 없으면 "연결 중" 이 전부다 — 베스천에서 막힌 것과 그 뒤 대상에서 막힌 것이
 * 같은 모양으로 보인다. 코어가 홉마다 connecting·connected 를 보고한다.
 */
export type EngineHopProgress = {
  /** `user@host:port`. 코어가 아는 주소 그대로다. */
  hopLabel: string;
  /** 1 부터. 1 이 이 기기에서 직접 붙는 홉이다. */
  hopIndex: number;
  hopCount: number;
  /** 'connecting' | 'connected' 등, 코어가 그 홉에 대해 보고한 단계. */
  stage: string;
};

/** One field of a keyboard-interactive round. */
export type EngineInteractivePrompt = {
  label: string;
  /** False means the server asked for this not to be shown as it is typed. */
  echo: boolean;
  /**
   * Whether the saved password may answer this field.
   *
   * The engine decides it per hop; the app must not re-derive it from the label.
   * A server that writes `Password:` while actually asking for a second factor
   * would get the password sent as the code, and that spends the one attempt.
   */
  allowStoredPassword: boolean;
  /** Whether to mask the input. Verification codes are deliberately not masked. */
  masked: boolean;
};

export type EngineInteractiveChallenge = {
  challengeId: string;
  /** Which round of this method it is; the first is 1. */
  attempt: number;
  name?: string;
  instruction: string;
  prompts: EngineInteractivePrompt[];
  /** True when the connection has a saved password an answer may point at. */
  hasStoredPassword: boolean;
  hop?: EngineConnectionHop;
};

/** The answers to one challenge. */
export type EngineInteractiveAnswer = {
  responses: string[];
  /**
   * Positions to fill with the saved password. The engine substitutes them, so
   * the password is never read out of the vault and back in.
   */
  storedPasswordIndexes?: number[];
};

/** A server key that needs a decision, raised inside the connection it appeared in. */
export type EngineHostKeyChallenge = {
  challengeId: string;
  algorithm: string;
  fingerprintSha256: string;
  keyBase64: string;
  /** True when a key is already on file for this host and a different one arrived. */
  mismatch: boolean;
  hop?: EngineConnectionHop;
};

/**
 * 이 대상에 닿기 전에 거쳐야 하는 서버(ProxyJump). 재귀라서 다단이 표현된다.
 *
 * 가장 안쪽(jump 가 없는 것)이 이 기기에서 직접 소켓을 여는 홉이고, 바깥으로 갈수록 그 뒤의
 * 홉이다 — 코어가 읽는 순서가 그렇다.
 */
export type EngineJumpTarget = {
  host: string;
  port: number;
  username: string;
  credential: EngineCredential;
  /** 이 홉에 대해 이미 신뢰하는 키. 없으면 이 홉의 키도 연결 중에 물어본다. */
  trustedHostKeysBase64?: string[];
  jump?: EngineJumpTarget;
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
  /**
   * 경유할 SSH 서버들. 없으면 대상에 직접 붙는다.
   *
   * tailnet 은 **첫 홉**의 것을 쓴다(소켓을 여는 것은 그 홉뿐이다). 그 판정은 호출부가 하고
   * 여기서는 정해진 것을 그대로 나른다.
   */
  jump?: EngineJumpTarget;
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
   * Called while the connection is open at the point the key arrived, once per
   * server that has to be asked about — so a jump chain can ask about each hop,
   * and an OTP host is not authenticated twice to find out what key it has.
   */
  onServerKey: (
    info: ServerPublicKeyInfo,
    challenge: EngineHostKeyChallenge,
  ) => Promise<boolean>;
  /**
   * Answers a keyboard-interactive round (OTP, an SSH-side password prompt, a
   * challenge-response device). Resolving null cancels the connect.
   *
   * Rounds arrive one at a time, and the server ends the attempt if an answer is
   * wrong, so each call must be answered before the next arrives. Omitting this
   * leaves interactive auth with nowhere to ask, which fails the connect against
   * any host that requires it.
   */
  onInteractiveChallenge?: (
    challenge: EngineInteractiveChallenge,
  ) => Promise<EngineInteractiveAnswer | null>;
  /**
   * The banner the server sent during authentication (RFC 4252 §5.4), verbatim.
   *
   * Some servers use it to tell the person to approve the login somewhere else
   * and send nothing further until they do. Shown while the connection waits, it
   * can be acted on; reported after a failure, the connection is already gone.
   */
  onBanner?: (text: string) => void;
  /**
   * 홉마다의 진행. 점프 체인이 없으면 대상 한 번만 온다.
   *
   * 화면이 "어디까지 갔는지" 를 말할 수 있는 유일한 근거다 — 이것을 버리면 여러 홉을 지나는 연결이
   * 통째로 "연결 중" 한 줄이 된다.
   */
  onHopProgress?: (progress: EngineHopProgress) => void;
  /** Fires if the transport goes away without disconnect() being called. */
  onDisconnected?: () => void;
};

export interface EngineShell {
  readonly id: string;
  sendData(bytes: Uint8Array): Promise<void>;
  resize(size: EngineTerminalSize): Promise<void>;
  readBuffer(cursor: EngineCursor): Promise<EngineReadResult>;
  /** Replays from a cursor then follows live output; resolves to a listener id. */
  follow(
    handler: EngineOutputHandler,
    options: EngineFollowOptions,
  ): Promise<number>;
  unfollow(listenerId: number): Promise<void>;
  prepareAutocomplete(): Promise<EngineAutocompleteResult>;
  runCompletion(command: string): Promise<EngineCompletionResult>;
  reinjectShellIntegration(shellHint?: string): Promise<void>;
  close(): Promise<void>;
}

export type EngineAutocompleteResult = {
  capability: Omit<TerminalAutocompleteCapability, 'sessionId'>;
  snapshot:
    | (Omit<TerminalAutocompleteSnapshot, 'sessionId'> & {
        os?: { id: string; like?: string; prettyName?: string };
      })
    | null;
};

export type EngineCompletionResult = {
  stdout: string;
  truncated: boolean;
};

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
  readChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<EngineSftpReadChunk>;
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

/** SSM 셸 요청. 필드 이름은 코어(coretypes.AWSConnectPayload)의 JSON 그대로다. */
export interface AwsSsmShellRequest {
  region: string;
  instanceId: string;
  cols: number;
  rows: number;
  streamUrl: string;
  tokenValue: string;
  ssmSessionId?: string;
  /** 윈도우 인스턴스면 "powershell". 비어 있으면 POSIX 셸이다. */
  shellKind?: string;
  kmsKeyId?: string;
  kmsCipherTextBlobBase64?: string;
  kmsPlainTextKeyBase64?: string;
}

/** SSM 포트포워드 요청. 코어(coretypes.SSMPortForwardStartPayload)의 JSON 그대로다. */
export interface SsmPortForwardRequest {
  region: string;
  targetId: string;
  targetPort: number;
  /** 0 이면 커널이 빈 포트를 고른다. */
  bindPort: number;
  streamUrl: string;
  tokenValue: string;
  ssmSessionId?: string;
}

export interface EngineSsmForward {
  readonly id: string;
  /** SSH 가 붙어야 할 로컬 포트. */
  readonly bindPort: number;
  stop(): Promise<void>;
}

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
  /** Cancels an SSH connection that is still inside dial/authentication. */
  cancelConnect(connectionId: string): Promise<void>;
  connect(options: ConnectOptions): Promise<EngineConnection>;
  /**
   * SSH over SSM 에 쓸 임시 키쌍을 만든다.
   *
   * EC2 Instance Connect 는 공개키를 60초만 인스턴스에 올려 주므로 세션마다 새 키가 필요하다.
   * 기기에 crypto 가 없어 엔진이 만든다.
   */
  generateEphemeralSshKey(): Promise<{
    privateKeyPem: string;
    publicKey: string;
  }>;
  /**
   * AWS SSM 셸을 연다. **돌아오는 것은 SSH 셸과 같은 `EngineShell`** 이라 터미널 화면을 그대로
   * 붙일 수 있다.
   *
   * 자격증명은 엔진에 오지 않는다 — 앱이 `ssm:StartSession` 으로 받은 토큰만 넘긴다.
   */
  startAwsSsmShell(options: {
    sessionId: string;
    request: AwsSsmShellRequest;
    onClosed?: () => void;
  }): Promise<EngineShell>;
  /**
   * SSH over SSM 을 태울 로컬 포워드를 연다. 실제로 묶인 포트로 평범하게 SSH 를 붙인다.
   *
   * 세션이 끝나면 `stop()` 을 불러야 한다 — 남겨 두면 AWS 쪽에 SSM 세션이 남는다.
   */
  startSsmPortForward(options: {
    forwardId: string;
    request: SsmPortForwardRequest;
  }): Promise<EngineSsmForward>;
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
  validatePrivateKey(
    privateKeyPem: string,
    passphrase?: string,
  ): Promise<string | null>;
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
