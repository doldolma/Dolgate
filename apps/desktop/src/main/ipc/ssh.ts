import {
  getAwsEc2HostSshPort,
  isAwsEc2HostRecord,
  isAwsEc2WindowsPlatform,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  type DesktopConnectInput,
  type DesktopLocalConnectInput,
  type KeyboardInteractiveRespondInput,
  type ServerInfoResponse,
} from "@shared";
import { shell as electronShell, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { AwsEc2HostRecord, MainIpcContext, SshHostRecord } from "./context";
import { probeLocalAgent, resolveLocalAgentEndpoint } from "./agent-endpoint";
import { connectAwsEc2OverSsm } from "./aws-ec2-ssh-over-ssm";
import { runWithIpcSessionOwner } from "./session-owner";
import { t } from '../i18n';
import { logMessage } from "../activity-log-message";

// 로컬 agent 엔드포인트 해석은 agent-endpoint 모듈로 이전(포워딩+인증 공용 + 셸 환경 해석).
// 기존 import 경로(테스트 포함) 호환을 위해 재노출한다.
export { resolveLocalAgentEndpoint as resolveAgentForwardingEndpoint } from "./agent-endpoint";

async function assertAwsSsmServerProxySupported(
  ctx: MainIpcContext,
  accessToken: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/info", ctx.authService.getServerUrl()), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown error";
    throw new Error(
      t('sshIpc.ssmSupportFailed', { message }),
    );
  }

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? t('sshIpc.serverAuthRequired')
        : t('sshIpc.ssmSupportStatus', { status: response.status }),
    );
  }

  const info = (await response.json()) as Partial<ServerInfoResponse>;
  if (info.capabilities?.sessions?.awsSsm !== true) {
    throw new Error(t('sshIpc.ssmUnsupported'));
  }
}

// SSH-over-SSM 실패로 SSM 셸에 폴백한 뒤 이 시간 안에는 SSH 재시도를 건너뛴다.
// 실패한 SSH 시도는 preflight(Run Command)·EIC·핸드셰이크까지 수 초를 쓰므로,
// 연결할 때마다 그 레이턴시를 반복 지불하지 않게 한다.
const AWS_SSH_OVER_SSM_RETRY_AFTER_MS = 10 * 60 * 1000;

// SSH-over-SSM 가능성에 영향을 주는 연결 설정의 지문. 시그니처가 바뀌면
// (포트·사용자·AZ·인스턴스·프로필·프록시 모드 수정) 폴백 기억을 버리고 SSH부터 다시 시도한다.
function buildAwsEc2SshOverSsmSignature(host: AwsEc2HostRecord): string {
  return JSON.stringify([
    host.awsRegion,
    host.awsInstanceId,
    getAwsEc2HostSshPort(host),
    host.awsSshUsername?.trim() || null,
    host.awsAvailabilityZone ?? null,
    host.awsSsmServerProxyEnabled === true,
    host.awsProfileId ?? null,
  ]);
}

// renderer는 이 에러 메시지로 호스트 키 신뢰 프롬프트를 띄운다(host-coordinator의
// requireTrustedHostKeys). 폴백해 버리면 사용자가 신뢰 후 SSH로 붙을 기회가 사라진다.
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHostKeySecurityError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return [
    /Host key is not trusted yet/i,
    /host key mismatch/i,
    /Host key changed/i,
    /trusted host key/i,
    /host key trust/i,
  ].some((pattern) => pattern.test(message));
}

function combineAwsSshFallbackFailure(
  sshError: unknown,
  fallbackError: unknown,
): Error {
  return new Error(
    t('sshIpc.fallbackFailed', {
      primary: errorMessageOf(sshError),
      fallback: errorMessageOf(fallbackError),
    }),
  );
}

async function connectAwsServerProxySessionWithAuthRetry(
  ctx: MainIpcContext,
  input: {
    profileName: string;
    region: string;
    instanceId: string;
    cols: number;
    rows: number;
    title: string;
    hostId: string;
    hostLabel: string;
    startupCommand?: string;
    shellKind?: string;
  },
): Promise<{ sessionId: string }> {
  const envSpec = await ctx.awsService.buildServerProxySessionEnvSpec(
    input.profileName,
    input.region,
  );

  const connectOnce = async (accessToken: string) => {
    await assertAwsSsmServerProxySupported(ctx, accessToken);
    return ctx.coreManager.connectAwsServerProxySession({
      ...input,
      serverUrl: ctx.authService.getServerUrl(),
      accessToken,
      env: envSpec.env,
      unsetEnv: envSpec.unsetEnv,
    });
  };

  const initialAccessToken = ctx.authService.getAccessToken();
  try {
    return await connectOnce(initialAccessToken);
  } catch (error) {
    const refreshed = await ctx.authService.refreshSession().catch(() => null);
    if (refreshed?.status !== "authenticated") {
      throw error;
    }
    return connectOnce(ctx.authService.getAccessToken());
  }
}

export function registerSshIpcHandlers(ctx: MainIpcContext): void {
  // hostId → SSH-over-SSM 폴백 기억. register 클로저 안에 두어 앱 수명과 함께 산다.
  const awsSshOverSsmFallbacks = new Map<
    string,
    { signature: string; retryAfter: number }
  >();

  ipcMain.handle(
    ipcChannels.ssh.connect,
    async (event, input: DesktopConnectInput) =>
      runWithIpcSessionOwner(ctx, event, async () => {
      const host = ctx.hosts.getById(input.hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (isAwsEcsHostRecord(host)) {
        throw new Error(t('sshIpc.ecsUseContainers'));
      }

      if (isAwsEc2HostRecord(host)) {
        const profileName = ctx.awsService.requireManagedProfileName(
          host.awsProfileId,
          host.awsProfileName,
        );
        const title = input.title?.trim() || host.label;
        // Windows 인스턴스는 SSH-over-SSM 이 성립하지 않는다. 그 경로는 EC2 Instance Connect 로
        // 임시 공개키를 밀어 넣어 인증하는데 EIC 는 Linux 전용이라, 시도해 봐야 "공개키 전송 중"
        // 진행 표시를 띄운 뒤 EIC 오류로 떨어질 뿐이다(폴백 기억도 10분이면 만료돼 계속 반복된다).
        const isWindowsInstance = isAwsEc2WindowsPlatform(host.awsPlatform);
        const connectionInput = {
          profileName,
          region: host.awsRegion,
          instanceId: host.awsInstanceId,
          cols: input.cols,
          rows: input.rows,
          hostId: host.id,
          hostLabel: host.label,
          title,
          startupCommand: input.startupCommand,
          // Windows 인스턴스의 SSM 세션은 PowerShell 로 떨어진다. 코어가 POSIX 셸 통합
          // 스크립트를 타이핑하지 않도록 종류를 알려 준다(안 알려 주면 첫 화면이 PowerShell
          // 파싱 오류로 덮인다). 두 경로 모두 각자의 ssh-core 로 이 값을 실어 보낸다 —
          // 직결은 로컬 코어, 서버 프록시는 sync-api 안의 코어.
          shellKind: isWindowsInstance ? "powershell" : undefined,
        };
        const connectSsmShell = async () =>
          host.awsSsmServerProxyEnabled === true
            ? connectAwsServerProxySessionWithAuthRetry(ctx, connectionInput)
            : (async () => {
                const awsSessionEnv = ctx.awsService.buildManagedSessionEnvSpec();
                const ssmSession = ctx.awsService.shouldUseInProcessSsm()
                  ? await ctx.awsService.startSsmShellSession(
                      profileName,
                      host.awsRegion,
                      host.awsInstanceId,
                    )
                  : undefined;
                return ctx.coreManager.connectAwsSession({
                  ...connectionInput,
                  env: awsSessionEnv.env,
                  unsetEnv: awsSessionEnv.unsetEnv,
                  ssmSession,
                });
              })();

        let connection: { sessionId: string } | undefined;
        if (input.tmux === true && isWindowsInstance) {
          // tmux 는 SSH 경로 전용인데 Windows 는 거기 못 간다. SSM 셸로 대체하면 tmux 없이
          // 붙어 놓고 성공한 것처럼 보이므로, 무엇이 안 되는지 그대로 알린다.
          throw new Error(t('sshIpc.windowsTmuxUnsupported'));
        }
        if (input.tmux === true) {
          // tmux control mode over SSH-over-SSM — same as a normal SSH host,
          // only the transport differs (server-proxy WebSocket vs local tunnel).
          // tmux는 SSM 셸로 대체할 수 없으므로 폴백 없이 실패를 그대로 알린다.
          connection = await connectAwsEc2OverSsm(ctx, host, {
            cols: input.cols,
            rows: input.rows,
            title,
            command: input.tmuxCommand?.trim() || undefined,
            tmux: true,
            tmuxVersion: input.tmuxVersion,
            startupCommand: input.startupCommand,
          });
        } else {
          // 일반 연결도 SSH-over-SSM을 우선 시도한다 — 실제 SSH 셸이라 셸 통합
          // (동적 자동완성·명령 완료 알림)과 ZMODEM/드래그 업로드가 살아난다.
          // sshd 미기동·EIC 미지원 등으로 실패하면 기존 SSM 셸로 폴백한다.
          const signature = buildAwsEc2SshOverSsmSignature(host);
          let failedSshOverSsm: { error: unknown; signature: string } | undefined;
          const memo = awsSshOverSsmFallbacks.get(host.id);
          const skipSshAttempt =
            isWindowsInstance ||
            (memo !== undefined &&
              memo.signature === signature &&
              memo.retryAfter > Date.now());
          if (memo && !skipSshAttempt) {
            awsSshOverSsmFallbacks.delete(host.id);
          }
          if (!skipSshAttempt) {
            try {
              connection = await connectAwsEc2OverSsm(ctx, host, {
                cols: input.cols,
                rows: input.rows,
                title,
                startupCommand: input.startupCommand,
                awaitReady: true,
              });
            } catch (error) {
              if (isHostKeySecurityError(error)) {
                throw error;
              }
              const latestHost = ctx.hosts.getById(host.id);
              failedSshOverSsm = {
                error,
                signature:
                  latestHost && isAwsEc2HostRecord(latestHost)
                    ? buildAwsEc2SshOverSsmSignature(latestHost)
                    : signature,
              };
            }
          }
          if (!connection) {
            try {
              connection = await connectSsmShell();
            } catch (fallbackError) {
              if (failedSshOverSsm) {
                throw combineAwsSshFallbackFailure(
                  failedSshOverSsm.error,
                  fallbackError,
                );
              }
              throw fallbackError;
            }
            if (failedSshOverSsm) {
              const reason = errorMessageOf(failedSshOverSsm.error);
              awsSshOverSsmFallbacks.set(host.id, {
                signature: failedSshOverSsm.signature,
                retryAfter: Date.now() + AWS_SSH_OVER_SSM_RETRY_AFTER_MS,
              });
              ctx.activityLogs.append(
                "warn",
                "session",
                logMessage('sshIpc.fallbackNotice'),
                { hostId: host.id, host: host.label, reason },
              );
            }
          }
        }
        ctx.sessionReplayService.noteSessionConfigured(
          connection.sessionId,
          input.cols,
          input.rows,
        );
        return connection;
      }

      if (isWarpgateSshHostRecord(host)) {
        const trustedHostKeysBase64 = ctx.requireTrustedHostKeys({
          hostname: host.warpgateSshHost,
          port: host.warpgateSshPort,
        });
        const title = input.title?.trim() || host.label;
        const connection = await ctx.coreManager.connect({
          host: host.warpgateSshHost,
          port: host.warpgateSshPort,
          username: `${host.warpgateUsername}:${host.warpgateTargetName}`,
          authType: "keyboardInteractive",
          trustedHostKeyBase64: trustedHostKeysBase64[0],
          trustedHostKeysBase64,
          cols: input.cols,
          rows: input.rows,
          command: input.command?.trim() || undefined,
          startupCommand: input.startupCommand,
          hostId: host.id,
          hostLabel: host.label,
          title,
          transport: "warpgate",
        });
        ctx.sessionReplayService.noteSessionConfigured(
          connection.sessionId,
          input.cols,
          input.rows,
        );
        return connection;
      }

      ctx.assertSshHost(host);
      const sshHost = host as SshHostRecord;
      const trustedHostKeysBase64 = ctx.requireTrustedHostKeys(sshHost);
      const username = ctx.requireConfiguredSshUsername(sshHost);
      const { secrets, shouldPersistHostSecret } =
        await ctx.resolveRuntimeSshSecrets(sshHost, input.secrets);
      await ctx.ensureCertificateAuthReady(sshHost, secrets);
      const jump = await ctx.resolveJumpHostTarget(sshHost);
      const title = input.title?.trim() || sshHost.label;
      const useMosh = jump ? false : sshHost.useMosh === true;
      const agentForwardingRequested =
        sshHost.agentForwarding === true && !useMosh;
      const agentForwardingEndpoint = agentForwardingRequested
        ? await resolveLocalAgentEndpoint()
        : null;
      // authType이 "agent"면 로컬 ssh-agent 엔드포인트를 해석해 코어에 전달(서명 위임).
      const authAgentEndpoint =
        sshHost.authType === "agent" ? await resolveLocalAgentEndpoint() : null;
      const connection = await ctx.coreManager.connect({
        host: sshHost.hostname,
        port: sshHost.port,
        username,
        authType: sshHost.authType,
        password: secrets.password,
        privateKeyPem: secrets.privateKeyPem,
        certificateText: secrets.certificateText,
        passphrase: secrets.passphrase,
        trustedHostKeyBase64: trustedHostKeysBase64[0],
        trustedHostKeysBase64,
        jump,
        // tailnet 경유면 코어가 그 노드로 raw 전송을 연다. 기대 이름을 함께 넘겨서 실제로
        // 붙은 tailnet 이 다르면 연결을 거부하게 한다.
        ...ctx.resolveTailnetRoute(sshHost),
        cols: input.cols,
        rows: input.rows,
        // tmux control mode 진입이면 tmuxCommand(특정 세션 attach 등)를 Go payload.Command 로
        // 보내 기본 new-session 대신 쓰게 한다. 일반 연결은 호스트 설정 command 를 그대로 쓴다.
        command:
          input.tmux === true
            ? input.tmuxCommand?.trim() || undefined
            : input.command?.trim() || undefined,
        startupCommand: input.startupCommand,
        // env는 호스트 속성. 구버전 데이터(시크릿에만 있던 env)는 host.env가 비었을 때만 폴백으로 사용.
        env: sshHost.env && sshHost.env.length > 0 ? sshHost.env : secrets.env,
        // mosh는 jump와 상호 배타다(UI에서 차단). 방어적으로 jump가 있으면 useMosh를
        // 무시해 jump 연결을 보장한다(잘못된 조합이 들어와도 안전하게 SSH로 폴백).
        useMosh,
        agentForwarding: agentForwardingRequested,
        agentForwardingEndpointKind: agentForwardingEndpoint?.kind,
        agentForwardingEndpoint: agentForwardingEndpoint?.endpoint,
        authAgentEndpointKind: authAgentEndpoint?.kind,
        authAgentEndpoint: authAgentEndpoint?.endpoint,
        tmux: input.tmux === true,
        // tmux control mode 진입 시 감지된 원격 tmux 버전을 코어로 전달해 버전별 입력
        // 인코딩(-H vs -l)·refresh-client 방언(콤마 vs WxH)을 고르게 한다.
        tmuxVersion: input.tmux === true ? input.tmuxVersion : undefined,
        hostId: sshHost.id,
        hostLabel: sshHost.label,
        title,
        transport: "ssh",
      });
      ctx.sessionReplayService.noteSessionConfigured(
        connection.sessionId,
        input.cols,
        input.rows,
      );

      if (shouldPersistHostSecret) {
        ctx.pendingSessionSecrets.set(connection.sessionId, {
          hostId: sshHost.id,
          label: title,
          secrets,
        });
      }

      return connection;
      }),
  );

  ipcMain.handle(
    ipcChannels.ssh.connectLocal,
    async (event, input: DesktopLocalConnectInput) =>
      runWithIpcSessionOwner(ctx, event, async () => {
      const title = input.title?.trim() || "Terminal";
      const connection = await ctx.coreManager.connectLocalSession({
        cols: input.cols,
        rows: input.rows,
        title,
        shellKind: input.shellKind?.trim() || undefined,
        executable: input.executable?.trim() || undefined,
        args: input.args?.filter((value) => value.trim().length > 0),
        env: input.env,
        workingDirectory: input.workingDirectory?.trim() || undefined,
        lifecycle: {
          hostId: "local-terminal",
          hostLabel: "Local Terminal",
          connectionKind: "local",
        },
      });
      ctx.sessionReplayService.noteSessionConfigured(
        connection.sessionId,
        input.cols,
        input.rows,
      );
      return connection;
      }),
  );

  ipcMain.handle(
    ipcChannels.ssh.write,
    async (_event, sessionId: string, data: string) => {
      ctx.coreManager.write(sessionId, data);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.writeBinary,
    async (_event, sessionId: string, data: Uint8Array) => {
      ctx.coreManager.writeBinary(sessionId, data);
    },
  );

  // SSH Agent 인증 설정 시 로컬 agent 상태(도달·키 개수)를 조회한다. 실패해도 인증엔 무관.
  ipcMain.handle(ipcChannels.ssh.probeAgent, async () => probeLocalAgent());

  ipcMain.handle(
    ipcChannels.ssh.resize,
    async (_event, sessionId: string, cols: number, rows: number) => {
      ctx.sessionReplayService.handleTerminalResize(sessionId, cols, rows);
      ctx.coreManager.resize(sessionId, cols, rows);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.disconnect,
    async (_event, sessionId: string) => {
      ctx.coreManager.disconnect(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.prepareAutocomplete,
    async (_event, sessionId: string) => {
      await ctx.coreManager.prepareAutocomplete(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.installShellIntegration,
    async (_event, sessionId: string) => {
      await ctx.coreManager.installShellIntegration(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.reinjectShellIntegration,
    async (_event, sessionId: string) => {
      await ctx.coreManager.reinjectShellIntegration(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.refreshAutocomplete,
    async (_event, sessionId: string) => {
      await ctx.coreManager.refreshAutocomplete(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.stopAutocomplete,
    async (_event, sessionId: string) => {
      await ctx.coreManager.stopAutocomplete(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.completionQuery,
    async (_event, sessionId: string, command: string) => {
      return ctx.coreManager.queryCompletion(sessionId, command);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.respondKeyboardInteractive,
    async (_event, input: KeyboardInteractiveRespondInput) => {
      await ctx.coreManager.respondKeyboardInteractive(input);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxSplitPane,
    async (_event, sessionId: string, direction: "h" | "v") => {
      ctx.coreManager.tmuxSplitPane(sessionId, direction);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxNewWindow,
    async (_event, sessionId: string) => {
      ctx.coreManager.tmuxNewWindow(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxSelectWindow,
    async (_event, sessionId: string, windowId: string) => {
      ctx.coreManager.tmuxSelectWindow(sessionId, windowId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxSelectPane,
    async (_event, sessionId: string) => {
      ctx.coreManager.tmuxSelectPane(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxKillPane,
    async (_event, sessionId: string) => {
      ctx.coreManager.tmuxKillPane(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxKillWindow,
    async (_event, sessionId: string, windowId: string) => {
      ctx.coreManager.tmuxKillWindow(sessionId, windowId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxKillSession,
    async (_event, sessionId: string, sessionName: string) => {
      ctx.coreManager.tmuxKillSession(sessionId, sessionName);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxRenameWindow,
    async (_event, sessionId: string, windowId: string, name: string) => {
      ctx.coreManager.tmuxRenameWindow(sessionId, windowId, name);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxDetach,
    async (_event, sessionId: string) => {
      ctx.coreManager.tmuxDetach(sessionId);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.tmuxCommand,
    async (_event, sessionId: string, command: string) => {
      ctx.coreManager.tmuxCommand(sessionId, command);
    },
  );

  ipcMain.handle(
    ipcChannels.shell.openExternal,
    async (_event, url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error(t('sshIpc.externalLinkScheme'));
      }
      await electronShell.openExternal(target.toString());
    },
  );
}
