import {
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isWarpgateSshHostRecord,
  type DesktopConnectInput,
  type DesktopLocalConnectInput,
  type KeyboardInteractiveRespondInput,
} from "@shared";
import { shell as electronShell, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext, SshHostRecord } from "./context";

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
        const awsSessionEnv = ctx.awsService.buildManagedSessionEnvSpec();
        const connection = await ctx.coreManager.connectAwsSession({
          profileName,
          region: host.awsRegion,
          instanceId: host.awsInstanceId,
          cols: input.cols,
          rows: input.rows,
          hostId: host.id,
          hostLabel: host.label,
          title: input.title?.trim() || host.label,
          env: awsSessionEnv.env,
          unsetEnv: awsSessionEnv.unsetEnv,
        });
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
      return ctx.coreManager.connectLocalSession({
        cols: input.cols,
        rows: input.rows,
        title: input.title?.trim() || "Terminal",
        shellKind: input.shellKind?.trim() || undefined,
        executable: input.executable?.trim() || undefined,
        args: input.args?.filter((value) => value.trim().length > 0),
        env: input.env,
        workingDirectory: input.workingDirectory?.trim() || undefined,
      });
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
