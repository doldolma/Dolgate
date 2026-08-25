import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
  TerminalTab,
} from "@shared";
import { DEFAULT_SFTP_BROWSER_COLUMN_WIDTHS, isSshHostRecord } from "@shared";
import type { HostContainersTabState } from "./createAppStore";
import { createAppStore, upsertTransferJob } from "./createAppStore";
import {
  createAwsEc2Host,
  createContainerDetails,
  createContainerSummary,
  createContainerTab,
  createDeferred,
  createEcsHost,
  createMockApi,
  createUntrustedHostProbe,
  flushMicrotasks,
} from "./createAppStore.test-support";
import { getSessionConnectedAt } from "../lib/terminal-cwd-registry";

describe("createAppStore sessions and auth recovery", () => {
  function createAwsSessionTab(
    overrides: Partial<TerminalTab> = {},
  ): TerminalTab {
    return {
      id: "aws-session-1",
      stableId: "aws-session-1",
      sessionId: "aws-session-1",
      source: "host",
      hostId: "aws-host-1",
      title: "AWS Linux",
      status: "connecting",
      sessionShare: null,
      hasReceivedOutput: false,
      lastEventAt: "2026-06-11T07:49:48.000Z",
      ...overrides,
    };
  }

  it("opens a new session tab and moves to focus mode on connect", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
    expect(store.getState().tabs[0]?.title).toBe("Prod");
    expect(store.getState().tabStrip).toEqual([
      { kind: "session", sessionId: "session-1" },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
    expect(store.getState().hostDrawer).toEqual({ mode: "closed" });
  });

  it("opens an RDP host as a remote-desktop pane instead of a terminal", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);

    // 비밀번호는 메인 프로세스가 secretRef 로 푼다 — 렌더러는 hostId 만 넘긴다.
    //
    // 세 번째 인자는 원격 화면이 들어갈 자리의 크기다. 접속할 때 이 크기로 붙어야 화면이 뜨는
    // 순간부터 창에 맞는다. 테스트 환경에는 그 요소가 없으므로 undefined 가 간다.
    expect(api.rdp.connect).toHaveBeenCalledWith(
      expect.any(String),
      "rdp-host-1",
      undefined,
    );
    // 터미널 경로로 새지 않아야 한다.
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(api.serial.connect).not.toHaveBeenCalled();

    const tab = store.getState().tabs.at(-1);
    expect(tab?.paneKind).toBe("rdp");
    expect(tab?.hostId).toBe("rdp-host-1");
    expect(tab?.status).toBe("connected");
    // 붙은 뒤에는 연결 화면이 캔버스를 가리면 안 된다.
    expect(tab?.connectionProgress).toBeNull();
    expect(store.getState().activeWorkspaceTab).toBe(
      `session:${tab?.sessionId}`,
    );
  });

  it("stores the RDP hover details from the connect reply and resize events", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);

    const tab = store.getState().tabs.at(-1);
    expect(tab?.rdpDesktopSize).toEqual({ width: 1920, height: 1080 });
    expect(tab?.rdpUsername).toBe("WORKGROUP\\admin");
    expect(tab?.rdpMonitorCount).toBe(1);

    // 해상도가 바뀌면 hover 의 표기도 따라가야 한다.
    store.getState().handleRdpEvent({
      type: "resized",
      sessionId: tab!.sessionId,
      desktopWidth: 2560,
      desktopHeight: 1440,
      monitors: [
        { index: 0, left: 0, top: 0, width: 1280, height: 1440 },
        { index: 1, left: 1280, top: 0, width: 1280, height: 1440 },
      ],
    });

    const resized = store.getState().tabs.at(-1);
    expect(resized?.rdpDesktopSize).toEqual({ width: 2560, height: 1440 });
    expect(resized?.rdpMonitorCount).toBe(2);
  });

  it("resets the RDP connected-at clock when the session ends", async () => {
    // 자동 재연결이 sessionId 를 재사용하므로, 끊길 때 지우지 않으면 재연결 후의
    // "연결 경과"가 이전 연결 시각부터 센다.
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);
    const sessionId = store.getState().tabs.at(-1)!.sessionId;
    expect(getSessionConnectedAt(sessionId)).not.toBeNull();

    store.getState().handleRdpEvent({ type: "closed", sessionId });

    expect(getSessionConnectedAt(sessionId)).toBeNull();
  });

  it("removes the RDP tab when the remote side ends the session", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);
    const sessionId = store.getState().tabs.at(-1)!.sessionId;

    // 원격에서 로그오프하면 코어가 closed 를 올린다. 탭이 connected 로 남아 거짓말하면 안 된다.
    store.getState().handleRdpEvent({ type: "closed", sessionId });

    expect(
      store.getState().tabs.find((tab) => tab.sessionId === sessionId),
    ).toBeUndefined();
  });

  it("keeps a failed RDP tab visible when closed follows the error", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);
    const sessionId = store.getState().tabs.at(-1)!.sessionId;

    // rdp-core 는 실패 시 error 다음에 항상 closed 를 보낸다. 그때 탭을 지우면 사용자가
    // 이유를 읽기도 전에 사라진다.
    store
      .getState()
      .handleRdpEvent({ type: "error", sessionId, message: "logon failure" });
    store.getState().handleRdpEvent({ type: "closed", sessionId });

    const tab = store.getState().tabs.find((item) => item.sessionId === sessionId);
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("logon failure");
  });

  it("ignores RDP events for a session it does not have", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    const before = store.getState().tabs.length;

    store.getState().handleRdpEvent({ type: "closed", sessionId: "ghost" });

    expect(store.getState().tabs).toHaveLength(before);
  });

  it("disconnects the RDP core when its tab is closed", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);

    const sessionId = store.getState().tabs.at(-1)!.sessionId;
    await store.getState().disconnectTab(sessionId);

    // ssh-core 로 보내면 아무 일도 일어나지 않고 사이드카 세션이 살아남는다.
    expect(api.rdp.disconnect).toHaveBeenCalledWith(sessionId);
    expect(api.ssh.disconnect).not.toHaveBeenCalled();
    expect(
      store.getState().tabs.find((tab) => tab.sessionId === sessionId),
    ).toBeUndefined();
  });

  it("saves the chosen monitors on this device only and reconnects", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);
    const first = store.getState().tabs.at(-1)!.sessionId;

    const monitors = [
      { id: 1, label: "Built-in", width: 3024, height: 1964 },
      { id: 2, label: "LG HDR 4K", width: 3840, height: 2160 },
    ];
    await store.getState().setRdpMonitors(first, monitors);

    // 기기 로컬 설정에 남아야 다음 접속에도 같은 배치를 쓴다. 호스트 레코드에 넣으면 안 된다 —
    // 레코드는 동기화되는데 붙어 있는 모니터는 기기마다 달라서, 다른 기기에서 고른 배치가
    // 넘어오면 없는 화면을 가리킨다.
    expect(api.settings.update).toHaveBeenCalledWith({
      rdpMonitorsByHostId: { "rdp-host-1": monitors },
    });
    expect(api.hosts.update).not.toHaveBeenCalled();

    // 레이아웃은 접속 시점 GCC 값이라 세션 중 변경이 불가능하다 — 끊고 다시 붙어야 한다.
    expect(api.rdp.disconnect).toHaveBeenCalledWith(first);

    const tab = store.getState().tabs.at(-1);
    expect(tab?.paneKind).toBe("rdp");
    expect(tab?.sessionId).not.toBe(first);
  });

  it("ignores a monitor change aimed at a terminal tab", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    const sessionId = store.getState().tabs.at(-1)!.sessionId;

    await store.getState().setRdpMonitors(sessionId, []);

    expect(api.rdp.disconnect).not.toHaveBeenCalled();
    expect(api.hosts.update).not.toHaveBeenCalled();
  });

  it("marks an RDP tab as errored when the core refuses the connection", async () => {
    const api = createMockApi();
    api.rdp.connect = vi.fn().mockRejectedValue(new Error("auth failed"));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("rdp-host-1", 120, 32);

    const tab = store.getState().tabs.at(-1);
    expect(tab?.status).toBe("error");
    expect(tab?.errorMessage).toBe("auth failed");
  });

  it("prompts for startup snippet variables and sends the resolved command", async () => {
    const api = createMockApi();
    const originalHosts = await api.hosts.list();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...originalHosts[0],
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      },
    ] as HostRecord[]);
    api.snippets.list = vi.fn().mockResolvedValue([
      {
        id: "snippet-1",
        label: "Open app",
        keyword: "app",
        command: "cd {{path=/srv/app}} && echo {{env}}",
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().connectHost("host-1", 120, 32);
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingStartupCommandPrompt?.variables).toEqual([
      { name: "path", defaultValue: "/srv/app" },
      { name: "env", defaultValue: "" },
    ]);

    await store.getState().confirmStartupCommandPrompt({
      path: "/opt/service",
      env: "prod",
    });

    expect(api.ssh.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        startupCommand: "cd /opt/service && echo prod",
      }),
    );
    expect(store.getState().pendingStartupCommandPrompt).toBeNull();
  });

  it("reuses resolved startup snippet values during an authentication retry", async () => {
    const api = createMockApi();
    const originalHosts = await api.hosts.list();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...originalHosts[0],
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      },
    ] as HostRecord[]);
    api.snippets.list = vi.fn().mockResolvedValue([
      {
        id: "snippet-1",
        label: "Open app",
        keyword: "app",
        command: "cd {{path}}",
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().confirmStartupCommandPrompt({ path: "/srv/prod" });
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: { message: "authentication failed" },
    });
    await store.getState().submitCredentialRetry({
      username: "ubuntu",
      password: "secret",
    });

    expect(api.ssh.connect).toHaveBeenCalledTimes(2);
    expect(api.ssh.connect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startupCommand: "cd /srv/prod" }),
    );
    expect(store.getState().pendingStartupCommandPrompt).toBeNull();
  });

  it("clears startup snippet references when the snippet is removed", async () => {
    const api = createMockApi();
    const originalHosts = await api.hosts.list();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...originalHosts[0],
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      },
    ] as HostRecord[]);
    api.snippets.list = vi.fn().mockResolvedValue([
      {
        id: "snippet-1",
        label: "Open app",
        keyword: "app",
        command: "cd /srv/app",
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().removeSnippet("snippet-1");

    expect(api.snippets.remove).toHaveBeenCalledWith("snippet-1");
    expect(store.getState().snippets).toEqual([]);
    expect(store.getState().hosts[0]).toMatchObject({ startupCommand: null });
  });

  it("cancels a startup snippet prompt without opening a session", async () => {
    const api = createMockApi();
    const originalHosts = await api.hosts.list();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...originalHosts[0],
        startupCommand: { type: "snippet", snippetId: "snippet-1" },
      },
    ] as HostRecord[]);
    api.snippets.list = vi.fn().mockResolvedValue([
      {
        id: "snippet-1",
        label: "Open app",
        command: "cd {{path}}",
        keyword: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().connectHost("host-1", 120, 32);
    store.getState().cancelStartupCommandPrompt();

    expect(store.getState().pendingStartupCommandPrompt).toBeNull();
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().tabs).toEqual([]);
  });

  it("uses the serial connection flow for serial hosts without SSH auth prompts", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
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
        groupName: null,
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("serial-1", 120, 32);

    expect(api.serial.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "serial-1",
        cols: 120,
        rows: 32,
      }),
    );
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingMissingUsernamePrompt).toBeNull();
    expect(store.getState().tabs[0]?.sessionId).toBe("serial-session-1");
  });

  it("keeps an AWS SSM session tab open when an error is followed by a closed event", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [createAwsSessionTab()],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "aws-session-1",
      payload: {
        message: "opening SSM data channel: websocket: bad handshake",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {
        message: "AWS SSM session exited with code 254",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({
      sessionId: "aws-session-1",
      status: "error",
      errorMessage: "opening SSM data channel: websocket: bad handshake",
    });
    expect(store.getState().tabs[0]?.connectionProgress?.message).toBe(
      "opening SSM data channel: websocket: bad handshake",
    );
  });

  // SSM 세션의 connected 는 데이터채널이 열린 시점에 나간다. 그 뒤 핸드셰이크나 셸 기동이
  // 실패하면 이 상태에서 죽는데(계정의 KMS 세션 암호화가 그 경로다), 예전에는 탭이 그냥 사라져
  // 사용자가 이유를 볼 방법이 없었다.
  it("붙자마자 이유 없이 닫힌 AWS SSM 세션도 탭을 남긴다", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [
        createAwsSessionTab({ status: "connected", hasReceivedOutput: false }),
      ],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({
      sessionId: "aws-session-1",
      status: "error",
    });
  });

  it("출력을 받은 뒤 정상 종료한 세션은 그대로 닫는다", async () => {
    // 위 판정이 정상 종료까지 붙잡으면 셸을 끝낼 때마다 오류 탭이 남는다.
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [
        createAwsSessionTab({ status: "connected", hasReceivedOutput: true }),
      ],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
  });

  it("keeps an AWS SSM session tab open when the SSM session closes with a non-zero exit code", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [createAwsSessionTab()],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {
        message: "AWS SSM session exited with code 254",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({
      sessionId: "aws-session-1",
      status: "error",
      errorMessage: "AWS SSM session exited with code 254",
    });
    expect(store.getState().tabs[0]?.connectionProgress?.message).toBe(
      "AWS SSM session exited with code 254",
    );
  });

  it("keeps an AWS SSM session tab open for non-zero exit even after output was printed", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [
        createAwsSessionTab({
          status: "connected",
          hasReceivedOutput: true,
        }),
      ],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {
        message: "AWS SSM session exited with code 254",
      },
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({
      sessionId: "aws-session-1",
      status: "error",
      errorMessage: "AWS SSM session exited with code 254",
    });
  });

  it("does not restore the connecting overlay when a delayed connected event arrives after output", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [
        createAwsSessionTab({
          status: "connecting",
          hasReceivedOutput: true,
          connectionProgress: {
            stage: "connecting",
            message: "AWS Linux SSM 세션을 시작하는 중입니다.",
            blockingKind: "none",
            retryable: false,
          },
        }),
      ],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "aws-session-1",
      payload: {
        status: "connected",
      },
    });

    expect(store.getState().tabs[0]).toMatchObject({
      sessionId: "aws-session-1",
      status: "connected",
      hasReceivedOutput: true,
      connectionProgress: null,
    });
  });

  it("removes an AWS SSM session tab on normal close after output was received", async () => {
    const store = createAppStore(createMockApi());
    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
      tabs: [
        createAwsSessionTab({
          status: "connected",
          hasReceivedOutput: true,
        }),
      ],
      tabStrip: [{ kind: "session", sessionId: "aws-session-1" }],
      activeWorkspaceTab: "session:aws-session-1",
    }));

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "aws-session-1",
      payload: {
        message: "AWS SSM session exited with code 0",
      },
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().tabStrip).toHaveLength(0);
  });

  it("prompts for a missing SSH username before opening a session", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "",
        authType: "password",
        privateKeyPath: null,
        secretRef: "host:host-1",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().pendingMissingUsernamePrompt).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      cols: 120,
      rows: 32,
    });
    expect(store.getState().tabs).toHaveLength(0);
  });

  it("saves a prompted username and retries the SSH session connect", async () => {
    const api = createMockApi();
    const initialHost: HostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "",
      authType: "password",
      privateKeyPath: null,
      secretRef: "host:host-1",
      groupName: "Servers",
      terminalThemeId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    api.hosts.list = vi.fn().mockResolvedValue([initialHost]);
    api.hosts.update = vi.fn().mockImplementation(async (_id, draft) => ({
      ...initialHost,
      ...draft,
      kind: "ssh",
      id: initialHost.id,
      createdAt: initialHost.createdAt,
      updatedAt: "2025-01-02T00:00:00.000Z",
    }));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().submitMissingUsernamePrompt({ username: "ubuntu" });

    expect(api.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "ubuntu",
      }),
    );
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingMissingUsernamePrompt).toBeNull();
    const updatedHost = store
      .getState()
      .hosts.find((host) => host.id === "host-1");
    expect(isSshHostRecord(updatedHost as HostRecord)).toBe(true);
    expect(
      updatedHost && isSshHostRecord(updatedHost)
        ? updatedHost.username
        : null,
    ).toBe("ubuntu");
    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
  });

  it("opens a unified auth retry request for SSH authentication failures", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: {
        message:
          "ssh handshake failed: ssh: handshake failed: ssh: unexpected message type 51 (expected 60)",
      },
    });

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      authType: "password",
      initialUsername: "ubuntu",
    });
  });

  it("opens the retry dialog when certificate preflight fails before connect", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "certificate",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.ssh.connect = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
        ),
      );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      source: "ssh",
      authType: "certificate",
      initialUsername: "ubuntu",
      message: "SSH 인증서가 만료되었습니다. 새 인증서를 가져와 다시 시도하세요.",
    });
  });

  it("retries SSH auth with username and reopens using the attempted username on failure", async () => {
    const api = createMockApi();
    let currentHost: HostRecord = {
      id: "host-1",
      kind: "ssh",
      label: "Prod",
      hostname: "prod.example.com",
      port: 22,
      username: "ubuntu",
      authType: "certificate",
      privateKeyPath: null,
      certificatePath: null,
      secretRef: "host:host-1",
      groupName: "Servers",
      terminalThemeId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    api.hosts.list = vi.fn().mockResolvedValue([currentHost]);
    api.hosts.update = vi.fn().mockImplementation(async (_id, draft) => {
      currentHost = {
        ...currentHost,
        ...draft,
        kind: "ssh",
        id: currentHost.id,
        createdAt: currentHost.createdAt,
        updatedAt: "2025-01-02T00:00:00.000Z",
      };
      return currentHost;
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-1",
      payload: {
        message: "authentication failed",
      },
    });

    await store.getState().submitCredentialRetry({
      username: "test11",
      privateKeyPem: "PRIVATE KEY",
      certificateText: "ssh-ed25519-cert-v01@openssh.com AAAA",
      passphrase: "secret",
    });

    expect(api.hosts.update).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "test11",
      }),
    );
    expect(api.ssh.connect).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingCredentialRetry).toBeNull();

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "session-2",
      payload: {
        message: "authentication failed",
      },
    });
    await flushMicrotasks();

    expect(api.hosts.update).toHaveBeenLastCalledWith(
      "host-1",
      expect.objectContaining({
        kind: "ssh",
        username: "ubuntu",
      }),
    );
    expect(store.getState().pendingCredentialRetry).toMatchObject({
      hostId: "host-1",
      authType: "certificate",
      initialUsername: "test11",
    });
  });

  it("creates a pending tab immediately before the real session id is resolved", async () => {
    const api = createMockApi();
    const connect = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const connectPromise = store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );
    expect(store.getState().tabs[0]?.status).toBe("pending");
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "connecting",
    );

    connect.resolve({ sessionId: "session-1" });
    await connectPromise;

    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
    expect(store.getState().tabs[0]?.status).toBe("connecting");
  });

  it("updates pending AWS SSH tabs from SSH-over-SSM preflight progress events", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      profileName: "default",
      available: true,
      isSsoProfile: false,
      isAuthenticated: true,
      accountId: null,
      arn: null,
      errorMessage: null,
    });
    const connect = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));

    const connectPromise = store.getState().connectHost("aws-host-1", 120, 32);
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "sending-public-key",
      message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "sending-public-key",
      message: "EC2 Instance Connect로 공개 키를 전송하는 중입니다.",
      blockingKind: "none",
    });

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "opening-tunnel",
      message: "SSH 연결용 내부 SSM 터널을 여는 중입니다.",
    });
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      stage: "opening-tunnel",
      message: "SSH 연결용 내부 SSM 터널을 여는 중입니다.",
    });

    connect.resolve({ sessionId: "aws-session-1" });
    await connectPromise;
  });

  // 실패 원인 코드를 탭에 남겨 둬야 실패 화면이 "무엇을 해야 하는지" 를 고를 수 있다 —
  // 안 남기면 화면이 오류 원문을 다시 뜯어 원인을 추측하게 된다.
  it("keeps the AWS preflight failure reason on the pending tab and clears it on the next attempt", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      profileName: "default",
      available: true,
      isSsoProfile: false,
      isAuthenticated: true,
      accountId: null,
      arn: null,
      errorMessage: null,
    });
    const connect = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));

    const connectPromise = store.getState().connectHost("aws-host-1", 120, 32);
    await flushMicrotasks();

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "checking-ssm",
      message: "SSM 관리 상태를 확인하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.awsDiagnosticReasonCode).toBeNull();

    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "checking-ssm",
      message: "SSM 상태 조회 권한이 없습니다.",
      reasonCode: "describe-access-denied",
    });
    expect(store.getState().tabs[0]?.awsDiagnosticReasonCode).toBe(
      "describe-access-denied",
    );

    // 탭은 재연결에도 그대로 쓰인다 — 지우지 않으면 지난 실패의 안내가 다음 실패에 붙는다.
    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "checking-profile",
      message: "AWS 프로필을 확인하는 중입니다.",
    });
    expect(store.getState().tabs[0]?.awsDiagnosticReasonCode).toBeNull();

    // 'unknown' 은 담지 않는다 — 고를 안내가 없고, 그 문구는 SFTP 를 가리켜 터미널에선 틀린다.
    store.getState().handleContainerConnectionProgressEvent({
      endpointId: "aws-ec2-ssh:aws-host-1",
      hostId: "aws-host-1",
      stage: "checking-profile",
      message: "확인되지 않은 오류가 발생했습니다.",
      reasonCode: "unknown",
    });
    expect(store.getState().tabs[0]?.awsDiagnosticReasonCode).toBeNull();

    connect.resolve({ sessionId: "aws-session-1" });
    await connectPromise;
  });

  it("opens a local terminal tab immediately and replaces the pending id when connected", async () => {
    const api = createMockApi();
    const connectLocal = createDeferred<{ sessionId: string }>();
    api.ssh.connectLocal = vi
      .fn()
      .mockImplementation(() => connectLocal.promise);
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const openPromise = store.getState().openLocalTerminal(120, 32);
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.source).toBe("local");
    expect(store.getState().tabs[0]?.title).toBe("Terminal");
    expect(store.getState().tabs[0]?.sessionId.startsWith("pending:")).toBe(
      true,
    );
    expect(store.getState().tabs[0]?.connectionProgress?.message).toBe(
      "로컬 터미널을 시작하는 중입니다.",
    );

    connectLocal.resolve({ sessionId: "local-session-1" });
    await openPromise;

    expect(store.getState().tabs[0]?.sessionId).toBe("local-session-1");
    expect(store.getState().tabs[0]?.source).toBe("local");
    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-1");
  });

  // 셸은 처음 받은 크기로 프롬프트를 그린다. 씨앗값으로 시작하면 곧 도착하는 실제 크기에 맞춰
  // conhost 가 리플로우하며 그 프롬프트가 화면에 남는다 — 실기기에서 첫 줄에 프롬프트가 두 번
  // 찍히고 첫 입력이 엉뚱한 열에서 시작했다. pane 이 측정을 마칠 틈을 주면 그 잔상이 없어진다.
  it("starts the local shell with the size the pane measured, not the seed", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const openPromise = store.getState().openLocalTerminal(120, 32);
    await flushMicrotasks();

    const pendingSessionId = store.getState().tabs[0]?.sessionId;
    if (!pendingSessionId?.startsWith("pending:")) {
      throw new Error(`expected a pending local tab, got ${pendingSessionId}`);
    }
    // pane 이 마운트되며 실제 격자를 보고한 것과 같은 경로.
    store.getState().updatePendingConnectionSize(pendingSessionId, 203, 55);

    await openPromise;

    expect(api.ssh.connectLocal).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 203, rows: 55 }),
    );
  });

  it("retries a failed local session in the same tab context", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "local-session-1",
      payload: {
        message: "failed to start shell",
      },
    });

    await store.getState().retrySessionConnection("local-session-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("local-session-1");
    expect(api.ssh.connectLocal).toHaveBeenCalledTimes(2);
    expect(store.getState().tabs[0]?.source).toBe("local");
  });

  it("opens ECS exec shell using only /bin/sh", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    expect(api.aws.openEcsExecShell).toHaveBeenCalledTimes(1);
    expect(api.aws.openEcsExecShell).toHaveBeenCalledWith({
      hostId: "ecs-host-1",
      serviceName: "api",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      containerName: "api",
      cols: 120,
      rows: 32,
      command: "/bin/sh",
    });
  });

  it("keeps a missing-shell ECS exec session open as a close-only error overlay", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });

    expect(store.getState().tabs[0]?.status).toBe("connected");
    expect(store.getState().tabs[0]?.shellKind).toBe("aws-ecs-exec");

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });
    await flushMicrotasks();

    expect(api.aws.openEcsExecShell).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("keeps ECS exec AWS auth errors instead of rewriting them as missing shell failures", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().markSessionOutput(
      "ecs-shell-1",
      new TextEncoder().encode("/app # "),
    );
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message:
          "aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "Token has expired",
    );
    expect(store.getState().tabs[0]?.errorMessage).not.toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
  });

  it("retries a failed ECS exec shell using /bin/sh again", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" })
      .mockResolvedValueOnce({ sessionId: "ecs-shell-2" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });

    await store.getState().retrySessionConnection("ecs-shell-1");

    expect(api.aws.openEcsExecShell).toHaveBeenNthCalledWith(2, {
      hostId: "ecs-host-1",
      serviceName: "api",
      taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      containerName: "api",
      cols: 120,
      rows: 32,
      command: "/bin/sh",
    });
    expect(store.getState().tabs[0]?.sessionId).toBe("ecs-shell-2");
  });

  it("closes a missing-shell ECS exec session through the standard close action", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    await store.getState().disconnectTab("ecs-shell-1");

    expect(api.ssh.disconnect).toHaveBeenCalledWith("ecs-shell-1");
    expect(store.getState().tabs).toHaveLength(0);
  });

  it("keeps a missing-shell ECS exec session open even if a small chunk arrives before the 127 error", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().markSessionOutput(
      "ecs-shell-1",
      new Uint8Array([27, 91, 54, 110]),
    );
    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "ecs-shell-1",
      payload: {
        message: "Process exited with status 127",
      },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("keeps an ECS exec session open when it closes immediately without a separate error event", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "ecs-shell-1" });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    store.getState().handleCoreEvent({
      type: "connected",
      sessionId: "ecs-shell-1",
      payload: { shellKind: "aws-ecs-exec" },
    });
    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "ecs-shell-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ECS 컨테이너 셸을 시작하지 못했습니다.",
    );
    expect(store.getState().tabs[0]?.connectionProgress).toMatchObject({
      blockingKind: "dialog",
      retryable: false,
    });
  });

  it("shows a clearer permission error when ECS exec is denied by IAM", async () => {
    const api = createMockApi();
    api.aws.openEcsExecShell = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "AccessDeniedException: User is not authorized to perform: ecs:ExecuteCommand on resource: *",
        ),
      );
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createEcsHost()],
    }));
    await store.getState().openEcsExecShell(
      "ecs-host-1",
      "api",
      "arn:aws:ecs:ap-northeast-2:123456789012:task/prod/api-1",
      "api",
    );

    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "ecs:ExecuteCommand",
    );
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "권한이 없습니다",
    );
  });

  it("creates a new titled session each time the same host is connected", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().tabs.map((tab) => tab.title)).toEqual([
      "Prod",
      "Prod (1)",
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-2");
  });

  // 호스트 키 확인은 이제 **연결 안에서** 한다. 예전에는 연결 전에 키를 미리 읽어 왔고(프로브),
  // 그 프로브도 점프 호스트에 인증해야 해서 OTP 호스트에서는 코드를 두 번 넣어야 했다 — TOTP 는
  // 한 번 쓰면 무효라 통과할 수 없었다.
  it("connects first and answers the host key question in place", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    // 키를 미리 읽지 않고 곧바로 연결을 시작한다.
    expect(api.knownHosts.probeHost).not.toHaveBeenCalled();
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);

    const sessionId = store.getState().tabs[0]?.sessionId;
    store.getState().handleCoreEvent({
      type: "hostKeyTrustChallenge",
      sessionId: sessionId!,
      payload: {
        challengeId: "hostkey-trust-1",
        hop: { username: "ubuntu", host: "prod.example.com", port: 22 },
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:test",
        publicKeyBase64: "AAAATEST",
        mismatch: false,
      },
    });

    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe(
      "untrusted",
    );
    expect(store.getState().pendingHostKeyPrompt?.probe.fingerprintSha256).toBe(
      "SHA256:test",
    );

    await store.getState().acceptPendingHostKeyPrompt("trust");

    // 저장하고 코어에 답한다. **다시 연결하지 않는다** — 연결은 이미 그 자리에서 기다린다.
    expect(api.knownHosts.trust).toHaveBeenCalled();
    expect(api.ssh.respondHostKeyTrust).toHaveBeenCalledWith({
      challengeId: "hostkey-trust-1",
      trust: true,
    });
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  /**
   * 연결 중 뜨는 신뢰 물음은 **연결 중인 호스트의 hostId** 를 실어 보낸다.
   *
   * 실기기에서 "저장해도 매번 다시 묻는" 건의 원인이다. 메인은 이 hostId 로 tailnet 범위를 정하고
   * (렌더러가 범위를 주장하게 두면 우회 경로가 되므로 그 규칙은 그대로 둔다), 연결은 그 범위로
   * known_hosts 를 조회한다. 그래서 hostId 가 비거나 다른 호스트를 가리키면 범위가 어긋나
   * **저장은 되는데 다음 연결이 못 찾는다.**
   *
   * 예전에는 홉 **주소**로만 호스트를 찾았다. 한 주소에 호스트 레코드가 둘이면(하나는 tailnet 이
   * 걸리고 하나는 안 걸린 채로) 목록에서 먼저 나온 쪽을 집는다. 이제 탭의 호스트를 먼저 본다.
   */
  it("연결 중인 호스트의 hostId·라벨로 신뢰를 저장한다", async () => {
    const api = createMockApi();
    const sharedAddress = { hostname: "10.0.0.9", port: 22 };
    const baseHost = {
      kind: "ssh" as const,
      username: "ubuntu",
      authType: "password" as const,
      privateKeyPath: null,
      groupName: "Servers",
      terminalThemeId: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    // 목록 순서가 중요하다 — 주소로 찾으면 tailnet 이 없는 `temp` 가 먼저 걸린다.
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...baseHost,
        ...sharedAddress,
        id: "host-temp",
        // 라벨을 앞에 오게 둔다 — 스토어가 라벨 순으로 정렬하므로 주소 검색이 이쪽을 먼저 집는다.
        label: "alpha",
        secretRef: "host:host-temp",
        tailnetId: null,
      },
      {
        ...baseHost,
        ...sharedAddress,
        id: "host-1",
        label: "beta",
        secretRef: "host:host-1",
        tailnetId: "tailnet-a",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    const sessionId = store.getState().tabs[0]?.sessionId;

    store.getState().handleCoreEvent({
      type: "hostKeyTrustChallenge",
      sessionId: sessionId!,
      payload: {
        challengeId: "hostkey-trust-scope",
        hop: { username: "ubuntu", host: sharedAddress.hostname, port: sharedAddress.port },
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:scope",
        publicKeyBase64: "AAAASCOPE",
        mismatch: false,
      },
    });

    // 라벨도 연결 중인 호스트의 것이어야 한다 — `temp` 로 물으면 사용자는 다른 서버로 읽는다.
    expect(store.getState().pendingHostKeyPrompt?.probe.hostLabel).toBe("beta");
    expect(store.getState().pendingHostKeyPrompt?.probe.hostId).toBe("host-1");

    await store.getState().acceptPendingHostKeyPrompt("trust");

    // 이것이 이 건의 핵심이다. hostId 가 `host-temp` 나 "" 로 가면 메인이 범위를 잘못(또는
    // 없이) 정하고, 다음 연결이 그 키를 못 찾아 또 묻는다.
    expect(api.knownHosts.trust).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "host-1",
        host: "10.0.0.9",
        port: 22,
      }),
    );
    // 범위는 렌더러가 주장하지 않는다 — 메인이 hostId 로 정한다(우회 방지).
    expect(api.knownHosts.trust).toHaveBeenCalledWith(
      expect.not.objectContaining({ tailnetId: expect.anything() }),
    );
  });

  // 거절하면 코어에 알려야 그 연결이 끝난다. 안 알리면 코어가 계속 기다린다.
  it("tells the core when the host key is declined", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    const sessionId = store.getState().tabs[0]?.sessionId;
    store.getState().handleCoreEvent({
      type: "hostKeyTrustChallenge",
      sessionId: sessionId!,
      payload: {
        challengeId: "hostkey-trust-2",
        hop: { username: "ubuntu", host: "prod.example.com", port: 22 },
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:test",
        publicKeyBase64: "AAAATEST",
        mismatch: false,
      },
    });

    store.getState().dismissPendingHostKeyPrompt();

    expect(api.ssh.respondHostKeyTrust).toHaveBeenCalledWith({
      challengeId: "hostkey-trust-2",
      trust: false,
    });
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  // 공개 키 설치가 묻는 인증도 화면에 올라와야 한다.
  //
  // 설치는 탭을 만들지 않아서 붙일 자리가 없었다 — 코어는 물을 곳이 없다고 보고 그냥 실패시켰고,
  // 대화상자에는 "keyboard-interactive responder is not configured" 만 남았다. OTP 나 비밀번호를
  // 요구하는 호스트에는 키를 올릴 방법 자체가 없던 셈이다.
  it("공개 키 설치의 인증 물음을 그 호스트의 카드로 만든다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      sessionId: "keyinstall:host-1",
      payload: {
        challengeId: "keyinstall:host-1-1",
        attempt: 1,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false, masked: false }],
        hop: { username: "ubuntu", host: "prod.example.com", port: 22 },
      },
    });

    const auth = store.getState().pendingInteractiveAuths[0];
    expect(auth).toMatchObject({
      source: "keyInstall",
      hostId: "host-1",
      sessionId: "keyinstall:host-1",
      challengeId: "keyinstall:host-1-1",
    });

    // 답은 상관 ID(sessionId)로 간다 — 설치에는 엔드포인트가 없다.
    await store
      .getState()
      .respondInteractiveAuth("keyinstall:host-1-1", ["123456"]);
    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "keyinstall:host-1",
        challengeId: "keyinstall:host-1-1",
        responses: ["123456"],
      }),
    );

    // 코어가 통과를 알리면 카드는 사라진다.
    store.getState().handleCoreEvent({
      type: "keyboardInteractiveResolved",
      sessionId: "keyinstall:host-1",
      payload: { challengeId: "keyinstall:host-1-1" },
    });
    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });

  // 설치 중 올라온 신뢰 물음은 탭을 가리키지 않아야 한다.
  //
  // sessionId 는 "답을 기다리는 탭"이라는 뜻이고, AppShell 이 그 값으로 화면을 옮긴다. 설치의
  // 상관 ID 를 그대로 담으면 있지도 않은 `session:keyinstall:…` 로 튄다 — 사용자는 설치
  // 대화상자를 보고 있다가 빈 화면으로 끌려간다.
  it("설치의 신뢰 물음은 존재하지 않는 탭을 가리키지 않는다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleCoreEvent({
      type: "hostKeyTrustChallenge",
      sessionId: "keyinstall:host-1",
      payload: {
        challengeId: "hostkey-trust-install",
        hop: { username: "ubuntu", host: "bastion.example.com", port: 22 },
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:test",
        publicKeyBase64: "AAAATEST",
        mismatch: false,
      },
    });

    // 물음 자체는 떠야 한다(전역 대화상자).
    expect(store.getState().pendingHostKeyPrompt?.liveChallengeId).toBe(
      "hostkey-trust-install",
    );
    expect(store.getState().pendingHostKeyPrompt?.sessionId).toBeNull();
  });

  // 포워딩·공개키 설치는 탭이 없어서 진행 정보를 받을 자리가 없었다 — 시작해도 tailnet 도 점프도
  // 아무것도 안 보이고 결과만 떨어졌다. 이제는 상관 ID 만으로 공통 뷰에 모인다.
  it("탭이 없는 연결도 홉과 배너를 공통 뷰에 모은다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleCoreEvent({
      type: "connectionHopProgress",
      endpointId: "rule-1",
      payload: { hopIndex: 1, hopCount: 2, hopLabel: "ubuntu@bastion:22", stage: "connected" },
    });
    store.getState().handleCoreEvent({
      type: "connectionHopProgress",
      endpointId: "rule-1",
      payload: { hopIndex: 2, hopCount: 2, hopLabel: "ubuntu@target:22", stage: "connecting" },
    });
    store.getState().handleCoreEvent({
      type: "sshBanner",
      endpointId: "rule-1",
      payload: { text: "Approve at https://login.example.com/a/1" },
    });

    const view = store.getState().connectionViews["rule-1"];
    expect(view?.hops.map((hop) => hop.stage)).toEqual(["connected", "connecting"]);
    expect(view?.banner).toContain("https://login.example.com/a/1");

    // 성공하면 뷰는 사라진다 — 남기면 다음 시작이 앞 시도의 홉을 물려받는다.
    store.getState().handleCoreEvent({
      type: "portForwardStarted",
      endpointId: "rule-1",
      payload: {},
    });
    expect(store.getState().connectionViews["rule-1"]).toBeUndefined();
  });

  // 실패는 남는다. 사용자가 무엇 때문에 못 붙었는지 읽고 닫아야 한다.
  it("실패한 연결 뷰는 남고 사용자가 닫을 수 있다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleCoreEvent({
      type: "connectionHopProgress",
      endpointId: "rule-1",
      payload: { hopIndex: 1, hopCount: 1, hopLabel: "ubuntu@target:22", stage: "connecting" },
    });
    store.getState().handleCoreEvent({
      type: "portForwardError",
      endpointId: "rule-1",
      payload: { message: "ssh handshake failed" },
    });

    expect(store.getState().connectionViews["rule-1"]).toMatchObject({
      status: "error",
      message: "ssh handshake failed",
    });

    store.getState().dismissConnectionView("rule-1");
    expect(store.getState().connectionViews["rule-1"]).toBeUndefined();
  });

  // 두 연결이 동시에 물으면 둘 다 답을 받아야 한다.
  //
  // 슬롯이 하나뿐이던 시절에는 뒤에 온 물음이 앞의 것을 지웠고, 지워진 쪽은 아무도 답할 수 없어
  // 코어의 예산(5분)이 다 될 때까지 "연결 중…"에 앉아 있었다. 앱을 켤 때 세션을 여러 개
  // 복원하거나 같은 베스천 뒤의 호스트를 한꺼번에 열면 실제로 겹친다.
  it("동시에 온 신뢰 물음을 잃지 않고 하나씩 묻는다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    const sessionId = store.getState().tabs[0]?.sessionId;

    const challenge = (challengeId: string, host: string) => ({
      type: "hostKeyTrustChallenge" as const,
      sessionId: sessionId!,
      payload: {
        challengeId,
        hop: { username: "ubuntu", host, port: 22 },
        algorithm: "ssh-ed25519",
        fingerprintSha256: `SHA256:${challengeId}`,
        publicKeyBase64: "AAAATEST",
        mismatch: false,
      },
    });

    store.getState().handleCoreEvent(challenge("hostkey-trust-a", "a.example.com"));
    store.getState().handleCoreEvent(challenge("hostkey-trust-b", "b.example.com"));

    // 먼저 온 것을 계속 보여 준다 — 뒤엣것이 앞엣것을 지우지 않는다.
    expect(store.getState().pendingHostKeyPrompt?.liveChallengeId).toBe(
      "hostkey-trust-a",
    );
    expect(store.getState().queuedHostKeyPrompts).toHaveLength(1);

    store.getState().dismissPendingHostKeyPrompt();

    // 앞엣것을 끝내면 뒤엣것이 올라온다. 그래야 그 연결도 답을 받는다.
    expect(store.getState().pendingHostKeyPrompt?.liveChallengeId).toBe(
      "hostkey-trust-b",
    );

    store.getState().dismissPendingHostKeyPrompt();

    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(api.ssh.respondHostKeyTrust).toHaveBeenCalledWith({
      challengeId: "hostkey-trust-a",
      trust: false,
    });
    expect(api.ssh.respondHostKeyTrust).toHaveBeenCalledWith({
      challengeId: "hostkey-trust-b",
      trust: false,
    });
  });

  // 이미 저장된 키와 다른 키가 오면 "교체" 로 묻는다(기존 제품 결정 그대로).
  it("asks to replace when the key changed", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    const sessionId = store.getState().tabs[0]?.sessionId;
    store.getState().handleCoreEvent({
      type: "hostKeyTrustChallenge",
      sessionId: sessionId!,
      payload: {
        challengeId: "hostkey-trust-3",
        hop: { username: "ubuntu", host: "prod.example.com", port: 22 },
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:new",
        publicKeyBase64: "AAAANEW",
        mismatch: true,
      },
    });

    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe("mismatch");

    await store.getState().acceptPendingHostKeyPrompt("replace");

    expect(api.knownHosts.replace).toHaveBeenCalled();
    expect(api.ssh.respondHostKeyTrust).toHaveBeenCalledWith({
      challengeId: "hostkey-trust-3",
      trust: true,
    });
  });

  // 이미 신뢰된 호스트는 연결 전 probe를 건너뛰므로(중복 순회 방지), 키가 바뀐 사실은 실연결의
  // strict 검사가 "host key mismatch"로 처음 알린다. 그 오류를 그대로 두면 신뢰 프롬프트로 갈
  // 길이 없어(자동 재연결 금지 + 자격증명 프롬프트 대상도 아님) known host 레코드를 손으로
  // 지워야 했다 — 아래 세 케이스가 그 복구 경로의 계약이다.
  function seedTrustedHostOne(api: DesktopApi) {
    api.knownHosts.list = vi.fn().mockResolvedValue([
      {
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAAOLD",
        fingerprintSha256: "SHA256:old",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
  }

  it("re-prompts to replace the key when an already-trusted host's key changed", async () => {
    const api = createMockApi();
    seedTrustedHostOne(api);
    api.ssh.connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ssh handshake failed: host key mismatch"))
      .mockResolvedValue({ sessionId: "session-1" });
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "host-1",
      hostLabel: "Prod",
      host: "prod.example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAANEW",
      fingerprintSha256: "SHA256:new",
      status: "mismatch",
      existing: {
        id: "known-1",
        host: "prod.example.com",
        port: 22,
        algorithm: "ssh-ed25519",
        publicKeyBase64: "AAAAOLD",
        fingerprintSha256: "SHA256:old",
        createdAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    // 신뢰돼 있었으므로 연결 전 probe는 없었고, 실패 후 강제 probe가 한 번 돌았다.
    expect(api.knownHosts.probeHost).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe("mismatch");
    // 다이얼로그가 저장된 지문과 현재 지문을 대조해 보여줄 수 있어야 한다.
    expect(
      store.getState().pendingHostKeyPrompt?.probe.existing?.fingerprintSha256,
    ).toBe("SHA256:old");
    expect(store.getState().pendingHostKeyPrompt?.probe.fingerprintSha256).toBe(
      "SHA256:new",
    );
    // 막다른 오류가 아니라 신뢰 대기 상태로 남는다.
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "awaiting-host-trust",
    );
    expect(store.getState().tabs[0]?.status).not.toBe("error");

    // 사용자가 교체를 선택하면 레코드를 갈아치우고 같은 연결을 이어간다.
    await store.getState().acceptPendingHostKeyPrompt("replace");

    expect(api.knownHosts.replace).toHaveBeenCalled();
    expect(api.knownHosts.trust).not.toHaveBeenCalled();
    expect(api.ssh.connect).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  it("keeps the mismatch error without retrying when the probe still reports trusted", async () => {
    const api = createMockApi();
    seedTrustedHostOne(api);
    api.ssh.connect = vi
      .fn()
      .mockRejectedValue(new Error("ssh handshake failed: host key mismatch"));
    // 바뀐 키가 이 호스트가 아닌 경우(점프 홉 등). 여기서 재시도하면 같은 실패를 반복한다.
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "host key mismatch",
    );
  });

  it("keeps the original mismatch error when the recovery probe itself fails", async () => {
    const api = createMockApi();
    seedTrustedHostOne(api);
    api.ssh.connect = vi
      .fn()
      .mockRejectedValue(new Error("ssh handshake failed: host key mismatch"));
    api.knownHosts.probeHost = vi
      .fn()
      .mockRejectedValue(new Error("Timed out waiting for SSH core response"));
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    // probe 실패 사유로 덮어쓰면 진짜 원인이 가려진다.
    expect(store.getState().tabs[0]?.errorMessage).toContain(
      "host key mismatch",
    );
    expect(store.getState().tabs[0]?.errorMessage).not.toContain("Timed out");
  });

  it("prompts for host key trust before connecting an untrusted AWS EC2 host over SSM", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      profileName: "default",
      available: true,
      isSsoProfile: false,
      isAuthenticated: true,
      accountId: null,
      arn: null,
      errorMessage: null,
    });
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "aws-host-1",
      hostLabel: "AWS Linux",
      host: "aws-ssm:default:ap-northeast-2:i-aws",
      port: 22,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "untrusted",
      existing: null,
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [...state.hosts, createAwsEc2Host()],
    }));

    await store.getState().connectHost("aws-host-1", 120, 32);

    // AWS SSM 은 키를 인스턴스 신원(aws-ssm:…)으로 저장하는데 실제로 붙는 주소는 로컬 터널이다.
    // 코어는 자기가 붙은 주소만 아니까 연결 중에 물으면 그 임시 주소로 저장된다 — 그래서 이 경로만
    // 예전처럼 연결 전에 읽고 묻는다(임시 EIC 키로 인증하므로 사람을 두 번 부르지 않는다).
    expect(api.knownHosts.probeHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "aws-host-1" }),
    );
    expect(api.ssh.connect).not.toHaveBeenCalled();
    const prompt = store.getState().pendingHostKeyPrompt;
    expect(prompt?.probe.status).toBe("untrusted");
    expect(prompt?.probe.host).toBe("aws-ssm:default:ap-northeast-2:i-aws");
    // 살아 있는 질의가 아니다 — 수락하면 그때 연결을 시작한다.
    expect(prompt?.liveChallengeId ?? null).toBeNull();

    await store.getState().acceptPendingHostKeyPrompt("trust");

    expect(api.knownHosts.trust).toHaveBeenCalled();
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  // Windows EC2 는 SSM 셸(PowerShell)로 붙어서 대조할 SSH 호스트 키가 없다. 그런데도 probe 를
  // 하면 SSM 터널을 열어 22번 포트에서 키를 읽으려 하고, probe 경로의 AWS preflight 가 Windows
  // 를 거부해 연결이 거기서 끝난다 — 메인의 SSM 셸 경로까지 가지도 못한다.
  it("skips the host key probe for a Windows EC2 host and connects straight through", async () => {
    const api = createMockApi();
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      profileName: "default",
      available: true,
      isSsoProfile: false,
      isAuthenticated: true,
      accountId: null,
      arn: null,
      errorMessage: null,
    });
    api.knownHosts.probeHost = vi.fn();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState((state) => ({
      hosts: [
        ...state.hosts,
        {
          ...createAwsEc2Host(),
          label: "AWS Win",
          awsPlatform: "Windows",
          awsSshUsername: null,
          awsSshMetadataStatus: "idle",
        } as HostRecord,
      ],
    }));

    await store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.knownHosts.probeHost).not.toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(api.ssh.connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "aws-host-1" }),
    );
  });

  it("returns to home when the last session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().disconnectTab("session-1");

    expect(store.getState().tabs[0]?.status).toBe("disconnecting");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
  });

  it("returns to the containers tab when a container shell session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    await store.getState().openHostContainerShell("host-1", "container-1");
    await store.getState().disconnectTab("session-container-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("containers");
    expect(store.getState().activeContainerHostId).toBe("host-1");
  });

  it("falls back to home when the stored containers return target no longer exists", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openHostContainersTab("host-1");
    await store.getState().openHostContainerShell("host-1", "container-1");
    await store.getState().closeHostContainersTab("host-1");
    await store.getState().disconnectTab("session-container-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "session-container-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
  });

  it("returns to the previous settings section when a session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openSettingsSection("security");
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("security");
  });

  it("returns to the sftp tab when a session opened from sftp closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-1");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("sftp");
  });

  it("returns to the previously active session when the latest session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().disconnectTab("local-session-2");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-2",
      payload: {},
    });

    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-1");
    expect(store.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      "local-session-1",
    ]);
  });

  it("preserves the original return target across a retried local session", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    store.getState().openSettingsSection("security");
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "error",
      sessionId: "local-session-1",
      payload: {
        message: "failed to start shell",
      },
    });

    await store.getState().retrySessionConnection("local-session-1");
    await store.getState().disconnectTab("local-session-2");

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-2",
      payload: {},
    });

    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().activeWorkspaceTab).toBe("home");
    expect(store.getState().homeSection).toBe("settings");
    expect(store.getState().settingsSection).toBe("security");
  });

  it("does not change focus when a background session closes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().openLocalTerminal(120, 32);
    await store.getState().openLocalTerminal(120, 32);

    store.getState().handleCoreEvent({
      type: "closed",
      sessionId: "local-session-1",
      payload: {},
    });

    expect(store.getState().activeWorkspaceTab).toBe("session:local-session-2");
    expect(store.getState().tabs.map((tab) => tab.sessionId)).toEqual([
      "local-session-2",
    ]);
  });

  it("updates theme settings through the desktop api", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ theme: "dark" });

    expect(api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    expect(store.getState().settings.theme).toBe("dark");
  });

  it("stores the home host layout preference locally without sync", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ homeHostViewMode: "list" });

    expect(api.settings.update).toHaveBeenCalledWith({
      homeHostViewMode: "list",
    });
    expect(api.sync.pushDirty).not.toHaveBeenCalled();
    expect(store.getState().settings.homeHostViewMode).toBe("list");
  });

  it("syncs the global terminal system theme mode through the desktop api", async () => {
    const api = createMockApi();
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().updateSettings({ globalTerminalThemeId: "system" });

    expect(api.settings.update).toHaveBeenCalledWith({
      globalTerminalThemeId: "system",
    });
    expect(api.sync.pushDirty).toHaveBeenCalledTimes(1);
    expect(store.getState().settings.globalTerminalThemeId).toBe("system");
  });

  it("refreshes hosts and keychain entries after removing a keychain secret", async () => {
    const api = createMockApi();
    let hosts: HostRecord[] = [
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    let keychainEntries = [
      {
        secretRef: "secret-1",
        label: "Prod Secret",
        hasPassword: true,
        hasPassphrase: false,
        hasManagedPrivateKey: false,
        hasCertificate: false,
        linkedHostCount: 1,
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];

    api.hosts.list = vi.fn().mockImplementation(async () => hosts);
    api.keychain.list = vi.fn().mockImplementation(async () => keychainEntries);
    api.keychain.remove = vi.fn().mockImplementation(async (secretRef: string) => {
      hosts = hosts.map((host) =>
        isSshHostRecord(host) && host.secretRef === secretRef
          ? { ...host, secretRef: null, updatedAt: "2025-01-02T00:00:00.000Z" }
          : host,
      );
      keychainEntries = keychainEntries.filter((entry) => entry.secretRef !== secretRef);
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().removeKeychainSecret("secret-1");

    expect(api.keychain.remove).toHaveBeenCalledWith("secret-1");
    expect(api.hosts.list).toHaveBeenCalledTimes(2);
    expect(api.keychain.list).toHaveBeenCalledTimes(2);
    const refreshedHost = store.getState().hosts[0];
    expect(isSshHostRecord(refreshedHost)).toBe(true);
    if (isSshHostRecord(refreshedHost)) {
      expect(refreshedHost.secretRef).toBeNull();
    }
    expect(store.getState().keychainEntries).toEqual([]);
  });

  it("refreshes hosts and keychain entries after cloning a keychain secret for a host", async () => {
    const api = createMockApi();
    let hosts: HostRecord[] = [
      {
        id: "host-1",
        kind: "ssh",
        label: "Prod",
        hostname: "prod.example.com",
        port: 22,
        username: "ubuntu",
        authType: "password",
        privateKeyPath: null,
        certificatePath: null,
        secretRef: "secret-1",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];
    let keychainEntries = [
      {
        secretRef: "secret-1",
        label: "Shared Secret",
        hasPassword: false,
        hasPassphrase: true,
        hasManagedPrivateKey: true,
        hasCertificate: false,
        linkedHostCount: 1,
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ];

    api.hosts.list = vi.fn().mockImplementation(async () => hosts);
    api.keychain.list = vi.fn().mockImplementation(async () => keychainEntries);
    api.keychain.cloneForHost = vi.fn().mockImplementation(async ({ hostId }: { hostId: string }) => {
      hosts = hosts.map((host) =>
        isSshHostRecord(host) && host.id === hostId
          ? { ...host, secretRef: "secret-2", updatedAt: "2025-01-02T00:00:00.000Z" }
          : host,
      );
      keychainEntries = [
        ...keychainEntries,
        {
          secretRef: "secret-2",
          label: "Prod Host Secret",
          hasPassword: false,
          hasPassphrase: true,
          hasManagedPrivateKey: true,
          hasCertificate: false,
          linkedHostCount: 1,
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ];
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();

    await store.getState().cloneKeychainSecretForHost("host-1", "secret-1", {
      passphrase: "next-passphrase",
    });

    expect(api.keychain.cloneForHost).toHaveBeenCalledWith({
      hostId: "host-1",
      sourceSecretRef: "secret-1",
      secrets: { passphrase: "next-passphrase" },
    });
    expect(api.hosts.list).toHaveBeenCalledTimes(2);
    expect(api.keychain.list).toHaveBeenCalledTimes(2);
    const clonedHost = store.getState().hosts[0];
    expect(isSshHostRecord(clonedHost)).toBe(true);
    if (isSshHostRecord(clonedHost)) {
      expect(clonedHost.secretRef).toBe("secret-2");
    }
    expect(store.getState().keychainEntries.map((entry) => entry.secretRef)).toEqual([
      "secret-2",
      "secret-1",
    ]);
  });

  it("starts AWS SSO login and retries the session connect once when the profile is expired", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileId: "profile-sso",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.aws.getProfileStatusById = vi
      .fn()
      .mockResolvedValueOnce({
        profileName: "sso-profile",
        available: true,
        isSsoProfile: true,
        isAuthenticated: false,
        accountId: null,
        arn: null,
        errorMessage: "釉뚮씪?곗? 濡쒓렇?몄씠 ?꾩슂?⑸땲??",
      })
      .mockResolvedValueOnce({
        profileName: "sso-profile",
        available: true,
        isSsoProfile: true,
        isAuthenticated: true,
        accountId: "123456789012",
        arn: "arn:aws:iam::123456789012:user/test",
        errorMessage: null,
      });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.aws.loginById).toHaveBeenCalledWith("profile-sso");
    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().tabs[0]?.title).toBe("AWS Prod");
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });

  it("blocks AWS host connections that have no profile ID", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        ...createAwsEc2Host(),
        awsProfileId: null,
        awsProfileName: "default",
      },
    ]);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    await store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.aws.getProfileStatusById).not.toHaveBeenCalled();
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().tabs[0]).toMatchObject({
      status: "error",
      errorMessage:
        '연결된 AWS 프로필 "default"을 찾을 수 없습니다. 호스트 설정에서 프로필을 다시 선택해 주세요.',
    });
  });

  it("surfaces a targeted AWS credential message for non-SSO profiles and does not open a session", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-2",
        kind: "aws-ec2",
        label: "AWS Legacy",
        awsProfileId: "profile-legacy",
        awsProfileName: "legacy-profile",
        awsRegion: "us-east-1",
        awsInstanceId: "i-9999999999",
        awsInstanceName: "legacy",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.20",
        awsState: "running",
        groupName: null,
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.aws.getProfileStatusById = vi.fn().mockResolvedValue({
      profileName: "legacy-profile",
      available: true,
      isSsoProfile: false,
      isAuthenticated: false,
      accountId: null,
      arn: null,
      errorMessage: "???꾨줈?꾩? AWS CLI ?먭꺽 利앸챸???꾩슂?⑸땲??",
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();

    await store.getState().connectHost("aws-host-2", 120, 32);

    expect(api.aws.loginById).not.toHaveBeenCalled();
    expect(api.ssh.connect).not.toHaveBeenCalled();
    expect(store.getState().tabs[0]?.status).toBe("error");
    expect(store.getState().tabs[0]?.errorMessage).toBe(
      "???꾨줈?꾩? AWS CLI ?먭꺽 利앸챸???꾩슂?⑸땲??",
    );
  });

  it("tracks aws auth progress in the pending session tab and clears it after the retried session starts", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileId: "profile-sso",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const firstStatus =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatusById"]>>
      >();
    const secondStatus =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatusById"]>>
      >();
    const login = createDeferred<void>();
    const connect = createDeferred<{ sessionId: string }>();

    api.aws.getProfileStatusById = vi
      .fn()
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementationOnce(() => secondStatus.promise);
    api.aws.loginById = vi.fn().mockImplementation(() => login.promise);
    api.ssh.connect = vi.fn().mockImplementation(() => connect.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();

    const connectPromise = store.getState().connectHost("aws-host-1", 120, 32);
    await flushMicrotasks();

    const pendingSessionId = store.getState().tabs[0]?.sessionId;
    expect(pendingSessionId?.startsWith("pending:")).toBe(true);
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "checking-profile",
    );

    firstStatus.resolve({
      id: null,
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: false,
      accountId: null,
      arn: null,
      errorMessage: "釉뚮씪?곗? 濡쒓렇?몄씠 ?꾩슂?⑸땲??",
    });
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "browser-login",
    );

    login.resolve(undefined);
    await flushMicrotasks();

    secondStatus.resolve({
      id: null,
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      errorMessage: null,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "retrying-session",
    );
    expect(store.getState().tabs[0]?.connectionProgress?.message).toContain(
      "AWS Prod SSM 연결을 다시 시도하는 중입니다.",
    );

    connect.resolve({ sessionId: "session-1" });
    await connectPromise;

    expect(store.getState().pendingConnectionAttempts).toEqual([]);
    expect(store.getState().tabs[0]?.sessionId).toBe("session-1");
  });

  it("ignores duplicate aws connect attempts for the same host while auth recovery is already in progress", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "aws-host-1",
        kind: "aws-ec2",
        label: "AWS Prod",
        awsProfileId: "profile-sso",
        awsProfileName: "sso-profile",
        awsRegion: "ap-northeast-2",
        awsInstanceId: "i-1234567890",
        awsInstanceName: "aws-prod",
        awsPlatform: "linux",
        awsPrivateIp: "10.0.0.10",
        awsState: "running",
        groupName: "Servers",
        tags: [],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const status =
      createDeferred<
        Awaited<ReturnType<DesktopApi["aws"]["getProfileStatusById"]>>
      >();
    api.aws.getProfileStatusById = vi.fn().mockImplementation(() => status.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();

    const firstConnect = store.getState().connectHost("aws-host-1", 120, 32);
    const secondConnect = store.getState().connectHost("aws-host-1", 120, 32);

    expect(api.aws.getProfileStatusById).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(store.getState().tabs[0]?.connectionProgress?.stage).toBe(
      "checking-profile",
    );

    status.resolve({
      id: null,
      profileName: "sso-profile",
      available: true,
      isSsoProfile: true,
      isAuthenticated: true,
      accountId: "123456789012",
      arn: "arn:aws:iam::123456789012:user/test",
      errorMessage: null,
    });

    await Promise.all([firstConnect, secondConnect]);

    expect(api.ssh.connect).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingConnectionAttempts).toEqual([]);
  });
  // 실기기 증상: OTP 를 늦게 넣었더니 뒤에서 연결이 "시간 초과" 로 끝났는데 인증 카드는 그대로
  // 남았고, 코드를 넣고 누른 "응답 보내기" 는 아무 일도 하지 않았다. 받을 요청이 이미 없었다.
  it("takes down the auth card when the connect step gives up", async () => {
    const api = createMockApi();
    const connect = createDeferred<{ sessionId: string }>();
    api.ssh.connect = vi.fn().mockReturnValue(connect.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    const connecting = store.getState().connectHost("host-1", 120, 32);
    await flushMicrotasks();

    const sessionId = store.getState().tabs[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    // 코어가 점프 호스트의 OTP 를 물었다 — 프로브 요청 도중에 온다.
    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      sessionId: sessionId!,
      payload: {
        challengeId: "hostkey-1",
        attempt: 1,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false, masked: false }],
        hop: { username: "ubuntu", host: "192.168.200.37", port: 22 },
      },
    });
    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      challengeId: "hostkey-1",
    });

    connect.reject(new Error("ssh handshake failed: connection reset"));
    await connecting;

    expect(store.getState().pendingInteractiveAuths).toEqual([]);
    expect(store.getState().tabs[0]?.status).toBe("error");
  });

  it("says so when the answer can no longer be delivered", async () => {
    const api = createMockApi();
    api.ssh.respondKeyboardInteractive = vi
      .fn()
      .mockRejectedValue(new Error("challenge hostkey-1 not found"));

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      pendingInteractiveAuths: [{
        source: "ssh",
        sessionId: "session-1",
        challengeId: "hostkey-1",
        name: null,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false }],
        provider: "generic",
        autoSubmitted: false,
        }],
    });

    await store.getState().respondInteractiveAuth("hostkey-1", ["443626"]);

    // 카드는 남지만 이유를 말한다 — 조용히 실패하면 버튼이 먹통으로 보인다.
    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      challengeId: "hostkey-1",
      deliveryError: expect.stringContaining("hostkey-1"),
    });
  });

  // 카드를 닫으면 기다리던 코어도 끊어야 한다.
  //
  // 화면에서만 지우면 코어는 예산(5분)이 다 될 때까지 답을 기다린다 — 진행 카드가 "연결 중…"에
  // 앉은 채 남고, tailnet 을 경유하면 그 노드의 리스까지 붙잡는다. 실기기에서 그 상태였다.
  it("인증 카드를 닫으면 코어에 취소를 알린다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      pendingInteractiveAuths: [
        {
          source: "ssh",
          sessionId: "session-1",
          challengeId: "hostkey-1",
          name: null,
          instruction: "",
          prompts: [{ label: "Verification code:", echo: false }],
          provider: "generic",
          autoSubmitted: false,
        },
      ],
    });

    store.getState().clearPendingInteractiveAuth("hostkey-1");

    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        challengeId: "hostkey-1",
        cancelled: true,
      }),
    );
    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });

  // 엔드포인트 쪽(SFTP·컨테이너·포워딩) 물음도 같은 경로로 끊긴다. 상관 ID 만 다르다.
  it("엔드포인트 인증 카드를 닫아도 취소가 전파된다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      pendingInteractiveAuths: [
        {
          source: "portForward",
          endpointId: "rule-1",
          challengeId: "rule-1-1",
          name: null,
          instruction: "",
          prompts: [{ label: "Verification code:", echo: false }],
          provider: "generic",
          autoSubmitted: false,
        } as never,
      ],
    });

    store.getState().clearPendingInteractiveAuth("rule-1-1");

    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "rule-1",
        challengeId: "rule-1-1",
        cancelled: true,
      }),
    );
  });

  // 닫기가 실패해도 카드는 사라져야 한다. 이미 끝난 물음이면 코어가 "not found" 를 주는데,
  // 그것 때문에 카드가 남으면 사용자는 닫을 방법이 없다.
  it("코어가 이미 그 물음을 버렸어도 카드는 닫힌다", async () => {
    const api = createMockApi();
    api.ssh.respondKeyboardInteractive = vi
      .fn()
      .mockRejectedValue(new Error("challenge hostkey-1 not found"));

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      pendingInteractiveAuths: [
        {
          source: "ssh",
          sessionId: "session-1",
          challengeId: "hostkey-1",
          name: null,
          instruction: "",
          prompts: [{ label: "Verification code:", echo: false }],
          provider: "generic",
          autoSubmitted: false,
        },
      ],
    });

    store.getState().clearPendingInteractiveAuth("hostkey-1");
    await Promise.resolve();

    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });
});
