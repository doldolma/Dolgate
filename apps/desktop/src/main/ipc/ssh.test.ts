import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcChannels } from "../../common/ipc-channels";

const ipcHandlers = new Map<string, (...args: any[]) => any>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler);
    }),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

import { registerSshIpcHandlers } from "./ssh";

function createContext() {
  return {
    hosts: {
      getById: vi.fn(),
    },
    awsService: {
      resolveManagedProfileNameOrFallback: vi.fn(),
      buildManagedSessionEnvSpec: vi.fn(),
    },
    coreManager: {
      connect: vi.fn(),
      connectAwsSession: vi.fn(),
    },
    sessionReplayService: {
      noteSessionConfigured: vi.fn(),
    },
    assertSshHost: vi.fn(),
    requireTrustedHostKey: vi.fn(),
    requireConfiguredSshUsername: vi.fn(),
    resolveRuntimeSshSecrets: vi.fn(),
    ensureCertificateAuthReady: vi.fn(),
    pendingSessionSecrets: new Map(),
  } as any;
}

describe("registerSshIpcHandlers", () => {
  beforeEach(() => {
    ipcHandlers.clear();
  });

  it("blocks certificate auth before connect when certificate inspection reports an error", async () => {
    const ctx = createContext();
    ctx.hosts.getById.mockReturnValue({
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      secretRef: "secret-1",
    });
    ctx.requireTrustedHostKey.mockReturnValue("trusted");
    ctx.requireConfiguredSshUsername.mockReturnValue("ubuntu");
    ctx.resolveRuntimeSshSecrets.mockResolvedValue({
      secrets: {
        privateKeyPem: "PRIVATE KEY",
        certificateText: "CERTIFICATE",
      },
      shouldPersistHostSecret: false,
    });
    ctx.ensureCertificateAuthReady.mockRejectedValue(
      new Error(
        "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
      ),
    );

    registerSshIpcHandlers(ctx);

    const connectHandler = ipcHandlers.get(ipcChannels.ssh.connect);
    expect(connectHandler).toBeTypeOf("function");

    await expect(
      connectHandler?.(null, {
        hostId: "host-1",
        cols: 120,
        rows: 32,
      }),
    ).rejects.toThrow(
      "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
    );
    expect(ctx.coreManager.connect).not.toHaveBeenCalled();
  });
});
