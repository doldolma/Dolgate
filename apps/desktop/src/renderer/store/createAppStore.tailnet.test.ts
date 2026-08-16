import { describe, expect, it, vi } from "vitest";
import { createAppStore } from "./createAppStore";
import { createMockApi, flushMicrotasks } from "./createAppStore.test-support";

/**
 * tailnet 을 경유하는 호스트는 연결 전에 노드를 올려야 하고, 그동안 무엇을 기다리는지 연결
 * 오버레이에 보여야 한다.
 *
 * 이 테스트가 있는 이유: 이 배선은 typecheck 로도 단위 테스트로도 잡히지 않는다. 실제로 한 번
 * 놓쳐서, 앱에서는 "호스트 키를 확인하는 중" 만 뜨고 tailnet 단계가 화면에 전혀 나타나지
 * 않았다. 스토어까지 돌려 보면 앱을 띄우지 않고도 그것을 잡을 수 있다.
 */
describe("tailnet readiness before connecting", () => {
  function createTailnetApi() {
    const api = createMockApi();
    vi.mocked(api.hosts.list).mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "아산",
        hostname: "agt-1",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        secretRef: "host:host-1",
        groupName: null,
        terminalThemeId: null,
        tailnetId: "net-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    vi.mocked(api.tailnet.list).mockResolvedValue([
      { id: "net-1", label: "회사망", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    return api;
  }

  it("shows the tailnet stage on the connecting tab", async () => {
    const api = createTailnetApi();
    // 노드가 올라오는 동안 붙들어 둔다 — 그 사이의 오버레이 상태를 확인하기 위해서다.
    let resolveTest: ((value: unknown) => void) | undefined;
    vi.mocked(api.tailnet.test).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve as (value: unknown) => void;
        }) as never,
    );

    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    const tab = store.getState().tabs.find((item) => item.hostId === "host-1");
    expect(tab, "연결 탭이 만들어져야 한다").toBeDefined();
    expect(tab?.connectionProgress?.stage).toBe("tailnet-connecting");
    expect(tab?.connectionProgress?.message).toContain("회사망");

    resolveTest?.({ id: "net-1", state: "running" });
  });

  // tailnet 이 **점프 호스트에만** 걸린 구성도 노드를 올려야 한다.
  //
  // 접속은 첫 홉의 tailnet 으로 나가는데(resolveTailnetRoute), 관문 판정만 대상의 tailnetId 를
  // 보던 시절에는 이 구성이 관문을 통째로 건너뛰었다. 노드가 내려가 있으면 dial 예산(10초) 안에
  // 기동까지 끝내야 했고, 못 넘기면 `jump host: context deadline exceeded` 로 죽었다 — 인증까지
  // 가지 못하니 OTP 도 묻지 않고 재연결만 반복했다.
  it("점프 호스트에만 tailnet 이 걸려 있어도 노드를 올린다", async () => {
    const api = createMockApi();
    vi.mocked(api.hosts.list).mockResolvedValue([
      {
        id: "jump-1",
        kind: "ssh",
        label: "베스천",
        hostname: "bastion",
        port: 22,
        username: "ubuntu",
        authType: "password",
        secretRef: "host:jump-1",
        groupName: null,
        terminalThemeId: null,
        tailnetId: "net-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "host-1",
        kind: "ssh",
        label: "사내 LAN 호스트",
        hostname: "10.0.0.9",
        port: 22,
        username: "ubuntu",
        authType: "password",
        secretRef: "host:host-1",
        groupName: null,
        terminalThemeId: null,
        // 대상에는 tailnet 이 없다 — 그 망에서 보이는 주소일 뿐이다.
        tailnetId: null,
        jumpHostIds: ["jump-1"],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ] as never);
    vi.mocked(api.tailnet.list).mockResolvedValue([
      { id: "net-1", label: "회사망", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
    ] as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    // 첫 홉의 tailnet 을 올리려 했어야 한다.
    expect(vi.mocked(api.tailnet.list)).toHaveBeenCalled();
    const tab = store.getState().tabs.find((item) => item.hostId === "host-1");
    expect(tab?.connectionProgress?.stage).toBe("tailnet-connecting");
  });

  it("leaves hosts without a tailnet untouched", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    // tailnet 을 안 쓰는 호스트는 준비 단계를 거치지 않는다 — 연결이 그만큼 늦어지면 안 된다.
    expect(vi.mocked(api.tailnet.test)).not.toHaveBeenCalled();
    expect(vi.mocked(api.tailnet.list)).not.toHaveBeenCalled();
  });

  // 노드가 올라오는 동안 무엇을 기다리는지 보여야 한다. 이게 없으면 사용자는 "연결하는 중" 에서
  // 몇 분간 아무 설명 없이 기다리고, 브라우저 로그인이 필요한 것도 알 수 없다.
  it("reports what the tailnet is waiting for", async () => {
    const api = createTailnetApi();

    let emitStatus: ((status: { id: string; state: string; authUrl?: string }) => void) | undefined;
    vi.mocked(api.tailnet.onStatus).mockImplementation((listener) => {
      emitStatus = listener as never;
      return () => undefined;
    });
    vi.mocked(api.tailnet.test).mockImplementation(() => new Promise(() => undefined) as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    const messageNow = () =>
      store.getState().tabs.find((item) => item.hostId === "host-1")?.connectionProgress?.message;
    const blockingNow = () =>
      store.getState().tabs.find((item) => item.hostId === "host-1")?.connectionProgress
        ?.blockingKind;

    // 링크가 아직 없으면 "받는 중" — 누를 것이 없는데 누르라고 하면 안 된다.
    emitStatus?.({ id: "net-1", state: "needsAuth" });
    await flushMicrotasks();
    expect(messageNow()).toContain("인증 링크");
    expect(blockingNow()).toBe("none");

    // 링크가 오면 사람이 브라우저에서 할 일이 있다는 표시로 바꾼다.
    emitStatus?.({ id: "net-1", state: "needsAuth", authUrl: "https://login.example.com/a/x" });
    await flushMicrotasks();
    expect(messageNow()).toContain("브라우저");
    expect(blockingNow()).toBe("browser");

    // 관리자 승인을 기다리는 경우는 사용자가 할 일이 없다 — 다르게 말해야 한다.
    emitStatus?.({ id: "net-1", state: "needsApproval" });
    await flushMicrotasks();
    expect(messageNow()).toContain("관리자 승인");
  });

  // 인증 URL 은 한 번 쓰이면 상태에서 비워진다. 그때 링크를 기다리는 문구로 되돌아가면 순서가
  // 거꾸로 보인다 — 브라우저가 이미 열렸고 로그인까지 끝난 뒤에 "링크를 받는 중" 이 뜬다.
  it("does not fall back to the link-waiting message after the url was used", async () => {
    const api = createTailnetApi();
    let emitStatus: ((status: { id: string; state: string; authUrl?: string }) => void) | undefined;
    vi.mocked(api.tailnet.onStatus).mockImplementation((listener) => {
      emitStatus = listener as never;
      return () => undefined;
    });
    vi.mocked(api.tailnet.test).mockImplementation(() => new Promise(() => undefined) as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    const messageNow = () =>
      store.getState().tabs.find((item) => item.hostId === "host-1")?.connectionProgress?.message;

    emitStatus?.({ id: "net-1", state: "needsAuth", authUrl: "https://login.example.com/a/x" });
    await flushMicrotasks();
    expect(messageNow()).toContain("브라우저");

    // 로그인 직후 — URL 이 비워진 needsAuth 가 온다.
    emitStatus?.({ id: "net-1", state: "needsAuth" });
    await flushMicrotasks();
    expect(messageNow()).not.toContain("인증 링크");
    expect(messageNow()).toContain("확인하는 중");
  });

  // 취소하거나 실패하면 그 사실이 화면에 드러나야 한다. 조용히 끝나면 오버레이가 마지막 문구
  // 그대로 멈춰서, 사용자에게는 "취소를 눌렀는데 아무 일도 없다" 로 보인다.
  it("surfaces a failed or cancelled tailnet as a connection error", async () => {
    const api = createTailnetApi();
    vi.mocked(api.tailnet.test).mockResolvedValue({ id: "net-1", state: "stopped" } as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    const tab = store.getState().tabs.find((item) => item.hostId === "host-1");
    expect(tab?.status).toBe("error");
    // 호스트 키를 신뢰하라는 안내로 새면 안 된다 — 여기엔 신뢰할 키가 없다.
    expect(tab?.connectionProgress?.stage).not.toBe("awaiting-host-trust");
  });

  // 코어가 동기화 없이 진행하기로 했으면(degraded) 관문을 통과시켜야 한다.
  //
  // 여기서 실패로 읽으면 코어가 넘긴 연결을 화면이 되돌려 세운다 — ready 하나만 보던 때가 그랬고,
  // 그 상태로 3분을 기다리다 실패했다. 데이터 플레인은 이미 받아 둔 넷맵으로 통하므로, 실제로 갈 수
  // 있는지는 그 뒤의 SSH 연결이 답한다.
  it("동기화가 끊긴 채 진행하기로 한 tailnet 은 통과시킨다", async () => {
    const api = createTailnetApi();
    vi.mocked(api.tailnet.test).mockResolvedValue({
      id: "net-1",
      state: "running",
      ready: false,
      authorized: true,
      online: false,
      degraded: true,
    } as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    expect(vi.mocked(api.ssh.connect)).toHaveBeenCalled();
    const tab = store.getState().tabs.find((item) => item.hostId === "host-1");
    expect(tab?.status).not.toBe("error");
  });

  // 브라우저 로그인을 기다리다 접는 경로. 코어는 이때 실패가 아니라 "접혔다" 로 끝내는데,
  // 그 끝이 여기까지 와야 연결 시도가 멈춘다 — 오지 않으면 오버레이가 대기 문구 그대로
  // 남아서, 취소를 눌렀는데 아무 일도 없는 것으로 보인다.
  it("ends the attempt when the user cancels while waiting for login", async () => {
    const api = createTailnetApi();
    let emitStatus: ((status: { id: string; state: string; authUrl?: string }) => void) | undefined;
    vi.mocked(api.tailnet.onStatus).mockImplementation((listener) => {
      emitStatus = listener as never;
      return () => undefined;
    });
    let resolveTest: ((value: unknown) => void) | undefined;
    vi.mocked(api.tailnet.test).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve as (value: unknown) => void;
        }) as never,
    );

    const store = createAppStore(api);
    await store.getState().bootstrap();
    const connecting = store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    emitStatus?.({ id: "net-1", state: "needsAuth", authUrl: "https://login.example.com/a/x" });
    await flushMicrotasks();

    // 취소가 코어에 닿으면 진행 중이던 시도가 이 모양으로 끝난다.
    resolveTest?.({ id: "net-1", state: "stopped", cancelled: true });
    await connecting;
    await flushMicrotasks();

    const tab = store.getState().tabs.find((item) => item.hostId === "host-1");
    expect(tab?.status).toBe("error");
  });

  // 다른 tailnet 의 상태가 이 연결의 진행을 덮으면 안 된다.
  it("ignores status for a different tailnet", async () => {
    const api = createTailnetApi();
    let emitStatus: ((status: { id: string; state: string }) => void) | undefined;
    vi.mocked(api.tailnet.onStatus).mockImplementation((listener) => {
      emitStatus = listener as never;
      return () => undefined;
    });
    vi.mocked(api.tailnet.test).mockImplementation(() => new Promise(() => undefined) as never);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    void store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    emitStatus?.({ id: "other-net", state: "needsApproval" });
    await flushMicrotasks();

    const message = store
      .getState()
      .tabs.find((item) => item.hostId === "host-1")?.connectionProgress?.message;
    expect(message).toContain("연결하는 중");
  });
});
