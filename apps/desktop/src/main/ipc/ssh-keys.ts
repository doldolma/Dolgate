import type { SshKeyGenerateInput, SshKeyInstallInput } from "@shared";
import { clipboard, ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerSshKeyIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.sshKeys.generate,
    async (_event, input: SshKeyGenerateInput) => ctx.generateSshKey(input),
  );

  ipcMain.handle(
    ipcChannels.sshKeys.copyPublicKey,
    async (_event, secretRef: string) => {
      const material = await ctx.resolveSshPublicKey(secretRef);
      clipboard.writeText(material.publicKey);
    },
  );

  ipcMain.handle(
    ipcChannels.sshKeys.install,
    async (_event, input: SshKeyInstallInput) => ctx.installSshPublicKey(input),
  );
}
