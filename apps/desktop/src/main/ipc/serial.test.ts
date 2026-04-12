import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";
import { registerSerialIpcHandlers } from "./serial";

const electronSpies = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronSpies.ipcMainHandle,
  },
}));

describe("registerSerialIpcHandlers", () => {
  beforeEach(() => {
    electronSpies.ipcMainHandle.mockReset();
  });

  it("connects a serial host through the core manager", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const connectSerialSession = vi.fn().mockResolvedValue({ sessionId: "serial-session-1" });
    const noteSessionConfigured = vi.fn();

    registerSerialIpcHandlers({
      hosts: {
        getById: vi.fn().mockReturnValue({
          id: "serial-1",
          kind: "serial",
          label: "Console",
          transport: "local",
          devicePath: "/dev/tty.usbserial-0001",
          host: null,
          port: null,
          baudRate: 115200,
          dataBits: 8,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
          transmitLineEnding: "none",
          localEcho: false,
          localLineEditing: false,
        }),
      },
      coreManager: {
        connectSerialSession,
      },
      sessionReplayService: {
        noteSessionConfigured,
      },
    } as any);

    const handler = handlers.get(ipcChannels.serial.connect);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected serial.connect handler to be registered");
    }

    const result = await handler(
      {},
      {
        hostId: "serial-1",
        cols: 120,
        rows: 32,
        title: "Console",
      },
    );

    expect(connectSerialSession).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "serial-1",
        title: "Console",
        transport: "local",
        devicePath: "/dev/tty.usbserial-0001",
        cols: 120,
        rows: 32,
        transmitLineEnding: "none",
      }),
    );
    expect(noteSessionConfigured).toHaveBeenCalledWith("serial-session-1", 120, 32);
    expect(result).toEqual({ sessionId: "serial-session-1" });
  });

  it("lists serial ports through the core manager", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const listSerialPorts = vi.fn().mockResolvedValue([
      {
        path: "/dev/tty.usbserial-0001",
        displayName: "/dev/tty.usbserial-0001",
        manufacturer: null,
      },
    ]);

    registerSerialIpcHandlers({
      coreManager: {
        listSerialPorts,
      },
    } as any);

    const handler = handlers.get(ipcChannels.serial.listPorts);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected serial.listPorts handler to be registered");
    }

    const result = await handler({}, undefined);

    expect(listSerialPorts).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        path: "/dev/tty.usbserial-0001",
        displayName: "/dev/tty.usbserial-0001",
        manufacturer: null,
      },
    ]);
  });

  it("forwards serial control actions to the core manager", async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    electronSpies.ipcMainHandle.mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    const controlSerialSession = vi.fn().mockResolvedValue(undefined);

    registerSerialIpcHandlers({
      coreManager: {
        controlSerialSession,
      },
    } as any);

    const handler = handlers.get(ipcChannels.serial.control);
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("expected serial.control handler to be registered");
    }

    await handler({}, {
      sessionId: "serial-session-1",
      action: "set-rts",
      enabled: true,
    });

    expect(controlSerialSession).toHaveBeenCalledWith("serial-session-1", {
      action: "set-rts",
      enabled: true,
    });
  });
});
