import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  buildAwsCommandEnv,
  decodeAwsCliOutput,
  resolveAwsExecutable,
} from "./aws-service";

const TUNNEL_READY_TIMEOUT_MS = 15_000;
const TUNNEL_READY_POLL_MS = 150;
const TUNNEL_STOP_TIMEOUT_MS = 6_000;
const TUNNEL_PORT_RELEASE_TIMEOUT_MS = 5_000;
const TUNNEL_OUTPUT_BUFFER_LIMIT_BYTES = 8_192;

export interface AwsSsmTunnelStartInput {
  runtimeId?: string;
  profileName: string;
  region: string;
  instanceId: string;
  bindAddress?: string | null;
  bindPort: number;
  targetPort: number;
}

export interface AwsSsmTunnelHandle {
  runtimeId: string;
  bindAddress: string;
  bindPort: number;
}

interface TunnelRuntime {
  process: ChildProcessByStdio<null, Readable, Readable>;
  stopRequested: boolean;
  lastMessage: string;
  bindAddress: string;
  bindPort: number;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

interface AwsSsmTunnelServiceOptions {
  onRuntimeTerminated?: (runtimeId: string, message: string) => void;
  spawnProcess?: typeof spawn;
  buildCommandEnv?: () => Promise<NodeJS.ProcessEnv>;
  killProcessTree?: (
    process: ChildProcessByStdio<null, Readable, Readable>,
  ) => Promise<void>;
  stopTimeoutMs?: number;
  portReleaseTimeoutMs?: number;
}

export function buildAwsSsmTunnelArgs(
  input: Omit<AwsSsmTunnelStartInput, "runtimeId" | "bindAddress"> & {
    bindAddress?: string | null;
  },
): string[] {
  const parameters = JSON.stringify({
    portNumber: [String(input.targetPort)],
    localPortNumber: [String(input.bindPort)],
  });
  return [
    "ssm",
    "start-session",
    "--target",
    input.instanceId,
    "--document-name",
    "AWS-StartPortForwardingSession",
    "--parameters",
    parameters,
    "--profile",
    input.profileName,
    "--region",
    input.region,
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendRecentBytes(current: Uint8Array, nextChunk: Uint8Array): Uint8Array {
  const merged =
    current.length === 0
      ? Buffer.from(nextChunk)
      : Buffer.concat([Buffer.from(current), Buffer.from(nextChunk)]);
  if (merged.length <= TUNNEL_OUTPUT_BUFFER_LIMIT_BYTES) {
    return merged;
  }
  return merged.subarray(merged.length - TUNNEL_OUTPUT_BUFFER_LIMIT_BYTES);
}

function normalizeBindAddress(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "127.0.0.1";
}

function resolveProbeAddress(bindAddress: string): string {
  switch (bindAddress) {
    case "0.0.0.0":
      return "127.0.0.1";
    case "::":
    case "[::]":
      return "::1";
    default:
      return bindAddress;
  }
}

async function waitForTunnelReady(
  bindAddress: string,
  bindPort: number,
  process: ChildProcessByStdio<null, Readable, Readable>,
  getLastMessage: () => string,
): Promise<void> {
  const startedAt = Date.now();
  const probeAddress = resolveProbeAddress(bindAddress);

  while (Date.now() - startedAt < TUNNEL_READY_TIMEOUT_MS) {
    if (process.exitCode !== null) {
      throw new Error(
        getLastMessage() || "AWS SSM tunnel exited before it became ready.",
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(
          {
            host: probeAddress,
            port: bindPort,
          },
          () => {
            socket.destroy();
            resolve();
          },
        );
        socket.setTimeout(1_000);
        socket.once("error", reject);
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      });
      return;
    } catch {
      await delay(TUNNEL_READY_POLL_MS);
    }
  }

  throw new Error(
    getLastMessage() || "AWS SSM tunnel readiness timed out.",
  );
}

async function waitForTunnelClosed(
  bindAddress: string,
  bindPort: number,
  getLastMessage: () => string,
  timeoutMs: number,
): Promise<void> {
  if (bindPort <= 0) {
    return;
  }

  const startedAt = Date.now();
  const probeAddress = resolveProbeAddress(bindAddress);

  while (Date.now() - startedAt < timeoutMs) {
    const isClosed = await new Promise<boolean>((resolve) => {
      const socket = createConnection(
        {
          host: probeAddress,
          port: bindPort,
        },
        () => {
          socket.destroy();
          resolve(false);
        },
      );
      socket.setTimeout(1_000);
      socket.once("error", () => resolve(true));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (isClosed) {
      return;
    }

    await delay(TUNNEL_READY_POLL_MS);
  }

  throw new Error(
    getLastMessage() ||
      `AWS SSM tunnel ${probeAddress}:${bindPort} is still accepting connections.`,
  );
}

function buildTaskkillPath(): string {
  const windowsRoot =
    process.env.SystemRoot?.trim() ||
    process.env.windir?.trim() ||
    "C:\\Windows";
  return path.join(windowsRoot, "System32", "taskkill.exe");
}

async function defaultKillProcessTree(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  if (process.platform !== "win32") {
    if (!child.kill("SIGKILL")) {
      throw new Error("failed to terminate AWS SSM tunnel process");
    }
    return;
  }

  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("AWS SSM tunnel process id is unavailable");
  }

  const taskkillPath = buildTaskkillPath();
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(
      taskkillPath,
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stderr = "";
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    killer.on("error", reject);
    killer.on("exit", (code) => {
      if (code === 0 || child.exitCode !== null) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `taskkill failed with exit code ${code ?? 0}`,
        ),
      );
    });
  });
}

export class AwsSsmTunnelService {
  private readonly runtimes = new Map<string, TunnelRuntime>();
  private readonly onRuntimeTerminated?: (
    runtimeId: string,
    message: string,
  ) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly buildCommandEnv: () => Promise<NodeJS.ProcessEnv>;
  private readonly killProcessTree: (
    process: ChildProcessByStdio<null, Readable, Readable>,
  ) => Promise<void>;
  private readonly stopTimeoutMs: number;
  private readonly portReleaseTimeoutMs: number;

  constructor(options: AwsSsmTunnelServiceOptions = {}) {
    this.onRuntimeTerminated = options.onRuntimeTerminated;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildCommandEnv = options.buildCommandEnv ?? (() => buildAwsCommandEnv());
    this.killProcessTree = options.killProcessTree ?? defaultKillProcessTree;
    this.stopTimeoutMs = options.stopTimeoutMs ?? TUNNEL_STOP_TIMEOUT_MS;
    this.portReleaseTimeoutMs =
      options.portReleaseTimeoutMs ?? TUNNEL_PORT_RELEASE_TIMEOUT_MS;
  }

  async start(input: AwsSsmTunnelStartInput): Promise<AwsSsmTunnelHandle> {
    const runtimeId = input.runtimeId?.trim() || randomUUID();
    if (this.runtimes.has(runtimeId)) {
      throw new Error(`AWS SSM tunnel ${runtimeId} is already running.`);
    }

    const awsPath = await resolveAwsExecutable("aws");
    await resolveAwsExecutable("session-manager-plugin");
    const env = await this.buildCommandEnv();
    env.AWS_PAGER = "";

    const bindAddress = normalizeBindAddress(input.bindAddress);
    const args = buildAwsSsmTunnelArgs({
      profileName: input.profileName,
      region: input.region,
      instanceId: input.instanceId,
      bindAddress,
      bindPort: input.bindPort,
      targetPort: input.targetPort,
    });
    const child = this.spawnProcess(awsPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });

    let resolveExit!: () => void;
    const runtime: TunnelRuntime = {
      process: child,
      stopRequested: false,
      lastMessage: "",
      bindAddress,
      bindPort: input.bindPort,
      exitPromise: new Promise<void>((resolve) => {
        resolveExit = resolve;
      }),
      resolveExit,
    };
    this.runtimes.set(runtimeId, runtime);

    let capturedOutput: Uint8Array = Buffer.alloc(0);
    const captureOutput = (chunk: string | Buffer) => {
      const rawChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, "utf8");
      capturedOutput = appendRecentBytes(capturedOutput, rawChunk);
      const value = decodeAwsCliOutput(capturedOutput, {
        platform: process.platform,
        allowWindowsLegacyFallback: true,
      }).trim();
      if (value) {
        runtime.lastMessage = value;
      }
    };
    child.stdout.on("data", captureOutput);
    child.stderr.on("data", captureOutput);
    child.once("exit", (code, signal) => {
      runtime.resolveExit();
      const current = this.runtimes.get(runtimeId);
      if (!current) {
        return;
      }
      this.runtimes.delete(runtimeId);
      if (current.stopRequested) {
        return;
      }
      const message =
        current.lastMessage ||
        (signal
          ? `AWS SSM tunnel exited with signal ${signal}`
          : `AWS SSM tunnel exited with code ${code ?? 0}`);
      this.onRuntimeTerminated?.(runtimeId, message);
    });
    child.once("error", (error) => {
      runtime.lastMessage = error.message;
    });

    try {
      await waitForTunnelReady(
        bindAddress,
        input.bindPort,
        child,
        () => runtime.lastMessage,
      );
      return {
        runtimeId,
        bindAddress,
        bindPort: input.bindPort,
      };
    } catch (error) {
      await this.stop(runtimeId).catch(() => undefined);
      throw error;
    }
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      return;
    }

    runtime.stopRequested = true;
    try {
      await this.killProcessTree(runtime.process);
    } catch (error) {
      runtime.stopRequested = false;
      throw error;
    }

    await Promise.race([
      runtime.exitPromise,
      delay(this.stopTimeoutMs).then(() => {
        throw new Error(
          `Timed out waiting for AWS SSM tunnel ${runtimeId} to stop.`,
        );
      }),
    ]);

    await waitForTunnelClosed(
      runtime.bindAddress,
      runtime.bindPort,
      () => runtime.lastMessage,
      this.portReleaseTimeoutMs,
    );
  }

  async shutdown(): Promise<void> {
    const runtimeIds = Array.from(this.runtimes.keys());
    await Promise.all(runtimeIds.map((runtimeId) => this.stop(runtimeId)));
  }
}
