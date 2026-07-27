import type {
  HostRecord,
  HostSecretInput,
  SshHostRecord,
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
import { t } from '../../i18n';

type StoreSetter = SliceDeps["set"];

export function createTrustAuthServices({ api, get }: SliceDeps) {
  const requireAwsProfileId = (
    profileId: string | null | undefined,
    profileName: string,
  ): string => {
    if (profileId) {
      return profileId;
    }
    const label = profileName.trim();
    throw new Error(
      label
        ? t('aws.profile.linkedNotFoundNamed', { label })
        : t('trustAuth.profileNotFoundSelect'),
    );
  };

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
    profileId: string | null | undefined,
    profileName: string,
    reportProgress: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    const requiredProfileId = requireAwsProfileId(profileId, profileName);
    reportProgress(t('trustAuth.browserLogin', { profile: profileName }), {
      blockingKind: "browser",
      stage: "browser-login",
    });
    try {
      await api.aws.loginById(requiredProfileId);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? normalizeRemoteInvokeErrorMessage(error.message)
          : t('awsProfiles.error.ssoLoginFailed'),
      );
    }

    reportProgress(t('trustAuth.checkingLoginResult', { profile: profileName }));
    const refreshedStatus = await api.aws.getProfileStatusById(requiredProfileId);
    if (!refreshedStatus.isAuthenticated) {
      throw new Error(
        refreshedStatus.errorMessage ||
          t('awsSftp.progress.ssoNotVerified'),
      );
    }
    return refreshedStatus;
  };

  const ensureAwsSsoProfileAuthenticationIfNeeded = async (
    profileId: string | null | undefined,
    profileName: string,
    reportProgress?: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    const requiredProfileId = requireAwsProfileId(profileId, profileName);
    reportProgress?.(t('containersStore.checkingProfile', { profile: profileName }));
    const status = await api.aws.getProfileStatusById(requiredProfileId);
    if (status.isAuthenticated || !status.isSsoProfile) {
      return status;
    }

    return loginAwsSsoProfile(
      requiredProfileId,
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
      host.awsProfileId,
      host.awsProfileName,
      reportProgress,
    );
    if (status.isAuthenticated) {
      return;
    }

    if (!status.isSsoProfile) {
      throw new Error(
        status.errorMessage ||
          t('trustAuth.cliCredentialsNeeded', { profile: host.awsProfileName }),
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
      // 프로브가 방출하는 홉 진행을 이 연결의 오버레이(터미널 탭 등)에 매핑하기 위한 상관 ID.
      sessionId: input.sessionId ?? null,
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

  // 대상의 다단 ProxyJump 체인을 순서대로(첫 홉=클라이언트에서 직접 연결 … 마지막=대상 바로 앞).
  // footgun 회피: shared-core의 normalizeJumpHostIds(value export)를 직접 import하지 않고 인라인.
  const deriveJumpChain = (host: SshHostRecord): string[] => {
    const source =
      Array.isArray(host.jumpHostIds) && host.jumpHostIds.length > 0
        ? host.jumpHostIds
        : host.jumpHostId
          ? [host.jumpHostId]
          : [];
    const seen = new Set<string>();
    const chain: string[] = [];
    for (const id of source) {
      if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        chain.push(id);
      }
    }
    return chain;
  };

  const ensureTrustedHost = (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    // 타깃이 점프(베스천)를 경유하면, 그 베스천들을 먼저 신뢰해야 main이 경유해 타깃 키를
    // probe할 수 있다. 다단 ProxyJump는 체인 전체를 첫 홉부터 순서대로 신뢰한다 — 각 홉은
    // 자신의 설정으로 probe되며, 미신뢰 홉이 있으면 그 홉에서 신뢰 프롬프트가 뜬다(Termius식
    // 홉별 trust). 이미 신뢰된 홉은 재-probe를 생략(중복 순회·pre-auth 몰림 방지, 실연결의
    // strict host-key 검사가 안전을 보장). 점프가 없는 일반 경로는 inner 프로미스를 그대로
    // 반환해 추가 마이크로태스크 없이 기존 타이밍을 유지한다.
    const targetHost = get().hosts.find((item) => item.id === input.hostId);
    if (targetHost && isSshHostRecord(targetHost)) {
      const chain = deriveJumpChain(targetHost).filter(
        (jumpHostId) => jumpHostId !== input.hostId,
      );
      if (chain.length > 0) {
        return (async () => {
          for (const jumpHostId of chain) {
            const jumpTrusted = await ensureTrustedHostKey(set, {
              ...input,
              hostId: jumpHostId,
              skipProbeIfAlreadyTrusted: true,
            });
            if (!jumpTrusted) {
              return false;
            }
          }
          return ensureTrustedHostKey(set, input);
        })();
      }
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
