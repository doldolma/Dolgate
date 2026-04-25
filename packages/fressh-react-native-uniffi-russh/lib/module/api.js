/**
 * We cannot make the generated code match this API exactly because uniffi
 * - Doesn't support ts literals for rust enums
 * - Doesn't support passing a js object with methods and properties to or from rust.
 *
 * The second issue is much harder to get around than the first.
 * In practice it means that if you want to pass an object with callbacks and props to rust, it need to be in seperate args.
 * If you want to pass an object with callbacks and props from rust to js (like ssh handles), you need to instead only pass an object with callbacks
 * just make one of the callbacks a sync info() callback.
 *
 * Then in this api wrapper we can smooth over those rough edges.
 * See: - https://jhugman.github.io/uniffi-bindgen-react-native/idioms/callback-interfaces.html
 */
import * as GeneratedRussh from "./index.js";
// #endregion
// #region Wrapper to match the ideal API
const terminalTypeLiteralToEnum = {
    Vanilla: GeneratedRussh.TerminalType.Vanilla,
    Vt100: GeneratedRussh.TerminalType.Vt100,
    Vt102: GeneratedRussh.TerminalType.Vt102,
    Vt220: GeneratedRussh.TerminalType.Vt220,
    Ansi: GeneratedRussh.TerminalType.Ansi,
    Xterm: GeneratedRussh.TerminalType.Xterm,
    Xterm256: GeneratedRussh.TerminalType.Xterm256,
};
const terminalTypeEnumToLiteral = {
    [GeneratedRussh.TerminalType.Vanilla]: "Vanilla",
    [GeneratedRussh.TerminalType.Vt100]: "Vt100",
    [GeneratedRussh.TerminalType.Vt102]: "Vt102",
    [GeneratedRussh.TerminalType.Vt220]: "Vt220",
    [GeneratedRussh.TerminalType.Ansi]: "Ansi",
    [GeneratedRussh.TerminalType.Xterm]: "Xterm",
    [GeneratedRussh.TerminalType.Xterm256]: "Xterm256",
};
const sshConnProgressEnumToLiteral = {
    [GeneratedRussh.SshConnectionProgressEvent.TcpConnected]: "tcpConnected",
    [GeneratedRussh.SshConnectionProgressEvent.SshHandshake]: "sshHandshake",
};
const streamEnumToLiteral = {
    [GeneratedRussh.StreamKind.Stdout]: "stdout",
    [GeneratedRussh.StreamKind.Stderr]: "stderr",
};
const sftpEntryKindEnumToLiteral = {
    [GeneratedRussh.SftpEntryKind.File]: "file",
    [GeneratedRussh.SftpEntryKind.Directory]: "directory",
    [GeneratedRussh.SftpEntryKind.Symlink]: "symlink",
    [GeneratedRussh.SftpEntryKind.Unknown]: "unknown",
};
function generatedConnDetailsToIdeal(details) {
    let security;
    if (details.security instanceof GeneratedRussh.Security.Password) {
        security = { type: "password", password: details.security.inner.password };
    }
    else if (details.security instanceof GeneratedRussh.Security.Key) {
        security = {
            type: "key",
            privateKey: details.security.inner.privateKeyContent,
            passphrase: details.security.inner.passphrase ?? undefined,
        };
    }
    else {
        security = {
            type: "certificate",
            privateKey: details.security.inner.privateKeyContent,
            certificate: details.security.inner.certificateText,
            passphrase: details.security.inner.passphrase ?? undefined,
        };
    }
    return {
        host: details.host,
        port: details.port,
        username: details.username,
        security,
    };
}
function securityToGenerated(security) {
    switch (security.type) {
        case "password":
            return new GeneratedRussh.Security.Password({
                password: security.password,
            });
        case "key":
            return new GeneratedRussh.Security.Key({
                privateKeyContent: security.privateKey,
                passphrase: security.passphrase,
            });
        case "certificate":
            return new GeneratedRussh.Security.Certificate({
                privateKeyContent: security.privateKey,
                certificateText: security.certificate,
                passphrase: security.passphrase,
            });
    }
}
function cursorToGenerated(cursor) {
    switch (cursor.mode) {
        case "head":
            return new GeneratedRussh.Cursor.Head();
        case "tailBytes":
            return new GeneratedRussh.Cursor.TailBytes({
                bytes: cursor.bytes,
            });
        case "seq":
            return new GeneratedRussh.Cursor.Seq({ seq: cursor.seq });
        case "time":
            return new GeneratedRussh.Cursor.TimeMs({ tMs: cursor.tMs });
        case "live":
            return new GeneratedRussh.Cursor.Live();
    }
}
function toTerminalChunk(ch) {
    return {
        seq: ch.seq,
        tMs: ch.tMs,
        stream: streamEnumToLiteral[ch.stream],
        bytes: ch.bytes,
    };
}
function wrapShellSession(shell) {
    const info = shell.getInfo();
    const readBuffer = (cursor, maxBytes) => {
        const res = shell.readBuffer(cursorToGenerated(cursor), maxBytes);
        return {
            chunks: res.chunks.map(toTerminalChunk),
            nextSeq: res.nextSeq,
            dropped: res.dropped,
        };
    };
    const addListener = (cb, opts) => {
        const listener = {
            onEvent: (ev) => {
                if (ev instanceof GeneratedRussh.ShellEvent.Chunk) {
                    cb(toTerminalChunk(ev.inner[0]));
                }
                else if (ev instanceof GeneratedRussh.ShellEvent.Dropped) {
                    cb({
                        kind: "dropped",
                        fromSeq: ev.inner.fromSeq,
                        toSeq: ev.inner.toSeq,
                    });
                }
            },
        };
        try {
            const id = shell.addListener(listener, {
                cursor: cursorToGenerated(opts.cursor),
                coalesceMs: opts.coalesceMs,
            });
            if (id === 0n) {
                throw new Error("Failed to attach shell listener (id=0)");
            }
            return id;
        }
        catch (e) {
            throw new Error(`addListener failed: ${String(e?.message ?? e)}`);
        }
    };
    return {
        channelId: info.channelId,
        createdAtMs: info.createdAtMs,
        pty: terminalTypeEnumToLiteral[info.term],
        connectionId: info.connectionId,
        sendData: (data, o) => shell.sendData(data, o?.signal ? { signal: o.signal } : undefined),
        close: (o) => shell.close(o?.signal ? { signal: o.signal } : undefined),
        // setBufferPolicy,
        bufferStats: shell.bufferStats,
        currentSeq: () => Number(shell.currentSeq()),
        readBuffer,
        addListener,
        removeListener: (id) => shell.removeListener(id),
    };
}
function wrapConnection(conn) {
    const info = conn.getInfo();
    return {
        connectionId: info.connectionId,
        connectionDetails: generatedConnDetailsToIdeal(info.connectionDetails),
        createdAtMs: info.createdAtMs,
        connectedAtMs: info.connectedAtMs,
        progressTimings: {
            tcpEstablishedAtMs: info.progressTimings.tcpEstablishedAtMs,
            sshHandshakeAtMs: info.progressTimings.sshHandshakeAtMs,
        },
        startShell: async ({ onClosed, ...params }) => {
            const shell = await conn.startShell({
                term: terminalTypeLiteralToEnum[params.term],
                onClosedCallback: onClosed
                    ? {
                        onChange: (channelId) => onClosed(channelId),
                    }
                    : undefined,
                terminalMode: params.terminalMode,
                terminalPixelSize: params.terminalPixelSize,
                terminalSize: params.terminalSize,
            }, params.abortSignal ? { signal: params.abortSignal } : undefined);
            return wrapShellSession(shell);
        },
        disconnect: (opts) => conn.disconnect(opts?.signal ? { signal: opts.signal } : undefined),
    };
}
function wrapSftpConnection(conn) {
    const info = conn.getInfo();
    const asyncOpts = (opts) => opts?.signal ? { signal: opts.signal } : undefined;
    return {
        connectionId: info.connectionId,
        connectionDetails: generatedConnDetailsToIdeal(info.connectionDetails),
        createdAtMs: info.createdAtMs,
        connectedAtMs: info.connectedAtMs,
        listDirectory: async (path, opts) => {
            const listing = await conn.listDirectory(path, asyncOpts(opts));
            return {
                path: listing.path,
                entries: listing.entries.map((entry) => ({
                    name: entry.name,
                    path: entry.path,
                    isDirectory: entry.isDirectory,
                    size: entry.size,
                    mtime: entry.mtime ?? null,
                    kind: sftpEntryKindEnumToLiteral[entry.kind],
                    permissions: entry.permissions ?? null,
                })),
            };
        },
        readFileChunk: (path, offset, length, opts) => conn.readFileChunk(path, offset, length, asyncOpts(opts)),
        writeFileChunk: (path, offset, data, opts) => conn.writeFileChunk(path, offset, data, asyncOpts(opts)),
        mkdir: (path, opts) => conn.mkdir(path, asyncOpts(opts)),
        rename: (sourcePath, targetPath, opts) => conn.rename(sourcePath, targetPath, asyncOpts(opts)),
        chmod: (path, permissions, opts) => conn.chmod(path, permissions, asyncOpts(opts)),
        delete: (path, opts) => conn.delete_(path, asyncOpts(opts)),
        close: (opts) => conn.close(asyncOpts(opts)),
    };
}
async function connect({ onServerKey, onConnectionProgress, onDisconnected, ...options }) {
    const security = securityToGenerated(options.security);
    const sshConnection = await GeneratedRussh.connect({
        connectionDetails: {
            host: options.host,
            port: options.port,
            username: options.username,
            security,
        },
        onConnectionProgressCallback: onConnectionProgress
            ? {
                onChange: (statusEnum) => onConnectionProgress(sshConnProgressEnumToLiteral[statusEnum]),
            }
            : undefined,
        onDisconnectedCallback: onDisconnected
            ? {
                onChange: (connectionId) => onDisconnected(connectionId),
            }
            : undefined,
        onServerKeyCallback: {
            onChange: (serverKeyInfo) => onServerKey(serverKeyInfo, options.abortSignal),
        },
    }, options.abortSignal ? { signal: options.abortSignal } : undefined);
    return wrapConnection(sshConnection);
}
async function connectSftp({ onServerKey, onConnectionProgress, onDisconnected, ...options }) {
    const generated = GeneratedRussh;
    if (!generated.connectSftp) {
        throw new Error("SFTP native bridge is not available.");
    }
    const security = securityToGenerated(options.security);
    const sftpConnection = await generated.connectSftp({
        connectionDetails: {
            host: options.host,
            port: options.port,
            username: options.username,
            security,
        },
        onConnectionProgressCallback: onConnectionProgress
            ? {
                onChange: (statusEnum) => onConnectionProgress(sshConnProgressEnumToLiteral[statusEnum]),
            }
            : undefined,
        onDisconnectedCallback: onDisconnected
            ? {
                onChange: (connectionId) => onDisconnected(connectionId),
            }
            : undefined,
        onServerKeyCallback: {
            onChange: (serverKeyInfo) => onServerKey(serverKeyInfo, options.abortSignal),
        },
    }, options.abortSignal ? { signal: options.abortSignal } : undefined);
    return wrapSftpConnection(sftpConnection);
}
async function generateKeyPair(type) {
    const map = {
        rsa: GeneratedRussh.KeyType.Rsa,
        ecdsa: GeneratedRussh.KeyType.Ecdsa,
        ed25519: GeneratedRussh.KeyType.Ed25519,
    };
    return GeneratedRussh.generateKeyPair(map[type]);
}
function validatePrivateKey(key, passphrase) {
    try {
        GeneratedRussh.validatePrivateKey(key, passphrase);
        return { valid: true };
    }
    catch (e) {
        return { valid: false, error: e };
    }
}
function validateCertificate(certificate) {
    try {
        GeneratedRussh.validateCertificate(certificate);
        return { valid: true };
    }
    catch (e) {
        return { valid: false, error: e };
    }
}
// #endregion
export { SshError, SshError_Tags } from "./generated/uniffi_russh.js";
export const RnRussh = {
    uniffiInitAsync: GeneratedRussh.uniffiInitAsync,
    connect,
    connectSftp,
    generateKeyPair,
    validatePrivateKey,
    validateCertificate,
};
//# sourceMappingURL=api.js.map