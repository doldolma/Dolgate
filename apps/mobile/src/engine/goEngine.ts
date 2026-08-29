import { fromByteArray, toByteArray } from 'base64-js';
import { NativeEventEmitter, NativeModules } from 'react-native';
import type { EmitterSubscription, NativeModule } from 'react-native';

import {
  HostKeyRejectedError,
  type ConnectOptions,
  type EngineArgon2idParams,
  type EngineAutocompleteResult,
  type EngineCompletionResult,
  type EngineDirectoryListing,
  type EngineSftpConnection,
  type EngineSftpEntry,
  type EngineSftpTextFile,
  type EngineSftpWriteTextFile,
  type EngineSftpReadChunk,
  type EngineConnection,
  type EngineConnectionHop,
  type EngineCredential,
  type EngineJumpTarget,
  type EngineCursor,
  type EngineFollowOptions,
  type EngineHopProgress,
  type EngineHostKeyChallenge,
  type EngineInteractiveAnswer,
  type EngineInteractiveChallenge,
  type EngineOutputHandler,
  type EngineReadResult,
  type EngineShell,
  type EngineTerminalSize,
  type EngineTailnetConfig,
  type EngineTailnetEvent,
  type MobileSshEngine,
  type ServerPublicKeyInfo,
  type StartShellOptions,
  type AwsSsmShellRequest,
  type SsmPortForwardRequest,
  type EngineSsmForward,
} from './types';
import { t } from '../i18n';

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
const EVENT_TAILNET = 'GoSshEngine:tailnet';
const EVENT_CONNECTION = 'GoSshEngine:connection';

const DEFAULT_TERM = 'xterm-256color';

/**
 * An event a connection raises while it is being opened.
 *
 * The wire form is ssh-core's, the same one the desktop receives over stdio, so
 * the two apps read one vocabulary rather than one per platform.
 */
type NativeConnectionEvent = {
  type: string;
  sessionId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
};

type ConnectionEventHandler = (event: NativeConnectionEvent) => void;

type ConnectionEventOptions = Pick<
  ConnectOptions,
  | 'connectionId'
  | 'host'
  | 'port'
  | 'onServerKey'
  | 'onInteractiveChallenge'
  | 'onBanner'
  | 'onHopProgress'
>;

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
  respondKeyboardInteractive(payloadJson: string): Promise<void>;
  respondHostKeyTrust(challengeId: string, trust: boolean): Promise<void>;
  cancelConnect(connectionId: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  startShell(
    connectionId: string,
    optionsJson: string,
  ): Promise<NativeStartShellResult>;
  /** SSH over SSM 에 쓸 임시 키쌍(JSON: privateKeyPem·publicKey). */
  generateEphemeralSshKey(): Promise<string>;
  /** AWS SSM 셸. SSH 셸과 같은 shellId 체계로 돌아오므로 아래 셸 조작이 그대로 쓰인다. */
  startAwsSsmShell(
    sessionId: string,
    requestJson: string,
  ): Promise<NativeStartShellResult>;
  startSsmPortForward(
    forwardId: string,
    requestJson: string,
  ): Promise<{ forwardId: string; bindPort: number }>;
  stopSsmPortForward(forwardId: string): Promise<void>;
  sendData(shellId: string, dataBase64: string): Promise<void>;
  prepareAutocomplete(shellId: string): Promise<string>;
  runCompletion(shellId: string, command: string): Promise<string>;
  reinjectShellIntegration(shellId: string, shellHint: string): Promise<void>;
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
  sftpRename(
    sftpId: string,
    sourcePath: string,
    targetPath: string,
  ): Promise<void>;
  sftpChmod(sftpId: string, path: string, mode: number): Promise<void>;
  sftpRemove(sftpId: string, path: string): Promise<void>;
  sftpStat(sftpId: string, path: string): Promise<string>;
  sftpReadTextFile(sftpId: string, path: string): Promise<string>;
  sftpWriteTextFile(sftpId: string, requestJson: string): Promise<void>;
  closeSftp(sftpId: string): Promise<void>;
  deriveArgon2idKey(
    passphraseBase64: string,
    saltBase64: string,
    memoryKib: number,
    timeCost: number,
    parallelism: number,
    outputLength: number,
  ): Promise<string>;
  configureTailnets(stateScope: string, configsJson: string): Promise<void>;
  startTailnet(requestId: string, payloadJson: string): Promise<void>;
  cancelTailnet(requestId: string, tailnetId: string): Promise<void>;
  disconnectTailnet(requestId: string, tailnetId: string): Promise<void>;
  snapshotTailnets(requestId: string): Promise<void>;
  forgetTailnet(tailnetId: string): Promise<void>;
  closeTailnets(): Promise<void>;
};

function nativeModule(): GoSshEngineNativeModule | null {
  return (
    (NativeModules.GoSshEngineModule as GoSshEngineNativeModule | undefined) ??
    null
  );
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
    throw new Error(t('engine.nativeModuleMissing'));
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
  return credentialFieldsOf(options.credential);
}

/** 자격증명을 코어의 필드 이름으로. 대상과 점프 홉이 같은 모양을 쓴다. */
function credentialFieldsOf(
  credential: EngineCredential,
): Record<string, unknown> {
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
    ...(options.tailnet
      ? {
          tailnetId: options.tailnet.tailnetId,
          ...(options.tailnet.tailnetName
            ? { tailnetName: options.tailnet.tailnetName }
            : {}),
        }
      : {}),
    trustedHostKeyBase64,
    // ssh-core takes the plural list in preference to the single key, and
    // accepts the connection if the presented key matches any entry. Omitted
    // when empty so the singular field stays in charge.
    ...(trustedHostKeysBase64?.length ? { trustedHostKeysBase64 } : {}),
    ...(options.jump ? { jump: jumpPayload(options.jump) } : {}),
    rows: options.size?.rows ?? 0,
    cols: options.size?.cols ?? 0,
    ...credentialFields(options),
  };
}

function hopOf(raw: unknown): EngineConnectionHop | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const hop = raw as Record<string, unknown>;
  const host = typeof hop.host === 'string' ? hop.host : '';
  if (!host) {
    return undefined;
  }
  return {
    host,
    port: typeof hop.port === 'number' ? hop.port : undefined,
    username: typeof hop.username === 'string' ? hop.username : undefined,
  };
}

function interactiveChallengeOf(
  raw: Record<string, unknown>,
): EngineInteractiveChallenge {
  const prompts = Array.isArray(raw.prompts) ? raw.prompts : [];
  return {
    challengeId: String(raw.challengeId ?? ''),
    attempt: typeof raw.attempt === 'number' ? raw.attempt : 1,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    instruction: typeof raw.instruction === 'string' ? raw.instruction : '',
    prompts: prompts.map(entry => {
      const prompt = (entry ?? {}) as Record<string, unknown>;
      return {
        label: String(prompt.label ?? ''),
        echo: Boolean(prompt.echo),
        allowStoredPassword: Boolean(prompt.allowStoredPassword),
        masked: Boolean(prompt.masked),
      };
    }),
    hasStoredPassword: Boolean(raw.hasStoredPassword),
    hop: hopOf(raw.hop),
  };
}

/**
 * Answers the trust question the connection raised.
 *
 * An answer is sent even when the caller's handler throws. The connection is
 * blocked on this one reply; leaving it unsent turns a UI error into a connection
 * that hangs until its budget runs out, so a failure to ask is answered as "no".
 *
 * onDecision fires the moment the decision is known, before the answer is sent.
 * Reporting it afterwards loses the race: the engine ends the dial as soon as it
 * hears "no", and the connect error can reach its handler before a decision
 * recorded on the way out has landed.
 */
async function answerHostKeyChallenge(
  native: GoSshEngineNativeModule,
  options: ConnectionEventOptions,
  raw: Record<string, unknown>,
  onDecision: (accepted: boolean) => void,
): Promise<void> {
  const challenge: EngineHostKeyChallenge = {
    challengeId: String(raw.challengeId ?? ''),
    algorithm: String(raw.algorithm ?? ''),
    fingerprintSha256: String(raw.fingerprintSha256 ?? ''),
    keyBase64: String(raw.publicKeyBase64 ?? ''),
    mismatch: Boolean(raw.mismatch),
    hop: hopOf(raw.hop),
  };
  // The key belongs to whichever server presented it. Through a jump chain that
  // is not the host the request named, so recording it under the request's
  // address would file a bastion's key against the host behind it.
  const info: ServerPublicKeyInfo = {
    host: challenge.hop?.host ?? options.host,
    port: challenge.hop?.port ?? options.port,
    algorithm: challenge.algorithm,
    fingerprintSha256: challenge.fingerprintSha256,
    keyBase64: challenge.keyBase64,
  };

  let accepted = false;
  try {
    accepted = await options.onServerKey(info, challenge);
  } catch {
    accepted = false;
  }
  onDecision(accepted);
  try {
    await native.respondHostKeyTrust(challenge.challengeId, accepted);
  } catch {
    // The challenge is already gone — the connect failed or was cancelled while
    // the sheet was open. There is nothing left to answer.
  }
}

async function answerInteractiveChallenge(
  native: GoSshEngineNativeModule,
  options: ConnectionEventOptions,
  raw: Record<string, unknown>,
): Promise<void> {
  const challenge = interactiveChallengeOf(raw);
  let answer: EngineInteractiveAnswer | null = null;
  if (options.onInteractiveChallenge) {
    try {
      answer = await options.onInteractiveChallenge(challenge);
    } catch {
      answer = null;
    }
  }
  // Cancelling is reported rather than left silent: a dismissed prompt that says
  // nothing leaves the connection waiting out its budget, holding a tailnet
  // node's lease while it does.
  const payload = answer
    ? {
        challengeId: challenge.challengeId,
        responses: answer.responses,
        ...(answer.storedPasswordIndexes?.length
          ? { storedPasswordIndexes: answer.storedPasswordIndexes }
          : {}),
      }
    : { challengeId: challenge.challengeId, responses: [], cancelled: true };
  try {
    await native.respondKeyboardInteractive(JSON.stringify(payload));
  } catch {
    // Same as above: the challenge no longer exists.
  }
}

/**
 * A jump hop in the wire form ssh-core reads, recursively.
 *
 * The field names are the target's, because a hop is addressed the same way the
 * target is — one vocabulary for "a machine to authenticate to".
 */
function jumpPayload(jump: EngineJumpTarget): Record<string, unknown> {
  const keys = jump.trustedHostKeysBase64?.filter(Boolean) ?? [];
  return {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    trustedHostKeyBase64: keys[0] ?? '',
    ...(keys.length ? { trustedHostKeysBase64: keys } : {}),
    ...credentialFieldsOf(jump.credential),
    ...(jump.jump ? { jump: jumpPayload(jump.jump) } : {}),
  };
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
  private tailnetHandler: ((event: EngineTailnetEvent) => void) | null = null;
  // Keyed by connection id: a prompt has to reach the connect call that raised
  // it, and several connections can be opening at once.
  private connectionHandlers = new Map<string, ConnectionEventHandler>();
  private pendingShellClosedIds = new Set<string>();

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
      this.emitter.addListener(EVENT_CHUNK, payload =>
        this.handleChunk(payload),
      ),
      this.emitter.addListener(EVENT_DROPPED, payload =>
        this.handleDropped(payload),
      ),
      this.emitter.addListener(EVENT_SHELL_CLOSED, payload => {
        const shellId = String(payload?.shellId);
        const handler = this.shellClosedHandlers.get(shellId);
        if (handler) {
          this.shellClosedHandlers.delete(shellId);
          handler();
          return;
        }
        // startShell resolves with the native-generated id, so a shell that exits
        // immediately can report closed before JS knows which handler to attach.
        // Keep a bounded one-shot record and consume it during registration.
        if (this.pendingShellClosedIds.size >= 128) {
          const oldest = this.pendingShellClosedIds.values().next().value;
          if (oldest) {
            this.pendingShellClosedIds.delete(oldest);
          }
        }
        this.pendingShellClosedIds.add(shellId);
      }),
      this.emitter.addListener(EVENT_DISCONNECTED, payload => {
        const handler = this.disconnectHandlers.get(
          String(payload?.connectionId),
        );
        handler?.();
      }),
      this.emitter.addListener(EVENT_CONNECTION, payload =>
        this.handleConnectionEvent(payload),
      ),
      this.emitter.addListener(EVENT_TAILNET, payload => {
        if (!this.tailnetHandler) {
          return;
        }
        try {
          this.tailnetHandler(
            JSON.parse(String(payload?.eventJson ?? '')) as EngineTailnetEvent,
          );
        } catch {
          // A malformed native event is ignored; the request promise still
          // carries operation failures and a later snapshot repairs UI state.
        }
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
      stream:
        Number(payload?.stream) === STREAM_STDERR
          ? ('stderr' as const)
          : ('stdout' as const),
      bytes: toByteArray(String(payload?.dataBase64 ?? '')),
    });
  }

  private handleConnectionEvent(payload: any): void {
    let event: NativeConnectionEvent;
    try {
      event = JSON.parse(
        String(payload?.eventJson ?? ''),
      ) as NativeConnectionEvent;
    } catch {
      // A malformed native event is dropped. The prompt it carried goes
      // unanswered, and the connect fails on its own budget rather than here.
      return;
    }
    const handler = this.connectionHandlers.get(
      String(event.sessionId ?? event.requestId ?? ''),
    );
    handler?.(event);
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
  registerOutput(
    subscriptionToken: string,
    handler: EngineOutputHandler,
  ): void {
    this.ensureAttached();
    this.chunkHandlers.set(subscriptionToken, handler);
  }

  unregisterOutput(subscriptionToken: string): void {
    this.chunkHandlers.delete(subscriptionToken);
  }

  prepareShellClosed(): void {
    this.ensureAttached();
  }

  forgetShellTokens(tokens: Iterable<string>): void {
    for (const token of tokens) {
      this.chunkHandlers.delete(token);
    }
  }

  registerShellClosed(shellId: string, handler: () => void): void {
    this.ensureAttached();
    if (this.pendingShellClosedIds.delete(shellId)) {
      handler();
      return;
    }
    this.shellClosedHandlers.set(shellId, handler);
  }

  forgetShell(shellId: string): void {
    this.shellClosedHandlers.delete(shellId);
    this.pendingShellClosedIds.delete(shellId);
  }

  registerDisconnected(connectionId: string, handler: () => void): void {
    this.ensureAttached();
    this.disconnectHandlers.set(connectionId, handler);
  }

  forgetConnection(connectionId: string): void {
    this.disconnectHandlers.delete(connectionId);
  }

  /**
   * Registers before the connect call, not after: the trust question and the
   * first OTP round are raised during the dial, so a handler attached once
   * connect resolves would arrive after the questions it exists to answer.
   */
  registerConnectionEvents(
    connectionId: string,
    handler: ConnectionEventHandler,
  ): void {
    this.ensureAttached();
    this.connectionHandlers.set(connectionId, handler);
  }

  forgetConnectionEvents(connectionId: string): void {
    this.connectionHandlers.delete(connectionId);
  }

  registerTailnet(handler: (event: EngineTailnetEvent) => void): void {
    this.ensureAttached();
    this.tailnetHandler = handler;
  }

  forgetTailnet(handler?: (event: EngineTailnetEvent) => void): void {
    if (!handler || this.tailnetHandler === handler) {
      this.tailnetHandler = null;
    }
  }

  /** Test seam: drops every subscription and handler. */
  reset(): void {
    this.subscriptions.forEach(subscription => subscription.remove());
    this.subscriptions = [];
    this.emitter = null;
    this.chunkHandlers.clear();
    this.shellClosedHandlers.clear();
    this.disconnectHandlers.clear();
    this.connectionHandlers.clear();
    this.tailnetHandler = null;
    this.pendingShellClosedIds.clear();
  }
}

const events = new GoEngineEvents();

/** Test seam: clears event subscriptions between cases. */
export function resetGoEngineEvents(): void {
  events.reset();
}

/**
 * Runs one native SSH dial operation with the exact event/prompt plumbing used
 * by normal mobile terminal connections. Remote Desktop uses this while the Go
 * tunnel performs its eager SSH + direct-tcpip dial, so host trust, OTP, banners
 * and hop progress do not fork into a second implementation.
 */
export async function runWithGoConnectionEvents<T>(
  options: ConnectionEventOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const native = requireNative();
  let declined = false;
  events.registerConnectionEvents(options.connectionId, event => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'hostKeyTrustChallenge':
        void answerHostKeyChallenge(native, options, payload, accepted => {
          declined = declined || !accepted;
        });
        return;
      case 'keyboardInteractiveChallenge':
        void answerInteractiveChallenge(native, options, payload);
        return;
      case 'sshBanner': {
        const text = String(payload.text ?? '');
        if (text) options.onBanner?.(text);
        return;
      }
      case 'connectionHopProgress': {
        const hopLabel = String(payload.hopLabel ?? '');
        if (!hopLabel) return;
        options.onHopProgress?.({
          hopLabel,
          hopIndex: typeof payload.hopIndex === 'number' ? payload.hopIndex : 1,
          hopCount: typeof payload.hopCount === 'number' ? payload.hopCount : 1,
          stage: String(payload.stage ?? ''),
        });
        return;
      }
      default:
        return;
    }
  });

  try {
    return await operation();
  } catch (error) {
    throw declined ? new HostKeyRejectedError() : error;
  } finally {
    events.forgetConnectionEvents(options.connectionId);
  }
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
    const result = await requireNative().readBuffer(
      this.id,
      mode,
      seq,
      tailBytes,
      timeMs,
      0,
    );
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

  async follow(
    handler: EngineOutputHandler,
    options: EngineFollowOptions,
  ): Promise<number> {
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

  async prepareAutocomplete(): Promise<EngineAutocompleteResult> {
    return JSON.parse(
      await requireNative().prepareAutocomplete(this.id),
    ) as EngineAutocompleteResult;
  }

  async runCompletion(command: string): Promise<EngineCompletionResult> {
    return JSON.parse(
      await requireNative().runCompletion(this.id, command),
    ) as EngineCompletionResult;
  }

  async reinjectShellIntegration(shellHint = ''): Promise<void> {
    await requireNative().reinjectShellIntegration(this.id, shellHint);
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

    if (options.onClosed) {
      events.prepareShellClosed();
    }
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

  async readChunk(
    path: string,
    offset: number,
    length: number,
  ): Promise<EngineSftpReadChunk> {
    const result = await requireNative().sftpReadChunk(
      this.id,
      path,
      offset,
      length,
    );
    return {
      bytes: toByteArray(result.dataBase64 ?? ''),
      eof: Boolean(result.eof),
    };
  }

  async writeChunk(
    path: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<void> {
    await requireNative().sftpWriteChunk(
      this.id,
      path,
      offset,
      fromByteArray(bytes),
    );
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

  async readTextFile(path: string): Promise<EngineSftpTextFile> {
    const raw = await requireNative().sftpReadTextFile(this.id, path);
    return JSON.parse(raw) as EngineSftpTextFile;
  }

  async writeTextFile(request: EngineSftpWriteTextFile): Promise<void> {
    await requireNative().sftpWriteTextFile(this.id, JSON.stringify(request));
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

  async configureTailnets(
    stateScope: string,
    configs: EngineTailnetConfig[],
    onEvent: (event: EngineTailnetEvent) => void,
  ): Promise<void> {
    events.registerTailnet(onEvent);
    try {
      await requireNative().configureTailnets(
        stateScope,
        JSON.stringify({ configs }),
      );
    } catch (error) {
      events.forgetTailnet(onEvent);
      throw error;
    }
  }

  async startTailnet(
    requestId: string,
    config: EngineTailnetConfig,
    timeoutMs = 0,
  ): Promise<void> {
    await requireNative().startTailnet(
      requestId,
      JSON.stringify({ config, timeoutMs }),
    );
  }

  async cancelTailnet(requestId: string, tailnetId: string): Promise<void> {
    await requireNative().cancelTailnet(requestId, tailnetId);
  }

  async disconnectTailnet(requestId: string, tailnetId: string): Promise<void> {
    await requireNative().disconnectTailnet(requestId, tailnetId);
  }

  async snapshotTailnets(requestId: string): Promise<void> {
    await requireNative().snapshotTailnets(requestId);
  }

  async forgetTailnet(tailnetId: string): Promise<void> {
    await requireNative().forgetTailnet(tailnetId);
  }

  async closeTailnets(): Promise<void> {
    events.forgetTailnet();
    await requireNative().closeTailnets();
  }

  /**
   * Connects, asking about whatever the connection runs into: an unknown host
   * key, a verification code, a banner the server wants read.
   *
   * Everything is asked inside the one connection. Trust used to be settled
   * before it — probe the host, show what it presented, then connect trusting
   * that key — which cost a second TCP connection and key exchange, and could not
   * work at all where it was needed most: a bastion that wants an OTP made the
   * probe ask for a code, and by the time the real connect asked again the code
   * had rotated.
   *
   * Keys already on file are still passed, so a host that presents one of them is
   * not asked about. A key outside that list raises the question — as a new host
   * if the list was empty, as a changed key if it was not.
   */
  async cancelConnect(connectionId: string): Promise<void> {
    await requireNative().cancelConnect(connectionId);
  }

  async connect(options: ConnectOptions): Promise<EngineConnection> {
    const native = requireNative();
    const onFile = options.trustedHostKeysBase64?.filter(Boolean) ?? [];
    if (options.onDisconnected) {
      events.registerDisconnected(options.connectionId, options.onDisconnected);
    }

    try {
      await runWithGoConnectionEvents(options, () =>
        native.connect(
          options.connectionId,
          JSON.stringify(connectPayload(options, onFile[0] ?? '', onFile)),
        ),
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

  async generateEphemeralSshKey(): Promise<{
    privateKeyPem: string;
    publicKey: string;
  }> {
    const raw = await requireNative().generateEphemeralSshKey();
    return JSON.parse(raw) as { privateKeyPem: string; publicKey: string };
  }

  async startAwsSsmShell(options: {
    sessionId: string;
    request: AwsSsmShellRequest;
    onClosed?: () => void;
  }): Promise<EngineShell> {
    if (options.onClosed) {
      events.prepareShellClosed();
    }
    const result = await requireNative().startAwsSsmShell(
      options.sessionId,
      JSON.stringify({ id: options.sessionId, ...options.request }),
    );
    if (options.onClosed) {
      events.registerShellClosed(result.shellId, options.onClosed);
    }
    return new GoShell(result.shellId);
  }

  async startSsmPortForward(options: {
    forwardId: string;
    request: SsmPortForwardRequest;
  }): Promise<EngineSsmForward> {
    const result = await requireNative().startSsmPortForward(
      options.forwardId,
      JSON.stringify({ id: options.forwardId, ...options.request }),
    );
    return {
      id: result.forwardId,
      bindPort: result.bindPort,
      stop: async () => {
        await requireNative().stopSsmPortForward(result.forwardId);
      },
    };
  }

  async validatePrivateKey(
    privateKeyPem: string,
    passphrase?: string,
  ): Promise<string | null> {
    try {
      await requireNative().inspectPrivateKey(privateKeyPem, passphrase ?? '');
      return null;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : t('engine.privateKeyUnreadable');
    }
  }

  async validateCertificate(certificateText: string): Promise<string | null> {
    try {
      const raw = await requireNative().inspectCertificate(certificateText);
      const inspection = JSON.parse(raw) as { status?: string };
      // The engine reports a status rather than throwing for a well-formed but
      // unusable certificate, so anything other than "valid" is a problem.
      if (inspection.status && inspection.status !== 'valid') {
        return t('engine.certificateUnusable', { status: inspection.status });
      }
      return null;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : t('engine.certificateUnreadable');
    }
  }
}
