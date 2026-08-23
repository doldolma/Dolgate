import type { SessionPanelSlice, SliceDeps } from "../types";

// 패널 상태는 창 단위다(스토어가 창마다 하나) — 영속화하지 않는다. AI 패널 폭과 같은 결이다.
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 260;
const MAX_WIDTH = 720;

export function createSessionPanelSlice(deps: SliceDeps): SessionPanelSlice {
  const { set } = deps;

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
      set((state) => ({
        sessionPanelOpen: true,
        sessionPanelSectionBySessionId: {
          ...state.sessionPanelSectionBySessionId,
          [sessionId]: section,
        },
      }));
    },

    // ⌘I 처럼 "그 섹션으로 여닫기". 이미 그 섹션을 보고 있으면 닫는다.
    toggleSessionPanelSection: (sessionId, section) => {
      if (!sessionId) {
        return;
      }
      set((state) => {
        const showing =
          state.sessionPanelOpen &&
          (state.sessionPanelSectionBySessionId[sessionId] ?? 'history') === section;
        if (showing) {
          return { sessionPanelOpen: false };
        }
        return {
          sessionPanelOpen: true,
          sessionPanelSectionBySessionId: {
            ...state.sessionPanelSectionBySessionId,
            [sessionId]: section,
          },
        };
      });
    },
  };
}
