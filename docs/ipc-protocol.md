# SSH Core IPC Protocol

This page covers only the framed stdio protocol between Electron `main` and Go `ssh-core`.
Electron IPC, the preload API, and the session share WebSocket are out of scope.

The Electron `main` process talks to the Go SSH core over a framed binary protocol on stdio.

The frame format:

- `1 byte`: frame kind
- `4 bytes`: metadata length (big-endian)
- `4 bytes`: payload length (big-endian)
- `N bytes`: metadata JSON
- `M bytes`: raw payload

There are two frame kinds:

- `1`: control frame
- `2`: stream frame

## Request envelope

```json
{
  "id": "req_1",
  "type": "connect",
  "sessionId": "optional-session",
  "endpointId": "optional-endpoint",
  "jobId": "optional-job",
  "payload": {}
}
```

The request rides as JSON in a `control frame`'s metadata, with an empty payload.

## Event envelope

```json
{
  "type": "connected",
  "requestId": "req_1",
  "sessionId": "session_1",
  "endpointId": "optional-endpoint",
  "jobId": "optional-job",
  "payload": {}
}
```

This also rides as JSON in a `control frame`'s metadata.

## Command types

- `health`
- `connect`
- `resize`
- `disconnect`
- `sftpConnect`
- `sftpDisconnect`
- `sftpList`
- `sftpMkdir`
- `sftpRename`
- `sftpDelete`
- `sftpChmod`
- `sftpReadFile`
- `sftpWriteFile`
- `sftpTransferStart`
- `sftpTransferCancel`
- `tailnetTest`
- `tailnetForget`

## Event types

- `status`
- `connected`
- `error`
- `closed`
- `sftpConnected`
- `sftpDisconnected`
- `sftpListed`
- `sftpFileRead`
- `sftpAck`
- `sftpError`
- `sftpTransferProgress`
- `sftpTransferCompleted`
- `sftpTransferFailed`
- `sftpTransferCancelled`
- `tailnetStatus`
- `tailnetForgot`

## Stream frames

Terminal I/O travels as `stream frames`, separate from control events. This path carries raw bytes without base64, cutting string-conversion overhead and avoiding UTF-8 corruption.

```json
{
  "type": "data",
  "sessionId": "session_1"
}
```

That JSON is the stream frame's metadata; the actual terminal bytes ride in the frame payload.

The input stream uses `type: "write"`, the output stream `type: "data"`.

## The `connect` payload

The renderer holds only references, never the secret values themselves; Electron `main` restores the actual values from the keychain and hands them to the Go core. This keeps passwords and passphrases from lingering in the renderer.

## tailnet

Where node state lives is decided by a **process environment variable**, not by requests — it is fixed at spawn time and does not vary per request.

```
DOLGATE_TAILNET_STATE_DIR=<app data>/tailnet
```

If empty, only `tailnetTest` and `tailnetForget` are refused; everything else keeps working.
Without a value, tsnet would create a path unrelated to the app under `os.UserConfigDir()` that the user could neither find nor delete by deregistering. The directory contains node keys, so it is **device-local only** and never synced.

### `tailnetTest`

Brings a node up, checks it reaches `running`, and streams the progress as **multiple** `tailnetStatus` events **under the same `requestId`**. It is not a single response because parts of the flow involve a human — like browser login.

`state` values:

| Value | Meaning |
|---|---|
| `needsAuth` | authentication needed. If `authUrl` accompanies it, authorize in the browser |
| `needsApproval` | registered, awaiting admin approval |
| `starting` | coming up |
| `running` | done |
| `stopped` | stopped. The reason rides in `error` |

The same state is never emitted twice in a row. It ends on reaching `running` or on timeout.

### `tailnetForget`

Deregisters the node — deletes it from the control plane (logout), shuts the server down, and removes the local state directory. The tailnet configuration itself remains, so reconnecting follows the same flow as first registration. The result arrives as `tailnetForgot`.

## SFTP identifiers

- `sessionId`: interactive terminal session identifier
- `endpointId`: remote SFTP connection identifier
- `jobId`: file transfer job identifier

SFTP browsing is handled with control frames alone; file transfer progress arrives via `sftpTransfer*` events. Passing a local file path in the payload makes the Go core perform the copy itself.
