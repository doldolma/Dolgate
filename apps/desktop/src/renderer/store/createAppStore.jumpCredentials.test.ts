import { describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import { jumpHostIdAtDepth } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { buildHopCredentialRetry } from "./utils";
import { credentialRetryDialogRequest } from "../shells/appShellUtils";

// 비밀번호 빼고 공유한 팀 호스트가 점프를 거치면, 요청 창이 대상만 물어 베스천 비밀번호를 넣을 길이 없었다.
// 이제 요청 창은 그 홉(베스천 → 대상 순)을 묻고, 넣은 값은 붙을 때까지 이어서 보낸다.

const stamp = "2025-01-01T00:00:00.000Z";
const bastion = {
  id: "bastion",
  kind: "ssh",
  label: "Bastion",
  hostname: "bastion.example.com",
  port: 22,
  username: "jump",
  authType: "password",
  privateKeyPath: null,
  secretRef: null,
  groupName: null,
  terminalThemeId: null,
  createdAt: stamp,
  updatedAt: stamp,
} as unknown as HostRecord;
const target = {
  ...bastion,
  id: "target",
  label: "Target",
  hostname: "target.internal",
  username: "app",
  jumpHostIds: ["bastion"],
} as unknown as HostRecord;

function createChainStore() {
  const api = createMockApi();
  api.hosts.list = vi.fn().mockResolvedValue([bastion, target]);
  return { api, store: createAppStore(api) };
}

describe("jump host credentials", () => {
  it("maps the core's jump depth to the jump host, counted back from the target", () => {
    expect(jumpHostIdAtDepth({ jumpHostIds: ["first", "last"] }, 1)).toBe("last");
    expect(jumpHostIdAtDepth({ jumpHostIds: ["first", "last"] }, 2)).toBe("first");
    expect(jumpHostIdAtDepth({ jumpHostIds: ["first", "last"] }, 0)).toBeNull();
    expect(jumpHostIdAtDepth({ jumpHostId: "legacy" }, 1)).toBe("legacy");
  });

  it("builds the prompt for the hop that needs credentials", () => {
    const retry = buildHopCredentialRetry({
      hosts: [bastion, target],
      vaultIndex: { myUsernameByHostId: { bastion: "ops" } } as never,
      hostId: "target",
      needed: { hostId: "bastion", reason: "missing" },
      source: "ssh",
      sessionId: "pending-1",
      carried: { secrets: { password: "app-pw" } },
    });
    expect(retry).toMatchObject({
      hostId: "target",
      promptHostId: "bastion",
      authType: "password",
      initialUsername: "ops",
      carried: { secrets: { password: "app-pw" } },
    });
    expect(retry?.message).toContain("Bastion");
    expect(retry?.message).toContain("Target");
    expect(retry?.requestId).toEqual(expect.any(String));

    // 대상 자신이면 묻는 호스트가 따로 없다.
    expect(
      buildHopCredentialRetry({
        hosts: [bastion, target],
        vaultIndex: null,
        hostId: "target",
        needed: { hostId: "target", reason: "missing" },
        source: "ssh",
      }),
    ).toMatchObject({ hostId: "target", promptHostId: undefined, initialUsername: "app" });
  });

  it("titles the dialog with the host it asks about", () => {
    const request = credentialRetryDialogRequest([bastion, target], {
      hostId: "target",
      promptHostId: "bastion",
      source: "ssh",
      authType: "password",
      message: "",
      initialUsername: "jump",
    });
    expect(request).toMatchObject({ hostLabel: "Bastion" });
    expect(
      credentialRetryDialogRequest([bastion, target], {
        hostId: "target",
        source: "ssh",
        authType: "password",
        message: "",
        initialUsername: "app",
      }),
    ).toMatchObject({ hostLabel: "Target" });
  });

  it("asks the jump host first, then the target, and sends both values together", async () => {
    const { api, store } = createChainStore();
    api.ssh.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "target", reason: "missing" } })
      .mockResolvedValueOnce({ sessionId: "session-1" });

    await store.getState().bootstrap();
    await store.getState().connectHost("target", 120, 32);

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "target",
      promptHostId: "bastion",
      source: "ssh",
      authType: "password",
      initialUsername: "jump",
    });

    await store.getState().submitCredentialRetry({ username: "jump", password: "jump-pw" });

    expect(api.ssh.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hostId: "target",
        jumpSecrets: { bastion: expect.objectContaining({ password: "jump-pw" }) },
      }),
    );
    // 다시 시도가 띄운 대상의 요청 창은 남는다.
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "target",
      initialUsername: "app",
    });
    expect(store.getState().pendingCredentialRetry?.promptHostId).toBeUndefined();

    await store.getState().submitCredentialRetry({ username: "app", password: "app-pw" });

    expect(api.ssh.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        secrets: expect.objectContaining({ password: "app-pw" }),
        jumpSecrets: { bastion: expect.objectContaining({ password: "jump-pw" }) },
      }),
    );
    expect(store.getState().pendingCredentialRetry).toBeNull();
  });

  // 점프 홉의 인증 거절은 코어가 깊이를 싣는다 — 대상 창이 아니라 그 홉을 묻고, 대상에 넣은 값은 함께 보낸다.
  it("asks the jump host that rejected the login, carrying what was typed for the target", async () => {
    const { api, store } = createChainStore();
    api.ssh.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "target", reason: "missing" } })
      .mockResolvedValueOnce({ sessionId: "session-1" })
      .mockResolvedValueOnce({ sessionId: "session-2" });

    await store.getState().bootstrap();
    await store.getState().connectHost("target", 120, 32);
    await store.getState().submitCredentialRetry({ username: "app", password: "app-pw" });

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: {
        message: "jump host: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain",
        jumpDepth: 1,
      },
    });

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "target",
      promptHostId: "bastion",
      initialUsername: "jump",
      carried: { secrets: expect.objectContaining({ password: "app-pw" }) },
    });

    await store.getState().submitCredentialRetry({ username: "jump", password: "jump-pw" });

    expect(api.ssh.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        secrets: expect.objectContaining({ password: "app-pw" }),
        jumpSecrets: { bastion: expect.objectContaining({ password: "jump-pw" }) },
      }),
    );
  });

  it("says which hop's input was cancelled", async () => {
    const { api, store } = createChainStore();
    api.ssh.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } });

    await store.getState().bootstrap();
    await store.getState().connectHost("target", 120, 32);
    const sessionId = store.getState().pendingCredentialRetry?.sessionId;
    store.getState().dismissPendingCredentialRetry();

    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().tabs.find((tab) => tab.sessionId === sessionId)?.errorMessage).toContain("Bastion");
  });

  it("asks the jump host for an SFTP pane and sends its value with the retry", async () => {
    const { api, store } = createChainStore();
    api.sftp.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({
        id: "endpoint-1",
        kind: "remote",
        hostId: "target",
        title: "Target",
        path: "/home/app",
        connectedAt: stamp,
      });

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "target");

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "target",
      promptHostId: "bastion",
      source: "sftp",
      paneId: "right",
    });
    // pane 은 오류로 물들이지 않는다.
    expect(store.getState().sftp.rightPane.errorMessage).toBeUndefined();

    await store.getState().submitCredentialRetry({ username: "jump", password: "jump-pw" });

    expect(api.sftp.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hostId: "target",
        jumpSecrets: { bastion: expect.objectContaining({ password: "jump-pw" }) },
      }),
    );
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe("endpoint-1");
  });
});
