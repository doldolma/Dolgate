import {
  isSerialHostRecord,
  type DesktopSerialConnectInput,
  type DesktopSerialControlInput,
} from "@shared";
import { ipcMain } from "electron";
import { ipcChannels } from "../../common/ipc-channels";
import type { MainIpcContext } from "./context";

export function registerSerialIpcHandlers(ctx: MainIpcContext): void {
  ipcMain.handle(
    ipcChannels.serial.connect,
    async (_event, input: DesktopSerialConnectInput) => {
      const host = ctx.hosts.getById(input.hostId);
      if (!host) {
        throw new Error("Host not found");
      }
      if (!isSerialHostRecord(host)) {
        throw new Error("이 기능은 Serial host에서만 사용할 수 있습니다.");
      }

      const connection = await ctx.coreManager.connectSerialSession({
        hostId: host.id,
        hostLabel: host.label,
        title: input.title?.trim() || host.label,
        cols: input.cols,
        rows: input.rows,
        transport: host.transport,
        devicePath: host.devicePath ?? undefined,
        host: host.host ?? undefined,
        port: host.port ?? undefined,
        baudRate: host.baudRate,
        dataBits: host.dataBits,
        parity: host.parity,
        stopBits: host.stopBits,
        flowControl: host.flowControl,
        transmitLineEnding: host.transmitLineEnding,
        localEcho: host.localEcho,
        localLineEditing: host.localLineEditing,
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
    ipcChannels.serial.listPorts,
    async () => ctx.coreManager.listSerialPorts(),
  );

  ipcMain.handle(
    ipcChannels.serial.control,
    async (_event, input: DesktopSerialControlInput) =>
      ctx.coreManager.controlSerialSession(input.sessionId, {
        action: input.action,
        enabled: input.enabled,
      }),
  );
}
