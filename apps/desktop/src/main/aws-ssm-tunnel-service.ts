import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  buildAwsCommandEnv,
  decodeAwsCliOutput,
  resolveAwsExecutable,
} from "./aws-service";

const TUNNEL_READY_TIMEOUT_MS = 15_000;
const TUNNEL_PORT_PROBE_POLL_MS = 150;
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

/**
 * In-process tunnel backend: runs the SSM port-forwarding data channel inside
 * ssh-core (no aws CLI, no session-manager-plugin). Wired after CoreManager
 * construction; when absent or shouldUse() is false, tunnels spawn the binary.
 */
export interface AwsSsmInProcessTunnelBackend {
  shouldUse: () => boolean;
  start: (
    input: AwsSsmTunnelStartInput & { runtimeId: string; bindAddress: string },
  ) => Promise<{ bindAddress: string; bindPort: number }>;
  stop: (runtimeId: string) => Promise<void>;
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
  readyTimeoutMs?: number;
  portProbePollMs?: number;
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

function resolveBindProbeAddress(bindAddress: string): string {
  switch (bindAddress) {
    case "[::]":
      return "::";
    default:
      return bindAddress;
  }
}

function hasOpenedBindPort(message: string, bindPort: number): boolean {
  const escapedPort = String(bindPort).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bPort\\s+${escapedPort}\\s+opened\\b`, "i").test(
    message,
  );
}

async function isLocalPortInUse(
  bindAddress: string,
  bindPort: number,
): Promise<boolean> {
  if (bindPort <= 0) {
    return false;
  }

  const probeAddress = resolveBindProbeAddress(bindAddress);
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (result: boolean, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      server.removeAllListeners();
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(true);
        return;
      }
      finish(false, error);
    });
    server.listen(
      {
        host: probeAddress,
        port: bindPort,
        exclusive: true,
      },
      () => {
        server.close((error) => {
          finish(false, error ?? undefined);
        });
      },
    );
  });
}

async function waitForTunnelReady(
  bindAddress: string,
  bindPort: number,
  exitPromise: Promise<void>,
  outputReadyPromise: Promise<void>,
  processErrorPromise: Promise<never>,
  getLastMessage: () => string,
  readyTimeoutMs: number,
  pollMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const pollLocalBind = async () => {
      if (settled) {
        return;
      }
      try {
        if (await isLocalPortInUse(bindAddress, bindPort)) {
          finish();
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!settled) {
        pollTimer = setTimeout(pollLocalBind, pollMs);
      }
    };

    void outputReadyPromise.then(
      () => finish(),
      (error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
    );
    void processErrorPromise.catch((error) => finish(error));
    void exitPromise.then(() =>
      finish(
        new Error(
          getLastMessage() || "AWS SSM tunnel exited before it became ready.",
        ),
      ),
    );
    pollTimer = setTimeout(pollLocalBind, pollMs);
    timeoutTimer = setTimeout(
      () =>
        finish(
          new Error(
            getLastMessage() ||
              `AWS SSM tunnel on local port ${bindPort} readiness timed out.`,
          ),
        ),
      readyTimeoutMs,
    );
  });
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

  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isLocalPortInUse(bindAddress, bindPort))) {
      return;
    }

    await delay(TUNNEL_PORT_PROBE_POLL_MS);
  }

  throw new Error(
    getLastMessage() ||
      `AWS SSM tunnel ${bindAddress}:${bindPort} is still holding the local port.`,
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
  private readonly inProcessRuntimeIds = new Set<string>();
  private inProcessBackend?: AwsSsmInProcessTunnelBackend;
  private readonly onRuntimeTerminated?: (
    runtimeId: string,
    message: string,
  ) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly buildCommandEnv: () => Promise<NodeJS.ProcessEnv>;
  private readonly killProcessTree: (
    process: ChildProcessByStdio<null, Readable, Readable>,
  ) => Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly portProbePollMs: number;
  private readonly stopTimeoutMs: number;
  private readonly portReleaseTimeoutMs: number;

  constructor(options: AwsSsmTunnelServiceOptions = {}) {
    this.onRuntimeTerminated = options.onRuntimeTerminated;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildCommandEnv = options.buildCommandEnv ?? (() => buildAwsCommandEnv());
    this.killProcessTree = options.killProcessTree ?? defaultKillProcessTree;
    this.readyTimeoutMs = options.readyTimeoutMs ?? TUNNEL_READY_TIMEOUT_MS;
    this.portProbePollMs = options.portProbePollMs ?? TUNNEL_PORT_PROBE_POLL_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? TUNNEL_STOP_TIMEOUT_MS;
    this.portReleaseTimeoutMs =
      options.portReleaseTimeoutMs ?? TUNNEL_PORT_RELEASE_TIMEOUT_MS;
  }

  setInProcessBackend(backend: AwsSsmInProcessTunnelBackend | undefined): void {
    this.inProcessBackend = backend;
  }

  async start(input: AwsSsmTunnelStartInput): Promise<AwsSsmTunnelHandle> {
    const runtimeId = input.runtimeId?.trim() || randomUUID();
    if (this.runtimes.has(runtimeId) || this.inProcessRuntimeIds.has(runtimeId)) {
      throw new Error(`AWS SSM tunnel ${runtimeId} is already running.`);
    }

    if (this.inProcessBackend?.shouldUse()) {
      const resolved = await this.inProcessBackend.start({
        ...input,
        runtimeId,
        bindAddress: normalizeBindAddress(input.bindAddress),
      });
      this.inProcessRuntimeIds.add(runtimeId);
      return {
        runtimeId,
        bindAddress: resolved.bindAddress,
        bindPort: resolved.bindPort,
      };
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
    let resolveOutputReady!: () => void;
    let rejectProcessError!: (error: Error) => void;
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
    const outputReadyPromise = new Promise<void>((resolve) => {
      resolveOutputReady = resolve;
    });
    const processErrorPromise = new Promise<never>((_, reject) => {
      rejectProcessError = reject;
    });
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
        if (hasOpenedBindPort(value, input.bindPort)) {
          resolveOutputReady();
        }
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
      rejectProcessError(error);
    });

    try {
      await waitForTunnelReady(
        bindAddress,
        input.bindPort,
        runtime.exitPromise,
        outputReadyPromise,
        processErrorPromise,
        () => runtime.lastMessage,
        this.readyTimeoutMs,
        this.portProbePollMs,
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
    if (this.inProcessRuntimeIds.has(runtimeId)) {
      this.inProcessRuntimeIds.delete(runtimeId);
      await this.inProcessBackend?.stop(runtimeId);
      return;
    }

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
    const runtimeIds = [
      ...this.runtimes.keys(),
      ...this.inProcessRuntimeIds,
    ];
    await Promise.all(runtimeIds.map((runtimeId) => this.stop(runtimeId)));
  }
}
