import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialsNeededResult, HostRecord, RdpCredentialFailure } from "@shared";
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

// 다듬기 3단계(RDP) — RDP 서버가 NLA 로 비밀번호를 요구하는데 없거나 넣은 값을 거절하면, 실패 카드 대신 VNC 와 같은 요청 창으로
// 계정·비밀번호·도메인을 묻고 넣은 값으로 같은 탭을 다시 붙인다. 전에는 실패 카드뿐이라 호스트 편집(팀 호스트는 My credentials)으로
// 가야 했다. 호스트는 시험 도우미의 "Win Box"(rdp-host-1)다.

const HOST = "rdp-host-1";
const needs = (
  failure: RdpCredentialFailure,
  extra: { username?: string; domain?: string } = {},
): CredentialsNeededResult => ({
  credentialsNeeded: {
    hostId: HOST,
    reason: failure === "password-required" ? "missing" : "rejected",
    message: "core detail",
    failure,
    ...extra,
  },
});
const connected = {
  desktopWidth: 1920,
  desktopHeight: 1080,
  monitors: [{ index: 0, left: 0, top: 0, width: 1920, height: 1080 }],
  username: "CORP\\alice",
};

function createStore() {
  const api = createMockApi();
  return { api, store: createAppStore(api) };
}

const tabOf = (store: ReturnType<typeof createAppStore>) => store.getState().tabs.find((tab) => tab.hostId === HOST);

afterEach(() => {
  __resetReconnectOrchestratorForTest();
});

describe("RDP host's own credentials", () => {
  it("asks for the account, password and domain in the same prompt and keeps the tab waiting", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn().mockResolvedValue(needs("password-required", { username: "alice", domain: "CORP" }));
    await store.getState().bootstrap();

    await store.getState().connectHost(HOST, 120, 32);
    const pending = store.getState().pendingCredentialRetry;
    expect(pending).toMatchObject({
      source: "rdp",
      hostId: HOST,
      rdpFailure: "password-required",
      authType: "password",
      initialUsername: "alice",
      initialDomain: "CORP",
      sessionId: tabOf(store)?.sessionId,
    });
    expect(pending?.message).toBe(t("credentialRetry.rdpCredentialsNeeded", { label: "Win Box" }));
    // 실패가 아니라 기다리는 모양이다 — 화면은 실패 카드 대신 '연결 중' 카드를 요청 창 뒤에 둔다.
    const tab = tabOf(store);
    expect(tab?.status).not.toBe("error");
    expect(tab?.connectionProgress?.message).toBe(t("connectProgress.credentialRetry", { label: "Win Box" }));
  });

  it("reconnects the same tab with the account, password and domain that were typed", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("password-required"))
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);
    const stableId = tabOf(store)?.stableId;

    await store.getState().submitCredentialRetry({ username: " alice ", password: "typed", domain: " CORP " });

    expect(api.rdp.connect).toHaveBeenLastCalledWith(expect.any(String), HOST, undefined, {
      rdpSecrets: { username: "alice", password: "typed", domain: "CORP" },
    });
    expect(store.getState().pendingCredentialRetry).toBeNull();
    const tab = tabOf(store);
    expect(tab?.status).toBe("connected");
    expect(tab?.stableId).toBe(stableId);
    expect(tab?.rdpUsername).toBe("CORP\\alice");
    expect(store.getState().tabs.filter((item) => item.hostId === HOST)).toHaveLength(1);
    // 넣은 값은 붙은 뒤 호스트 비밀값으로 들어간다 — 목록을 다시 읽는다.
    expect(vi.mocked(api.hosts.list).mock.calls.length).toBeGreaterThan(1);
  });

  // 도메인을 비운 것은 '도메인 없이'다 — 메인이 저장된 도메인으로 메우면 안 된다.
  it("sends an emptied domain as it is", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("auth-rejected", { username: "alice", domain: "CORP" }))
      .mockResolvedValueOnce(connected);
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    await store.getState().submitCredentialRetry({ username: "alice", password: "typed" });

    expect(api.rdp.connect).toHaveBeenLastCalledWith(expect.any(String), HOST, undefined, {
      rdpSecrets: { username: "alice", password: "typed", domain: "" },
    });
  });

  it("words a rejection differently from a missing password", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn().mockResolvedValue(needs("auth-rejected"));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      rdpFailure: "auth-rejected",
      message: t("credentialRetry.rdpCredentialsRejected"),
    });
  });

  it("refuses an empty account or password and keeps asking", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn().mockResolvedValue(needs("password-required"));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    await expect(store.getState().submitCredentialRetry({ username: " ", password: "pw" })).rejects.toThrow(
      t("credentialRetry.usernameRequired"),
    );
    await expect(store.getState().submitCredentialRetry({ username: "alice", password: "" })).rejects.toThrow(
      t("credentialRetry.passwordRequired"),
    );
    expect(store.getState().pendingCredentialRetry?.rdpFailure).toBe("password-required");
    expect(api.rdp.connect).toHaveBeenCalledTimes(1);
  });

  it("asks again when the typed password is rejected", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("password-required"))
      .mockResolvedValueOnce(needs("auth-rejected", { username: "alice" }));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    await store.getState().submitCredentialRetry({ username: "alice", password: "wrong" });
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      rdpFailure: "auth-rejected",
      initialUsername: "alice",
      sessionId: tabOf(store)?.sessionId,
    });
    expect(tabOf(store)?.status).not.toBe("error");
  });

  it("marks the tab with the reason when the prompt is cancelled", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn().mockResolvedValue(needs("password-required"));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    store.getState().dismissPendingCredentialRetry();
    const tab = tabOf(store);
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe(t("sessionStore.authInputCancelled", { label: "Win Box" }));
    // 실패 카드의 Retry 가 남는다 — 다시 누르면 다시 묻는다.
    expect(tab?.connectionProgress?.retryable).not.toBe(false);
    expect(store.getState().pendingCredentialRetry).toBeNull();
  });

  it("closes the prompt before the retry connects", async () => {
    const { api, store } = createStore();
    let release!: (value: unknown) => void;
    api.rdp.connect = vi
      .fn()
      .mockResolvedValueOnce(needs("password-required"))
      .mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    const submitted = store.getState().submitCredentialRetry({ username: "alice", password: "typed" });
    await vi.waitFor(() => expect(api.rdp.connect).toHaveBeenCalledTimes(2));
    expect(store.getState().pendingCredentialRetry).toBeNull();
    release(connected);
    await submitted;
  });

  // 재연결 도중에 물으면 재연결을 멈춘다 — 두면 감시 시간이 지나 같은 탭을 다시 붙이며 세션을 바꿔, 요청 창이 가리킬 탭이 사라진다.
  it("stops an auto-reconnect that ends up asking", async () => {
    registerReconnectHandler("rdp", {
      renderScheduled: () => undefined,
      perform: async () => undefined,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });
    const { api, store } = createStore();
    let stableId = "";
    api.rdp.connect = vi.fn(async (sessionId: string) => {
      stableId = store.getState().tabs.find((tab) => tab.sessionId === sessionId)?.stableId ?? "";
      scheduleReconnect({ kind: "rdp", key: stableId });
      return needs("auth-rejected");
    });
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    expect(stableId).not.toBe("");
    expect(isReconnecting(stableId)).toBe(false);
    expect(store.getState().pendingCredentialRetry?.rdpFailure).toBe("auth-rejected");
  });

  // 잠김·만료처럼 다시 넣어도 풀리지 않는 것은 메인이 실패로 끝낸다 — 요청 창 없이 실패 카드로.
  it("leaves what typing cannot fix on the failure card", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi
      .fn()
      .mockRejectedValue(new Error("finalize connection: CredSSP: status is STATUS_ACCOUNT_LOCKED_OUT [0xc0000234]"));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    expect(store.getState().pendingCredentialRetry).toBeNull();
    expect(tabOf(store)?.status).toBe("error");
  });
});

describe("the request the dialog shows for an RDP host", () => {
  const winBox = {
    id: HOST,
    kind: "rdp",
    label: "Win Box",
    hostname: "10.0.0.20",
    port: 3389,
    secretRef: null,
    groupName: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  } as unknown as HostRecord;

  it("names the RDP host and carries the reason and the domain it used", () => {
    const request = credentialRetryDialogRequest([winBox], {
      hostId: HOST,
      source: "rdp",
      authType: "password",
      message: "m",
      initialUsername: "alice",
      initialDomain: "CORP",
      rdpFailure: "auth-rejected",
    });
    expect(request).toMatchObject({ hostLabel: "Win Box", rdpFailure: "auth-rejected", initialDomain: "CORP" });
  });

  // RDP 호스트에 SSH 의 값을 물을 수는 없다 — 까닭 코드 없이는 창을 띄우지 않는다.
  it("shows nothing for an RDP host without an RDP reason", () => {
    expect(
      credentialRetryDialogRequest([winBox], {
        hostId: HOST,
        source: "rdp",
        authType: "password",
        message: "m",
        initialUsername: "",
      }),
    ).toBeNull();
  });
});

// 3단계(RDP) 결함 ① — 코어는 붙는 중의 실패를 세션 이벤트로 이미 화면에 알린다. 메인이 그 접속 호출을 '알렸음'으로 끝내면 화면
// 흐름은 탭을 다시 그리지 않는다 — 오류로 다시 그리면 Retry 가 숨고 재연결 표시를 덮는다(실제 앱: 닫힌 포트의 실패 카드에 Close 만,
// 2026-11-02). VNC 의 3단계 결함 ①과 같다.
describe("an RDP failure the core already showed", () => {
  it("leaves the tab as the core's failure event drew it, Retry and all", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn(async (sessionId: string) => {
      store.getState().handleRdpEvent({ type: "error", sessionId, message: "connection refused", failure: "refused" });
      return { failureReported: true as const };
    });
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    const tab = tabOf(store);
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("connection refused");
    expect(tab?.errorFailure).toBe("refused");
    expect(tab?.connectionProgress?.retryable).not.toBe(false);
  });

  it("leaves a reconnect the failure scheduled on screen", async () => {
    const { api, store } = createStore();
    const scheduled = createConnectionProgress("reconnecting", "reconnecting soon");
    api.rdp.connect = vi.fn(async (sessionId: string) => {
      store.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId ? { ...tab, status: "connecting" as const, connectionProgress: scheduled } : tab,
        ),
      }));
      return { failureReported: true as const };
    });
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    const tab = tabOf(store);
    expect(tab?.status).toBe("connecting");
    expect(tab?.connectionProgress).toEqual(scheduled);
  });

  // 코어에 닿기 전의 실패(호스트 사라짐·통로 못 엶)는 화면이 아직 모른다 — 지금처럼 오류로 그린다.
  it("still shows a failure from before the core", async () => {
    const { api, store } = createStore();
    api.rdp.connect = vi.fn().mockRejectedValue(new Error("tailnet forward failed"));
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);

    const tab = tabOf(store);
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("tailnet forward failed");
  });
});

// 3단계(RDP) 계획 4 — 자동 재연결은 다시 붙으면 끝나야 한다. RDP 는 끝내는 곳이 없어 시도마다 거는 감시(30초)가 성공 뒤에 울렸고,
// 붙어 있는 세션을 끊고 다시 붙었다(실제 앱: Windows VM, 2026-11-02 — 시도 2, 3, 4 …). VNC 3단계 결함 ③과 같다.
describe("RDP auto-reconnect once it is back on", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the reconnect, so the watchdog does not cut the session again", async () => {
    const { api, store } = createStore();
    await store.getState().bootstrap();
    await store.getState().connectHost(HOST, 120, 32);
    const stableId = tabOf(store)!.stableId;
    const perform = vi.fn(async () => {
      await store.getState().retryRdpConnection(tabOf(store)!.sessionId);
    });
    registerReconnectHandler("rdp", {
      renderScheduled: () => undefined,
      perform,
      renderGaveUp: () => undefined,
      isStillPresent: () => true,
    });

    vi.useFakeTimers();
    // 연결이 끊겼다(서버 재부팅·통로 끊김).
    scheduleReconnect({ kind: "rdp", key: stableId });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(tabOf(store)?.status).toBe("connected");
    expect(isReconnecting(stableId)).toBe(false);

    // 감시 시간(30초)이 지나도 다시 붙이지 않는다.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(api.rdp.connect).toHaveBeenCalledTimes(2);
    expect(tabOf(store)?.status).toBe("connected");
  });
});
