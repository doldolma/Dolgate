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
  isRdpHostRecord,
} from "@shared";
import type { PendingHostKeyPrompt } from "../types";
import type { SliceDeps } from "./context";
import {
  applyConnectionProgress,
  createConnectionProgress,
  resolveTailnetProgress,
  isAwsEc2HostRecord,
  isAwsSsoAuthenticationErrorMessage,
  isChangedHostKeyErrorMessage,
  normalizeRemoteInvokeErrorMessage,
} from "../utils";
import { resolveHostTailnetId } from '../../lib/host-tailnet';
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

  /**
   * 이 호스트의 키를 이미 신뢰하고 있는가.
   *
   * 연결 전 확인이 남아 있는 경로(AWS SSM, 아래 참조)에서만 쓴다 — 신뢰하고 있으면 프로브를
   * 건너뛴다. 조회 범위(tailnet)를 메인과 똑같이 계산해야 한다. 어긋나면 렌더러는 "신뢰함" 이라
   * 넘기는데 메인은 거부해서, 신뢰할 방법이 없는 막다른 오류가 된다.
   */
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

  /**
   * 연결 전에 서버 키를 읽어야 하는 호스트인가.
   *
   * 보통은 아니다 — 코어가 핸드셰이크 도중 묻는다. AWS SSM 은 예외다: 키를 저장하는 이름이
   * 인스턴스 신원(aws-ssm:프로필:리전:i-…)인데 실제로 붙는 주소는 로컬 터널
   * (127.0.0.1:임의포트)이다. 코어는 자기가 붙은 주소만 아니까 연결 중에 물으면 그 임시 주소로
   * 저장돼 다음 연결에서 또 묻는다. 이 경로는 인증이 임시 EIC 키라서 미리 읽어도 사람을 두 번
   * 부르지 않는다(OTP 점프 호스트가 문제였다).
   */
  const readsHostKeyBeforeConnect = (hostId: string): boolean => {
    const host = get().hosts.find((item) => item.id === hostId);
    return host !== undefined && isAwsEc2HostRecord(host);
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

  /**
   * 프로파일 **이름**으로 SSO 로그인을 보장한다.
   *
   * RDP 의 SSM 경유 대상은 프로파일을 이름으로만 들고 있다(RdpAwsSsmTarget — 기기마다 id 가 다를 수
   * 있어서다). 그런데 인증 확인·로그인 API 는 id 로 동작하므로, 여기서 이름 → 상태(id 포함)로 한 번
   * 바꿔 준다.
   *
   * 이게 없으면 SSO 세션이 만료된 채로 접속이 시작되고, 사용자는 브라우저 로그인 대신 SDK 의 원문
   * 오류("The SSO session token associated with profile=... was not found or is invalid")를 본다 —
   * 다른 호스트 종류는 접속 전에 이 단계를 거치므로 로그인 창이 뜬다.
   */
  const ensureAwsSsoAuthenticationByProfileName = async (
    profileName: string,
    reportProgress: (
      message: string,
      options?: {
        blockingKind?: TerminalConnectionProgress["blockingKind"];
        stage?: TerminalConnectionProgress["stage"];
      },
    ) => void,
  ) => {
    reportProgress(t('containersStore.checkingProfile', { profile: profileName }));
    const status = await api.aws.getProfileStatus(profileName);
    if (status.isAuthenticated) {
      return;
    }
    if (!status.isSsoProfile) {
      // 정적 자격증명 프로파일이다. 우리가 갱신해 줄 방법이 없으므로 무엇을 해야 하는지 말한다.
      throw new Error(
        status.errorMessage ||
          t('trustAuth.cliCredentialsNeeded', { profile: profileName }),
      );
    }
    await loginAwsSsoProfile(status.id, profileName, reportProgress);
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
    /**
     * 지금 서버 키를 읽어서 저장된 값과 대조한다.
     *
     * 연결 경로는 이걸 켜지 않는다 — 키 확인은 연결 안에서 한다. 키가 바뀐 뒤 복구할 때만 쓴다:
     * 저장된 지문과 현재 지문을 나란히 보여 주려면 연결 밖에서 읽어야 한다.
     */
    forceProbe?: boolean;
    action: PendingHostKeyPrompt["action"];
  };

  /**
   * 이 호스트의 키를 확인하고, 필요하면 프롬프트를 세운다.
   *
   * 연결 경로에서는 아무것도 하지 않는다(아래 참조). forceProbe 일 때만 실제로 서버 키를 읽는다 —
   * 점프를 경유하는 호스트는 메인이 (이미 신뢰된) 점프를 통해 프로브한다.
   */
  const ensureTrustedHostKey = async (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    // 모르는 키는 **연결 중에** 묻는다 — 이 경로에서는 프로브를 돌리지 않는다.
    //
    // 프로브는 대상까지 가는 또 하나의 연결이고, 점프 호스트에 다시 인증해야 한다. OTP 를 요구하는
    // 베스천이면 코드를 두 번 넣어야 하는데 TOTP 는 한 번 쓰면 무효하고 30초마다 바뀐다 — 실기기에서
    // 그 때문에 첫 연결이 통과하지 못했다. 코어가 핸드셰이크 도중 키를 보여 주고 신뢰를 받는다
    // (hostKeyTrustChallenge). 그러면 인증은 한 번뿐이다.
    //
    // VNC 도 같다: 화면은 vnc-core 가 그리지만 경유 터널은 ssh-core 가 연다(ipc/vnc.ts 의
    // startPortForward) — 즉 SSH 홉의 키는 그 안에서 물을 수 있다.
    //
    // 예외 둘: forceProbe(키 변경 복구)와 AWS SSM(저장 이름이 dial 주소와 다르다).
    if (!input.forceProbe) {
      if (!readsHostKeyBeforeConnect(input.hostId)) {
        return true;
      }
      if (hasTrustedHostKey(input.hostId)) {
        return true;
      }
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
  /**
   * 이 호스트가 tailnet 을 경유하면 노드를 먼저 올린다.
   *
   * 입력을 `EnsureTrustedHostInput` 보다 좁게 받는다 — 이 함수는 hostId 와 진행 표시용
   * sessionId/endpointId 만 쓴다. `action`(신뢰 프롬프트 이후 동작)을 요구하면 그 프롬프트가
   * 없는 종류(RDP)가 의미 없는 값을 만들어 넘겨야 한다.
   */
  const ensureTailnetReady = (
    set: StoreSetter,
    input: {
      hostId: string;
      sessionId?: string | null;
      endpointId?: string | null;
    },
  ): Promise<boolean> => {
    const hosts = get().hosts;
    const tailnetId = resolveHostTailnetId(
      hosts.find((item) => item.id === input.hostId),
      hosts,
    );
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
    input: { hostId: string; sessionId?: string | null; endpointId?: string | null },
    tailnetId: string,
  ): Promise<boolean> => {
    // 인터넷이 없으면 노드를 올릴 수 없다. 그런데 tsnet 의 Start 는 그 사실을 알려 주지 않고
    // 돌아오지 않아서, 그대로 두면 사용자는 아무 설명 없이 기다리다 한도까지 간다.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error(t('sessionSvc.tailnetOffline'));
    }

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
        return;
      }
      // 인증 관련 상태가 아니면 "연결 중" 으로 되돌린다.
      //
      // 이것이 없으면 마지막 인증 문구가 그대로 남는다. 만료된 노드는 재인증을 거치며 엔진이
      // 멈추고 상태가 starting 으로 내려가는데, 그때 화면은 "인증 링크를 받는 중" 에 얼어붙어
      // 실제로 무엇을 기다리는지와 어긋난다 — 사용자에게는 무한 대기로 보인다.
      report('connecting');
    });

    try {
      const final = await api.tailnet.test({
        id: tailnetId,
        controlUrl: record.controlUrl,
      });
      // 관문은 코어의 판정만 본다. state 로 다시 조합하면 기준이 갈린다 — 만료된 노드는 새 netmap
      // 이 오기 전까지 running 으로 보고되므로, state 만 보면 그 낡은 값에 통과한다.
      //
      // degraded 는 "동기화가 끊긴 채로 코어가 진행하기로 했다" 는 결정이다. 그것도 통과로 읽어야
      // 한다 — 여기서 실패로 보면, 코어가 넘긴 연결을 화면이 되돌려 세워 두게 된다.
      if (final.ready === true || final.degraded === true) {
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
    return Boolean(
      host &&
        (isSshHostRecord(host) || isRdpHostRecord(host)) &&
        (host as { tailnetId?: string | null }).tailnetId?.trim(),
    );
  };

  const ensureTrustedHostChain = (
    set: StoreSetter,
    input: EnsureTrustedHostInput,
  ): Promise<boolean> => {
    // forceProbe(키 변경 복구)에서만 의미가 있다 — 바뀐 키가 대상이 아니라 베스천일 수 있으므로
    // 체인을 첫 홉부터 순서대로 확인한다. 메인은 각 홉을 그 앞 홉을 경유해 프로브하므로 순서를
    // 지켜야 한다. 연결 경로에서는 홉의 키도 코어가 핸드셰이크 중에 묻는다.
    //
    // 점프가 없는 경로는 inner 프로미스를 그대로 반환해 추가 마이크로태스크 없이 기존 타이밍을
    // 유지한다(중간 상태를 관찰하는 화면이 있다).
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

  /**
   * 연결이 호스트 키 불일치로 실패한 뒤, 교체 프롬프트로 되돌린다.
   *
   * 정상 경로는 연결 전에 서버 키를 읽지 않으므로(인증을 두 번 요구하게 된다), 키가 바뀐
   * 사실은 실연결의 호스트 키 검사가 처음 알린다. 그 오류는 자동 재연결 금지 대상이고
   * (reconnect-classify의 permanent) 자격증명 프롬프트 대상도 아니라서, 여기서 다시 probe하지
   * 않으면 known host 레코드를 손으로 지우는 것 말고는 빠져나갈 길이 없다.
   *
   * 자동으로 신뢰하지는 않는다 — probe가 mismatch를 확인하면 프롬프트를 띄우고, 사용자가 저장된
   * 지문과 현재 지문을 직접 보고 "교체 후 계속"을 눌러야 진행된다.
   *
   * probe가 trusted를 돌려주면 아무것도 하지 않는다. 바뀐 키가 이 호스트가 아닌 경우(예: 점프
   * 홉, 노드마다 키가 다른 로드밸런서)인데, 그때 재시도하면 같은 실패를 반복하는 루프가 된다 —
   * 원래 오류를 그대로 남겨 호출자가 보여주게 한다.
   *
   * @returns 프롬프트를 띄웠으면 true. 호출자는 오류 상태 대신 "신뢰 대기" 상태를 보이면 된다.
   */
  const recoverFromChangedHostKey = async (
    set: StoreSetter,
    input: EnsureTrustedHostInput & { message: string },
  ): Promise<boolean> => {
    if (!isChangedHostKeyErrorMessage(input.message)) {
      return false;
    }
    try {
      await ensureTrustedHost(set, { ...input, forceProbe: true });
    } catch {
      // probe 자체가 실패하면(네트워크·tailnet·권한) 원래 연결 오류를 보여주는 게 맞다 —
      // probe 실패 사유로 덮어쓰면 진짜 원인이 가려진다.
      return false;
    }
    return Boolean(get().pendingHostKeyPrompt);
  };

  return {
    loginAwsSsoProfile,
    ensureAwsSsoProfileAuthenticationIfNeeded,
    ensureAwsSsoAuthenticationByProfileName,
    ensureAwsHostAuthentication,
    ensureTrustedHost,
    recoverFromChangedHostKey,
    // RDP 는 SSH 신뢰 체인(호스트 키 probe)을 타지 않는다 — 인증서 TOFU 를 메인이 따로 한다.
    // 그래서 tailnet 준비만 따로 쓸 수 있게 내보낸다.
    ensureTailnetReady,
  };
}
