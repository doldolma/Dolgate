import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityLogRecord,
  CoreEvent,
  CoreRequest,
  SftpLifecycleLogMetadata,
} from "@shared";
import { ipcChannels } from "../common/ipc-channels";
import { encodeControlFrame } from "./core-framing";

const { appGetPathMock, existsSyncMock, spawnMock, writeFileSyncMock } =
  vi.hoisted(() => ({
    appGetPathMock: vi.fn(() => "/tmp/dolgate-test-user-data"),
    existsSyncMock: vi.fn(() => true),
    spawnMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/dolssh",
    getPath: appGetPathMock,
    isPackaged: false,
  },
  BrowserWindow: class {},
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    writeFileSync: writeFileSyncMock,
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { CoreManager } from "./core-manager";

function decodeControlFrame(
  buffer: Buffer,
): CoreRequest<Record<string, unknown>> {
  const metadataLength = buffer.readUInt32BE(1);
  return JSON.parse(
    buffer.subarray(9, 9 + metadataLength).toString("utf8"),
  ) as CoreRequest<Record<string, unknown>>;
}

function createFakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    window: {
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        }),
      },
    },
  };
}

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();

  const writes: Buffer[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };

  child.stdin = {
    write: vi.fn((chunk: Uint8Array) => {
      writes.push(Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(),
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    child.emit("exit", 0, signal ?? null);
    return true;
  });
  child.exitCode = null;
  child.killed = false;

  return {
    child,
    writes,
    emitControl(event: CoreEvent<Record<string, unknown>>) {
      child.stdout.emit("data", encodeControlFrame(event));
    },
  };
}

function getTransferEventPayloads(sent: Array<{ channel: string; payload: unknown }>) {
  return sent
    .filter((entry) => entry.channel === ipcChannels.sftp.transferEvent)
    .map(
      (entry) =>
        entry.payload as {
          job: {
            id: string;
            status: string;
            bytesCompleted?: number;
            errorCode?: string;
            errorOperation?: string;
            errorPath?: string;
            errorItemName?: string;
            errorMessage?: string;
            detailMessage?: string;
          };
        },
    );
}

function getSftpLifecycleLogs(records: ActivityLogRecord[]) {
  return records.filter((record) => record.kind === "sftp-lifecycle");
}

async function resolveNextSftpRequest(
  fakeProcess: ReturnType<typeof createFakeChildProcess>,
  writeIndex: number,
  type: CoreEvent<Record<string, unknown>>["type"],
  payload: Record<string, unknown> = {},
): Promise<CoreRequest<Record<string, unknown>>> {
  await waitForWriteCount(fakeProcess.writes, writeIndex + 1);
  const request = decodeControlFrame(fakeProcess.writes[writeIndex]);
  fakeProcess.emitControl({
    type,
    requestId: request.id,
    endpointId: request.endpointId,
    payload,
  });
  return request;
}

function expectSerializedNotToContain(value: unknown, secrets: string[]) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

function getLatestPartialCleanupQueueWrite() {
  const call = [...writeFileSyncMock.mock.calls]
    .reverse()
    .find(([filePath]) => String(filePath).endsWith("sftp-partial-cleanup.json"));
  expect(call).toBeTruthy();
  return JSON.parse(String(call?.[1])) as Array<Record<string, unknown>>;
}

async function waitForWriteCount(
  writes: Buffer[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (writes.length >= expectedCount) {
      return;
    }
    await Promise.resolve();
  }
}

describe("CoreManager SFTP sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appGetPathMock.mockReturnValue("/tmp/dolgate-test-user-data");
    existsSyncMock.mockReturnValue(true);
  });

  it("uses the caller-provided endpoint id for sftpConnect", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-123",
      host: "warpgate.example.com",
      port: 2222,
      username: "example.user:prod-db",
      authType: "keyboardInteractive",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-1",
      title: "Warpgate Prod",
    });

    await waitForWriteCount(fakeProcess.writes, 1);

    const request = decodeControlFrame(fakeProcess.writes[0]);
    expect(request.type).toBe("sftpConnect");
    expect(request.endpointId).toBe("endpoint-123");
    expect(request.payload).toMatchObject({
      host: "warpgate.example.com",
      port: 2222,
      username: "example.user:prod-db",
      authType: "keyboardInteractive",
    });

    fakeProcess.emitControl({
      type: "sftpConnected",
      requestId: request.id,
      endpointId: "endpoint-123",
      payload: {
        path: "/home/example.user",
      },
    });

    await expect(connectPromise).resolves.toMatchObject({
      id: "endpoint-123",
      hostId: "host-1",
      title: "Warpgate Prod",
      path: "/home/example.user",
    });
  });

  it("records SFTP connect and disconnect as a single lifecycle log row", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const appendedLogs: unknown[] = [];
    const upsertedLogs: ActivityLogRecord[] = [];

    const manager = new CoreManager(
      (entry) => {
        appendedLogs.push(entry);
      },
      (record) => {
        upsertedLogs.push(record);
      },
    );

    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-lifecycle",
      host: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "ssh-login-secret",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-lifecycle",
      title: "Prod SFTP",
    });

    await resolveNextSftpRequest(fakeProcess, 0, "sftpConnected", {
      path: "/home/ubuntu",
    });
    await connectPromise;

    const disconnectPromise = manager.sftpDisconnect("endpoint-lifecycle");
    await resolveNextSftpRequest(fakeProcess, 1, "sftpDisconnected");
    await disconnectPromise;

    const lifecycleLogs = getSftpLifecycleLogs(upsertedLogs);
    expect(appendedLogs).toEqual([]);
    expect(lifecycleLogs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lifecycleLogs.map((record) => record.id))).toEqual(
      new Set(["sftp:endpoint-lifecycle"]),
    );
    const finalMetadata = lifecycleLogs.at(-1)
      ?.metadata as unknown as SftpLifecycleLogMetadata;
    expect(finalMetadata).toMatchObject({
      endpointId: "endpoint-lifecycle",
      hostId: "host-lifecycle",
      hostLabel: "Prod SFTP",
      title: "Prod SFTP",
      status: "closed",
      uploadedCount: 0,
      downloadedCount: 0,
      errorCount: 0,
      visitedPathCount: 1,
      lastPath: "/home/ubuntu",
    });
    expect(finalMetadata.connectedAt).toBeTruthy();
    expect(finalMetadata.endedAt).toBeTruthy();
  });

  it("summarizes SFTP operations and transfers in the lifecycle log", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const upsertedLogs: ActivityLogRecord[] = [];

    const manager = new CoreManager(
      undefined,
      (record) => {
        upsertedLogs.push(record);
      },
    );

    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-summary",
      host: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "ssh-login-secret",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-summary",
      title: "Summary Host",
    });
    await resolveNextSftpRequest(fakeProcess, 0, "sftpConnected", {
      path: "/home/ubuntu",
    });
    await connectPromise;

    const listPromise = manager.sftpList({
      endpointId: "endpoint-summary",
      path: "/srv",
    });
    await resolveNextSftpRequest(fakeProcess, 1, "sftpListed", {
      path: "/srv",
      entries: [],
    });
    await listPromise;

    const mkdirPromise = manager.sftpMkdir({
      endpointId: "endpoint-summary",
      path: "/srv",
      name: "logs",
    });
    await resolveNextSftpRequest(fakeProcess, 2, "sftpAck");
    await mkdirPromise;

    const renamePromise = manager.sftpRename({
      endpointId: "endpoint-summary",
      path: "/srv/old.txt",
      nextName: "new.txt",
    });
    await resolveNextSftpRequest(fakeProcess, 3, "sftpAck");
    await renamePromise;

    const chmodPromise = manager.sftpChmod({
      endpointId: "endpoint-summary",
      path: "/srv/app.txt",
      mode: 0o644,
    });
    await resolveNextSftpRequest(fakeProcess, 4, "sftpAck");
    await chmodPromise;

    const chownPromise = manager.sftpChown({
      endpointId: "endpoint-summary",
      path: "/srv/app.txt",
      owner: "ubuntu",
      group: "ubuntu",
    });
    await resolveNextSftpRequest(fakeProcess, 5, "sftpAck");
    await chownPromise;

    const deletePromise = manager.sftpDelete({
      endpointId: "endpoint-summary",
      paths: ["/srv/a.txt", "/srv/b.txt"],
    });
    await resolveNextSftpRequest(fakeProcess, 6, "sftpAck");
    await deletePromise;

    const uploadJob = await manager.startSftpTransfer({
      source: { kind: "local", path: "/Users/tester" },
      target: { kind: "remote", endpointId: "endpoint-summary", path: "/srv" },
      items: [
        { name: "a.txt", path: "/Users/tester/a.txt", isDirectory: false, size: 100 },
        { name: "b.txt", path: "/Users/tester/b.txt", isDirectory: false, size: 200 },
      ],
      conflictResolution: "overwrite",
    });
    fakeProcess.emitControl({
      type: "sftpTransferCompleted",
      jobId: uploadJob.id,
      payload: {
        bytesTotal: 300,
        bytesCompleted: 300,
        completedItemCount: 2,
      },
    });

    const downloadJob = await manager.startSftpTransfer({
      source: { kind: "remote", endpointId: "endpoint-summary", path: "/srv" },
      target: { kind: "local", path: "/Users/tester/Downloads" },
      items: [
        { name: "remote.log", path: "/srv/remote.log", isDirectory: false, size: 400 },
      ],
      conflictResolution: "overwrite",
    });
    fakeProcess.emitControl({
      type: "sftpTransferCompleted",
      jobId: downloadJob.id,
      payload: {
        bytesTotal: 400,
        bytesCompleted: 400,
        completedItemCount: 1,
      },
    });

    const copyJob = await manager.startSftpTransfer({
      source: { kind: "remote", endpointId: "endpoint-summary", path: "/srv" },
      target: { kind: "remote", endpointId: "endpoint-summary", path: "/srv/copy" },
      items: [
        { name: "remote.log", path: "/srv/remote.log", isDirectory: false, size: 50 },
      ],
      conflictResolution: "overwrite",
    });
    fakeProcess.emitControl({
      type: "sftpTransferCompleted",
      jobId: copyJob.id,
      payload: {
        bytesTotal: 50,
        bytesCompleted: 50,
        completedItemCount: 1,
      },
    });

    const failedJob = await manager.startSftpTransfer({
      source: { kind: "local", path: "/Users/tester" },
      target: { kind: "remote", endpointId: "endpoint-summary", path: "/root" },
      items: [
        { name: "denied.txt", path: "/Users/tester/denied.txt", isDirectory: false, size: 10 },
      ],
      conflictResolution: "overwrite",
    });
    fakeProcess.emitControl({
      type: "sftpTransferFailed",
      jobId: failedJob.id,
      payload: {
        message: "permission denied",
        errorCode: "permission_denied",
        errorOperation: "target_create",
      },
    });

    const finalLog = getSftpLifecycleLogs(upsertedLogs).at(-1);
    expect(finalLog?.level).toBe("error");
    expect(finalLog?.metadata).toMatchObject({
      endpointId: "endpoint-summary",
      status: "connected",
      uploadedCount: 2,
      uploadedBytes: 300,
      downloadedCount: 1,
      downloadedBytes: 400,
      remoteCopyCount: 1,
      remoteCopyBytes: 50,
      mkdirCount: 1,
      renameCount: 1,
      chmodCount: 1,
      chownCount: 1,
      deleteCount: 2,
      errorCount: 1,
      visitedPathCount: 6,
      lastPath: "/srv/a.txt",
    });
  });

  it("broadcasts endpoint-scoped interactive auth events to renderer listeners", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    const events: CoreEvent<Record<string, unknown>>[] = [];
    manager.registerWindow(fakeWindow.window as never);
    manager.setTerminalEventHandler((event) => {
      events.push(event);
    });

    await manager.start();

    fakeProcess.emitControl({
      type: "keyboardInteractiveChallenge",
      endpointId: "endpoint-123",
      payload: {
        challengeId: "challenge-1",
        attempt: 1,
        instruction: "approve",
        prompts: [],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "keyboardInteractiveChallenge",
        endpointId: "endpoint-123",
      }),
    );
    expect(fakeWindow.sent).toContainEqual(
      expect.objectContaining({
        channel: ipcChannels.ssh.event,
        payload: expect.objectContaining({
          type: "keyboardInteractiveChallenge",
          endpointId: "endpoint-123",
        }),
      }),
    );
  });

  it("routes endpoint-scoped keyboardInteractive responses through the endpoint id", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    await manager.respondKeyboardInteractive({
      endpointId: "endpoint-123",
      challengeId: "challenge-1",
      responses: ["ABCD-1234"],
    });

    const request = decodeControlFrame(fakeProcess.writes[0]);
    expect(request.type).toBe("keyboardInteractiveRespond");
    expect(request.endpointId).toBe("endpoint-123");
    expect(request.sessionId).toBeUndefined();
    expect(request.payload).toMatchObject({
      challengeId: "challenge-1",
      responses: ["ABCD-1234"],
    });
  });

  it("broadcasts cancelling immediately and preserves it across progress updates", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    manager.registerWindow(fakeWindow.window as never);

    const job = await manager.startSftpTransfer({
      source: { kind: "local", path: "/tmp/local" },
      target: { kind: "remote", endpointId: "endpoint-1", path: "/tmp/remote" },
      items: [
        {
          name: "large.bin",
          path: "/tmp/local/large.bin",
          isDirectory: false,
          size: 1024,
        },
      ],
      conflictResolution: "overwrite",
    });

    fakeWindow.sent.length = 0;
    await manager.cancelSftpTransfer(job.id);

    const transferEventsAfterCancel = getTransferEventPayloads(fakeWindow.sent);
    expect(transferEventsAfterCancel.at(-1)?.job).toMatchObject({
      id: job.id,
      status: "cancelling",
    });

    const cancelRequest = decodeControlFrame(fakeProcess.writes.at(-1) as Buffer);
    expect(cancelRequest.type).toBe("sftpTransferCancel");
    expect(cancelRequest.jobId).toBe(job.id);

    fakeProcess.emitControl({
      type: "sftpTransferProgress",
      jobId: job.id,
      payload: {
        bytesTotal: 1024,
        bytesCompleted: 256,
        speedBytesPerSecond: 512,
        etaSeconds: 2,
      },
    });

    const transferEventsAfterProgress = getTransferEventPayloads(fakeWindow.sent);
    expect(transferEventsAfterProgress.at(-1)?.job).toMatchObject({
      id: job.id,
      status: "cancelling",
      bytesCompleted: 256,
    });

    fakeProcess.emitControl({
      type: "sftpTransferCancelled",
      jobId: job.id,
      payload: {
        bytesTotal: 1024,
        bytesCompleted: 256,
      },
    });

    const transferEventsAfterCancelled = getTransferEventPayloads(fakeWindow.sent);
    expect(transferEventsAfterCancelled.at(-1)?.job).toMatchObject({
      id: job.id,
      status: "cancelled",
    });
  });

  it("preserves transfer failure diagnostics and normalizes permission copy", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);

    const manager = new CoreManager();
    const fakeWindow = createFakeWindow();
    manager.registerWindow(fakeWindow.window as never);

    const job = await manager.startSftpTransfer({
      source: { kind: "local", path: "/Users/tester" },
      target: { kind: "remote", endpointId: "endpoint-1", path: "/srv/app" },
      items: [
        {
          name: "secret.txt",
          path: "/Users/tester/secret.txt",
          isDirectory: false,
          size: 128,
        },
      ],
      conflictResolution: "overwrite",
    });

    fakeWindow.sent.length = 0;
    fakeProcess.emitControl({
      type: "sftpTransferFailed",
      jobId: job.id,
      payload: {
        message: 'sftp: "permission denied" (SSH_FX_PERMISSION_DENIED)',
        detailMessage: 'sftp: "permission denied" (SSH_FX_PERMISSION_DENIED)',
        errorCode: "permission_denied",
        errorOperation: "target_create",
        errorPath: "/srv/app/secret.txt",
        errorItemName: "secret.txt",
      },
    });

    const transferEvents = getTransferEventPayloads(fakeWindow.sent);
    expect(transferEvents.at(-1)?.job).toMatchObject({
      id: job.id,
      status: "failed",
      errorCode: "permission_denied",
      errorOperation: "target_create",
      errorPath: "/srv/app/secret.txt",
      errorItemName: "secret.txt",
      errorMessage: "대상 폴더에 쓸 권한이 없습니다.",
      detailMessage: 'sftp: "permission denied" (SSH_FX_PERMISSION_DENIED)',
    });
  });

  it("keeps SFTP connection and sudo secrets out of logs and runtime summaries", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const logs: unknown[] = [];
    const manager = new CoreManager((entry) => {
      logs.push(entry);
    });
    const fakeWindow = createFakeWindow();
    manager.registerWindow(fakeWindow.window as never);
    const secrets = ["ssh-login-secret", "key-passphrase-secret", "sudo-secret"];

    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-secure",
      host: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "password",
      password: "ssh-login-secret",
      passphrase: "key-passphrase-secret",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-secure",
      title: "Prod Secure",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const connectRequest = decodeControlFrame(fakeProcess.writes[0]);
    expect(JSON.stringify(connectRequest.payload)).toContain("ssh-login-secret");
    fakeProcess.emitControl({
      type: "sftpConnected",
      requestId: connectRequest.id,
      endpointId: "endpoint-secure",
      payload: {
        path: "/home/ubuntu",
        sudoStatus: "passwordRequired",
      },
    });
    const summary = await connectPromise;

    const chownPromise = manager.sftpChown({
      endpointId: "endpoint-secure",
      path: "/srv/app.txt",
      owner: "root",
      group: "root",
      sudoPassword: "sudo-secret",
    });
    await waitForWriteCount(fakeProcess.writes, 2);
    const chownRequest = decodeControlFrame(fakeProcess.writes[1]);
    expect(JSON.stringify(chownRequest.payload)).toContain("sudo-secret");
    fakeProcess.emitControl({
      type: "sftpAck",
      requestId: chownRequest.id,
      endpointId: "endpoint-secure",
      payload: {
        message: "path owner updated",
      },
    });
    await chownPromise;

    const job = await manager.startSftpTransfer({
      source: { kind: "local", path: "/Users/tester" },
      target: { kind: "remote", endpointId: "endpoint-secure", path: "/srv" },
      items: [
        {
          name: "app.txt",
          path: "/Users/tester/app.txt",
          isDirectory: false,
          size: 128,
        },
      ],
      conflictResolution: "overwrite",
    });
    fakeProcess.emitControl({
      type: "sftpTransferProgress",
      jobId: job.id,
      payload: {
        status: "running",
        bytesTotal: 128,
        bytesCompleted: 64,
        partialPath: "/srv/.app.txt.dolgate-partial.job-secure",
      },
    });

    const cleanupQueue = getLatestPartialCleanupQueueWrite();
    expect(cleanupQueue).toHaveLength(1);
    expect(Object.keys(cleanupQueue[0]).sort()).toEqual([
      "createdAt",
      "hostId",
      "id",
      "jobId",
      "path",
    ]);
    expect(cleanupQueue[0]).toMatchObject({
      hostId: "host-secure",
      jobId: job.id,
      path: "/srv/.app.txt.dolgate-partial.job-secure",
    });
    expectSerializedNotToContain(
      {
        summary,
        logs,
        rendererEvents: fakeWindow.sent,
        cleanupQueue,
      },
      secrets,
    );
  });

  it("does not copy SFTP connection secrets into connection failure logs", async () => {
    const fakeProcess = createFakeChildProcess();
    spawnMock.mockReturnValue(fakeProcess.child);
    const logs: unknown[] = [];
    const manager = new CoreManager((entry) => {
      logs.push(entry);
    });
    const secrets = ["ssh-login-secret", "key-passphrase-secret"];

    const connectPromise = manager.sftpConnect({
      endpointId: "endpoint-failed",
      host: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "privateKey",
      privateKeyPem: "PRIVATE KEY",
      passphrase: "key-passphrase-secret",
      password: "ssh-login-secret",
      trustedHostKeyBase64: "AAAATEST",
      hostId: "host-failed",
      title: "Prod Failed",
    });

    await waitForWriteCount(fakeProcess.writes, 1);
    const request = decodeControlFrame(fakeProcess.writes[0]);
    fakeProcess.emitControl({
      type: "sftpError",
      requestId: request.id,
      endpointId: "endpoint-failed",
      payload: {
        message: "authentication failed",
      },
    });

    await expect(connectPromise).rejects.toThrow("authentication failed");
    expectSerializedNotToContain(logs, secrets);
  });
});
