import type {
  HostRecord,
  HostSecretInput,
  TerminalConnectionProgress,
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

export function createTrustAuthServices({ api }: SliceDeps) {
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

  const ensureTrustedHost = async (
    set: StoreSetter,
    input: {
      hostId: string;
      sessionId?: string | null;
      endpointId?: string | null;
      action: PendingHostKeyPrompt["action"];
    },
  ): Promise<boolean> => {
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

  return {
    loginAwsSsoProfile,
    ensureAwsSsoProfileAuthenticationIfNeeded,
    ensureAwsHostAuthentication,
    ensureTrustedHost,
  };
}
