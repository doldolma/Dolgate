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
  applyConnectionProgress,
  createConnectionProgress,
  resolveTailnetProgress,
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
          // AWS·warpgate 호스트는 tailnet 을 타지 않는다 — 항상 기본 범위다.
          tailnetId: null,
        }
      : isWarpgateSshHostRecord(host)
        ? {
            host: host.warpgateSshHost,
            port: host.warpgateSshPort,
            tailnetId: null,
          }
        : isSshHostRecord(host)
          ? {
              host: host.hostname,
              port: host.port,
              // 신뢰는 tailnet 범위 안에서만 유효하다. 메인은 이 범위로 조회하므로 여기서
              // 빼면 판정이 어긋난다 — 렌더러는 "이미 신뢰함"이라 프로브를 건너뛰는데 메인은
              // 거부해서, 신뢰할 방법이 없는 막다른 오류가 된다. tailnet 을 나중에 붙인
              // 호스트가 정확히 그 상태가 된다.
              tailnetId: host.tailnetId ?? null,
            }
          : null;

    if (!target) {
      return false;
    }

    // 빈 문자열과 없음은 같은 범위다(메인의 normalizeTailnetScope 와 같은 규칙).
    const scope = (target.tailnetId ?? "").trim();

    return state.knownHosts.some(
      (record) =>
        record.host === target.host &&
        record.port === target.port &&
        (record.tailnetId ?? "").trim() === scope,
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

  /**
   * 같은 tailnet 을 향해 진행 중인 준비 작업.
   *
   * 코어는 tailnet 당 연결 시도 하나만 유지하고 새 시도가 앞의 것을 접는다. 합치지 않으면
   * 터미널을 두 개 동시에 열었을 때 뒤에 시작한 쪽이 앞의 인증을 취소해 버린다.
   */
  const tailnetReadyInFlight = new Map<string, Promise<boolean>>();

  /**
   * 이 호스트가 tailnet 을 경유하면 연결을 만들기 전에 노드를 올린다.
   *
   * 연결 안쪽(dial)에서 하지 않는 이유: 그 층에는 어느 세션인지도, 사람을 기다릴 예산도 없다.
   * 여기서 하면 진행을 그 연결의 오버레이에 그대로 보여줄 수 있다.
   */
  const ensureTailnetReady = (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    const host = get().hosts.find((item) => item.id === input.hostId);
    const tailnetId =
      host && isSshHostRecord(host) ? host.tailnetId?.trim() : undefined;
    if (!tailnetId) {
      return Promise.resolve(true);
    }
    const running = tailnetReadyInFlight.get(tailnetId);
    if (running) {
      return running;
    }
    const started = runTailnetReady(set, input, tailnetId).finally(() => {
      tailnetReadyInFlight.delete(tailnetId);
    });
    tailnetReadyInFlight.set(tailnetId, started);
    return started;
  };

  const runTailnetReady = async (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
    tailnetId: string,
  ): Promise<boolean> => {
    const records = await api.tailnet.list();
    const record = records.find((entry) => entry.id === tailnetId);
    if (!record) {
      // 호스트는 tailnet 을 가리키는데 이 기기에는 없다. 메인도 이 상태의 연결을 거부한다.
      throw new Error(t('sessionSvc.tailnetMissing'));
    }

    const target = {
      sessionId: input.sessionId,
      endpointId: input.endpointId,
      hostId: input.hostId,
    };
    const report = (waiting: Parameters<typeof resolveTailnetProgress>[1]) => {
      applyConnectionProgress(set, target, resolveTailnetProgress(record.label, waiting));
    };

    report('connecting');

    // 노드가 올라오는 동안의 중간 상태. 이걸 흘리지 않으면 사용자는 "연결하는 중" 에서 몇 분간
    // 아무 설명 없이 기다린다 — 실제로 브라우저 로그인이 필요한데도 그것을 알 수 없었다.
    // 인증 URL 은 한 번 쓰이면 상태에서 비워진다. 그래서 로그인 직후에 "URL 없는 needsAuth" 가
    // 오는데, 그것을 링크를 기다리는 상태로 되돌려 말하면 순서가 거꾸로 보인다(브라우저가 이미
    // 열렸고 로그인까지 끝난 뒤에 "링크를 받는 중" 이 뜬다).
    let sawAuthUrl = false;
    const unsubscribe = api.tailnet.onStatus((status) => {
      if (status.id !== tailnetId) {
        return;
      }
      if (status.state === 'needsAuth') {
        // 오버레이가 "브라우저 다시 열기"·"취소" 를 낼 수 있게 기다리는 대상을 남긴다.
        set({
          pendingTailnetAuth: {
            tailnetId,
            label: record.label,
            authUrl: status.authUrl ?? null,
          },
        });
        if (status.authUrl) {
          sawAuthUrl = true;
          report('needsAuth');
          return;
        }
        report(sawAuthUrl ? 'verifyingAuth' : 'preparingAuth');
        return;
      }
      if (status.state === 'needsApproval') {
        report('needsApproval');
      }
    });

    try {
      const final = await api.tailnet.test({
        id: tailnetId,
        controlUrl: record.controlUrl,
      });
      if (final.state === 'running') {
        return true;
      }
      // 실패를 예외로 알린다. false 로 돌려주면 호출부가 "호스트 키 신뢰 대기" 로 취급해서,
      // 누를 것도 없는 화면에 멈춘다 — 취소를 눌러도 아무 일이 없는 것으로 보였다.
      // 예외는 연결 실패 경로를 그대로 타서 이유와 Retry/Close 가 뜬다.
      throw new Error(
        final.error ??
          t(
            sawAuthUrl
              ? 'sessionSvc.tailnetAuthCancelled'
              : 'sessionSvc.tailnetConnectFailed',
            { label: record.label },
          ),
      );
    } finally {
      unsubscribe();
      set({ pendingTailnetAuth: null });
    }
  };

  const ensureTrustedHost = (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    // tailnet 을 경유하는 호스트는 노드가 먼저 올라와 있어야 한다. 호스트 키 probe 도 그
    // 통로로 나가므로 신뢰 확인보다 앞이어야 한다.
    //
    // 판정이 동기라, tailnet 을 안 쓰는 호스트는 프로미스를 하나도 더 얹지 않는다 — 중간
    // 상태를 관찰하는 화면이 기존 타이밍에 의존한다.
    if (needsTailnetReady(input.hostId)) {
      return (async () => {
        if (!(await ensureTailnetReady(set, input))) {
          return false;
        }
        return ensureTrustedHostChain(set, input);
      })();
    }
    return ensureTrustedHostChain(set, input);
  };

  /** tailnet 준비가 필요한 호스트인지. 동기 판정이라 아닌 경우의 타이밍을 건드리지 않는다. */
  const needsTailnetReady = (hostId: string): boolean => {
    const host = get().hosts.find((item) => item.id === hostId);
    return Boolean(host && isSshHostRecord(host) && host.tailnetId?.trim());
  };

  const ensureTrustedHostChain = (
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
