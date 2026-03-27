import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createConnection } from "node:net";
import type { Readable } from "node:stream";
import { buildAwsCommandEnv, resolveAwsExecutable } from "./aws-service";

const TUNNEL_READY_TIMEOUT_MS = 15_000;
const TUNNEL_READY_POLL_MS = 150;

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
}

interface AwsSsmTunnelServiceOptions {
  onRuntimeTerminated?: (runtimeId: string, message: string) => void;
  spawnProcess?: typeof spawn;
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

function normalizeBindAddress(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "127.0.0.1";
}

function resolveProbeAddress(bindAddress: string): string {
  return bindAddress === "0.0.0.0" ? "127.0.0.1" : bindAddress;
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
        getLastMessage() || "AWS SSM tunnel이 예상보다 빨리 종료되었습니다.",
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
    getLastMessage() || "AWS SSM tunnel 준비가 제한 시간을 초과했습니다.",
  );
}

export class AwsSsmTunnelService {
  private readonly runtimes = new Map<string, TunnelRuntime>();
  private readonly onRuntimeTerminated?: (
    runtimeId: string,
    message: string,
  ) => void;
  private readonly spawnProcess: typeof spawn;

  constructor(options: AwsSsmTunnelServiceOptions = {}) {
    this.onRuntimeTerminated = options.onRuntimeTerminated;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(input: AwsSsmTunnelStartInput): Promise<AwsSsmTunnelHandle> {
    const runtimeId = input.runtimeId?.trim() || randomUUID();
    if (this.runtimes.has(runtimeId)) {
      throw new Error(`AWS SSM tunnel ${runtimeId} is already running.`);
    }

    const awsPath = await resolveAwsExecutable("aws");
    await resolveAwsExecutable("session-manager-plugin");
    const env = await buildAwsCommandEnv();
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
    const runtime: TunnelRuntime = {
      process: child,
      stopRequested: false,
      lastMessage: "",
    };
    this.runtimes.set(runtimeId, runtime);

    const captureOutput = (chunk: string | Buffer) => {
      const value = chunk.toString().trim();
      if (value) {
        runtime.lastMessage = value;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", captureOutput);
    child.stderr.on("data", captureOutput);
    child.once("exit", (code, signal) => {
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
      await waitForTunnelReady(bindAddress, input.bindPort, child, () => runtime.lastMessage);
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
    this.runtimes.delete(runtimeId);
    runtime.stopRequested = true;
    runtime.process.removeAllListeners("exit");
    runtime.process.removeAllListeners("error");
    runtime.process.stdout.removeAllListeners("data");
    runtime.process.stderr.removeAllListeners("data");
    if (!runtime.process.killed && runtime.process.exitCode === null) {
      runtime.process.kill("SIGKILL");
    }
  }

  async shutdown(): Promise<void> {
    const runtimeIds = Array.from(this.runtimes.keys());
    await Promise.all(runtimeIds.map((runtimeId) => this.stop(runtimeId)));
  }
}
