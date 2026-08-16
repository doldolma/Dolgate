import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApi,
  HostContainerLogsSnapshot,
  HostDraft,
  HostRecord,
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

describe("createAppStore runtime, workspaces, and sharing", () => {
  it("uses a caller-assigned endpoint id when connecting a Warpgate SFTP host", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "warpgate-1",
      hostLabel: "Warpgate Prod",
      host: "warpgate.example.com",
      port: 2222,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.getState().activateSftp();

    await store.getState().connectSftpHost("right", "warpgate-1");

    const connectInput = vi.mocked(api.sftp.connect).mock.calls[0]?.[0];
    expect(connectInput?.hostId).toBe("warpgate-1");
    expect(connectInput?.endpointId).toBeTruthy();
    expect(store.getState().sftp.rightPane.endpoint?.id).toBe(
      connectInput?.endpointId,
    );
  });

  it("tracks endpoint-scoped interactive auth challenges for SFTP panes", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.knownHosts.probeHost = vi.fn().mockResolvedValue({
      hostId: "warpgate-1",
      hostLabel: "Warpgate Prod",
      host: "warpgate.example.com",
      port: 2222,
      algorithm: "ssh-ed25519",
      publicKeyBase64: "AAAATEST",
      fingerprintSha256: "SHA256:test",
      status: "trusted",
      existing: null,
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();
    await store.getState().connectSftpHost("right", "warpgate-1");

    const endpointId = vi.mocked(api.sftp.connect).mock.calls[0]?.[0]?.endpointId;
    expect(endpointId).toBeTruthy();

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: endpointId!,
      payload: {
        challengeId: "challenge-1",
        attempt: 1,
        name: "warpgate",
        instruction: "Open https://warpgate.example.com/authorize and enter code ABCD-1234",
        prompts: [
          { label: "Verification code", echo: true },
          { label: "Press Enter to continue", echo: true },
        ],
      },
    });

    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      source: "sftp",
      paneId: "right",
      endpointId,
      challengeId: "challenge-1",
      provider: "warpgate",
    });
    expect(api.shell.openExternal).toHaveBeenCalledWith(
      "https://warpgate.example.com/authorize",
    );
    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledWith({
      endpointId,
      challengeId: "challenge-1",
      responses: ["ABCD-1234", ""],
    });

    store.getState().handleCoreEvent({
      type: "sftpError",
      endpointId: endpointId!,
      payload: {
        message: "approval expired",
      },
    });

    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });

  it("does not reopen the same Warpgate approval URL repeatedly for a saved port forward", async () => {
    const api = createMockApi();
    api.hosts.list = vi.fn().mockResolvedValue([
      {
        id: "warpgate-1",
        kind: "warpgate-ssh",
        label: "Warpgate Prod",
        warpgateBaseUrl: "https://warpgate.example.com",
        warpgateSshHost: "warpgate.example.com",
        warpgateSshPort: 2222,
        warpgateTargetId: "target-1",
        warpgateTargetName: "prod-db",
        warpgateUsername: "example.user",
        groupName: "Servers",
        tags: ["prod"],
        terminalThemeId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    api.portForwards.list = vi.fn().mockResolvedValue({
      rules: [
        {
          id: "forward-warp-1",
          transport: "container",
          label: "Kafka UI",
          hostId: "warpgate-1",
          bindAddress: "127.0.0.1",
          bindPort: 0,
          containerId: "container-1",
          containerName: "kafka-ui",
          containerRuntime: "docker",
          networkName: "bridge",
          targetPort: 8080,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      runtimes: [],
    });
    const store = createAppStore(api);

    await store.getState().bootstrap();

    const challengePayload = {
      attempt: 1,
      name: "warpgate",
      instruction:
        "Open https://warpgate.example.com/authorize and enter code ABCD-1234",
      prompts: [
        { label: "Verification code", echo: true },
        { label: "Press Enter to continue", echo: true },
      ],
    };

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "forward-warp-1",
      payload: {
        challengeId: "challenge-1",
        ...challengePayload,
      },
    });

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "forward-warp-1",
      payload: {
        challengeId: "challenge-2",
        ...challengePayload,
      },
    });

    expect(api.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(api.ssh.respondKeyboardInteractive).toHaveBeenCalledTimes(2);
  });

  it("treats repeated markSessionOutput calls as a no-op after the first output arrives", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().markSessionOutput("session-1");
    const tabsAfterFirstOutput = store.getState().tabs;

    store.getState().markSessionOutput("session-1");

    expect(store.getState().tabs).toBe(tabsAfterFirstOutput);
    expect(store.getState().tabs[0]?.hasReceivedOutput).toBe(true);
  });

  it("does not switch to the containers section for discovery-only container auth challenges", async () => {
    const api = createMockApi();
    api.shell.openExternal = vi.fn().mockResolvedValue(undefined);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.getState().activateSftp();

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      endpointId: "containers:host-1",
      payload: {
        challengeId: "challenge-container-1",
        attempt: 1,
        name: "warpgate",
        instruction:
          "Open https://warpgate.example.com/authorize and enter code WXYZ-9999",
        prompts: [
          { label: "Verification code", echo: true },
          { label: "Press Enter to continue", echo: true },
        ],
      },
    });

    expect(store.getState().activeWorkspaceTab).toBe("sftp");
    expect(store.getState().activeContainerHostId).toBeNull();
    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      source: "containers",
      endpointId: "containers:host-1",
      hostId: "host-1",
      challengeId: "challenge-container-1",
      provider: "generic",
    });
    expect(api.shell.openExternal).not.toHaveBeenCalled();
    expect(api.ssh.respondKeyboardInteractive).not.toHaveBeenCalled();
  });

  it("surfaces keyboard-interactive challenges for regular SSH sessions", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleCoreEvent({
      type: "keyboardInteractiveChallenge",
      sessionId: "session-1",
      payload: {
        challengeId: "challenge-ssh-1",
        attempt: 1,
        name: "otp",
        instruction: "Enter the one-time code.",
        prompts: [{ label: "Code", echo: true }],
      },
    });

    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      source: "ssh",
      sessionId: "session-1",
      challengeId: "challenge-ssh-1",
      provider: "generic",
    });
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
  });

  it("creates and expands a workspace from adjacent tabs", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    const created = store
      .getState()
      .splitSessionIntoWorkspace("session-1", "right");
    expect(created).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]?.id },
      { kind: "session", sessionId: "session-3" },
    ]);

    const expanded = store
      .getState()
      .splitSessionIntoWorkspace("session-3", "bottom", "session-2");
    expect(expanded).toBe(true);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().tabStrip).toEqual([
      { kind: "workspace", workspaceId: store.getState().workspaces[0]?.id },
    ]);
  });

  it("starts workspace broadcast disabled and keeps it through focus, move, and resize changes", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    const created = store.getState().splitSessionIntoWorkspace("session-1", "right");
    expect(created).toBe(true);

    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(false);

    store.getState().toggleWorkspaceBroadcast(workspaceId!);
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);

    const splitId =
      store.getState().workspaces[0]?.layout.kind === "split"
        ? store.getState().workspaces[0]?.layout.id
        : null;

    store.getState().focusWorkspaceSession(workspaceId!, "session-2");
    store.getState().moveWorkspaceSession(workspaceId!, "session-1", "left", "session-2");
    expect(splitId).toBeTruthy();
    store.getState().resizeWorkspaceSplit(workspaceId!, splitId!, 0.6);

    expect(store.getState().workspaces[0]?.activeSessionId).toBe("session-1");
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);
  });

  it("moves a workspace pane around another pane in all supported directions", async () => {
    const expectations = [
      {
        direction: "left" as const,
        axis: "horizontal" as const,
        firstSessionId: "session-1",
        secondSessionId: "session-2",
      },
      {
        direction: "right" as const,
        axis: "horizontal" as const,
        firstSessionId: "session-2",
        secondSessionId: "session-1",
      },
      {
        direction: "top" as const,
        axis: "vertical" as const,
        firstSessionId: "session-1",
        secondSessionId: "session-2",
      },
      {
        direction: "bottom" as const,
        axis: "vertical" as const,
        firstSessionId: "session-2",
        secondSessionId: "session-1",
      },
    ];

    for (const expectation of expectations) {
      const store = createAppStore(createMockApi());
      await store.getState().bootstrap();
      await store.getState().connectHost("host-1", 120, 32);
      await store.getState().connectHost("host-1", 120, 32);

      const created = store
        .getState()
        .splitSessionIntoWorkspace("session-1", "right");
      expect(created).toBe(true);

      const workspace = store.getState().workspaces[0];
      expect(workspace).toBeTruthy();

      const moved = store
        .getState()
        .moveWorkspaceSession(
          workspace!.id,
          "session-1",
          expectation.direction,
          "session-2",
        );

      expect(moved).toBe(true);

      const nextWorkspace = store.getState().workspaces[0];
      expect(nextWorkspace?.activeSessionId).toBe("session-1");
      expect(store.getState().activeWorkspaceTab).toBe(
        `workspace:${workspace!.id}`,
      );
      expect(store.getState().tabStrip).toEqual([
        { kind: "workspace", workspaceId: workspace!.id },
      ]);
      expect(nextWorkspace?.layout).toMatchObject({
        kind: "split",
        axis: expectation.axis,
        first: {
          kind: "leaf",
          sessionId: expectation.firstSessionId,
        },
        second: {
          kind: "leaf",
          sessionId: expectation.secondSessionId,
        },
      });
    }
  });

  it("returns false without changing layout for invalid workspace pane moves", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspace = store.getState().workspaces[0];
    expect(workspace).toBeTruthy();

    const initialLayout = JSON.stringify(workspace!.layout);
    const initialTabStrip = store.getState().tabStrip;

    expect(
      store
        .getState()
        .moveWorkspaceSession(workspace!.id, "session-1", "left", "session-1"),
    ).toBe(false);
    expect(
      store
        .getState()
        .moveWorkspaceSession("missing-workspace", "session-1", "left", "session-2"),
    ).toBe(false);
    expect(
      store
        .getState()
        .moveWorkspaceSession(workspace!.id, "session-1", "left", "missing-session"),
    ).toBe(false);

    expect(JSON.stringify(store.getState().workspaces[0]?.layout)).toBe(
      initialLayout,
    );
    expect(store.getState().workspaces[0]?.activeSessionId).toBe("session-1");
    expect(store.getState().tabStrip).toBe(initialTabStrip);
  });

  it("detaches a workspace pane back into standalone tabs and collapses single-pane workspaces", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    store.getState().detachSessionFromWorkspace(workspaceId!, "session-1");

    expect(store.getState().workspaces).toHaveLength(0);
    expect(store.getState().tabStrip).toEqual([
      { kind: "session", sessionId: "session-2" },
      { kind: "session", sessionId: "session-1" },
    ]);
    expect(store.getState().activeWorkspaceTab).toBe("session:session-1");
  });

  it("removes workspace broadcast state when a workspace collapses back to standalone tabs", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().splitSessionIntoWorkspace("session-1", "right");
    const workspaceId = store.getState().workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();

    store.getState().toggleWorkspaceBroadcast(workspaceId!);
    expect(store.getState().workspaces[0]?.broadcastEnabled).toBe(true);

    store.getState().detachSessionFromWorkspace(workspaceId!, "session-1");

    expect(store.getState().workspaces).toHaveLength(0);
  });

  it("queues owner session-share chat notifications for active shares and clears them when the share stops", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 2,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-1",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "hello",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-1",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "hello",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    ]);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "inactive",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();
  });

  it("dismisses individual owner session-share chat notifications", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 1,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-1",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "first",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-2",
        nickname: "諛섏쭩?대뒗 ?대떖",
        senderRole: "viewer",
        text: "second",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    });

    store.getState().dismissSessionShareChatNotification("session-1", "chat-1");

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-2",
        nickname: "諛섏쭩?대뒗 ?대떖",
        senderRole: "viewer",
        text: "second",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    ]);
  });

  it("does not queue owner-authored chat notifications", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 1,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-owner",
        nickname: "Host Session Owner",
        senderRole: "owner",
        text: "owner message",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();
  });

  it("drops stale chat events after a share has already become inactive", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "inactive",
        shareUrl: null,
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });

    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-stale",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "stale message",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();
  });

  it("does not queue chat notifications until the share reaches active state", async () => {
    const store = createAppStore(createMockApi());

    await store.getState().bootstrap();
    await store.getState().connectHost("host-1", 120, 32);

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "starting",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-too-early",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "too early",
        sentAt: "2026-03-27T00:00:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toBeUndefined();

    store.getState().handleSessionShareEvent({
      sessionId: "session-1",
      state: {
        status: "active",
        shareUrl: "https://sync.example.com/share/share-1/token-1",
        inputEnabled: false,
        viewerCount: 0,
        errorMessage: null,
      },
    });
    store.getState().handleSessionShareChatEvent({
      sessionId: "session-1",
      message: {
        id: "chat-on-time",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "on time",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    });

    expect(store.getState().sessionShareChatNotifications["session-1"]).toEqual([
      {
        id: "chat-on-time",
        nickname: "留묒? ?ъ슦",
        senderRole: "viewer",
        text: "on time",
        sentAt: "2026-03-27T00:01:00.000Z",
      },
    ]);
  });

  // 포워딩이 붙으면 진행 팝업이 사라져야 한다.
  //
  // 코어의 portForwardStarted 는 메인에서 **런타임 레코드로 바뀌어** 들어오므로 handleCoreEvent
  // 는 그것을 보지 못한다. 그 사실을 놓쳐서, 붙은 뒤에도 팝업이 "SSH 연결" 에 앉은 채 남았다.
  it("포워딩이 붙으면 진행 뷰가 정리된다", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();

    store.getState().handleCoreEvent({
      type: "connectionHopProgress",
      endpointId: "pf-1",
      payload: { hopIndex: 1, hopCount: 1, hopLabel: "ubuntu@target:22", stage: "connecting" },
    });
    expect(store.getState().connectionViews["pf-1"]).toBeDefined();

    store.getState().handlePortForwardEvent({
      runtime: {
        ruleId: "pf-1",
        hostId: "host-1",
        transport: "ssh" as const,
        mode: "local" as const,
        bindAddress: "127.0.0.1",
        bindPort: 8080,
        status: "running" as const,
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
    } as never);

    expect(store.getState().connectionViews["pf-1"]).toBeUndefined();
  });

  // 포워딩은 start 실패를 삼키고 런타임 이벤트로만 알린다(services/network.ts). 그래서 키가
  // 바뀐 경우의 유일한 접점이 handlePortForwardEvent 다 — 터미널·SFTP·컨테이너와 같은 계약으로
  // 교체 프롬프트를 띄우고, 수락하면 이 룰의 포워딩을 다시 시작한다.
  function createSshForwardRule() {
    return {
      id: "pf-1",
      label: "Prod 8080",
      hostId: "host-1",
      transport: "ssh" as const,
      mode: "local" as const,
      bindAddress: "127.0.0.1",
      bindPort: 8080,
      targetHost: "127.0.0.1",
      targetPort: 8080,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
  }

  function createForwardErrorEvent(message: string) {
    return {
      runtime: {
        ruleId: "pf-1",
        hostId: "host-1",
        transport: "ssh" as const,
        mode: "local" as const,
        bindAddress: "127.0.0.1",
        bindPort: 8080,
        status: "error" as const,
        message,
        updatedAt: "2026-03-27T00:00:00.000Z",
      },
    };
  }

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

  it("re-prompts to replace the key when a port forward fails on a changed host key", async () => {
    const api = createMockApi();
    seedTrustedHostOne(api);
    vi.mocked(api.knownHosts.probeHost).mockResolvedValue({
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
    store.setState({ portForwards: [createSshForwardRule()] });

    store
      .getState()
      .handlePortForwardEvent(
        createForwardErrorEvent("ssh handshake failed: host key mismatch"),
      );
    await flushMicrotasks();

    expect(store.getState().pendingHostKeyPrompt?.probe.status).toBe("mismatch");
    expect(store.getState().pendingHostKeyPrompt?.action).toMatchObject({
      kind: "portForward",
      ruleId: "pf-1",
      hostId: "host-1",
    });

    await store.getState().acceptPendingHostKeyPrompt("replace");

    expect(api.knownHosts.replace).toHaveBeenCalled();
    expect(api.portForwards.start).toHaveBeenCalledWith("pf-1");
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
  });

  // 실기기 증상: 정지를 눌러 포워딩이 멈춘 뒤에도 "코드를 입력하세요" 카드가 그대로 남았다.
  // 코어의 portForwardStopped 는 메인에서 런타임 레코드로 바뀌어 이 핸들러로 오므로(그 지점에서
  // return 한다), handleCoreEvent 쪽 정리 코드는 실기기에서 도달하지 않는다.
  it("takes down the auth card when the forward stops", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      portForwards: [createSshForwardRule()],
      pendingInteractiveAuths: [{
        source: "portForward",
        endpointId: "pf-1",
        ruleId: "pf-1",
        hostId: "host-1",
        challengeId: "pf-1-1",
        name: null,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false }],
        provider: "generic",
        autoSubmitted: false,
        }],
    });

    store.getState().handlePortForwardEvent({
      runtime: {
        ruleId: "pf-1",
        hostId: "host-1",
        transport: "ssh" as const,
        mode: "local" as const,
        bindAddress: "127.0.0.1",
        bindPort: 8080,
        status: "stopped" as const,
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    });

    expect(store.getState().pendingInteractiveAuths).toEqual([]);
  });

  // 다른 규칙의 카드는 건드리지 않는다.
  it("keeps another rule's auth card when one forward stops", async () => {
    const api = createMockApi();
    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({
      pendingInteractiveAuths: [{
        source: "portForward",
        endpointId: "pf-2",
        ruleId: "pf-2",
        hostId: "host-1",
        challengeId: "pf-2-1",
        name: null,
        instruction: "",
        prompts: [{ label: "Verification code:", echo: false }],
        provider: "generic",
        autoSubmitted: false,
        }],
    });

    store.getState().handlePortForwardEvent({
      runtime: {
        ruleId: "pf-1",
        hostId: "host-1",
        transport: "ssh" as const,
        mode: "local" as const,
        bindAddress: "127.0.0.1",
        bindPort: 8080,
        status: "stopped" as const,
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    });

    expect(store.getState().pendingInteractiveAuths[0]).toMatchObject({
      challengeId: "pf-2-1",
    });
  });

  // 실기기 증상: 시작을 눌러도 화면이 그대로여서 눌렸는지 알 수 없었다. 아래에는 호스트 키 확인과
  // 코어의 SSH 연결(OTP 대기 포함)이 있어 몇십 초가 걸린다 — 누른 즉시 상태가 바뀌어야 한다.
  it("shows starting as soon as start is pressed", async () => {
    const api = createMockApi();
    // 코어 요청을 붙잡아 둔다 — 시작을 누른 직후의 화면 상태를 보려는 것이다.
    const start = createDeferred<Awaited<ReturnType<DesktopApi["portForwards"]["start"]>>>();
    api.portForwards.start = vi.fn().mockReturnValue(start.promise);

    const store = createAppStore(api);
    await store.getState().bootstrap();
    store.setState({ portForwards: [createSshForwardRule()] });

    const starting = store.getState().startPortForward("pf-1");
    await flushMicrotasks();

    // 코어가 아직 답하지 않았는데도 상태가 이미 바뀌어 있어야 한다. 이 아래에는 SSH 연결이 있고,
    // OTP 를 묻는 호스트면 사람이 답할 때까지 몇십 초가 걸린다 — 그동안 화면이 그대로면 사용자는
    // 버튼이 눌렸는지 알 수 없다.
    expect(
      store.getState().portForwardRuntimes.find((runtime) => runtime.ruleId === "pf-1")
        ?.status,
    ).toBe("starting");

    start.reject(new Error("ssh handshake failed"));
    await starting.catch(() => undefined);
  });

  it("leaves an ordinary port forward failure alone", async () => {
    const api = createMockApi();
    seedTrustedHostOne(api);
    const store = createAppStore(api);

    await store.getState().bootstrap();
    store.setState({ portForwards: [createSshForwardRule()] });

    store
      .getState()
      .handlePortForwardEvent(
        createForwardErrorEvent("bind: address already in use"),
      );
    await flushMicrotasks();

    expect(api.knownHosts.probeHost).not.toHaveBeenCalled();
    expect(store.getState().pendingHostKeyPrompt).toBeNull();
    expect(
      store
        .getState()
        .portForwardRuntimes.find((runtime) => runtime.ruleId === "pf-1")
        ?.message,
    ).toBe("bind: address already in use");
  });
});
