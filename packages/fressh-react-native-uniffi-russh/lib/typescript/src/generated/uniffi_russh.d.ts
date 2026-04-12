import { type UniffiByteArray, type UniffiRustArcPtr, type UnsafeMutableRawPointer, FfiConverterObject, FfiConverterObjectWithCallbacks, RustBuffer, UniffiAbstractObject, destructorGuardSymbol, pointerLiteralSymbol, uniffiTypeNameSymbol } from 'uniffi-bindgen-react-native';
export declare function connect(options: ConnectOptions, asyncOpts_?: {
    signal: AbortSignal;
}): Promise<SshConnectionInterface>;
export declare function generateKeyPair(keyType: KeyType): string;
export declare function validatePrivateKey(privateKeyContent: string): string;
export type BufferReadResult = {
    chunks: Array<TerminalChunk>;
    nextSeq: bigint;
    dropped: DroppedRange | undefined;
};
/**
 * Generated factory for {@link BufferReadResult} record objects.
 */
export declare const BufferReadResult: Readonly<{
    /**
     * Create a frozen instance of {@link BufferReadResult}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<BufferReadResult> & Required<Omit<BufferReadResult, never>>) => BufferReadResult;
    /**
     * Create a frozen instance of {@link BufferReadResult}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<BufferReadResult> & Required<Omit<BufferReadResult, never>>) => BufferReadResult;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<BufferReadResult>;
}>;
export type BufferStats = {
    ringBytesCount: bigint;
    usedBytes: bigint;
    headSeq: bigint;
    tailSeq: bigint;
    droppedBytesTotal: bigint;
    chunksCount: bigint;
};
/**
 * Generated factory for {@link BufferStats} record objects.
 */
export declare const BufferStats: Readonly<{
    /**
     * Create a frozen instance of {@link BufferStats}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<BufferStats> & Required<Omit<BufferStats, never>>) => BufferStats;
    /**
     * Create a frozen instance of {@link BufferStats}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<BufferStats> & Required<Omit<BufferStats, never>>) => BufferStats;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<BufferStats>;
}>;
export type ConnectOptions = {
    connectionDetails: ConnectionDetails;
    onConnectionProgressCallback: ConnectProgressCallback | undefined;
    onDisconnectedCallback: ConnectionDisconnectedCallback | undefined;
    onServerKeyCallback: ServerKeyCallback;
};
/**
 * Generated factory for {@link ConnectOptions} record objects.
 */
export declare const ConnectOptions: Readonly<{
    /**
     * Create a frozen instance of {@link ConnectOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<ConnectOptions> & Required<Omit<ConnectOptions, never>>) => ConnectOptions;
    /**
     * Create a frozen instance of {@link ConnectOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<ConnectOptions> & Required<Omit<ConnectOptions, never>>) => ConnectOptions;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<ConnectOptions>;
}>;
export type ConnectionDetails = {
    host: string;
    port: number;
    username: string;
    security: Security;
};
/**
 * Generated factory for {@link ConnectionDetails} record objects.
 */
export declare const ConnectionDetails: Readonly<{
    /**
     * Create a frozen instance of {@link ConnectionDetails}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<ConnectionDetails> & Required<Omit<ConnectionDetails, never>>) => ConnectionDetails;
    /**
     * Create a frozen instance of {@link ConnectionDetails}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<ConnectionDetails> & Required<Omit<ConnectionDetails, never>>) => ConnectionDetails;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<ConnectionDetails>;
}>;
export type DroppedRange = {
    fromSeq: bigint;
    toSeq: bigint;
};
/**
 * Generated factory for {@link DroppedRange} record objects.
 */
export declare const DroppedRange: Readonly<{
    /**
     * Create a frozen instance of {@link DroppedRange}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<DroppedRange> & Required<Omit<DroppedRange, never>>) => DroppedRange;
    /**
     * Create a frozen instance of {@link DroppedRange}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<DroppedRange> & Required<Omit<DroppedRange, never>>) => DroppedRange;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<DroppedRange>;
}>;
export type ListenerOptions = {
    cursor: Cursor;
    coalesceMs: /*u32*/ number | undefined;
};
/**
 * Generated factory for {@link ListenerOptions} record objects.
 */
export declare const ListenerOptions: Readonly<{
    /**
     * Create a frozen instance of {@link ListenerOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<ListenerOptions> & Required<Omit<ListenerOptions, never>>) => ListenerOptions;
    /**
     * Create a frozen instance of {@link ListenerOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<ListenerOptions> & Required<Omit<ListenerOptions, never>>) => ListenerOptions;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<ListenerOptions>;
}>;
export type ServerPublicKeyInfo = {
    host: string;
    port: number;
    remoteIp: string | undefined;
    algorithm: string;
    fingerprintSha256: string;
    keyBase64: string;
};
/**
 * Generated factory for {@link ServerPublicKeyInfo} record objects.
 */
export declare const ServerPublicKeyInfo: Readonly<{
    /**
     * Create a frozen instance of {@link ServerPublicKeyInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<ServerPublicKeyInfo> & Required<Omit<ServerPublicKeyInfo, never>>) => ServerPublicKeyInfo;
    /**
     * Create a frozen instance of {@link ServerPublicKeyInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<ServerPublicKeyInfo> & Required<Omit<ServerPublicKeyInfo, never>>) => ServerPublicKeyInfo;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<ServerPublicKeyInfo>;
}>;
/**
 * Snapshot of shell session info for property-like access in TS.
 */
export type ShellSessionInfo = {
    channelId: number;
    createdAtMs: number;
    connectedAtMs: number;
    term: TerminalType;
    connectionId: string;
};
/**
 * Generated factory for {@link ShellSessionInfo} record objects.
 */
export declare const ShellSessionInfo: Readonly<{
    /**
     * Create a frozen instance of {@link ShellSessionInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<ShellSessionInfo> & Required<Omit<ShellSessionInfo, never>>) => ShellSessionInfo;
    /**
     * Create a frozen instance of {@link ShellSessionInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<ShellSessionInfo> & Required<Omit<ShellSessionInfo, never>>) => ShellSessionInfo;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<ShellSessionInfo>;
}>;
export type SshConnectionInfo = {
    connectionId: string;
    connectionDetails: ConnectionDetails;
    createdAtMs: number;
    connectedAtMs: number;
    progressTimings: SshConnectionInfoProgressTimings;
};
/**
 * Generated factory for {@link SshConnectionInfo} record objects.
 */
export declare const SshConnectionInfo: Readonly<{
    /**
     * Create a frozen instance of {@link SshConnectionInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<SshConnectionInfo> & Required<Omit<SshConnectionInfo, never>>) => SshConnectionInfo;
    /**
     * Create a frozen instance of {@link SshConnectionInfo}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<SshConnectionInfo> & Required<Omit<SshConnectionInfo, never>>) => SshConnectionInfo;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<SshConnectionInfo>;
}>;
export type SshConnectionInfoProgressTimings = {
    tcpEstablishedAtMs: number;
    sshHandshakeAtMs: number;
};
/**
 * Generated factory for {@link SshConnectionInfoProgressTimings} record objects.
 */
export declare const SshConnectionInfoProgressTimings: Readonly<{
    /**
     * Create a frozen instance of {@link SshConnectionInfoProgressTimings}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<SshConnectionInfoProgressTimings> & Required<Omit<SshConnectionInfoProgressTimings, never>>) => SshConnectionInfoProgressTimings;
    /**
     * Create a frozen instance of {@link SshConnectionInfoProgressTimings}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<SshConnectionInfoProgressTimings> & Required<Omit<SshConnectionInfoProgressTimings, never>>) => SshConnectionInfoProgressTimings;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<SshConnectionInfoProgressTimings>;
}>;
export type StartShellOptions = {
    term: TerminalType;
    terminalMode: Array<TerminalMode> | undefined;
    terminalSize: TerminalSize | undefined;
    terminalPixelSize: TerminalPixelSize | undefined;
    onClosedCallback: ShellClosedCallback | undefined;
};
/**
 * Generated factory for {@link StartShellOptions} record objects.
 */
export declare const StartShellOptions: Readonly<{
    /**
     * Create a frozen instance of {@link StartShellOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<StartShellOptions> & Required<Omit<StartShellOptions, never>>) => StartShellOptions;
    /**
     * Create a frozen instance of {@link StartShellOptions}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<StartShellOptions> & Required<Omit<StartShellOptions, never>>) => StartShellOptions;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<StartShellOptions>;
}>;
export type TerminalChunk = {
    seq: bigint;
    tMs: number;
    stream: StreamKind;
    bytes: ArrayBuffer;
};
/**
 * Generated factory for {@link TerminalChunk} record objects.
 */
export declare const TerminalChunk: Readonly<{
    /**
     * Create a frozen instance of {@link TerminalChunk}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<TerminalChunk> & Required<Omit<TerminalChunk, never>>) => TerminalChunk;
    /**
     * Create a frozen instance of {@link TerminalChunk}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<TerminalChunk> & Required<Omit<TerminalChunk, never>>) => TerminalChunk;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<TerminalChunk>;
}>;
export type TerminalMode = {
    opcode: number;
    value: number;
};
/**
 * Generated factory for {@link TerminalMode} record objects.
 */
export declare const TerminalMode: Readonly<{
    /**
     * Create a frozen instance of {@link TerminalMode}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<TerminalMode> & Required<Omit<TerminalMode, never>>) => TerminalMode;
    /**
     * Create a frozen instance of {@link TerminalMode}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<TerminalMode> & Required<Omit<TerminalMode, never>>) => TerminalMode;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<TerminalMode>;
}>;
export type TerminalPixelSize = {
    pixelWidth: /*u32*/ number | undefined;
    pixelHeight: /*u32*/ number | undefined;
};
/**
 * Generated factory for {@link TerminalPixelSize} record objects.
 */
export declare const TerminalPixelSize: Readonly<{
    /**
     * Create a frozen instance of {@link TerminalPixelSize}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<TerminalPixelSize> & Required<Omit<TerminalPixelSize, never>>) => TerminalPixelSize;
    /**
     * Create a frozen instance of {@link TerminalPixelSize}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<TerminalPixelSize> & Required<Omit<TerminalPixelSize, never>>) => TerminalPixelSize;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<TerminalPixelSize>;
}>;
export type TerminalSize = {
    rowHeight: /*u32*/ number | undefined;
    colWidth: /*u32*/ number | undefined;
};
/**
 * Generated factory for {@link TerminalSize} record objects.
 */
export declare const TerminalSize: Readonly<{
    /**
     * Create a frozen instance of {@link TerminalSize}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    create: (partial: Partial<TerminalSize> & Required<Omit<TerminalSize, never>>) => TerminalSize;
    /**
     * Create a frozen instance of {@link TerminalSize}, with defaults specified
     * in Rust, in the {@link uniffi_russh} crate.
     */
    new: (partial: Partial<TerminalSize> & Required<Omit<TerminalSize, never>>) => TerminalSize;
    /**
     * Defaults specified in the {@link uniffi_russh} crate.
     */
    defaults: () => Partial<TerminalSize>;
}>;
export declare enum Cursor_Tags {
    Head = "Head",
    TailBytes = "TailBytes",
    Seq = "Seq",
    TimeMs = "TimeMs",
    Live = "Live"
}
export declare const Cursor: Readonly<{
    instanceOf: (obj: any) => obj is Cursor;
    Head: {
        new (): {
            readonly tag: Cursor_Tags.Head;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        "new"(): {
            readonly tag: Cursor_Tags.Head;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Cursor_Tags.Head;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
    };
    TailBytes: {
        new (inner: {
            bytes: bigint;
        }): {
            readonly tag: Cursor_Tags.TailBytes;
            readonly inner: Readonly<{
                bytes: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        "new"(inner: {
            bytes: bigint;
        }): {
            readonly tag: Cursor_Tags.TailBytes;
            readonly inner: Readonly<{
                bytes: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Cursor_Tags.TailBytes;
            readonly inner: Readonly<{
                bytes: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
    };
    Seq: {
        new (inner: {
            seq: bigint;
        }): {
            readonly tag: Cursor_Tags.Seq;
            readonly inner: Readonly<{
                seq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        "new"(inner: {
            seq: bigint;
        }): {
            readonly tag: Cursor_Tags.Seq;
            readonly inner: Readonly<{
                seq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Cursor_Tags.Seq;
            readonly inner: Readonly<{
                seq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
    };
    TimeMs: {
        new (inner: {
            tMs: number;
        }): {
            readonly tag: Cursor_Tags.TimeMs;
            readonly inner: Readonly<{
                tMs: number;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        "new"(inner: {
            tMs: number;
        }): {
            readonly tag: Cursor_Tags.TimeMs;
            readonly inner: Readonly<{
                tMs: number;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Cursor_Tags.TimeMs;
            readonly inner: Readonly<{
                tMs: number;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
    };
    Live: {
        new (): {
            readonly tag: Cursor_Tags.Live;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        "new"(): {
            readonly tag: Cursor_Tags.Live;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Cursor_Tags.Live;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Cursor";
        };
    };
}>;
export type Cursor = InstanceType<(typeof Cursor)[keyof Omit<typeof Cursor, 'instanceOf'>]>;
export declare enum KeyType {
    Rsa = 0,
    Ecdsa = 1,
    Ed25519 = 2,
    Ed448 = 3
}
export declare enum Security_Tags {
    Password = "Password",
    Key = "Key"
}
export declare const Security: Readonly<{
    instanceOf: (obj: any) => obj is Security;
    Password: {
        new (inner: {
            password: string;
        }): {
            readonly tag: Security_Tags.Password;
            readonly inner: Readonly<{
                password: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
        "new"(inner: {
            password: string;
        }): {
            readonly tag: Security_Tags.Password;
            readonly inner: Readonly<{
                password: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Security_Tags.Password;
            readonly inner: Readonly<{
                password: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
    };
    Key: {
        new (inner: {
            privateKeyContent: string;
        }): {
            readonly tag: Security_Tags.Key;
            readonly inner: Readonly<{
                privateKeyContent: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
        "new"(inner: {
            privateKeyContent: string;
        }): {
            readonly tag: Security_Tags.Key;
            readonly inner: Readonly<{
                privateKeyContent: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
        instanceOf(obj: any): obj is {
            readonly tag: Security_Tags.Key;
            readonly inner: Readonly<{
                privateKeyContent: string;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "Security";
        };
    };
}>;
export type Security = InstanceType<(typeof Security)[keyof Omit<typeof Security, 'instanceOf'>]>;
export declare enum ShellEvent_Tags {
    Chunk = "Chunk",
    Dropped = "Dropped"
}
export declare const ShellEvent: Readonly<{
    instanceOf: (obj: any) => obj is ShellEvent;
    Chunk: {
        new (v0: TerminalChunk): {
            readonly tag: ShellEvent_Tags.Chunk;
            readonly inner: Readonly<[TerminalChunk]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
        "new"(v0: TerminalChunk): {
            readonly tag: ShellEvent_Tags.Chunk;
            readonly inner: Readonly<[TerminalChunk]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
        instanceOf(obj: any): obj is {
            readonly tag: ShellEvent_Tags.Chunk;
            readonly inner: Readonly<[TerminalChunk]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
    };
    Dropped: {
        new (inner: {
            fromSeq: bigint;
            toSeq: bigint;
        }): {
            readonly tag: ShellEvent_Tags.Dropped;
            readonly inner: Readonly<{
                fromSeq: bigint;
                toSeq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
        "new"(inner: {
            fromSeq: bigint;
            toSeq: bigint;
        }): {
            readonly tag: ShellEvent_Tags.Dropped;
            readonly inner: Readonly<{
                fromSeq: bigint;
                toSeq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
        instanceOf(obj: any): obj is {
            readonly tag: ShellEvent_Tags.Dropped;
            readonly inner: Readonly<{
                fromSeq: bigint;
                toSeq: bigint;
            }>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "ShellEvent";
        };
    };
}>;
export type ShellEvent = InstanceType<(typeof ShellEvent)[keyof Omit<typeof ShellEvent, 'instanceOf'>]>;
export declare enum SshConnectionProgressEvent {
    TcpConnected = 0,
    SshHandshake = 1
}
export declare enum SshError_Tags {
    Disconnected = "Disconnected",
    UnsupportedKeyType = "UnsupportedKeyType",
    Auth = "Auth",
    ShellAlreadyRunning = "ShellAlreadyRunning",
    Russh = "Russh",
    RusshKeys = "RusshKeys"
}
export declare const SshError: Readonly<{
    instanceOf: (obj: any) => obj is SshError;
    Disconnected: {
        new (): {
            readonly tag: SshError_Tags.Disconnected;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(): {
            readonly tag: SshError_Tags.Disconnected;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.Disconnected;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.Disconnected;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    UnsupportedKeyType: {
        new (): {
            readonly tag: SshError_Tags.UnsupportedKeyType;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(): {
            readonly tag: SshError_Tags.UnsupportedKeyType;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.UnsupportedKeyType;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.UnsupportedKeyType;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    Auth: {
        new (v0: string): {
            readonly tag: SshError_Tags.Auth;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(v0: string): {
            readonly tag: SshError_Tags.Auth;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.Auth;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.Auth;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        getInner(obj: {
            readonly tag: SshError_Tags.Auth;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        }): Readonly<[string]>;
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    ShellAlreadyRunning: {
        new (): {
            readonly tag: SshError_Tags.ShellAlreadyRunning;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(): {
            readonly tag: SshError_Tags.ShellAlreadyRunning;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.ShellAlreadyRunning;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.ShellAlreadyRunning;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    Russh: {
        new (v0: string): {
            readonly tag: SshError_Tags.Russh;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(v0: string): {
            readonly tag: SshError_Tags.Russh;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.Russh;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.Russh;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        getInner(obj: {
            readonly tag: SshError_Tags.Russh;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        }): Readonly<[string]>;
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    RusshKeys: {
        new (v0: string): {
            readonly tag: SshError_Tags.RusshKeys;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        "new"(v0: string): {
            readonly tag: SshError_Tags.RusshKeys;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        instanceOf(obj: any): obj is {
            readonly tag: SshError_Tags.RusshKeys;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        hasInner(obj: any): obj is {
            readonly tag: SshError_Tags.RusshKeys;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        getInner(obj: {
            readonly tag: SshError_Tags.RusshKeys;
            readonly inner: Readonly<[string]>;
            /**
             * @private
             * This field is private and should not be used, use `tag` instead.
             */
            readonly [uniffiTypeNameSymbol]: "SshError";
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        }): Readonly<[string]>;
        isError(error: unknown): error is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
}>;
export type SshError = InstanceType<(typeof SshError)[keyof Omit<typeof SshError, 'instanceOf'>]>;
export declare enum StreamKind {
    Stdout = 0,
    Stderr = 1
}
export declare enum TerminalType {
    Vanilla = 0,
    Vt100 = 1,
    Vt102 = 2,
    Vt220 = 3,
    Ansi = 4,
    Xterm = 5,
    Xterm256 = 6
}
export interface ConnectProgressCallback {
    onChange(status: SshConnectionProgressEvent): void;
}
export declare class ConnectProgressCallbackImpl extends UniffiAbstractObject implements ConnectProgressCallback {
    readonly [uniffiTypeNameSymbol] = "ConnectProgressCallbackImpl";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    onChange(status: SshConnectionProgressEvent): void;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ConnectProgressCallbackImpl;
}
export interface ConnectionDisconnectedCallback {
    onChange(connectionId: string): void;
}
export declare class ConnectionDisconnectedCallbackImpl extends UniffiAbstractObject implements ConnectionDisconnectedCallback {
    readonly [uniffiTypeNameSymbol] = "ConnectionDisconnectedCallbackImpl";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    onChange(connectionId: string): void;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ConnectionDisconnectedCallbackImpl;
}
export interface ServerKeyCallback {
    onChange(serverKeyInfo: ServerPublicKeyInfo, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<boolean>;
}
export declare class ServerKeyCallbackImpl extends UniffiAbstractObject implements ServerKeyCallback {
    readonly [uniffiTypeNameSymbol] = "ServerKeyCallbackImpl";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    onChange(serverKeyInfo: ServerPublicKeyInfo, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<boolean>;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ServerKeyCallbackImpl;
}
export interface ShellClosedCallback {
    onChange(channelId: number): void;
}
export declare class ShellClosedCallbackImpl extends UniffiAbstractObject implements ShellClosedCallback {
    readonly [uniffiTypeNameSymbol] = "ShellClosedCallbackImpl";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    onChange(channelId: number): void;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ShellClosedCallbackImpl;
}
export interface ShellListener {
    onEvent(ev: ShellEvent): void;
}
export declare class ShellListenerImpl extends UniffiAbstractObject implements ShellListener {
    readonly [uniffiTypeNameSymbol] = "ShellListenerImpl";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    onEvent(ev: ShellEvent): void;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ShellListenerImpl;
}
export interface ShellSessionInterface {
    /**
     * Add a listener with optional replay and live follow.
     */
    addListener(listener: ShellListener, opts: ListenerOptions): bigint;
    /**
     * Buffer statistics snapshot.
     */
    bufferStats(): BufferStats;
    /**
     * Close the associated shell channel and stop its reader task.
     */
    close(asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
    /**
     * Current next sequence number.
     */
    currentSeq(): bigint;
    getInfo(): ShellSessionInfo;
    /**
     * Read the ring buffer from a cursor.
     */
    readBuffer(cursor: Cursor, maxBytes: /*u64*/ bigint | undefined): BufferReadResult;
    removeListener(id: bigint): void;
    /**
     * Send bytes to the active shell (stdin).
     */
    sendData(data: ArrayBuffer, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
}
export declare class ShellSession extends UniffiAbstractObject implements ShellSessionInterface {
    readonly [uniffiTypeNameSymbol] = "ShellSession";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    /**
     * Add a listener with optional replay and live follow.
     */
    addListener(listener: ShellListener, opts: ListenerOptions): bigint;
    /**
     * Buffer statistics snapshot.
     */
    bufferStats(): BufferStats;
    /**
     * Close the associated shell channel and stop its reader task.
     */
    close(asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
    /**
     * Current next sequence number.
     */
    currentSeq(): bigint;
    getInfo(): ShellSessionInfo;
    /**
     * Read the ring buffer from a cursor.
     */
    readBuffer(cursor: Cursor, maxBytes: /*u64*/ bigint | undefined): BufferReadResult;
    removeListener(id: bigint): void;
    /**
     * Send bytes to the active shell (stdin).
     */
    sendData(data: ArrayBuffer, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is ShellSession;
}
export interface SshConnectionInterface {
    disconnect(asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
    /**
     * Convenience snapshot for property-like access in TS.
     */
    getInfo(): SshConnectionInfo;
    startShell(opts: StartShellOptions, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<ShellSessionInterface>;
}
export declare class SshConnection extends UniffiAbstractObject implements SshConnectionInterface {
    readonly [uniffiTypeNameSymbol] = "SshConnection";
    readonly [destructorGuardSymbol]: UniffiRustArcPtr;
    readonly [pointerLiteralSymbol]: UnsafeMutableRawPointer;
    private constructor();
    disconnect(asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<void>;
    /**
     * Convenience snapshot for property-like access in TS.
     */
    getInfo(): SshConnectionInfo;
    startShell(opts: StartShellOptions, asyncOpts_?: {
        signal: AbortSignal;
    }): Promise<ShellSessionInterface>;
    /**
     * {@inheritDoc uniffi-bindgen-react-native#UniffiAbstractObject.uniffiDestroy}
     */
    uniffiDestroy(): void;
    static instanceOf(obj: any): obj is SshConnection;
}
/**
 * This should be called before anything else.
 *
 * It is likely that this is being done for you by the library's `index.ts`.
 *
 * It checks versions of uniffi between when the Rust scaffolding was generated
 * and when the bindings were generated.
 *
 * It also initializes the machinery to enable Rust to talk back to Javascript.
 */
declare function uniffiEnsureInitialized(): void;
declare const _default: Readonly<{
    initialize: typeof uniffiEnsureInitialized;
    converters: {
        FfiConverterTypeBufferReadResult: {
            read(from: RustBuffer): BufferReadResult;
            write(value: BufferReadResult, into: RustBuffer): void;
            allocationSize(value: BufferReadResult): number;
            lift(value: UniffiByteArray): BufferReadResult;
            lower(value: BufferReadResult): UniffiByteArray;
        };
        FfiConverterTypeBufferStats: {
            read(from: RustBuffer): BufferStats;
            write(value: BufferStats, into: RustBuffer): void;
            allocationSize(value: BufferStats): number;
            lift(value: UniffiByteArray): BufferStats;
            lower(value: BufferStats): UniffiByteArray;
        };
        FfiConverterTypeConnectOptions: {
            read(from: RustBuffer): ConnectOptions;
            write(value: ConnectOptions, into: RustBuffer): void;
            allocationSize(value: ConnectOptions): number;
            lift(value: UniffiByteArray): ConnectOptions;
            lower(value: ConnectOptions): UniffiByteArray;
        };
        FfiConverterTypeConnectProgressCallback: FfiConverterObjectWithCallbacks<ConnectProgressCallback>;
        FfiConverterTypeConnectionDetails: {
            read(from: RustBuffer): ConnectionDetails;
            write(value: ConnectionDetails, into: RustBuffer): void;
            allocationSize(value: ConnectionDetails): number;
            lift(value: UniffiByteArray): ConnectionDetails;
            lower(value: ConnectionDetails): UniffiByteArray;
        };
        FfiConverterTypeConnectionDisconnectedCallback: FfiConverterObjectWithCallbacks<ConnectionDisconnectedCallback>;
        FfiConverterTypeCursor: {
            read(from: RustBuffer): Cursor;
            write(value: Cursor, into: RustBuffer): void;
            allocationSize(value: Cursor): number;
            lift(value: UniffiByteArray): Cursor;
            lower(value: Cursor): UniffiByteArray;
        };
        FfiConverterTypeDroppedRange: {
            read(from: RustBuffer): DroppedRange;
            write(value: DroppedRange, into: RustBuffer): void;
            allocationSize(value: DroppedRange): number;
            lift(value: UniffiByteArray): DroppedRange;
            lower(value: DroppedRange): UniffiByteArray;
        };
        FfiConverterTypeKeyType: {
            read(from: RustBuffer): KeyType;
            write(value: KeyType, into: RustBuffer): void;
            allocationSize(value: KeyType): number;
            lift(value: UniffiByteArray): KeyType;
            lower(value: KeyType): UniffiByteArray;
        };
        FfiConverterTypeListenerOptions: {
            read(from: RustBuffer): ListenerOptions;
            write(value: ListenerOptions, into: RustBuffer): void;
            allocationSize(value: ListenerOptions): number;
            lift(value: UniffiByteArray): ListenerOptions;
            lower(value: ListenerOptions): UniffiByteArray;
        };
        FfiConverterTypeSecurity: {
            read(from: RustBuffer): Security;
            write(value: Security, into: RustBuffer): void;
            allocationSize(value: Security): number;
            lift(value: UniffiByteArray): Security;
            lower(value: Security): UniffiByteArray;
        };
        FfiConverterTypeServerKeyCallback: FfiConverterObjectWithCallbacks<ServerKeyCallback>;
        FfiConverterTypeServerPublicKeyInfo: {
            read(from: RustBuffer): ServerPublicKeyInfo;
            write(value: ServerPublicKeyInfo, into: RustBuffer): void;
            allocationSize(value: ServerPublicKeyInfo): number;
            lift(value: UniffiByteArray): ServerPublicKeyInfo;
            lower(value: ServerPublicKeyInfo): UniffiByteArray;
        };
        FfiConverterTypeShellClosedCallback: FfiConverterObjectWithCallbacks<ShellClosedCallback>;
        FfiConverterTypeShellEvent: {
            read(from: RustBuffer): ShellEvent;
            write(value: ShellEvent, into: RustBuffer): void;
            allocationSize(value: ShellEvent): number;
            lift(value: UniffiByteArray): ShellEvent;
            lower(value: ShellEvent): UniffiByteArray;
        };
        FfiConverterTypeShellListener: FfiConverterObjectWithCallbacks<ShellListener>;
        FfiConverterTypeShellSession: FfiConverterObject<ShellSessionInterface>;
        FfiConverterTypeShellSessionInfo: {
            read(from: RustBuffer): ShellSessionInfo;
            write(value: ShellSessionInfo, into: RustBuffer): void;
            allocationSize(value: ShellSessionInfo): number;
            lift(value: UniffiByteArray): ShellSessionInfo;
            lower(value: ShellSessionInfo): UniffiByteArray;
        };
        FfiConverterTypeSshConnection: FfiConverterObject<SshConnectionInterface>;
        FfiConverterTypeSshConnectionInfo: {
            read(from: RustBuffer): SshConnectionInfo;
            write(value: SshConnectionInfo, into: RustBuffer): void;
            allocationSize(value: SshConnectionInfo): number;
            lift(value: UniffiByteArray): SshConnectionInfo;
            lower(value: SshConnectionInfo): UniffiByteArray;
        };
        FfiConverterTypeSshConnectionInfoProgressTimings: {
            read(from: RustBuffer): SshConnectionInfoProgressTimings;
            write(value: SshConnectionInfoProgressTimings, into: RustBuffer): void;
            allocationSize(value: SshConnectionInfoProgressTimings): number;
            lift(value: UniffiByteArray): SshConnectionInfoProgressTimings;
            lower(value: SshConnectionInfoProgressTimings): UniffiByteArray;
        };
        FfiConverterTypeSshConnectionProgressEvent: {
            read(from: RustBuffer): SshConnectionProgressEvent;
            write(value: SshConnectionProgressEvent, into: RustBuffer): void;
            allocationSize(value: SshConnectionProgressEvent): number;
            lift(value: UniffiByteArray): SshConnectionProgressEvent;
            lower(value: SshConnectionProgressEvent): UniffiByteArray;
        };
        FfiConverterTypeSshError: {
            read(from: RustBuffer): SshError;
            write(value: SshError, into: RustBuffer): void;
            allocationSize(value: SshError): number;
            lift(value: UniffiByteArray): SshError;
            lower(value: SshError): UniffiByteArray;
        };
        FfiConverterTypeStartShellOptions: {
            read(from: RustBuffer): StartShellOptions;
            write(value: StartShellOptions, into: RustBuffer): void;
            allocationSize(value: StartShellOptions): number;
            lift(value: UniffiByteArray): StartShellOptions;
            lower(value: StartShellOptions): UniffiByteArray;
        };
        FfiConverterTypeStreamKind: {
            read(from: RustBuffer): StreamKind;
            write(value: StreamKind, into: RustBuffer): void;
            allocationSize(value: StreamKind): number;
            lift(value: UniffiByteArray): StreamKind;
            lower(value: StreamKind): UniffiByteArray;
        };
        FfiConverterTypeTerminalChunk: {
            read(from: RustBuffer): TerminalChunk;
            write(value: TerminalChunk, into: RustBuffer): void;
            allocationSize(value: TerminalChunk): number;
            lift(value: UniffiByteArray): TerminalChunk;
            lower(value: TerminalChunk): UniffiByteArray;
        };
        FfiConverterTypeTerminalMode: {
            read(from: RustBuffer): TerminalMode;
            write(value: TerminalMode, into: RustBuffer): void;
            allocationSize(value: TerminalMode): number;
            lift(value: UniffiByteArray): TerminalMode;
            lower(value: TerminalMode): UniffiByteArray;
        };
        FfiConverterTypeTerminalPixelSize: {
            read(from: RustBuffer): TerminalPixelSize;
            write(value: TerminalPixelSize, into: RustBuffer): void;
            allocationSize(value: TerminalPixelSize): number;
            lift(value: UniffiByteArray): TerminalPixelSize;
            lower(value: TerminalPixelSize): UniffiByteArray;
        };
        FfiConverterTypeTerminalSize: {
            read(from: RustBuffer): TerminalSize;
            write(value: TerminalSize, into: RustBuffer): void;
            allocationSize(value: TerminalSize): number;
            lift(value: UniffiByteArray): TerminalSize;
            lower(value: TerminalSize): UniffiByteArray;
        };
        FfiConverterTypeTerminalType: {
            read(from: RustBuffer): TerminalType;
            write(value: TerminalType, into: RustBuffer): void;
            allocationSize(value: TerminalType): number;
            lift(value: UniffiByteArray): TerminalType;
            lower(value: TerminalType): UniffiByteArray;
        };
    };
}>;
export default _default;
//# sourceMappingURL=uniffi_russh.d.ts.map