import type { DesktopApi } from '@shared';
import { useStore } from 'zustand';
import { createAppStore } from './createAppStore';

export const desktopApi: DesktopApi = new Proxy({} as DesktopApi, {
  get(_target, property) {
    return (window.dolssh as unknown as Record<PropertyKey, unknown>)[property];
  },
});

export const appStore = createAppStore(desktopApi);

export function useAppStore<T>(selector: (state: ReturnType<typeof appStore.getState>) => T): T {
  return useStore(appStore, selector);
}
