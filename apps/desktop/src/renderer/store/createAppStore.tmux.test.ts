import { describe, expect, it, vi } from "vitest";
import type { HostRecord } from "@shared";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { asWorkspaceTabId } from "./utils";

// tmux control mode 세션-윈도우-pane 그룹 모델(handleTmuxLayoutChange) 회귀 테스트.
// 특히 "윈도우 하나 닫아도 세션/다른 윈도우가 살아남는지"(close-all 회귀)를 가드한다.
describe("createAppStore tmux session grouping", () => {
  const CTL = "ctl-1";
  // 단일 pane window 레이아웃. 끝 숫자가 pane id → sessionId tmux:<ctl>:<n>.
  const layoutFor = (paneNum: number) => `bd5e,80x24,0,0,${paneNum}`;
  const RECONNECT_HOST: HostRecord = {
    id: "h1",
    kind: "ssh",
    label: "Prod",
    hostname: "prod.example.com",
    port: 22,
    username: "ubuntu",
    authType: "password",
    privateKeyPath: null,
    secretRef: null,
    jumpHostId: null,
    startupCommand: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };

  it("creates one session group + one top tab for the first window", () => {
    const store = createAppStore(createMockApi());
    store
      .getState()
      .handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
        index: 0,
        name: "zsh",
        active: true,
      });

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(1);
    expect(state.tmuxGroups[0]?.controlSessionId).toBe(CTL);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.tmux).toMatchObject({
      controlSessionId: CTL,
      windowId: "@0",
      index: 0,
      name: "zsh",
    });
    // 상단 탭은 세션 그룹 하나뿐(윈도우별 탭이 아님).
    expect(state.tabStrip).toEqual([
      { kind: "tmux", tmuxGroupId: state.tmuxGroups[0]?.id },
    ]);
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${state.tmuxGroups[0]?.id}`);
    expect(state.tabs.some((tab) => tab.sessionId === `tmux:${CTL}:0`)).toBe(
      true,
    );
  });

  it("adds a second window to the SAME group without a second top tab", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      name: "zsh",
      active: true,
    });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), {
      index: 1,
      name: "logs",
      active: false,
    });

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(1); // 같은 세션 → 그룹 1개
    expect(state.workspaces).toHaveLength(2); // 윈도우 2개
    expect(
      state.tabStrip.filter((item) => item.kind === "tmux"),
    ).toHaveLength(1); // 상단 탭은 여전히 1개
  });

  it("keeps the session + other windows alive when ONE window closes (close-all regression)", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      name: "zsh",
      active: true,
    });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), {
      index: 1,
      name: "logs",
      active: false,
    });

    // %window-close 로 @0 만 제거(로컬 정리).
    store.getState().removeTmuxWorkspacesLocal(CTL, "@0");

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(1); // 세션 생존
    expect(state.workspaces).toHaveLength(1); // @1 만 남음
    expect(state.workspaces[0]?.tmux?.windowId).toBe("@1");
    // 닫힌 @0 가 활성이었으므로 그룹 활성 윈도우가 @1 로 옮겨졌다.
    expect(state.tmuxGroups[0]?.activeWorkspaceId).toBe(
      state.workspaces[0]?.id,
    );
    expect(state.tabStrip.filter((item) => item.kind === "tmux")).toHaveLength(
      1,
    );
  });

  it("removes the group + top tab when the LAST window closes", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      name: "zsh",
      active: true,
    });

    store.getState().removeTmuxWorkspacesLocal(CTL, "@0");

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(0);
    expect(state.workspaces).toHaveLength(0);
    expect(state.tabStrip.filter((item) => item.kind === "tmux")).toHaveLength(
      0,
    );
  });

  it("switches to a sibling tmux group (not home) when the active group closes", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    // 두 개의 별도 tmux 세션(그룹). 충돌 피하려 windowId 를 다르게.
    api.handleTmuxLayoutChange("ctl-1", "@0", layoutFor(0), { index: 0 });
    api.handleTmuxLayoutChange("ctl-2", "@1", layoutFor(0), { index: 0 });
    const groupOne = store
      .getState()
      .tmuxGroups.find((group) => group.controlSessionId === "ctl-1");
    const groupTwo = store
      .getState()
      .tmuxGroups.find((group) => group.controlSessionId === "ctl-2");
    expect(groupOne && groupTwo).toBeTruthy();

    // 그룹 1 을 활성화한 뒤 그 마지막 윈도우를 닫는다.
    store.getState().activateTmuxGroup(groupOne!.id);
    store.getState().removeTmuxWorkspacesLocal("ctl-1", "@0");

    const state = store.getState();
    // home 으로 튀지 않고 형제 그룹(2)으로 전환되어야 한다(resolveNextVisibleTab tmux 처리).
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${groupTwo!.id}`);
    expect(state.tmuxGroups).toHaveLength(1);
  });

  it("keeps the session group tab active (tmuxgrp:) when focusing a tmux pane", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      name: "zsh",
      active: true,
    });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), {
      index: 1,
      name: "logs",
      active: false,
    });
    const group = store.getState().tmuxGroups[0]!;
    const win1 = store
      .getState()
      .workspaces.find((w) => w.tmux?.windowId === "@1")!;

    // pane 클릭(focus) → 윈도우 @1 로 전환되지만 상단 탭은 tmuxgrp: 유지(#3).
    store.getState().focusWorkspaceSession(win1.id, `tmux:${CTL}:1`);

    const state = store.getState();
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${group.id}`);
    expect(state.tmuxGroups[0]?.activeWorkspaceId).toBe(win1.id);
  });

  it("keeps tmuxgrp: active (not workspace:) when activating a tmux window", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0, active: true });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), { index: 1, active: false });
    const group = store.getState().tmuxGroups[0]!;
    const win1 = store
      .getState()
      .workspaces.find((w) => w.tmux?.windowId === "@1")!;

    store.getState().activateWorkspace(win1.id);

    const state = store.getState();
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${group.id}`);
    expect(state.tmuxGroups[0]?.activeWorkspaceId).toBe(win1.id);
  });

  it("keeps the group tab active (no blank screen) when the active window closes but the group survives", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0, active: true });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), { index: 1, active: false });
    const group = store.getState().tmuxGroups[0]!;

    // 활성 윈도우(@0) 를 닫는다 — 그룹은 @1 로 생존.
    store.getState().removeTmuxWorkspacesLocal(CTL, "@0");

    const state = store.getState();
    // 빈 화면 회귀 게이트: 활성 탭이 dangling 이 아니라 여전히 그룹 탭.
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${group.id}`);
    expect(state.workspaces).toHaveLength(1);
    expect(state.tmuxGroups[0]?.activeWorkspaceId).toBe(
      state.workspaces[0]?.id,
    );
  });

  it("recovers from a dangling workspace: active tab when its tmux window closes (group survives)", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0, active: true });
    api.handleTmuxLayoutChange(CTL, "@1", layoutFor(1), { index: 1, active: false });
    const group = store.getState().tmuxGroups[0]!;
    const win0 = store
      .getState()
      .workspaces.find((w) => w.tmux?.windowId === "@0")!;
    // 방어 경로: activeWorkspaceTab 이 어쩌다 닫히는 윈도우의 workspace: 일 때.
    store.setState({ activeWorkspaceTab: asWorkspaceTabId(win0.id) });

    store.getState().removeTmuxWorkspacesLocal(CTL, "@0");

    // 그룹 생존 → 그룹 탭으로 복귀(흰 화면 방지), 삭제된 workspace: 로 남지 않음.
    expect(store.getState().activeWorkspaceTab).toBe(`tmuxgrp:${group.id}`);
  });

  it("names the session group from the layout-change payload sessionName (no host fallback)", () => {
    const store = createAppStore(createMockApi());
    // layout-change payload 가 sessionName 을 실어오면(=Go handle.sessionName) 그룹은
    // 호스트명 fallback 대신 실제 tmux 세션명으로 생성된다(이벤트 순서 무관).
    store.getState().handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      active: true,
      sessionName: "dolgate",
    });
    expect(store.getState().tmuxGroups[0]?.sessionName).toBe("dolgate");

    // 후속 payload 에 빈 sessionName 이 와도 기존 세션명을 클로버하지 않는다.
    store.getState().handleTmuxLayoutChange(CTL, "@1", layoutFor(1), {
      index: 1,
      active: false,
    });
    expect(store.getState().tmuxGroups[0]?.sessionName).toBe("dolgate");
  });

  it("updates the session group footer name on %session-changed (applyTmuxSessionName)", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange("ctl-1", "@0", layoutFor(0), { index: 0 });
    api.handleTmuxLayoutChange("ctl-2", "@1", layoutFor(0), { index: 0 });

    store.getState().applyTmuxSessionName("ctl-1", "prod-tmux");

    const state = store.getState();
    expect(
      state.tmuxGroups.find((g) => g.controlSessionId === "ctl-1")?.sessionName,
    ).toBe("prod-tmux");
    // 다른 세션 그룹은 영향 없음.
    expect(
      state.tmuxGroups.find((g) => g.controlSessionId === "ctl-2")?.sessionName,
    ).not.toBe("prod-tmux");
    // 빈 이름은 무시(기존 값 클로버 방지).
    const before = state.tmuxGroups.find(
      (g) => g.controlSessionId === "ctl-1",
    )?.sessionName;
    store.getState().applyTmuxSessionName("ctl-1", "");
    expect(
      store
        .getState()
        .tmuxGroups.find((g) => g.controlSessionId === "ctl-1")?.sessionName,
    ).toBe(before);
  });

  it("places the session group tab where the control session tab was (open-in-current-tab position)", () => {
    const store = createAppStore(createMockApi());
    // tabStrip: [다른 세션, control 세션 탭]. control 탭이 인덱스 1 에 있다(원 세션
    // 슬롯을 재사용한 상황을 모사). 그룹 탭은 끝에 append 가 아니라 이 자리에 들어서야
    // "현재 탭에서 열기"가 성립한다.
    store.setState({
      tabStrip: [
        { kind: "session", sessionId: "other" },
        { kind: "session", sessionId: CTL },
      ],
    });

    store.getState().handleTmuxLayoutChange(CTL, "@0", layoutFor(0), {
      index: 0,
      active: true,
    });

    const state = store.getState();
    expect(state.tabStrip).toHaveLength(2);
    expect(state.tabStrip[0]).toEqual({ kind: "session", sessionId: "other" });
    expect(state.tabStrip[1]?.kind).toBe("tmux"); // control 탭 자리에 그룹 탭
    // control 세션 standalone 탭은 흡수되어 사라진다.
    expect(
      state.tabStrip.some(
        (item) => item.kind === "session" && item.sessionId === CTL,
      ),
    ).toBe(false);
  });

  it("updates the group's remote session list on %sessions-changed (applyTmuxSessionsList)", () => {
    const store = createAppStore(createMockApi());
    const api = store.getState();
    api.handleTmuxLayoutChange("ctl-1", "@0", layoutFor(0), { index: 0 });
    api.handleTmuxLayoutChange("ctl-2", "@1", layoutFor(0), { index: 0 });

    store.getState().applyTmuxSessionsList("ctl-1", [
      { name: "dolgate", windows: 2, attached: true },
      { name: "work", windows: 1, attached: false },
    ]);

    const state = store.getState();
    const g1 = state.tmuxGroups.find((g) => g.controlSessionId === "ctl-1");
    expect(g1?.sessions?.map((s) => s.name)).toEqual(["dolgate", "work"]);
    // 다른 control 세션 그룹은 영향 없음.
    expect(
      state.tmuxGroups.find((g) => g.controlSessionId === "ctl-2")?.sessions,
    ).toBeUndefined();
  });

  it("rebinds the same group/window on reconnect (new controlSessionId, same windowId)", () => {
    const store = createAppStore(createMockApi());
    store
      .getState()
      .handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0, name: "zsh" });
    const firstGroupId = store.getState().tmuxGroups[0]!.id;
    const firstStableId = store
      .getState()
      .tabs.find((tab) => tab.tmux?.windowId === "@0")?.stableId;

    // 실제 재연결 흐름: control 끊김 → 그룹이 reconnecting 으로 표시된 뒤 새 control
    // 세션이 같은 windowId 로 붙어 rebind 된다(살아있는 신규 tmux 와 구분하는 신호).
    store.getState().applyTmuxGroupReconnecting(
      firstGroupId,
      { attempt: 1, maxAttempts: 10, nextAttemptAt: 0, waitingForNetwork: false },
      "재연결 중…",
    );
    // 재연결: 새 control 세션 id, 같은 windowId.
    store
      .getState()
      .handleTmuxLayoutChange("ctl-2", "@0", "bd5e,80x24,0,0,0", {
        index: 0,
        name: "zsh",
      });

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(1); // 새 그룹이 생기지 않음
    expect(state.tmuxGroups[0]?.id).toBe(firstGroupId); // 그룹 id 불변
    expect(state.tmuxGroups[0]?.controlSessionId).toBe("ctl-2"); // controlSessionId rebind
    expect(state.workspaces).toHaveLength(1); // 윈도우 중복 안 생김
    // 터미널 remount 방지: pane stableId 는 windowId 기반이라 재연결에도 불변.
    const rebound = state.tabs.find((tab) => tab.tmux?.windowId === "@0");
    expect(rebound?.stableId).toBe(firstStableId);
  });

  it("toggles group.reconnect + pane status via applyTmuxGroupReconnecting/GaveUp", () => {
    const store = createAppStore(createMockApi());
    store.getState().handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0 });
    const groupId = store.getState().tmuxGroups[0]!.id;

    store.getState().applyTmuxGroupReconnecting(
      groupId,
      { attempt: 2, maxAttempts: 10, nextAttemptAt: 0, waitingForNetwork: false },
      "재연결 중…",
    );
    expect(store.getState().tmuxGroups[0]?.reconnect?.attempt).toBe(2);
    expect(
      store.getState().tabs.find((t) => t.tmux?.windowId === "@0")?.status,
    ).toBe("connecting");

    store.getState().applyTmuxGroupReconnectGaveUp(groupId, "끊김");
    expect(store.getState().tmuxGroups[0]?.reconnect ?? null).toBeNull();
    expect(
      store.getState().tabs.find((t) => t.tmux?.windowId === "@0")?.status,
    ).toBe("error");
  });

  it("clears group.reconnect + restores pane status when the control session rebinds", () => {
    const store = createAppStore(createMockApi());
    store.getState().handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0 });
    const groupId = store.getState().tmuxGroups[0]!.id;
    store.getState().applyTmuxGroupReconnecting(
      groupId,
      { attempt: 1, maxAttempts: 10, nextAttemptAt: 0, waitingForNetwork: false },
      "재연결 중…",
    );
    expect(store.getState().tmuxGroups[0]?.reconnect).not.toBeNull();

    // 새 control 세션 rebind(재연결 성공) → reconnect 해제 + 패인 'connected'.
    store
      .getState()
      .handleTmuxLayoutChange("ctl-2", "@0", layoutFor(0), { index: 0 });
    const state = store.getState();
    expect(state.tmuxGroups[0]?.controlSessionId).toBe("ctl-2");
    expect(state.tmuxGroups[0]?.reconnect ?? null).toBeNull();
    expect(state.tabs.find((t) => t.tmux?.windowId === "@0")?.status).toBe(
      "connected",
    );
  });

  it("prunes orphaned windows of the old control session after reconnect to a fresh tmux (reboot)", () => {
    vi.useFakeTimers();
    try {
      const store = createAppStore(createMockApi());
      const api = store.getState();
      api.handleTmuxLayoutChange("rb-old", "@0", layoutFor(0), { index: 0 });
      api.handleTmuxLayoutChange("rb-old", "@1", layoutFor(1), { index: 1 });
      expect(store.getState().workspaces).toHaveLength(2);

      // 실제 재부팅 흐름: control 끊김 → 그룹이 reconnecting 으로 표시된 뒤 새 control
      // 세션이 attach 한다.
      const rebootGroupId = store.getState().tmuxGroups[0]!.id;
      store.getState().applyTmuxGroupReconnecting(
        rebootGroupId,
        { attempt: 1, maxAttempts: 10, nextAttemptAt: 0, waitingForNetwork: false },
        "재연결 중…",
      );
      // 서버 재부팅 → 새 control 세션에서 @0 만 재출현(@1 은 사라짐).
      store
        .getState()
        .handleTmuxLayoutChange("rb-new", "@0", layoutFor(0), { index: 0 });
      // 디바운스 전: 아직 @1(rb-old) 고스트 workspace 가 남아 있다.
      expect(
        store
          .getState()
          .workspaces.some((w) => w.tmux?.controlSessionId === "rb-old"),
      ).toBe(true);

      vi.advanceTimersByTime(500);

      const state = store.getState();
      expect(state.tmuxGroups).toHaveLength(1);
      expect(state.tmuxGroups[0]?.controlSessionId).toBe("rb-new");
      // 고스트 @1 제거됨; @0(rb-new)만 남음.
      expect(state.workspaces).toHaveLength(1);
      expect(state.workspaces[0]?.tmux?.windowId).toBe("@0");
      expect(state.workspaces[0]?.tmux?.controlSessionId).toBe("rb-new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overwrite a live group when a 3rd tmux opens with the same windowId", () => {
    const store = createAppStore(createMockApi());
    // 살아있는 tmux 그룹 2개(서로 다른 control 세션, 같은 windowId @0).
    store
      .getState()
      .handleTmuxLayoutChange("ctl-a", "@0", layoutFor(0), { index: 0 });
    store
      .getState()
      .handleTmuxLayoutChange("ctl-b", "@0", layoutFor(0), { index: 0 });
    expect(store.getState().tmuxGroups).toHaveLength(2);

    // 3번째 tmux 를 추가로 연다(reconnecting 아님 = 신규). 같은 windowId @0 이지만
    // 살아있는 기존 그룹을 덮어쓰지 않고 새 그룹이 추가돼야 한다.
    store
      .getState()
      .handleTmuxLayoutChange("ctl-c", "@0", layoutFor(0), { index: 0 });

    const state = store.getState();
    expect(state.tmuxGroups).toHaveLength(3);
    expect(state.tmuxGroups.map((g) => g.controlSessionId).sort()).toEqual([
      "ctl-a",
      "ctl-b",
      "ctl-c",
    ]);
    // 첫 그룹(ctl-a)의 pane 세션이 마지막 세션으로 덮어씌워지지 않았다.
    expect(state.tabs.some((t) => t.sessionId === "tmux:ctl-a:0")).toBe(true);
    expect(state.tabs.some((t) => t.sessionId === "tmux:ctl-c:0")).toBe(true);
  });

  // 재연결 시 "탭 하나 더 생기면서 SSH 연결 시도"하던 회귀 가드: tmux 재연결
  // (reconnectGroupId)은 새 control 세션을 standalone 탭(tabStrip)으로 만들지 않고
  // 그룹 자리에서 진행한다 → 별도 SSH 탭이 보이거나 시도마다 쌓이지 않는다.
  it("does NOT create a standalone control tab on tmux reconnect (reconnectGroupId)", async () => {
    const store = createAppStore(createMockApi());
    store.setState({ hosts: [RECONNECT_HOST] });
    store
      .getState()
      .handleTmuxLayoutChange(CTL, "@0", layoutFor(0), { index: 0, active: true });
    // 그룹 hostId 는 control 탭에서 캡처되는데 테스트엔 control 탭이 없으므로 명시 세팅.
    store.setState((s) => ({
      tmuxGroups: s.tmuxGroups.map((g) => ({ ...g, hostId: "h1" })),
    }));
    const groupId = store.getState().tmuxGroups[0]!.id;
    expect(
      store.getState().tabStrip.filter((i) => i.kind === "session"),
    ).toHaveLength(0);

    // reconnect-handlers.perform 이 넘기는 형태: 8번째 인자 reconnectGroupId.
    await store
      .getState()
      .connectHost("h1", 120, 32, undefined, true, undefined, undefined, groupId);

    const state = store.getState();
    // 핵심: 탭바에 별도 standalone control 탭이 생기지 않는다(그룹 탭 1개만).
    expect(state.tabStrip.filter((i) => i.kind === "session")).toHaveLength(0);
    expect(state.tabStrip.filter((i) => i.kind === "tmux")).toHaveLength(1);
    // 화면도 그룹 탭을 유지(control 세션 pending 으로 튀지 않음).
    expect(state.activeWorkspaceTab).toBe(`tmuxgrp:${groupId}`);
    // control 세션은 흡수/이벤트용으로 tabs 에만 존재하고 tabStrip(탭바)엔 없다
    // → 화면에 별도 탭으로 안 보이지만, layout-change 가 오면 그룹으로 흡수될 수 있다.
    const controlTab = state.tabs.find((t) => t.hostId === "h1" && !t.tmux);
    expect(controlTab).toBeTruthy();
    expect(
      state.tabStrip.some(
        (i) => i.kind === "session" && i.sessionId === controlTab!.sessionId,
      ),
    ).toBe(false);
  });

  // 대조군: 일반(비-재연결) 연결은 기존대로 standalone 세션 탭을 만든다(정상 동작 보존).
  it("still creates a standalone tab for a normal (non-reconnect) connect", async () => {
    const store = createAppStore(createMockApi());
    store.setState({ hosts: [RECONNECT_HOST] });

    await store.getState().connectHost("h1", 120, 32);

    expect(
      store.getState().tabStrip.filter((i) => i.kind === "session"),
    ).toHaveLength(1);
  });
});
