import type { HostRecord } from "@shared";
import type { AwsSsmTunnelService } from "../../aws-ssm-tunnel-service";
import type { AwsEc2HostRecord } from "../context";

export interface TunnelRegistry {
  trackSftpTunnelRuntime: (endpointId: string, runtimeId: string) => void;
  trackContainersTunnelRuntime: (
    endpointId: string,
    runtimeId: string,
    hydratedHost: AwsEc2HostRecord,
  ) => void;
  trackContainerShellTunnelRuntime: (
    sessionId: string,
    runtimeId: string,
  ) => void;
  // 서버 프록시 컨테이너 연결은 로컬 SSM 터널이 없으므로(WS 릴레이가 ssh-core 안에서 전송을
  // 소유) 추적할 runtimeId가 없다. hydratedHost만 따로 기억해 재-preflight를 피한다.
  trackContainersHydratedHost: (
    endpointId: string,
    hydratedHost: AwsEc2HostRecord,
  ) => void;
  getContainersHydratedHost: (endpointId: string) => AwsEc2HostRecord | null;
  stopSftpTunnelForEndpoint: (endpointId: string) => Promise<void>;
  stopContainersTunnelForEndpoint: (endpointId: string) => Promise<void>;
  moveContainersTunnelRuntime: (sourceKey: string, nextKey: string) => void;
  stopContainerShellTunnelForSession: (sessionId: string) => Promise<void>;
  stopAll: () => Promise<void>;
}

export function createTunnelRegistry(deps: {
  awsSsmTunnelService: AwsSsmTunnelService;
}): TunnelRegistry {
  const { awsSsmTunnelService } = deps;
  const awsSftpTunnelRuntimeByEndpoint = new Map<string, string>();
  const awsContainersTunnelRuntimeByEndpoint = new Map<string, string>();
  const awsContainersHydratedHostByEndpoint = new Map<string, AwsEc2HostRecord>();
  const awsContainerShellTunnelRuntimeBySessionId = new Map<string, string>();

  const stopRuntime = async (runtimeId: string) => {
    await awsSsmTunnelService.stop(runtimeId).catch(() => undefined);
  };

  const stopSftpTunnelForEndpoint = async (endpointId: string) => {
    const runtimeId = awsSftpTunnelRuntimeByEndpoint.get(endpointId);
    if (!runtimeId) {
      return;
    }
    awsSftpTunnelRuntimeByEndpoint.delete(endpointId);
    await stopRuntime(runtimeId);
  };

  const stopContainersTunnelForEndpoint = async (endpointId: string) => {
    awsContainersHydratedHostByEndpoint.delete(endpointId);
    const runtimeId = awsContainersTunnelRuntimeByEndpoint.get(endpointId);
    if (!runtimeId) {
      return;
    }
    awsContainersTunnelRuntimeByEndpoint.delete(endpointId);
    await stopRuntime(runtimeId);
  };

  const stopContainerShellTunnelForSession = async (sessionId: string) => {
    const runtimeId = awsContainerShellTunnelRuntimeBySessionId.get(sessionId);
    if (!runtimeId) {
      return;
    }
    awsContainerShellTunnelRuntimeBySessionId.delete(sessionId);
    await stopRuntime(runtimeId);
  };

  return {
    trackSftpTunnelRuntime: (endpointId, runtimeId) => {
      awsSftpTunnelRuntimeByEndpoint.set(endpointId, runtimeId);
    },
    trackContainersTunnelRuntime: (endpointId, runtimeId, hydratedHost) => {
      awsContainersTunnelRuntimeByEndpoint.set(endpointId, runtimeId);
      awsContainersHydratedHostByEndpoint.set(endpointId, hydratedHost);
    },
    trackContainersHydratedHost: (endpointId, hydratedHost) => {
      awsContainersHydratedHostByEndpoint.set(endpointId, hydratedHost);
    },
    trackContainerShellTunnelRuntime: (sessionId, runtimeId) => {
      awsContainerShellTunnelRuntimeBySessionId.set(sessionId, runtimeId);
    },
    getContainersHydratedHost: (endpointId) =>
      awsContainersHydratedHostByEndpoint.get(endpointId) ?? null,
    stopSftpTunnelForEndpoint,
    stopContainersTunnelForEndpoint,
    moveContainersTunnelRuntime: (sourceKey, nextKey) => {
      const runtimeId = awsContainersTunnelRuntimeByEndpoint.get(sourceKey);
      if (!runtimeId) {
        return;
      }
      const hydratedHost = awsContainersHydratedHostByEndpoint.get(sourceKey);
      awsContainersTunnelRuntimeByEndpoint.delete(sourceKey);
      awsContainersHydratedHostByEndpoint.delete(sourceKey);
      awsContainersTunnelRuntimeByEndpoint.set(nextKey, runtimeId);
      if (hydratedHost) {
        awsContainersHydratedHostByEndpoint.set(nextKey, hydratedHost);
      }
    },
    stopContainerShellTunnelForSession,
    stopAll: async () => {
      await Promise.all(
        Array.from(awsSftpTunnelRuntimeByEndpoint.keys()).map((endpointId) =>
          stopSftpTunnelForEndpoint(endpointId),
        ),
      );
      await Promise.all(
        Array.from(awsContainersTunnelRuntimeByEndpoint.keys()).map(
          (endpointId) => stopContainersTunnelForEndpoint(endpointId),
        ),
      );
      await Promise.all(
        Array.from(awsContainerShellTunnelRuntimeBySessionId.keys()).map(
          (sessionId) => stopContainerShellTunnelForSession(sessionId),
        ),
      );
    },
  };
}
