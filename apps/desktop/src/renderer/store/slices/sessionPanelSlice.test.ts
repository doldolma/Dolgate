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
  return { slice: state as unknown as SessionPanelSlice, get: () => state };
}

describe('sessionPanelSlice', () => {
  it('폭은 범위 안으로 자른다', () => {
    const { get } = harness();
    get().setSessionPanelWidth(99999);
    expect(get().sessionPanelWidth).toBeLessThanOrEqual(720);
    get().setSessionPanelWidth(10);
    expect(get().sessionPanelWidth).toBeGreaterThanOrEqual(260);
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

  it('기본 섹션(히스토리)을 토글하면 닫힌다', () => {
    // 섹션을 한 번도 고르지 않은 세션의 기본값은 히스토리다.
    const { get } = harness();
    get().toggleSessionPanel();
    expect(get().sessionPanelOpen).toBe(true);
    get().toggleSessionPanelSection('s1', 'history');
    expect(get().sessionPanelOpen).toBe(false);
  });

  it('빈 sessionId 는 무시한다', () => {
    const { get } = harness();
    get().selectSessionPanelSection('', 'ai');
    get().toggleSessionPanelSection('', 'ai');
    expect(get().sessionPanelOpen).toBe(false);
    expect(get().sessionPanelSectionBySessionId['']).toBeUndefined();
  });
});
