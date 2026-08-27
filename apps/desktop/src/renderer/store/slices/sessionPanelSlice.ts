import {
  resolveDefaultSessionPanelSection,
  type SessionPanelSectionId,
} from "../../lib/session-panel";
import {
  resolveSessionPanelStateKey,
  stateKeyForWorkspace,
} from "../../lib/session-panel-scope";
import type { SessionPanelSlice, SliceDeps } from "../types";

// 패널 상태는 창 단위다(스토어가 창마다 하나) — 영속화하지 않는다. AI 패널 폭과 같은 결이다.
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 260;
const MAX_WIDTH = 720;

export function createSessionPanelSlice(deps: SliceDeps): SessionPanelSlice {
  const { set, get } = deps;

  /**
   * 살아 있는 세션의 것만 남긴다.
   *
   * 이 맵은 세션마다 항목이 하나 생기는데 세션이 닫혀도 지워지지 않아 앱 수명 동안 커졌다.
   * 세션이 닫히는 경로가 여러 개(사용자 닫기·tmux window close·재연결 실패…)라 그 자리마다
   * 지우는 대신, 사람이 섹션을 고를 때 한 번씩 훑는다 — 자주 일어나지 않고, 남아 있어도
   * 해가 없는 값이라 이 시점이면 충분하다.
   */
  function pruneSections(
    sections: Record<string, SessionPanelSectionId | null>,
  ): Record<string, SessionPanelSectionId | null> {
    // 살아 있는 목록을 알 수 없으면 **아무것도 지우지 않는다.** 모른다고 비우면 보고 있던
    // 섹션까지 잃는다(슬라이스만 떼어 굴리는 테스트 하네스처럼 tabs 가 없는 경우).
    const tabs = get().tabs;
    if (!tabs) {
      return sections;
    }
    const live = new Set(tabs.map((tab) => tab.sessionId));
    // tmux 창은 pane 이 아니라 창 자체가 키다 — 살아 있는 창의 키도 남긴다.
    for (const workspace of get().workspaces ?? []) {
      const key = stateKeyForWorkspace(workspace);
      if (key) {
        live.add(key);
      }
    }
    const entries = Object.entries(sections).filter(([sessionId]) =>
      live.has(sessionId),
    );
    if (entries.length === Object.keys(sections).length) {
      return sections;
    }
    return Object.fromEntries(entries);
  }

  return {
    sessionPanelOpen: false,
    sessionPanelWidth: DEFAULT_WIDTH,
    sessionPanelSectionBySessionId: {},

    toggleSessionPanel: () => {
      set((state) => ({ sessionPanelOpen: !state.sessionPanelOpen }));
    },

    setSessionPanelWidth: (width) => {
      set({
        sessionPanelWidth: Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, Math.round(width)),
        ),
      });
    },

    // 섹션을 골라 보여 준다. 패널이 닫혀 있으면 함께 연다 — 레일 클릭뿐 아니라 "이 명령을
    // AI 에게" 처럼 밖에서 부르는 경로도 이걸 쓴다.
    //
    // 같은 것을 다시 눌러도 닫지 않는다. 여닫는 것은 상단 바 토글과 ⌘I 의 몫이다.
    selectSessionPanelSection: (sessionId, section) => {
      if (!sessionId) {
        return;
      }
      // **tmux 창 안에서는 pane 이 아니라 창이 단위다.** 부르는 쪽(레일·상태바·단축키·AI 열기)은
      // 그대로 sessionId 를 넘기고, 정규화는 여기서 한 번만 한다.
      const key = resolveSessionPanelStateKey(get().workspaces, sessionId);
      set((state) => ({
        sessionPanelOpen: true,
        sessionPanelSectionBySessionId: {
          ...pruneSections(state.sessionPanelSectionBySessionId),
          [key]: section,
        },
      }));
    },

    // ⌘I 처럼 "그 섹션으로 여닫기". 이미 그 섹션을 보고 있으면 닫는다.
    toggleSessionPanelSection: (sessionId, section) => {
      if (!sessionId) {
        return;
      }
      const key = resolveSessionPanelStateKey(get().workspaces, sessionId);
      set((state) => {
        // 기본값 판정은 패널과 **같은** 규칙을 써야 한다 — 갈리면 아직 아무것도 고르지 않은
        // 세션에서 ⌘I 가 보고 있는 섹션을 닫지 못하고 그 섹션을 다시 여는 것으로 끝난다.
        const showing =
          state.sessionPanelOpen &&
          (state.sessionPanelSectionBySessionId[key] ??
            resolveDefaultSessionPanelSection(
              state.tabs?.find((tab) => tab.sessionId === sessionId)?.source,
            )) === section;
        if (showing) {
          return { sessionPanelOpen: false };
        }
        return {
          sessionPanelOpen: true,
          sessionPanelSectionBySessionId: {
            ...pruneSections(state.sessionPanelSectionBySessionId),
            [key]: section,
          },
        };
      });
    },
  };
}
