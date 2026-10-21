import { useStore } from 'zustand';
import { createAppStore } from './createAppStore';
import { createMockApi } from './createAppStore.test-support';
import type { AppState } from './types';

/**
 * `vi.mock('…/store/appStore', …)` 의 대역 — 목 API 위에서 도는 진짜 스토어.
 *
 * 화면 → 스토어 동작 → API 까지 실제 배관을 그대로 지나게 한다(스토어를 흉내 내면 화면이 부르는 동작이 실제로
 * 있는지·무엇을 부르는지는 시험되지 않는다). 시험은 이 모듈의 `appStore`·`desktopApi` 를 가져와 상태를 넣고 호출을
 * 본다. 시험마다 `appStore.setState(appStore.getInitialState(), true)` 로 되돌린다.
 */
export function createAppStoreModuleMock() {
  const desktopApi = createMockApi();
  const appStore = createAppStore(desktopApi);
  const useAppStore = <T,>(selector: (state: AppState) => T): T => useStore(appStore, selector);
  return { desktopApi, appStore, useAppStore };
}
