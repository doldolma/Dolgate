import { fromByteArray, toByteArray } from 'base64-js';
import { NativeEventEmitter, NativeModules } from 'react-native';
import type { EmitterSubscription, NativeModule } from 'react-native';

import {
  HostKeyRejectedError,
  type ConnectOptions,
  type EngineArgon2idParams,
  type EngineDirectoryListing,
  type EngineSftpConnection,
  type EngineSftpEntry,
  type EngineSftpReadChunk,
  type EngineConnection,
  type EngineCursor,
  type EngineFollowOptions,
  type EngineOutputHandler,
  type EngineReadResult,
  type EngineShell,
  type EngineTerminalSize,
  type MobileSshEngine,
  type ServerPublicKeyInfo,
  type StartShellOptions,
} from './types';

// Cursor and stream codes, matching the constants in
// services/ssh-core/mobile/bind.go. They cross as plain numbers because
// gomobile cannot carry an enum.
const CURSOR_HEAD = 0;
const CURSOR_TAIL_BYTES = 1;
const CURSOR_SEQ = 2;
const CURSOR_TIME_MS = 3;
const CURSOR_LIVE = 4;

const STREAM_STDERR = 1;

const EVENT_CHUNK = 'GoSshEngine:chunk';
const EVENT_DROPPED = 'GoSshEngine:dropped';
const EVENT_SHELL_CLOSED = 'GoSshEngine:shellClosed';
const EVENT_DISCONNECTED = 'GoSshEngine:disconnected';

const DEFAULT_TERM = 'xterm-256color';

type NativeReadResult = {
  dataBase64: string;
  nextSeq: number;
  hasDropped: boolean;
  droppedFromSeq?: number;
  droppedToSeq?: number;
};

type NativeStartShellResult = {
  shellId: string;
  info: string;
};

/** The native module surface, implemented by Kotlin and Swift. */
type GoSshEngineNativeModule = NativeModule & {
  getEngineVersion(): Promise<string>;
  probeHostKey(requestJson: string): Promise<string>;
  inspectPrivateKey(privateKeyPem: string, passphrase: string): Promise<string>;
  inspectCertificate(certificateText: string): Promise<string>;
  connect(connectionId: string, requestJson: string): Promise<string>;
  disconnect(connectionId: string): Promise<void>;
  startShell(connectionId: string, optionsJson: string): Promise<NativeStartShellResult>;
  sendData(shellId: string, dataBase64: string): Promise<void>;
  resize(shellId: string, rows: number, cols: number): Promise<void>;
  closeShell(shellId: string): Promise<void>;
  readBuffer(
    shellId: string,
    cursorMode: number,
    seq: number,
    tailBytes: number,
    timeMs: number,
    maxBytes: number,
  ): Promise<NativeReadResult>;
  getShellStats(shellId: string): Promise<string>;
  getCurrentSeq(shellId: string): Promise<number>;
  followOutput(
    shellId: string,
    subscriptionToken: string,
    cursorMode: number,
    seq: number,
    tailBytes: number,
    timeMs: number,
    coalesceMs: number,
  ): Promise<number>;
  unfollowOutput(shellId: string, listenerId: number): Promise<void>;
  startSftp(connectionId: string): Promise<string>;
  sftpList(sftpId: string, path: string): Promise<string>;
  sftpReadChunk(
    sftpId: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<{ dataBase64: string; eof: boolean }>;
  sftpWriteChunk(
    sftpId: string,
    path: string,
    offset: number,
    dataBase64: string,
  ): Promise<void>;
  sftpMkdir(sftpId: string, path: string): Promise<void>;
  sftpRename(sftpId: string, sourcePath: string, targetPath: string): Promise<void>;
  sftpChmod(sftpId: string, path: string, mode: number): Promise<void>;
  sftpRemove(sftpId: string, path: string): Promise<void>;
  sftpStat(sftpId: string, path: string): Promise<string>;
  closeSftp(sftpId: string): Promise<void>;
  deriveArgon2idKey(
    passphraseBase64: string,
    saltBase64: string,
    memoryKib: number,
    timeCost: number,
    parallelism: number,
    outputLength: number,
  ): Promise<string>;
};

function nativeModule(): GoSshEngineNativeModule | null {
  return (NativeModules.GoSshEngineModule as GoSshEngineNativeModule | undefined) ?? null;
}

/**
 * Whether this build has the engine linked in. There is no software fallback, so
 * a false here means SSH is unavailable and the app should say so rather than
 * fail per-connection.
 */
export function isGoEngineAvailable(): boolean {
  return nativeModule() != null;
}

export function getGoEngineVersion(): Promise<string> {
  return requireNative().getEngineVersion();
}

function requireNative(): GoSshEngineNativeModule {
  const native = nativeModule();
  if (!native) {
    throw new Error('Go SSH 엔진 네이티브 모듈을 찾을 수 없습니다.');
  }
  return native;
}

/**
 * Flattens a cursor into the positional arguments the native module takes. Only
 * the field belonging to the mode is read on the other side, so the unused slots
 * are zero rather than optional.
 */
function cursorArgs(cursor: EngineCursor): [number, number, number, number] {
  switch (cursor.mode) {
    case 'seq':
      return [CURSOR_SEQ, cursor.seq, 0, 0];
    case 'tailBytes':
      return [CURSOR_TAIL_BYTES, 0, cursor.bytes, 0];
    case 'timeMs':
      return [CURSOR_TIME_MS, 0, 0, cursor.tMs];
    case 'live':
      return [CURSOR_LIVE, 0, 0, 0];
    case 'head':
    default:
      return [CURSOR_HEAD, 0, 0, 0];
  }
}

function credentialFields(options: ConnectOptions): Record<string, unknown> {
  const { credential } = options;
  switch (credential.type) {
    case 'password':
      return { authType: 'password', password: credential.password };
    case 'key':
      return {
        authType: 'privateKey',
        privateKeyPem: credential.privateKey,
        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
      };
    case 'certificate':
      return {
        authType: 'certificate',
        privateKeyPem: credential.privateKey,
        certificateText: credential.certificate,
        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
      };
  }
}

/**
 * Builds the connect payload. This is the same wire format the desktop app sends
 * ssh-core over the stdio protocol, so there is one vocabulary for a connection
 * request rather than one per platform.
 */
function connectPayload(
  options: ConnectOptions,
  trustedHostKeyBase64: string,
  trustedHostKeysBase64?: string[],
): Record<string, unknown> {
  return {
    id: options.connectionId,
    host: options.host,
    port: options.port,
    username: options.username,
    trustedHostKeyBase64,
    // ssh-core takes the plural list in preference to the single key, and
    // accepts the connection if the presented key matches any entry. Omitted
    // when empty so the singular field stays in charge.
    ...(trustedHostKeysBase64?.length
      ? { trustedHostKeysBase64 }
      : {}),
    rows: options.size?.rows ?? 0,
    cols: options.size?.cols ?? 0,
    ...credentialFields(options),
  };
}

/**
 * ssh-core's strict host key check fails with this when the key a host presents
 * is not among the ones it was handed. It is the signal that a connect made from
 * keys on file has to fall back to asking.
 */
const HOST_KEY_MISMATCH = 'host key mismatch';

function isHostKeyMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(HOST_KEY_MISMATCH);
}

/** Shared event plumbing: one emitter, fanned out to per-shell subscribers. */
class GoEngineEvents {
  private emitter: NativeEventEmitter | null = null;
  private subscriptions: EmitterSubscription[] = [];

  // Keyed by subscription token. A shell can have several subscriptions (the
  // terminal and the background snapshot), and the engine invokes each one
  // separately — so an event must reach exactly the subscription it came from.
  // Keying by shell instead would hand every chunk to every subscriber, and each
  // one would see the same bytes once per subscription.
  private chunkHandlers = new Map<string, EngineOutputHandler>();
  private shellClosedHandlers = new Map<string, () => void>();
  private disconnectHandlers = new Map<string, () => void>();

  /**
   * Attaches on first use rather than at module load, so a build without the
   * native module never constructs an emitter for it.
   */
  private ensureAttached(): void {
    if (this.emitter) {
      return;
    }
    const native = requireNative();
    this.emitter = new NativeEventEmitter(native);
    this.subscriptions = [
      this.emitter.addListener(EVENT_CHUNK, payload => this.handleChunk(payload)),
      this.emitter.addListener(EVENT_DROPPED, payload => this.handleDropped(payload)),
      this.emitter.addListener(EVENT_SHELL_CLOSED, payload => {
        const handler = this.shellClosedHandlers.get(String(payload?.shellId));
        handler?.();
      }),
      this.emitter.addListener(EVENT_DISCONNECTED, payload => {
        const handler = this.disconnectHandlers.get(String(payload?.connectionId));
        handler?.();
      }),
    ];
  }

  private handleChunk(payload: any): void {
    const handler = this.chunkHandlers.get(String(payload?.subscriptionToken));
    if (!handler) {
      return;
    }
    handler.onChunk({
      seq: Number(payload?.seq ?? 0),
      tMs: Number(payload?.tMs ?? 0),
      stream: Number(payload?.stream) === STREAM_STDERR ? ('stderr' as const) : ('stdout' as const),
      bytes: toByteArray(String(payload?.dataBase64 ?? '')),
    });
  }

  private handleDropped(payload: any): void {
    const handler = this.chunkHandlers.get(String(payload?.subscriptionToken));
    if (!handler) {
      return;
    }
    handler.onDropped?.({
      fromSeq: Number(payload?.fromSeq ?? 0),
      toSeq: Number(payload?.toSeq ?? 0),
    });
  }

  /**
   * Registers before the native subscription is created, because the engine can
   * deliver replay chunks as soon as it exists — a token minted afterwards would
   * miss them.
   */
  registerOutput(subscriptionToken: string, handler: EngineOutputHandler): void {
    this.ensureAttached();
    this.chunkHandlers.set(subscriptionToken, handler);
  }

  unregisterOutput(subscriptionToken: string): void {
    this.chunkHandlers.delete(subscriptionToken);
  }

  forgetShellTokens(tokens: Iterable<string>): void {
    for (const token of tokens) {
      this.chunkHandlers.delete(token);
    }
  }

  registerShellClosed(shellId: string, handler: () => void): void {
    this.ensureAttached();
    this.shellClosedHandlers.set(shellId, handler);
  }

  forgetShell(shellId: string): void {
    this.shellClosedHandlers.delete(shellId);
  }

  registerDisconnected(connectionId: string, handler: () => void): void {
    this.ensureAttached();
    this.disconnectHandlers.set(connectionId, handler);
  }

  forgetConnection(connectionId: string): void {
    this.disconnectHandlers.delete(connectionId);
  }

  /** Test seam: drops every subscription and handler. */
  reset(): void {
    this.subscriptions.forEach(subscription => subscription.remove());
    this.subscriptions = [];
    this.emitter = null;
    this.chunkHandlers.clear();
    this.shellClosedHandlers.clear();
    this.disconnectHandlers.clear();
  }
}

const events = new GoEngineEvents();

/** Test seam: clears event subscriptions between cases. */
export function resetGoEngineEvents(): void {
  events.reset();
}

let nextSubscriptionToken = 0;

class GoShell implements EngineShell {
  private readonly tokensByListenerId = new Map<number, string>();

  constructor(readonly id: string) {}

  async sendData(bytes: Uint8Array): Promise<void> {
    await requireNative().sendData(this.id, fromByteArray(bytes));
  }

  async resize(size: EngineTerminalSize): Promise<void> {
    await requireNative().resize(this.id, size.rows, size.cols);
  }

  async readBuffer(cursor: EngineCursor): Promise<EngineReadResult> {
    const [mode, seq, tailBytes, timeMs] = cursorArgs(cursor);
    // maxBytes 0 lets the engine apply its own cap.
    const result = await requireNative().readBuffer(this.id, mode, seq, tailBytes, timeMs, 0);
    return {
      bytes: toByteArray(result.dataBase64 ?? ''),
      nextSeq: Number(result.nextSeq ?? 0),
      ...(result.hasDropped
        ? {
            dropped: {
              fromSeq: Number(result.droppedFromSeq ?? 0),
              toSeq: Number(result.droppedToSeq ?? 0),
            },
          }
        : {}),
    };
  }

  async follow(handler: EngineOutputHandler, options: EngineFollowOptions): Promise<number> {
    const [mode, seq, tailBytes, timeMs] = cursorArgs(options.cursor);

    // Minted here and handed to the engine, so the handler is in place before
    // the subscription can emit its first replay chunk.
    nextSubscriptionToken += 1;
    const token = `${this.id}~sub${nextSubscriptionToken}`;
    events.registerOutput(token, handler);

    try {
      const listenerId = await requireNative().followOutput(
        this.id,
        token,
        mode,
        seq,
        tailBytes,
        timeMs,
        options.coalesceMs ?? 0,
      );
      this.tokensByListenerId.set(listenerId, token);
      return listenerId;
    } catch (error) {
      events.unregisterOutput(token);
      throw error;
    }
  }

  async unfollow(listenerId: number): Promise<void> {
    const token = this.tokensByListenerId.get(listenerId);
    if (token) {
      // Unregistered first: the native detach is asynchronous, and until it
      // completes the subscription keeps emitting.
      events.unregisterOutput(token);
      this.tokensByListenerId.delete(listenerId);
    }
    await requireNative().unfollowOutput(this.id, listenerId);
  }

  async close(): Promise<void> {
    events.forgetShellTokens(this.tokensByListenerId.values());
    this.tokensByListenerId.clear();
    events.forgetShell(this.id);
    await requireNative().closeShell(this.id);
  }
}

class GoConnection implements EngineConnection {
  constructor(
    readonly id: string,
    private readonly defaultSize?: EngineTerminalSize,
  ) {}

  async startShell(options: StartShellOptions): Promise<EngineShell> {
    const optionsJson = JSON.stringify({
      term: options.term ?? DEFAULT_TERM,
      rows: options.size?.rows ?? this.defaultSize?.rows ?? 0,
      cols: options.size?.cols ?? this.defaultSize?.cols ?? 0,
    });

    const result = await requireNative().startShell(this.id, optionsJson);
    if (options.onClosed) {
      events.registerShellClosed(result.shellId, options.onClosed);
    }
    return new GoShell(result.shellId);
  }

  async disconnect(): Promise<void> {
    events.forgetConnection(this.id);
    await requireNative().disconnect(this.id);
  }
}


class GoSftp implements EngineSftpConnection {
  constructor(
    readonly id: string,
    private readonly connectionId: string,
  ) {}

  async list(path: string): Promise<EngineDirectoryListing> {
    const raw = await requireNative().sftpList(this.id, path);
    return JSON.parse(raw) as EngineDirectoryListing;
  }

  async readChunk(path: string, offset: number, length: number): Promise<EngineSftpReadChunk> {
    const result = await requireNative().sftpReadChunk(this.id, path, offset, length);
    return { bytes: toByteArray(result.dataBase64 ?? ''), eof: Boolean(result.eof) };
  }

  async writeChunk(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    await requireNative().sftpWriteChunk(this.id, path, offset, fromByteArray(bytes));
  }

  async mkdir(path: string): Promise<void> {
    await requireNative().sftpMkdir(this.id, path);
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
    await requireNative().sftpRename(this.id, sourcePath, targetPath);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await requireNative().sftpChmod(this.id, path, mode);
  }

  async remove(path: string): Promise<void> {
    await requireNative().sftpRemove(this.id, path);
  }

  async stat(path: string): Promise<EngineSftpEntry> {
    const raw = await requireNative().sftpStat(this.id, path);
    return JSON.parse(raw) as EngineSftpEntry;
  }

  /** Closes the session and the connection it was opened on. */
  async close(): Promise<void> {
    const native = requireNative();
    events.forgetConnection(this.connectionId);
    try {
      await native.closeSftp(this.id);
    } finally {
      await native.disconnect(this.connectionId);
    }
  }
}

export class GoSshEngineAdapter implements MobileSshEngine {
  readonly name = 'go' as const;

  /**
   * Connects, asking about the host key only when it has to.
   *
   * The dialer checks host keys strictly against keys it was handed rather than
   * asking mid-handshake, so a host nobody has seen before takes two steps:
   * probe it, let the caller accept or reject what it presents, then connect
   * trusting exactly that key. That costs an extra TCP connection and a full key
   * exchange, which is why a host with keys already on file skips the probe and
   * connects against those directly.
   *
   * A mismatch is not treated as a failure but as "this needs asking about": the
   * host may have rotated its key, or dropped the algorithm we had on file, or
   * be something else entirely. Falling back to the probe routes all three to
   * the same prompt the first connect uses, so the caller can see what changed
   * and decide, rather than being handed a bare mismatch error.
   */
  async connect(options: ConnectOptions): Promise<EngineConnection> {
    const native = requireNative();
    const onFile = options.trustedHostKeysBase64?.filter(Boolean) ?? [];

    if (onFile.length > 0) {
      if (options.onDisconnected) {
        events.registerDisconnected(options.connectionId, options.onDisconnected);
      }
      try {
        await native.connect(
          options.connectionId,
          JSON.stringify(connectPayload(options, onFile[0], onFile)),
        );
        return new GoConnection(options.connectionId, options.size);
      } catch (error) {
        events.forgetConnection(options.connectionId);
        if (!isHostKeyMismatch(error)) {
          throw error;
        }
        // Fall through to the probe so the caller gets asked.
      }
    }

    const probeRaw = await native.probeHostKey(
      JSON.stringify(connectPayload(options, '')),
    );
    const probed = JSON.parse(probeRaw) as {
      algorithm: string;
      publicKeyBase64: string;
      fingerprintSha256: string;
    };

    // The engine reports only the key itself; the address comes from the request
    // that was just made.
    const info: ServerPublicKeyInfo = {
      host: options.host,
      port: options.port,
      algorithm: probed.algorithm,
      fingerprintSha256: probed.fingerprintSha256,
      keyBase64: probed.publicKeyBase64,
    };

    const accepted = await options.onServerKey(info);
    if (!accepted) {
      throw new HostKeyRejectedError();
    }

    if (options.onDisconnected) {
      events.registerDisconnected(options.connectionId, options.onDisconnected);
    }

    try {
      await native.connect(
        options.connectionId,
        JSON.stringify(connectPayload(options, probed.publicKeyBase64)),
      );
    } catch (error) {
      events.forgetConnection(options.connectionId);
      throw error;
    }

    return new GoConnection(options.connectionId, options.size);
  }

  /**
   * Opens a file-transfer session on its own connection, reusing connect() so
   * host key trust — including when the probe is skipped — is decided identically
   * to a terminal session.
   */
  async connectSftp(options: ConnectOptions): Promise<EngineSftpConnection> {
    await this.connect(options);
    try {
      const sftpId = await requireNative().startSftp(options.connectionId);
      return new GoSftp(sftpId, options.connectionId);
    } catch (error) {
      // The connection is already up; do not leak it when the session fails.
      // Wrapped in its own try rather than chained: a teardown that fails must
      // not replace the error that actually explains what went wrong.
      try {
        await requireNative().disconnect(options.connectionId);
      } catch {
        // Already failing; nothing useful to add.
      }
      throw error;
    }
  }

  async deriveArgon2idKey(
    passphrase: Uint8Array,
    salt: Uint8Array,
    params: EngineArgon2idParams,
  ): Promise<Uint8Array> {
    const derived = await requireNative().deriveArgon2idKey(
      fromByteArray(passphrase),
      fromByteArray(salt),
      params.memoryKib,
      params.timeCost,
      params.parallelism,
      params.outputLength,
    );
    return toByteArray(derived);
  }

  async validatePrivateKey(privateKeyPem: string, passphrase?: string): Promise<string | null> {
    try {
      await requireNative().inspectPrivateKey(privateKeyPem, passphrase ?? '');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : '개인키를 확인할 수 없습니다.';
    }
  }

  async validateCertificate(certificateText: string): Promise<string | null> {
    try {
      const raw = await requireNative().inspectCertificate(certificateText);
      const inspection = JSON.parse(raw) as { status?: string };
      // The engine reports a status rather than throwing for a well-formed but
      // unusable certificate, so anything other than "valid" is a problem.
      if (inspection.status && inspection.status !== 'valid') {
        return `인증서를 사용할 수 없습니다: ${inspection.status}`;
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : '인증서를 확인할 수 없습니다.';
    }
  }
}
