import {
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  type DesktopConnectInput,
  type DesktopLocalConnectInput,
  type KeyboardInteractiveRespondInput,
  type ServerInfoResponse,
} from "@shared";
import { shell as electronShell, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext, SshHostRecord } from "./context";

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
      `서버 AWS SSM 지원 여부를 확인하지 못했습니다. ${message}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "서버 인증이 필요합니다."
        : `서버 AWS SSM 지원 여부를 확인하지 못했습니다. (${response.status})`,
    );
  }

  const info = (await response.json()) as Partial<ServerInfoResponse>;
  if (info.capabilities?.sessions?.awsSsm !== true) {
    throw new Error("서버에서 AWS SSM 세션을 지원하지 않습니다.");
  }
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
  ipcMain.handle(
    ipcChannels.ssh.connect,
    async (_event, input: DesktopConnectInput) => {
      const host = ctx.hosts.getById(input.hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (isAwsEcsHostRecord(host)) {
        throw new Error("ECS 호스트는 세션 연결 대신 Containers 화면에서 엽니다.");
      }

      if (isAwsEc2HostRecord(host)) {
        const profileName =
          ctx.awsService.resolveManagedProfileNameOrFallback(
            host.awsProfileId,
            host.awsProfileName,
          ) ?? host.awsProfileName;
        const title = input.title?.trim() || host.label;
        const connectionInput = {
          profileName,
          region: host.awsRegion,
          instanceId: host.awsInstanceId,
          cols: input.cols,
          rows: input.rows,
          hostId: host.id,
          hostLabel: host.label,
          title,
        };
        const connection = host.awsSsmServerProxyEnabled === true
          ? await connectAwsServerProxySessionWithAuthRetry(ctx, connectionInput)
          : await (async () => {
              const awsSessionEnv = ctx.awsService.buildManagedSessionEnvSpec();
              return ctx.coreManager.connectAwsSession({
                ...connectionInput,
                env: awsSessionEnv.env,
                unsetEnv: awsSessionEnv.unsetEnv,
              });
            })();
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
      const title = input.title?.trim() || sshHost.label;
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
        cols: input.cols,
        rows: input.rows,
        command: input.command?.trim() || undefined,
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
    },
  );

  ipcMain.handle(
    ipcChannels.ssh.connectLocal,
    async (_event, input: DesktopLocalConnectInput) => {
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
    },
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
    ipcChannels.shell.openExternal,
    async (_event, url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error("외부 링크는 http 또는 https만 열 수 있습니다.");
      }
      await electronShell.openExternal(target.toString());
    },
  );
}
