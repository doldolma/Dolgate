import {
  buildAwsEc2SshOverSsmSignature,
  getConnectionFailureReason,
  isAwsEc2HostRecord,
  isAwsHostKeySecurityError,
  recordSshOverSsmFallback,
  shouldAttemptSshOverSsm,
  isAwsEc2WindowsPlatform,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  type DesktopConnectInput,
  type DesktopLocalConnectInput,
  type HostKeyTrustRespondInput,
  type KeyboardInteractiveRespondInput,
  type ServerInfoResponse,
} from "@shared";
import { shell as electronShell, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { AwsEc2HostRecord, MainIpcContext, SshHostRecord } from "./context";
import { probeLocalAgent, resolveLocalAgentEndpoint } from "./agent-endpoint";
import { connectAwsEc2OverSsm } from "./aws-ec2-ssh-over-ssm";
import { runWithIpcSessionOwner } from "./session-owner";
import { COMPLETION_EXIT_UNKNOWN } from "../core-manager";
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

// 시도 순서·재시도 억제·호스트키 판정은 **shared-core 한 벌**을 쓴다. 모바일도 같은 함수를
// 쓰므로 규칙이 플랫폼마다 갈리지 않는다(packages/shared-core/src/aws-ssm-attempt.ts).
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHostKeySecurityError(error: unknown): boolean {
  return isAwsHostKeySecurityError(errorMessageOf(error));
}

function combineAwsSshFallbackFailure(
  sshError: unknown,
  fallbackError: unknown,
): Error {
  const primary = errorMessageOf(sshError);
  const fallback = errorMessageOf(fallbackError);
  // 두 경로가 **같은 권한** 때문에 막혔으면 문장을 하나로 접는다.
  //
  // 둘 다 결국 같은 액션을 부른다(ssm:StartSession) — 그 권한이 없으면 SSH-over-SSM 도 SSM 셸도
  // 같은 이유로 실패하는데, 원문을 이어 붙이면 원인은 하나인데 화면에는 같은 말이 두 번 나온다.
  // 거부된 액션이 서로 다르면(예: EIC 키 전송과 세션 시작) 각각이 알려 주는 사실이 달라 둘 다 남긴다.
  const primaryReason = getConnectionFailureReason(primary);
  const fallbackReason = getConnectionFailureReason(fallback);
  if (
    primaryReason.code === "aws-permission" &&
    fallbackReason.code === "aws-permission" &&
    primaryReason.awsAction === fallbackReason.awsAction
  ) {
    // 앞쪽을 남긴다 — preflight 가 붙인 단계 표시가 들어 있어 어디서 막혔는지가 함께 온다.
    return new Error(primary);
  }
  return new Error(
    t('sshIpc.fallbackFailed', {
      primary,
      fallback,
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
          const attemptSsh = shouldAttemptSshOverSsm({
            host,
            isWindowsInstance,
            memo: memo
              ? { signature: memo.signature, retryAfterMs: memo.retryAfter }
              : null,
            nowMs: Date.now(),
          });
          if (memo && attemptSsh) {
            awsSshOverSsmFallbacks.delete(host.id);
          }
          if (attemptSsh) {
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
              const recorded = recordSshOverSsmFallback({ host, nowMs: Date.now() });
              awsSshOverSsmFallbacks.set(host.id, {
                // 지문은 실패 당시의 것을 쓴다 — 그 사이 사용자가 설정을 고쳤으면 다음 접속에서
                // 다시 시도해야 한다.
                signature: failedSshOverSsm.signature,
                retryAfter: recorded.retryAfterMs,
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
        const trustedHostKeysBase64 = ctx.resolveTrustedHostKeys({
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
      const trustedHostKeysBase64 = ctx.resolveTrustedHostKeys(sshHost);
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
        // env 는 호스트 속성이다. 자격증명은 여러 호스트가 공유하므로 거기에 두면 한 호스트의
        // 값이 다른 호스트로 번졌다 — 그래서 호스트로 옮겼고, 자격증명 쪽 필드는 없앴다.
        env: sshHost.env ?? undefined,
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
    async (_event, sessionId: string, shell?: string) => {
      await ctx.coreManager.reinjectShellIntegration(sessionId, shell);
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
    async (
      _event,
      sessionId: string,
      command: string,
      options?: { background?: boolean; elevate?: boolean },
    ): Promise<{
      stdout: string;
      exitCode: number;
      stderr: string;
      failed?: boolean;
      message?: string;
    }> => {
      // **완성 질의의 실패는 IPC 의 실패가 아니다.** 여기서 reject 하면 렌더러가 제대로 받아
      // 물러나는 경우까지 Electron 이 메인 로그에 "Error occurred in handler for ..." 로 찍는다.
      // 보조 채널은 세션 패널의 폴링들이 나눠 쓰므로 차례를 놓치는 일이 정상적으로 생기는데,
      // 그때마다 오류가 쌓이면 진짜 문제를 덮는다. 결과에 담아 보내고 렌더러 쪽 서비스가
      // 예외로 바꾼다(호출부의 try/catch 는 그대로다).
      try {
        return await ctx.coreManager.queryCompletion(sessionId, command, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 한 줄만 남긴다. 화면은 조용히 물러나지만(패널이 마지막 값을 지킨다) 왜 못 받았는지는
        // 어딘가에 있어야 한다 — 예전에는 Electron 이 스택까지 찍어 로그가 뒤덮였고, 그것을
        // 없애고 나니 이번엔 아무것도 안 남아 원인을 찾을 수 없었다.
        console.warn(
          `[completion] ${message} (session=${sessionId}, command=${command.slice(0, 80)})`,
        );
        return {
          stdout: "",
          exitCode: COMPLETION_EXIT_UNKNOWN,
          stderr: "",
          failed: true,
          message,
        };
      }
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.hostMetrics,
    async (
      _event,
      sessionId: string,
      options?: { processLimit?: number; system?: boolean },
    ): Promise<{ supported: boolean; sample: unknown | null; message?: string }> => {
      // 완성 질의와 같은 이유로 여기서 reject 하지 않는다 — 폴링 하나가 늦었다고 Electron 이
      // 메인 로그를 오류로 뒤덮으면 진짜 문제가 묻힌다. 결과에 담아 보낸다.
      try {
        return await ctx.coreManager.collectHostMetrics(sessionId, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[host-metrics] ${message} (session=${sessionId})`);
        return { supported: false, sample: null, message };
      }
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.respondKeyboardInteractive,
    async (_event, input: KeyboardInteractiveRespondInput) => {
      await ctx.coreManager.respondKeyboardInteractive(input);
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.respondHostKeyTrust,
    async (_event, input: HostKeyTrustRespondInput) => {
      await ctx.coreManager.respondHostKeyTrust(input);
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
    ipcChannels.ssh.tmuxRefreshSessions,
    async (_event, sessionId: string) => {
      ctx.coreManager.tmuxRefreshSessions(sessionId);
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
