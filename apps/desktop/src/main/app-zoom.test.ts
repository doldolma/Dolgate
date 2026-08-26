import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
}));

import { APP_ZOOM_STEPS, nearestZoomStepIndex, prepareWindowZoom } from './app-zoom';

describe('화면 배율 단계', () => {
  // 무한히 키우고 줄이는 대신 단계를 못 박는다. 목록이 바뀌면 상단바 역보정도 그 배율에서
  // 다시 확인해야 하므로, 목록 자체를 테스트가 지킨다.
  it('100% 를 포함하고 오름차순이다', () => {
    expect(APP_ZOOM_STEPS).toContain(1);
    const sorted = [...APP_ZOOM_STEPS].sort((a, b) => a - b);
    expect([...APP_ZOOM_STEPS]).toEqual(sorted);
  });

  it('목록 밖 값은 가장 가까운 단계로 끌어당긴다', () => {
    // 옛 빌드가 남긴 상태 파일이나 손으로 고친 값이 그대로 살아 있으면, 검증한 적 없는
    // 배율 위에서 상단바 역보정이 돌게 된다.
    expect(APP_ZOOM_STEPS[nearestZoomStepIndex(0.1)]).toBe(APP_ZOOM_STEPS[0]);
    expect(APP_ZOOM_STEPS[nearestZoomStepIndex(9)]).toBe(
      APP_ZOOM_STEPS[APP_ZOOM_STEPS.length - 1],
    );
    expect(APP_ZOOM_STEPS[nearestZoomStepIndex(1.02)]).toBe(1);
  });

  it('단계 값은 그대로 돌아온다', () => {
    for (const step of APP_ZOOM_STEPS) {
      expect(APP_ZOOM_STEPS[nearestZoomStepIndex(step)]).toBe(step);
    }
  });
});

/**
 * Chromium 은 배율을 호스트마다 **디스크에** 기억한다(userData 의 Preferences 안
 * partition.per_host_zoom_levels). 창을 만들 때 건 100% 는 페이지 로드가 끝나는 순간 그
 * 기억으로 덮어써진다 — 그래서 로드가 끝날 때 우리가 쥔 값을 다시 걸어야 한다.
 */
describe('배율은 기억하지 않는다', () => {
  function fakeWindow() {
    const listeners = new Map<string, () => void>();
    let factor = 1;
    const sent: number[] = [];
    const contents = {
      isDestroyed: () => false,
      setVisualZoomLevelLimits: () => Promise.resolve(),
      setZoomFactor: (next: number) => {
        factor = next;
      },
      getZoomFactor: () => factor,
      send: (_channel: string, value: number) => {
        sent.push(value);
      },
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    };
    return {
      window: { id: 1, webContents: contents, on: () => undefined },
      sent,
      /** Chromium 이 기억해 둔 배율을 되살린 뒤 로드가 끝난 상황. */
      finishLoadRestoring: (restored: number) => {
        factor = restored;
        listeners.get('did-finish-load')?.();
      },
      currentFactor: () => factor,
    };
  }

  it('되살아난 배율을 받아들이지 않고 100% 로 되돌린다', () => {
    const fake = fakeWindow();
    prepareWindowZoom(fake.window as never);
    expect(fake.currentFactor()).toBe(1);

    // 지난 실행에서 1.25 로 키워 둔 것을 Chromium 이 되살렸다.
    fake.finishLoadRestoring(1.25);
    expect(fake.currentFactor()).toBe(1);
    // 렌더러에도 100% 로 알린다 — 상단바 역보정이 되살아난 값 위에서 돌지 않게.
    expect(fake.sent.at(-1)).toBe(1);
  });
});
