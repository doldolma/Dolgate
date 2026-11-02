import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialsNeededResult, HostRecord, VncCredentialFailure } from "@shared";
import { t } from "../i18n";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { credentialRetryDialogRequest } from "../shells/appShellUtils";
import { createConnectionProgress } from "./utils";
import {
  __resetReconnectOrchestratorForTest,
  isReconnecting,
  registerReconnectHandler,
  scheduleReconnect,
} from "./services/reconnect-orchestrator";

// 다듬기 3단계 — VNC 서버가 비밀번호(계정)를 요구하거나 거절하면 실패 화면 대신 SSH 와 같은 요청 창으로 묻고, 넣은 값으로 같은
// 탭을 다시 붙인다. 전에는 "자격증명에 비밀번호를 입력하세요" 실패 화면뿐이라 호스트 편집으로 가야 했다.

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
/** 바로 붙는 VNC 호스트. */
const direct = {
  id: "vnc-direct",
  kind: "vnc",
  label: "Desk",
  hostname: "10.0.0.9",
  port: 5900,
  secretRef: null,
  groupName: null,
  createdAt: stamp,
  updatedAt: stamp,
} as unknown as HostRecord;
/** SSH 터널로 가는 VNC 호스트. */
const tunnelled = {
  ...direct,
  id: "vnc-tunnel",
  label: "Console",
  sshTunnelHostId: "bastion",
} as unknown as HostRecord;

const needs = (
  hostId: string,
  failure: VncCredentialFailure,
  extra: { username?: string } = {},
): CredentialsNeededResult => ({
  credentialsNeeded: {
    hostId,
    reason: failure === "password-required" || failure === "account-required" ? "missing" : "rejected",
    message: "core detail",
    failure,
    ...extra,
  },
});
const connected = { desktopWidth: 1280, desktopHeight: 800 };

function createStore() {
  const api = createMockApi();
  api.hosts.list = vi.fn().mockResolvedValue([bastion, direct, tunnelled]);
  return { api, store: createAppStore(api) };
}

const tabOf = (store: ReturnType<typeof createAppStore>, hostId: string) =>
  store.getState().tabs.find((tab) => tab.hostId === hostId);

afterEach(() => {
  __resetReconnectOrchestratorForTest();
});

describe("VNC host's own credentials", () => {
  it("asks for the VNC password in the same prompt and keeps the tab waiting", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue(needs("vnc-direct", "password-required"));
    await store.getState().bootstrap();

    await store.getState().connectHost("vnc-direct", 120, 32);
    const pending = store.getState().pendingCredentialRetry;
    expect(pending).toMatchObject({
      source: "vnc",
      hostId: "vnc-direct",
      vncFailure: "password-required",
      authType: "password",
      initialUsername: "",
      sessionId: tabOf(store, "vnc-direct")?.sessionId,
    });
    expect(pending?.message).toBe(t("credentialRetry.vncPasswordNeeded", { label: "Desk" }));
    // 앞선 시도의 값은 싣지 않는다 — 터널 값은 터널이 열릴 때 이미 저장됐다.
    expect(pending?.carried).toBeUndefined();
    // 실패가 아니라 기다리는 모양이다 — 화면은 실패 카드 대신 '연결 중' 카드를 요청 창 뒤에 둔다.
    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).not.toBe("error");
    expect(tab?.connectionProgress?.message).toBe(t("connectProgress.credentialRetry", { label: "Desk" }));
  });

  it("reconnects the same tab with the typed password in the VNC slot, without an account", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-direct", "password-required"))
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);
    const stableId = tabOf(store, "vnc-direct")?.stableId;

    await store.getState().submitCredentialRetry({ username: "ignored", password: "typed" });

    expect(api.vnc.connect).toHaveBeenLastCalledWith(expect.any(String), "vnc-direct", { vncSecrets: { password: "typed" } });
    expect(store.getState().pendingCredentialRetry).toBeNull();
    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).toBe("connected");
    expect(tab?.stableId).toBe(stableId);
    expect(store.getState().tabs.filter((item) => item.hostId === "vnc-direct")).toHaveLength(1);
  });

  it("words each reason the server gave", async () => {
    const cases: Array<[VncCredentialFailure, string]> = [
      ["auth-rejected", t("credentialRetry.vncPasswordRejected")],
      ["password-truncated", t("credentialRetry.vncPasswordTruncated")],
      ["account-required", t("credentialRetry.vncAccountNeeded", { label: "Desk" })],
      ["account-auth-rejected", t("credentialRetry.vncAccountRejected")],
    ];
    for (const [failure, message] of cases) {
      const { api, store } = createStore();
      api.vnc.connect = vi.fn().mockResolvedValue(needs("vnc-direct", failure));
      await store.getState().bootstrap();
      await store.getState().connectHost("vnc-direct", 120, 32);
      expect(store.getState().pendingCredentialRetry).toMatchObject({ vncFailure: failure, message });
    }
  });

  it("asks for the account too on a server that logs in with one, filled with the account it used", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-direct", "account-auth-rejected", { username: "alice" }))
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);
    expect(store.getState().pendingCredentialRetry?.initialUsername).toBe("alice");

    await store.getState().submitCredentialRetry({ username: "  bob ", password: "typed" });
    expect(api.vnc.connect).toHaveBeenLastCalledWith(expect.any(String), "vnc-direct", {
      vncSecrets: { username: "bob", password: "typed" },
    });
  });

  // 계정이 거절된 서버에서 계정을 비우면 VNC 암호로 붙는다 — 빈 계정도 그대로 실어 보낸다.
  it("sends an emptied account as it is", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-direct", "account-auth-rejected", { username: "alice" }))
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    await store.getState().submitCredentialRetry({ username: "", password: "typed" });
    expect(api.vnc.connect).toHaveBeenLastCalledWith(expect.any(String), "vnc-direct", {
      vncSecrets: { username: "", password: "typed" },
    });
  });

  it("refuses an empty password and keeps asking", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue(needs("vnc-direct", "password-required"));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    await expect(store.getState().submitCredentialRetry({ username: "", password: "" })).rejects.toThrow(
      t("credentialRetry.passwordRequired"),
    );
    expect(store.getState().pendingCredentialRetry?.vncFailure).toBe("password-required");
    expect(api.vnc.connect).toHaveBeenCalledTimes(1);
  });

  it("asks again when the typed password is rejected", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-direct", "password-required"))
      .mockResolvedValueOnce(needs("vnc-direct", "auth-rejected"));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    await store.getState().submitCredentialRetry({ username: "", password: "wrong" });
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      vncFailure: "auth-rejected",
      message: t("credentialRetry.vncPasswordRejected"),
      sessionId: tabOf(store, "vnc-direct")?.sessionId,
    });
    expect(tabOf(store, "vnc-direct")?.status).not.toBe("error");
  });

  it("marks the tab with the reason when the prompt is cancelled", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue(needs("vnc-direct", "password-required"));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    store.getState().dismissPendingCredentialRetry();
    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe(t("sessionStore.authInputCancelled", { label: "Desk" }));
    expect(store.getState().pendingCredentialRetry).toBeNull();
  });

  it("closes the prompt before the retry connects", async () => {
    const { api, store } = createStore();
    let release!: (value: unknown) => void;
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-direct", "password-required"))
      .mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    const submitted = store.getState().submitCredentialRetry({ username: "", password: "typed" });
    await vi.waitFor(() => expect(api.vnc.connect).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    release(connected);
    await submitted;
  });

  // VNC 값을 넣은 다음 시도에서 터널 호스트를 다시 물으면(그 사이 터널 비밀번호가 바뀜) 넣은 VNC 값을 잃지 않는다.
  it("keeps the typed VNC password when the tunnel host asks next", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("vnc-tunnel", "password-required"))
      .mockResolvedValueOnce({ credentialsNeeded: { hostId: "bastion", reason: "rejected", message: "denied" } })
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-tunnel", 120, 32);
    await store.getState().submitCredentialRetry({ username: "", password: "vnc-typed" });
    expect(store.getState().pendingCredentialRetry).toMatchObject({ hostId: "bastion", source: "vnc" });
    expect(store.getState().pendingCredentialRetry?.vncFailure).toBeUndefined();

    await store.getState().submitCredentialRetry({ username: "jump", password: "jump-pw" });
    expect(api.vnc.connect).toHaveBeenLastCalledWith(
      expect.any(String),
      "vnc-tunnel",
      expect.objectContaining({
        secrets: expect.objectContaining({ password: "jump-pw" }),
        vncSecrets: { password: "vnc-typed" },
      }),
    );
    expect(tabOf(store, "vnc-tunnel")?.status).toBe("connected");
  });

  // 재연결 도중에 물으면 재연결을 멈춘다 — 두면 감시 시간이 지나 같은 탭을 다시 붙이며 세션을 바꿔, 요청 창이 가리킬 탭이 사라진다.
  it("stops an auto-reconnect that ends up asking", async () => {
    registerReconnectHandler("vnc", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
    const { api, store } = createStore();
    let stableId = "";
    api.vnc.connect = vi.fn(async (sessionId: string) => {
      stableId = store.getState().tabs.find((tab) => tab.sessionId === sessionId)?.stableId ?? "";
      scheduleReconnect({ kind: "vnc", key: stableId });
      return needs("vnc-direct", "auth-rejected");
    });
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    expect(stableId).not.toBe("");
    expect(isReconnecting(stableId)).toBe(false);
    expect(store.getState().pendingCredentialRetry?.vncFailure).toBe("auth-rejected");
  });

  // 같은 갈래의 터널 요청도 같은 까닭으로 재연결을 멈춘다(2단계에서 생긴 길).
  it("stops an auto-reconnect that ends up asking the tunnel host", async () => {
    registerReconnectHandler("vnc", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
    const { api, store } = createStore();
    let stableId = "";
    api.vnc.connect = vi.fn(async (sessionId: string) => {
      stableId = store.getState().tabs.find((tab) => tab.sessionId === sessionId)?.stableId ?? "";
      scheduleReconnect({ kind: "vnc", key: stableId });
      return { credentialsNeeded: { hostId: "bastion", reason: "missing" as const } };
    });
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-tunnel", 120, 32);

    expect(isReconnecting(stableId)).toBe(false);
    expect(store.getState().pendingCredentialRetry?.hostId).toBe("bastion");
  });
});

describe("the request the dialog shows for a VNC host", () => {
  it("names the VNC host and carries the reason", () => {
    const request = credentialRetryDialogRequest([direct], {
      hostId: "vnc-direct",
      source: "vnc",
      authType: "password",
      message: "m",
      initialUsername: "",
      vncFailure: "password-required",
    });
    expect(request).toMatchObject({ hostLabel: "Desk", vncFailure: "password-required" });
  });

  // VNC 호스트에 SSH 의 값을 물을 수는 없다 — 까닭 코드 없이는 창을 띄우지 않는다.
  it("shows nothing for a VNC host without a VNC reason", () => {
    expect(
      credentialRetryDialogRequest([direct], {
        hostId: "vnc-direct",
        source: "vnc",
        authType: "password",
        message: "m",
        initialUsername: "",
      }),
    ).toBeNull();
  });
});

// 3단계 결함 ① — 코어는 붙는 중의 실패를 세션 이벤트로 이미 화면에 알린다. 메인이 그 접속 호출을 '알렸음'으로 끝내면 화면 흐름은
// 탭을 다시 그리지 않는다 — 오류로 다시 그리면 Retry 가 숨고 재연결 표시를 덮는다.
describe("a VNC failure the core already showed", () => {
  it("leaves the tab as the core's failure event drew it, Retry and all", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn(async (sessionId: string) => {
      store.getState().handleVncEvent({ type: "error", sessionId, message: "connection refused", failure: "refused" });
      return { failureReported: true as const };
    });
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("connection refused");
    expect(tab?.errorFailure).toBe("refused");
    expect(tab?.connectionProgress?.retryable).not.toBe(false);
  });

  it("leaves a reconnect the failure scheduled on screen", async () => {
    const { api, store } = createStore();
    const scheduled = createConnectionProgress("reconnecting", "reconnecting soon");
    api.vnc.connect = vi.fn(async (sessionId: string) => {
      store.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId ? { ...tab, status: "connecting" as const, connectionProgress: scheduled } : tab,
        ),
      }));
      return { failureReported: true as const };
    });
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).toBe("connecting");
    expect(tab?.connectionProgress).toEqual(scheduled);
  });

  // 코어에 닿기 전의 실패(터널·호스트 사라짐)는 화면이 아직 모른다 — 지금처럼 오류로 그린다.
  it("still shows a failure from before the core", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockRejectedValue(new Error("tunnel host not found"));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    const tab = tabOf(store, "vnc-direct");
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("tunnel host not found");
  });
});

// 3단계 결함 ③ — 자동 재연결은 다시 붙으면 끝나야 한다. VNC 는 끝내는 곳이 없어 시도마다 거는 감시(30초)가 성공 뒤에 울렸고,
// 붙어 있는 세션을 끊고 다시 붙었다(실제 앱, 2026-10-30 — 시도 8, 9 …).
describe("VNC auto-reconnect once it is back on", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the reconnect, so the watchdog does not cut the session again", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);
    const stableId = tabOf(store, "vnc-direct")!.stableId;
    const perform = vi.fn(async () => {
      await store.getState().retryVncConnection(tabOf(store, "vnc-direct")!.sessionId);
    });
    registerReconnectHandler("vnc", {
      renderScheduled: () => undefined,
      perform,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });

    vi.useFakeTimers();
    // 서버가 다시 켜져 세션이 끊겼다.
    scheduleReconnect({ kind: "vnc", key: stableId });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(tabOf(store, "vnc-direct")?.status).toBe("connected");
    expect(isReconnecting(stableId)).toBe(false);

    // 감시 시간(30초)이 지나도 다시 붙이지 않는다.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(api.vnc.connect).toHaveBeenCalledTimes(2);
    expect(tabOf(store, "vnc-direct")?.status).toBe("connected");
  });
});

// 요청 창 뒤 카드 문구 — 메인의 진행 알림과 접속 응답은 도착 순서가 정해져 있지 않다. 요청 창을 띄운 뒤에 온 '세션을 협상합니다'가
// 답을 기다리는 문구를 덮었다(실제 앱, 터널로 가는 VNC).
describe("progress that arrives after the prompt", () => {
  it("keeps the waiting words behind the prompt", async () => {
    const { api, store } = createStore();
    api.vnc.connect = vi.fn().mockResolvedValue(needs("vnc-direct", "password-required"));
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);

    const sessionId = tabOf(store, "vnc-direct")!.sessionId;
    store.getState().handleVncEvent({ type: "progress", sessionId, stage: "connecting", message: "negotiating" });
    expect(tabOf(store, "vnc-direct")?.connectionProgress?.message).toBe(
      t("connectProgress.credentialRetry", { label: "Desk" }),
    );
  });

  it("still shows progress on another tab that is connecting", async () => {
    const other = { ...direct, id: "vnc-other", label: "Other" } as unknown as HostRecord;
    const { api, store } = createStore();
    api.hosts.list = vi.fn().mockResolvedValue([bastion, direct, tunnelled, other]);
    api.vnc.connect = vi.fn((_sessionId: string, hostId: string) =>
      hostId === "vnc-direct" ? Promise.resolve(needs("vnc-direct", "password-required")) : new Promise<never>(() => {}),
    );
    await store.getState().bootstrap();
    await store.getState().connectHost("vnc-direct", 120, 32);
    void store.getState().connectHost("vnc-other", 120, 32);
    await vi.waitFor(() => expect(api.vnc.connect).toHaveBeenCalledTimes(2));

    const sessionId = tabOf(store, "vnc-other")!.sessionId;
    store.getState().handleVncEvent({ type: "progress", sessionId, stage: "connecting", message: "negotiating" });
    expect(tabOf(store, "vnc-other")?.connectionProgress?.message).toBe("negotiating");
  });
});

