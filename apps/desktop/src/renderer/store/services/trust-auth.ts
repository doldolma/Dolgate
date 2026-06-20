import type {
  HostRecord,
  HostSecretInput,
  TerminalConnectionProgress,
} from "@shared";
import {
  buildAwsSsmKnownHostIdentity,
  getAwsEc2HostSshPort,
  isSshHostRecord,
  isWarpgateSshHostRecord,
} from "@shared";
import type { PendingHostKeyPrompt } from "../types";
import type { SliceDeps } from "./context";
import {
  createConnectionProgress,
  isAwsEc2HostRecord,
  isAwsSsoAuthenticationErrorMessage,
  normalizeRemoteInvokeErrorMessage,
} from "../utils";

type StoreSetter = SliceDeps["set"];

export function createTrustAuthServices({ api, get }: SliceDeps) {
  const hasTrustedHostKey = (hostId: string): boolean => {
    const state = get();
    const host = state.hosts.find((item) => item.id === hostId);
    if (!host) {
      return false;
    }

    const target = isAwsEc2HostRecord(host)
      ? {
          host: buildAwsSsmKnownHostIdentity({
            profileName: host.awsProfileName,
            region: host.awsRegion,
            instanceId: host.awsInstanceId,
          }),
          port: getAwsEc2HostSshPort(host),
        }
      : isWarpgateSshHostRecord(host)
        ? {
            host: host.warpgateSshHost,
            port: host.warpgateSshPort,
          }
        : isSshHostRecord(host)
          ? {
              host: host.hostname,
              port: host.port,
            }
          : null;

    if (!target) {
      return false;
    }

    return state.knownHosts.some(
      (record) => record.host === target.host && record.port === target.port,
    );
  };

  const loginAwsSsoProfile = async (
    profileName: string,
    reportProgress: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    reportProgress(`브라우저에서 ${profileName} AWS 로그인을 진행하는 중입니다.`, {
      blockingKind: "browser",
      stage: "browser-login",
    });
    try {
      await api.aws.login(profileName);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? normalizeRemoteInvokeErrorMessage(error.message)
          : "AWS SSO 로그인을 시작하지 못했습니다.",
      );
    }

    reportProgress(`${profileName} 프로필 로그인 결과를 확인하는 중입니다.`);
    const refreshedStatus = await api.aws.getProfileStatus(profileName);
    if (!refreshedStatus.isAuthenticated) {
      throw new Error(
        refreshedStatus.errorMessage ||
          "AWS SSO 로그인 후에도 인증이 확인되지 않았습니다.",
      );
    }
    return refreshedStatus;
  };

  const ensureAwsSsoProfileAuthenticationIfNeeded = async (
    profileName: string,
    reportProgress?: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    reportProgress?.(`${profileName} 프로필 인증 상태를 확인하는 중입니다.`);
    const status = await api.aws.getProfileStatus(profileName);
    if (status.isAuthenticated || !status.isSsoProfile) {
      return status;
    }

    return loginAwsSsoProfile(
      profileName,
      reportProgress ??
        (() => {
          return;
        }),
    );
  };

  const ensureAwsHostAuthentication = async (
    host: Extract<HostRecord, { kind: "aws-ec2" }>,
    reportProgress: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    const status = await ensureAwsSsoProfileAuthenticationIfNeeded(
      host.awsProfileName,
      reportProgress,
    );
    if (status.isAuthenticated) {
      return;
    }

    if (!status.isSsoProfile) {
      throw new Error(
        status.errorMessage ||
          `${host.awsProfileName} 프로필에 AWS CLI 자격 증명이 필요합니다.`,
      );
    }
  };

  type EnsureTrustedHostInput = {
    hostId: string;
    sessionId?: string | null;
    endpointId?: string | null;
    skipProbeIfAlreadyTrusted?: boolean;
    action: PendingHostKeyPrompt["action"];
  };

  // Probe + (if needed) prompt for a single host's key. The main process probes
  // a host that has a jumpHostId THROUGH its (already-trusted) jump host, so the
  // jump must be trusted before this is called for such a target.
  const ensureTrustedHostKey = async (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    if (input.skipProbeIfAlreadyTrusted && hasTrustedHostKey(input.hostId)) {
      return true;
    }

    const probe = await api.knownHosts.probeHost({
      hostId: input.hostId,
      endpointId: input.endpointId ?? null,
    });
    if (probe.status === "trusted") {
      return true;
    }
    set({
      pendingHostKeyPrompt: {
        sessionId: input.sessionId ?? null,
        probe,
        action: input.action,
      },
    });
    return false;
  };

  const ensureTrustedHost = (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    // 타깃이 점프(베스천)를 경유하면, 베스천을 먼저 신뢰해야 main이 그 경유로 타깃 키를
    // probe할 수 있다. 베스천 자신은 jumpHostId가 없어 직접 probe된다. v1은 단일 홉이라
    // 한 단계만 선행 신뢰한다(체인/사이클 무한재귀 방지).
    // 점프가 없는 일반 경로는 inner 프로미스를 그대로 반환해 추가 마이크로태스크 없이
    // 기존 타이밍을 유지한다.
    const targetHost = get().hosts.find((item) => item.id === input.hostId);
    if (
      targetHost &&
      isSshHostRecord(targetHost) &&
      targetHost.jumpHostId &&
      targetHost.jumpHostId !== input.hostId
    ) {
      const jumpHostId = targetHost.jumpHostId;
      return (async () => {
        const jumpTrusted = await ensureTrustedHostKey(set, {
          ...input,
          hostId: jumpHostId,
        });
        if (!jumpTrusted) {
          return false;
        }
        return ensureTrustedHostKey(set, input);
      })();
    }

    return ensureTrustedHostKey(set, input);
  };

  return {
    loginAwsSsoProfile,
    ensureAwsSsoProfileAuthenticationIfNeeded,
    ensureAwsHostAuthentication,
    ensureTrustedHost,
  };
}
