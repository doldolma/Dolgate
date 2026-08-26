import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
}));

import { APP_ZOOM_STEPS, nearestZoomStepIndex } from './app-zoom';

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
