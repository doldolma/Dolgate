import { randomUUID } from "node:crypto";
import { t } from './i18n';

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
 * construction.
 */
export interface AwsSsmInProcessTunnelBackend {
  shouldUse: () => boolean;
  start: (
    input: AwsSsmTunnelStartInput & { runtimeId: string; bindAddress: string },
  ) => Promise<{ bindAddress: string; bindPort: number }>;
  stop: (runtimeId: string) => Promise<void>;
}

function normalizeBindAddress(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "127.0.0.1";
}

/**
 * Endpoint-scoped AWS SSM tunnels (SFTP, containers, container shells). Every
 * tunnel runs on the in-process data channel via the injected backend; the
 * legacy aws + session-manager-plugin spawn path is gone.
 */
export class AwsSsmTunnelService {
  private readonly inProcessRuntimeIds = new Set<string>();
  private inProcessBackend?: AwsSsmInProcessTunnelBackend;

  setInProcessBackend(backend: AwsSsmInProcessTunnelBackend | undefined): void {
    this.inProcessBackend = backend;
  }

  async start(input: AwsSsmTunnelStartInput): Promise<AwsSsmTunnelHandle> {
    const runtimeId = input.runtimeId?.trim() || randomUUID();
    if (this.inProcessRuntimeIds.has(runtimeId)) {
      throw new Error(`AWS SSM tunnel ${runtimeId} is already running.`);
    }

    const backend = this.inProcessBackend;
    if (!backend || !backend.shouldUse()) {
      throw new Error(
        t('misc.ssmTunnelUnsupported'),
      );
    }

    const resolved = await backend.start({
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

  async stop(runtimeId: string): Promise<void> {
    if (!this.inProcessRuntimeIds.has(runtimeId)) {
      return;
    }
    this.inProcessRuntimeIds.delete(runtimeId);
    await this.inProcessBackend?.stop(runtimeId);
  }

  async shutdown(): Promise<void> {
    const runtimeIds = [...this.inProcessRuntimeIds];
    await Promise.all(runtimeIds.map((runtimeId) => this.stop(runtimeId)));
  }
}
