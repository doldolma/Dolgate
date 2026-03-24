import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
}));

import { SessionShareService } from "./session-share-service";

function createServiceHarness() {
  const authService = {
    getServerUrl: vi.fn(() => "https://sync.example.com"),
  };
  const coreManager = {
    write: vi.fn(),
    writeBinary: vi.fn(),
  };

  const service = new SessionShareService(authService as never, coreManager as never);

  const share = {
    sessionId: "session-1",
    inputEnabled: true,
    viewerCount: 0,
    socket: null,
    state: {
      status: "active",
      shareUrl: "https://sync.example.com/share/share-1/token-1",
      inputEnabled: true,
      viewerCount: 0,
      errorMessage: null,
    },
  };

  return { service, coreManager, share };
}

describe("SessionShareService viewer input relay", () => {
  it("relays binary viewer input through writeBinary", () => {
    const { service, coreManager, share } = createServiceHarness();

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "binary",
      data: Buffer.from([0x1b, 0x5b, 0x41]).toString("base64"),
    });

    expect(coreManager.writeBinary).toHaveBeenCalledTimes(1);
    expect(coreManager.write).not.toHaveBeenCalled();
    const [, payload] = coreManager.writeBinary.mock.calls[0];
    expect(Array.from(payload as Uint8Array)).toEqual([0x1b, 0x5b, 0x41]);
  });

  it("relays utf8 viewer input through writeBinary as utf8 bytes", () => {
    const { service, coreManager, share } = createServiceHarness();

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "utf8",
      data: "한a",
    });

    expect(coreManager.writeBinary).toHaveBeenCalledTimes(1);
    expect(coreManager.write).not.toHaveBeenCalled();
    const [, payload] = coreManager.writeBinary.mock.calls[0];
    expect(Buffer.from(payload as Uint8Array).toString("utf8")).toBe("한a");
  });

  it("ignores viewer input when session share input is disabled", () => {
    const { service, coreManager, share } = createServiceHarness();
    share.inputEnabled = false;

    (service as any).handleOwnerServerMessage(share, {
      type: "viewer-input",
      encoding: "binary",
      data: Buffer.from("a").toString("base64"),
    });

    expect(coreManager.writeBinary).not.toHaveBeenCalled();
    expect(coreManager.write).not.toHaveBeenCalled();
  });
});
