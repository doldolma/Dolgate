import { describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import { t } from "../i18n";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { buildHopCredentialRetry } from "./utils";

// 다듬기 2단계 — 포트 포워딩·컨테이너·컨테이너 셸·VNC 터널도 SSH 터미널처럼 비밀번호가 빠진 홉을 요청 창으로 묻고,
// 제출하면 그 일을 넣은 값으로 다시 한다. 전에는 코어의 영어 원문("password auth requires a password")으로 끝났다.

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
const vncHost = {
  id: "vnc-1",
  kind: "vnc",
  label: "Console",
  hostname: "10.0.0.5",
  port: 5900,
  sshTunnelHostId: "bastion",
  secretRef: null,
  groupName: null,
  createdAt: stamp,
  updatedAt: stamp,
} as unknown as HostRecord;
const rule = {
  id: "pf-1",
  label: "web",
  hostId: "target",
  transport: "ssh",
  mode: "local",
  bindAddress: "127.0.0.1",
  bindPort: 18411,
  targetHost: "127.0.0.1",
  targetPort: 22,
  createdAt: stamp,
  updatedAt: stamp,
};
/** 요청 창에 넣는 베스천의 값 — 사용자 이름은 그대로다. */
const typed = { username: "jump", password: "jump-pw" };
const typedJump = { jumpSecrets: { bastion: expect.objectContaining({ password: "jump-pw" }) } };

/** 이제부터 호스트·키체인 목록을 다시 읽은 수 — 붙은 뒤 넣은 사용자 이름이 개인 호스트 레코드에 들어가 다시 읽는다. */
function rereads(api: ReturnType<typeof createMockApi>) {
  const before = vi.mocked(api.keychain.list).mock.calls.length;
  return () => vi.mocked(api.keychain.list).mock.calls.length - before;
}

function createStore() {
  const api = createMockApi();
  api.hosts.list = vi.fn().mockResolvedValue([bastion, target, vncHost]);
  return { api, store: createAppStore(api) };
}

describe("tunnel credentials", () => {
  it("words the SSH tunnel host's prompt so it is not read as the VNC password", () => {
    const retry = buildHopCredentialRetry({
      hosts: [bastion, target, vncHost],
      vaultIndex: null,
      hostId: "bastion",
      needed: { hostId: "bastion", reason: "missing" },
      source: "vnc",
      sessionId: "pending-1",
      tunnelFor: "Console",
    });
    expect(retry).toMatchObject({ hostId: "bastion", promptHostId: undefined, source: "vnc", sessionId: "pending-1" });
    expect(retry?.message).toBe(t("credentialRetry.tunnelPasswordNeeded", { label: "Bastion", target: "Console" }));

    // 터널 호스트의 점프 홉이면 점프 문구로, 가는 곳은 VNC 호스트다.
    const hop = buildHopCredentialRetry({
      hosts: [bastion, target, vncHost],
      vaultIndex: null,
      hostId: "target",
      needed: { hostId: "bastion", reason: "missing" },
      source: "vnc",
      tunnelFor: "Console",
    });
    expect(hop?.message).toBe(t("credentialRetry.jumpPasswordNeeded", { label: "Bastion", target: "Console" }));
  });

  it("asks the port forward's jump host and starts the rule with the typed value", async () => {
    const { api, store } = createStore();
    api.portForwards.start = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({
        ruleId: "pf-1",
        hostId: "target",
        transport: "ssh",
        mode: "local",
        bindAddress: "127.0.0.1",
        bindPort: 18411,
        status: "running",
        updatedAt: stamp,
      });
    await store.getState().bootstrap();
    store.setState({ portForwards: [rule as never] });

    await store.getState().startPortForward("pf-1");
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      source: "portForward",
      ruleId: "pf-1",
      hostId: "target",
      promptHostId: "bastion",
      authType: "password",
    });
    // 묻는 동안은 실패로 물들이지 않는다 — 누른 즉시 바꾼 '시작 중'만 거둔다.
    expect(store.getState().portForwardRuntimes.find((runtime) => runtime.ruleId === "pf-1")).toMatchObject({
      status: "stopped",
      message: undefined,
    });

    const reads = rereads(api);
    await store.getState().submitCredentialRetry(typed);
    expect(api.portForwards.start).toHaveBeenLastCalledWith("pf-1", expect.objectContaining(typedJump));
    expect(reads()).toBeGreaterThan(0);
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().portForwardRuntimes.find((runtime) => runtime.ruleId === "pf-1")?.status).toBe("running");
  });

  it("asks the container host's jump host, keeps the tab waiting, and lists again with the typed value", async () => {
    const { api, store } = createStore();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({ runtime: "docker", unsupportedReason: null, containers: [] });
    await store.getState().bootstrap();

    await store.getState().refreshHostContainers("target");
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      source: "containers",
      hostId: "target",
      promptHostId: "bastion",
    });
    expect(store.getState().containerTabs.find((tab) => tab.hostId === "target")).toMatchObject({
      isLoading: false,
      errorMessage: undefined,
    });

    const reads = rereads(api);
    await store.getState().submitCredentialRetry(typed);
    expect(api.containers.list).toHaveBeenLastCalledWith("target", expect.objectContaining(typedJump));
    expect(reads()).toBeGreaterThan(0);
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().containerTabs.find((tab) => tab.hostId === "target")?.runtime).toBe("docker");
  });

  it("says why the container tab is empty when the prompt is cancelled", async () => {
    const { api, store } = createStore();
    api.containers.list = vi.fn().mockResolvedValue({ credentialsNeeded: { hostId: "bastion", reason: "missing" } });
    await store.getState().bootstrap();

    await store.getState().refreshHostContainers("target");
    store.getState().dismissPendingCredentialRetry();
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().containerTabs.find((tab) => tab.hostId === "target")?.errorMessage).toBe(
      t("sessionStore.authInputCancelled", { label: "Bastion" }),
    );
  });

  it("asks before a container shell and reconnects the same tab with the typed value", async () => {
    const { api, store } = createStore();
    api.containers.openShell = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({ sessionId: "session-shell-1" });
    await store.getState().bootstrap();

    await store.getState().openHostContainerShell("target", "container-1");
    const pending = store.getState().pendingCredentialRetry;
    expect(pending).toMatchObject({
      source: "containerShell",
      hostId: "target",
      promptHostId: "bastion",
      containerId: "container-1",
      sessionId: expect.any(String),
    });
    expect(store.getState().tabs.find((tab) => tab.sessionId === pending?.sessionId)?.status).not.toBe("error");

    const reads = rereads(api);
    await store.getState().submitCredentialRetry(typed);
    expect(api.containers.openShell).toHaveBeenLastCalledWith("target", "container-1", expect.objectContaining(typedJump));
    expect(reads()).toBeGreaterThan(0);
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().tabs.some((tab) => tab.sessionId === "session-shell-1")).toBe(true);
  });

  it("asks the VNC host's SSH tunnel host in its own words and reconnects with the typed value", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockResolvedValueOnce({ desktopWidth: 1280, desktopHeight: 800 });
    await store.getState().bootstrap();

    await store.getState().connectHost("vnc-1", 120, 32);
    const pending = store.getState().pendingCredentialRetry;
    expect(pending).toMatchObject({ source: "vnc", hostId: "bastion", promptHostId: undefined, sessionId: expect.any(String) });
    expect(pending?.message).toBe(t("credentialRetry.tunnelPasswordNeeded", { label: "Bastion", target: "Console" }));
    expect(store.getState().tabs.find((tab) => tab.hostId === "vnc-1")?.status).not.toBe("error");

    const reads = rereads(api);
    await store.getState().submitCredentialRetry(typed);
    expect(reads()).toBeGreaterThan(0);
    // 터널 호스트가 이 SSH 접속의 대상이다 — 넣은 값은 대상 자리로 간다.
    expect(api.vnc.connect).toHaveBeenLastCalledWith(
      expect.any(String),
      "vnc-1",
      expect.objectContaining({ secrets: expect.objectContaining({ password: "jump-pw" }) }),
    );
    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(store.getState().tabs.find((tab) => tab.hostId === "vnc-1")?.status).toBe("connected");
  });

  it("marks the VNC tab with the reason when the prompt is cancelled", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue({ credentialsNeeded: { hostId: "bastion", reason: "missing" } });
    await store.getState().bootstrap();

    await store.getState().connectHost("vnc-1", 120, 32);
    store.getState().dismissPendingCredentialRetry();
    const tab = store.getState().tabs.find((item) => item.hostId === "vnc-1");
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe(t("sessionStore.authInputCancelled", { label: "Bastion" }));
  });
});

// 결함 ①(실제 앱, 2026-10-30) — 이 길들은 붙는 도중에 호스트 키를 묻는다(처음 쓰는 호스트). 요청 창이 열린 채면 그 물음을
// 가려 누를 수 없었고, 연결은 답을 기다리며 멈췄다. 제출하면 요청 창부터 닫는다 — 붙는 일이 끝나기 전에.
describe("closes the prompt before the retry connects", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("for a port forward", async () => {
    const { api, store } = createStore();
    const held = deferred<unknown>();
    api.portForwards.start = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockReturnValueOnce(held.promise);
    await store.getState().bootstrap();
    store.setState({ portForwards: [rule as never] });
    await store.getState().startPortForward("pf-1");

    const submitted = store.getState().submitCredentialRetry(typed);
    await vi.waitFor(() => expect(api.portForwards.start).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    held.resolve({ ruleId: "pf-1", hostId: "target", transport: "ssh", mode: "local", bindAddress: "127.0.0.1", bindPort: 18411, status: "running", updatedAt: stamp });
    await submitted;
  });

  it("for a container list", async () => {
    const { api, store } = createStore();
    const held = deferred<unknown>();
    api.containers.list = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockReturnValueOnce(held.promise);
    await store.getState().bootstrap();
    await store.getState().refreshHostContainers("target");

    const submitted = store.getState().submitCredentialRetry(typed);
    await vi.waitFor(() => expect(api.containers.list).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    held.resolve({ runtime: "docker", unsupportedReason: null, containers: [] });
    await submitted;
  });

  it("for a container shell", async () => {
    const { api, store } = createStore();
    const held = deferred<unknown>();
    api.containers.openShell = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockReturnValueOnce(held.promise);
    await store.getState().bootstrap();
    await store.getState().openHostContainerShell("target", "container-1");

    const submitted = store.getState().submitCredentialRetry(typed);
    await vi.waitFor(() => expect(api.containers.openShell).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    held.resolve({ sessionId: "session-shell-1" });
    await submitted;
  });

  it("for a VNC tunnel", async () => {
    const { api, store } = createStore();
    const held = deferred<unknown>();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockReturnValueOnce(held.promise);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-1", 120, 32);

    const submitted = store.getState().submitCredentialRetry(typed);
    await vi.waitFor(() => expect(api.vnc.connect).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    held.resolve({ desktopWidth: 1280, desktopHeight: 800 });
    await submitted;
  });

  // SFTP 는 2단계 전부터 같은 모양이었다(처음 쓰는 호스트로 열면 막혔다).
  it("for SFTP", async () => {
    const { api, store } = createStore();
    const held = deferred<unknown>();
    api.sftp.connect = vi
      .fn()
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "missing" } })
      .mockReturnValueOnce(held.promise);
    await store.getState().bootstrap();
    await store.getState().connectSftpHost("right", "target");
    expect(store.getState().pendingCredentialRetry).toMatchObject({ source: "sftp", promptHostId: "bastion" });

    const submitted = store.getState().submitCredentialRetry(typed);
    await vi.waitFor(() => expect(api.sftp.connect).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    held.resolve({ id: "endpoint-1", kind: "remote", hostId: "target", title: "Target", path: "/home/app", connectedAt: stamp });
    await submitted;
  });
});
