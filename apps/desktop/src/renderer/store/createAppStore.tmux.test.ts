import { describe, expect, it } from "vitest";
import { createAppStore } from "./createAppStore";
import { createMockApi } from "./createAppStore.test-support";
import { asWorkspaceTabId } from "./utils";

// tmux control mode 세션-윈도우-pane 그룹 모델(handleTmuxLayoutChange) 회귀 테스트.
// 특히 "윈도우 하나 닫아도 세션/다른 윈도우가 살아남는지"(close-all 회귀)를 가드한다.
describe("createAppStore tmux session grouping", () => {
  const CTL = "ctl-1";
  // 단일 pane window 레이아웃. 끝 숫자가 pane id → sessionId tmux:<ctl>:<n>.
  const layoutFor = (paneNum: number) => `bd5e,80x24,0,0,${paneNum}`;

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
    const firstGroupId = store.getState().tmuxGroups[0]?.id;
    const firstStableId = store
      .getState()
      .tabs.find((tab) => tab.tmux?.windowId === "@0")?.stableId;

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
});
