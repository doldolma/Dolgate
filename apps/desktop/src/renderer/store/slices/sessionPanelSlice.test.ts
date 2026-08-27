import { describe, expect, it } from 'vitest';
import { createSessionPanelSlice } from './sessionPanelSlice';
import type { AppState, SessionPanelSlice } from '../types';

/** 슬라이스만 떼어 굴리는 최소 하네스(다른 슬라이스는 건드리지 않는다). */
function harness() {
  let state = {} as AppState;
  const set = (partial: unknown) => {
    const next =
      typeof partial === 'function'
        ? (partial as (current: AppState) => Partial<AppState>)(state)
        : (partial as Partial<AppState>);
    state = { ...state, ...next };
  };
  const slice = createSessionPanelSlice({
    api: {} as never,
    set: set as never,
    get: (() => state) as never,
  });
  state = { ...state, ...slice } as AppState;
  return {
    slice: state as unknown as SessionPanelSlice,
    get: () => state,
    /** 살아 있는 세션 목록을 흉내낸다(섹션 기억 정리와 기본 섹션 판정이 이것을 본다). */
    setTabs: (tabs: Array<{ sessionId: string; source?: string }>) => {
      state = { ...state, tabs } as AppState;
    },
    /** 워크스페이스(=창) 목록. tmux 창이면 섹션을 pane 이 아니라 창 단위로 기억한다. */
    setWorkspaces: (workspaces: unknown[]) => {
      state = { ...state, workspaces } as AppState;
    },
  };
}

describe('sessionPanelSlice', () => {
  it('폭은 범위 안으로 자른다', () => {
    const { get } = harness();
    get().setSessionPanelWidth(99999);
    expect(get().sessionPanelWidth).toBeLessThanOrEqual(720);
    get().setSessionPanelWidth(10);
    expect(get().sessionPanelWidth).toBeGreaterThanOrEqual(260);
  });

  it('닫힌 세션의 섹션 기억은 다음 선택에서 정리된다', () => {
    // 세션마다 항목이 하나 생기는데 세션이 닫히는 경로가 여러 개라, 그 자리마다 지우는 대신
    // 사람이 섹션을 고를 때 훑는다. 정리하지 않으면 앱 수명 동안 계속 커진다.
    const { get, setTabs } = harness();
    setTabs([{ sessionId: 's1' }, { sessionId: 's2' }]);
    get().selectSessionPanelSection('s1', 'ai');
    get().selectSessionPanelSection('s2', 'ports');
    expect(Object.keys(get().sessionPanelSectionBySessionId).sort()).toEqual(['s1', 's2']);

    // s1 이 닫혔다.
    setTabs([{ sessionId: 's2' }]);
    get().selectSessionPanelSection('s2', 'history');
    expect(Object.keys(get().sessionPanelSectionBySessionId)).toEqual(['s2']);
  });

  it('살아 있는 목록을 모르면 아무것도 지우지 않는다', () => {
    // 모른다고 비우면 보고 있던 섹션까지 잃는다.
    const { get } = harness();
    get().selectSessionPanelSection('s1', 'ai');
    get().selectSessionPanelSection('s2', 'ports');
    expect(Object.keys(get().sessionPanelSectionBySessionId).sort()).toEqual(['s1', 's2']);
  });

  it('섹션을 고르면 패널이 함께 열린다', () => {
    // "이 명령을 AI 에게" 처럼 밖에서 부르는 경로가 이걸 쓴다 — 닫혀 있으면 열려야 한다.
    const { get } = harness();
    expect(get().sessionPanelOpen).toBe(false);
    get().selectSessionPanelSection('s1', 'ai');
    expect(get().sessionPanelOpen).toBe(true);
    expect(get().sessionPanelSectionBySessionId.s1).toBe('ai');
  });

  it('같은 섹션을 다시 골라도 닫지 않는다', () => {
    // 레일에서 닫히면 "왜 사라졌지" 가 된다. 여닫는 것은 상단 바 토글과 ⌘I 의 몫이다.
    const { get } = harness();
    get().selectSessionPanelSection('s1', 'history');
    get().selectSessionPanelSection('s1', 'history');
    expect(get().sessionPanelOpen).toBe(true);
  });

  it('토글은 그 섹션을 보고 있을 때만 닫는다', () => {
    const { get } = harness();
    get().toggleSessionPanelSection('s1', 'ai');
    expect(get().sessionPanelOpen).toBe(true);
    expect(get().sessionPanelSectionBySessionId.s1).toBe('ai');

    // 다른 섹션을 보고 있으면 그 섹션으로 바꿔 준다(닫지 않는다).
    get().selectSessionPanelSection('s1', 'history');
    get().toggleSessionPanelSection('s1', 'ai');
    expect(get().sessionPanelOpen).toBe(true);
    expect(get().sessionPanelSectionBySessionId.s1).toBe('ai');

    // 같은 섹션이면 닫는다.
    get().toggleSessionPanelSection('s1', 'ai');
    expect(get().sessionPanelOpen).toBe(false);
  });

  it('기본 섹션을 토글하면 닫힌다', () => {
    // 세션을 알 수 없으면(지표가 없는 세션도 같다) 기본값은 히스토리다.
    const { get } = harness();
    get().toggleSessionPanel();
    expect(get().sessionPanelOpen).toBe(true);
    get().toggleSessionPanelSection('s1', 'history');
    expect(get().sessionPanelOpen).toBe(false);
  });

  // 기본값 판정이 패널과 갈리면, 아직 아무것도 고르지 않은 호스트 세션에서 ⌘I 가 보고 있는
  // 섹션을 닫지 못하고 그 섹션을 다시 여는 것으로 끝난다.
  it('붙은 호스트 세션의 기본은 자원이라 그것으로 닫힌다', () => {
    const { get, setTabs } = harness();
    setTabs([{ sessionId: 's1', source: 'host' }]);
    get().toggleSessionPanel();
    get().toggleSessionPanelSection('s1', 'resources');
    expect(get().sessionPanelOpen).toBe(false);

    get().toggleSessionPanelSection('s1', 'history');
    expect(get().sessionPanelOpen).toBe(true);
    expect(get().sessionPanelSectionBySessionId.s1).toBe('history');
  });

  it('빈 sessionId 는 무시한다', () => {
    const { get } = harness();
    get().selectSessionPanelSection('', 'ai');
    get().toggleSessionPanelSection('', 'ai');
    expect(get().sessionPanelOpen).toBe(false);
    expect(get().sessionPanelSectionBySessionId['']).toBeUndefined();
  });
});

describe('tmux 창', () => {
  /** pane 둘짜리 tmux 창 하나. */
  function tmuxWindow() {
    return {
      id: 'ws-1',
      activeSessionId: 'tmux:ctl:%1',
      tmux: { controlSessionId: 'ctl', windowId: '@0' },
      layout: {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'leaf', sessionId: 'tmux:ctl:%0' },
        second: { kind: 'leaf', sessionId: 'tmux:ctl:%1' },
      },
    };
  }

  it('섹션은 pane 이 아니라 창에 기억한다', () => {
    // tmux 창은 호스트 하나다. pane 마다 따로 기억하면 pane 을 옮길 때마다 보던 섹션이 바뀐다.
    const { get, setTabs, setWorkspaces } = harness();
    setTabs([
      { sessionId: 'tmux:ctl:%0', source: 'host' },
      { sessionId: 'tmux:ctl:%1', source: 'host' },
    ]);
    setWorkspaces([tmuxWindow()]);

    get().selectSessionPanelSection('tmux:ctl:%1', 'docker');

    expect(get().sessionPanelSectionBySessionId).toEqual({ 'tmuxwin:ctl:@0': 'docker' });
  });

  it('다른 pane 에서 토글해도 같은 자리를 본다', () => {
    const { get, setTabs, setWorkspaces } = harness();
    setTabs([
      { sessionId: 'tmux:ctl:%0', source: 'host' },
      { sessionId: 'tmux:ctl:%1', source: 'host' },
    ]);
    setWorkspaces([tmuxWindow()]);
    get().selectSessionPanelSection('tmux:ctl:%1', 'docker');

    // 다른 pane 에서 같은 섹션을 토글하면 "보고 있는 것" 이므로 닫힌다.
    get().toggleSessionPanelSection('tmux:ctl:%0', 'docker');

    expect(get().sessionPanelOpen).toBe(false);
    expect(get().sessionPanelSectionBySessionId).toEqual({ 'tmuxwin:ctl:@0': 'docker' });
  });

  it('창 키는 정리에서 살아남는다', () => {
    // 정리는 "살아 있는 세션 id 만" 남기던 규칙이라, 창 키가 통째로 지워지면 보던 섹션을 잃는다.
    const { get, setTabs, setWorkspaces } = harness();
    setTabs([
      { sessionId: 'tmux:ctl:%0', source: 'host' },
      { sessionId: 'tmux:ctl:%1', source: 'host' },
    ]);
    setWorkspaces([tmuxWindow()]);
    get().selectSessionPanelSection('tmux:ctl:%1', 'docker');

    get().selectSessionPanelSection('tmux:ctl:%0', 'resources');

    expect(get().sessionPanelSectionBySessionId).toEqual({ 'tmuxwin:ctl:@0': 'resources' });
  });

  it('우리 분할은 pane 마다 따로 기억한다', () => {
    const { get, setTabs, setWorkspaces } = harness();
    setTabs([
      { sessionId: 'session-a', source: 'host' },
      { sessionId: 'session-b', source: 'host' },
    ]);
    setWorkspaces([
      {
        id: 'ws-2',
        activeSessionId: 'session-b',
        layout: {
          kind: 'split',
          direction: 'row',
          ratio: 0.5,
          first: { kind: 'leaf', sessionId: 'session-a' },
          second: { kind: 'leaf', sessionId: 'session-b' },
        },
      },
    ]);

    get().selectSessionPanelSection('session-a', 'docker');
    get().selectSessionPanelSection('session-b', 'resources');

    expect(get().sessionPanelSectionBySessionId).toEqual({
      'session-a': 'docker',
      'session-b': 'resources',
    });
  });
});
